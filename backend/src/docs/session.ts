import { Id, InsertOp, Op, Rga, idKey, opKey } from '../crdt/rga';
import { Entry, UndoManager } from '../crdt/undo';
import { spanDiff } from '../util/diff';
import { log } from '../util/logger';
import type { Role, Store } from '../store/types';
import type { Collaborator, Cursor, ServerMessage } from '../ws/protocol';
import { rebuild } from './replay';

export const SERVER_SITE = 'server';
const SYNC_LIMIT = 20_000;

export class ProtocolError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Transport-agnostic view of one connected client. */
export interface ClientConn {
  id: string;
  userId: string;
  name: string;
  siteId: string;
  role: Role;
  send(msg: ServerMessage): void;
}

export interface SessionOptions {
  snapshotEvery: number;
  maxDocChars: number;
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

const COLORS = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#008080',
  '#9a6324',
  '#800000',
];
export function colorFor(userId: string): string {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/**
 * One live, in-memory replica of a document on the server. All mutations go through
 * a mutex so the persisted `seq` order is exactly the order ops were applied.
 *
 * Write path: validate -> append to durable log -> apply to replica -> broadcast.
 * If the append fails nothing has been applied, so memory never gets ahead of disk.
 */
export class DocumentSession {
  private mutex = new Mutex();
  private clients = new Set<ClientConn>();
  private presence = new Map<string, Collaborator>();
  private undoers = new Map<string, UndoManager>();
  private opsSinceSnapshot = 0;

  private constructor(
    readonly docId: string,
    private store: Store,
    private rga: Rga,
    private seq: number,
    private opts: SessionOptions,
    replayed: number,
  ) {
    this.opsSinceSnapshot = replayed;
  }

  static async load(store: Store, docId: string, opts: SessionOptions): Promise<DocumentSession> {
    const { rga, seq, snapshotSeq, replayed } = await rebuild(store, docId);
    log.info('session loaded', { docId, seq, snapshotSeq, replayed });
    return new DocumentSession(docId, store, rga, seq, opts, replayed);
  }

  get text(): string {
    return this.rga.text();
  }
  get headSeq(): number {
    return this.seq;
  }
  get clientCount(): number {
    return this.clients.size;
  }

  // ---------- membership ----------

  join(conn: ClientConn, since?: number): Promise<void> {
    return this.mutex.run(async () => {
      this.clients.add(conn);
      conn.send({
        type: 'joined',
        siteId: conn.siteId,
        role: conn.role,
        seq: this.seq,
        collaborators: [...this.presence.values()],
      });
      if (since !== undefined && since <= this.seq) {
        const recs = await this.store.getOpsAfter(this.docId, since, undefined, SYNC_LIMIT + 1);
        if (recs.length <= SYNC_LIMIT) {
          conn.send({
            type: 'sync',
            seq: this.seq,
            ops: recs.map((r) => ({ seq: r.seq, siteId: r.siteId, op: r.op })),
          });
          return;
        }
      }
      conn.send({ type: 'snapshot', seq: this.seq, state: this.rga.toJSON() });
    });
  }

  leave(conn: ClientConn): void {
    this.clients.delete(conn);
    if (this.presence.delete(conn.siteId)) {
      this.broadcast({ type: 'presence_leave', siteId: conn.siteId }, conn);
    }
  }

  setPresence(conn: ClientConn, cursor: Cursor | null): void {
    const state: Collaborator = {
      siteId: conn.siteId,
      userId: conn.userId,
      name: conn.name,
      color: colorFor(conn.userId),
      cursor,
    };
    this.presence.set(conn.siteId, state); // ephemeral: never written to the op log
    this.broadcast({ type: 'presence', ...state }, conn);
  }

  broadcast(msg: ServerMessage, except?: ClientConn): void {
    for (const c of this.clients) {
      if (c === except) continue;
      try {
        c.send(msg);
      } catch (err) {
        log.warn('send failed', { docId: this.docId, conn: c.id, err: String(err) });
      }
    }
  }

  // ---------- editing ----------

  /** Ops from a client. Atomic: either the whole batch is valid or nothing is applied. */
  submit(conn: ClientConn, ops: Op[], msgId?: string): Promise<void> {
    return this.mutex.run(async () => {
      if (conn.role === 'viewer') throw new ProtocolError('forbidden', 'read-only access');
      const accepted = this.validate(ops, conn.siteId);
      const seq = await this.commit(conn.userId, conn.siteId, accepted, true, conn);
      conn.send({ type: 'ack', msgId, seq });
    });
  }

  undoRedo(conn: ClientConn, kind: 'undo' | 'redo'): Promise<void> {
    return this.mutex.run(async () => {
      if (conn.role === 'viewer') throw new ProtocolError('forbidden', 'read-only access');
      let n = this.rga.clock;
      const newId = (): Id => ({ c: SERVER_SITE, n: ++n });
      const mgr = this.undoFor(conn.userId);
      const ops = kind === 'undo' ? mgr.undo(this.rga, newId) : mgr.redo(this.rga, newId);
      // Compensating ops go to everyone, including the requester.
      await this.commit(conn.userId, SERVER_SITE, ops, false);
    });
  }

  /** Replace the visible text with `target` using ordinary CRDT ops (used to restore versions). */
  replaceText(userId: string, target: string): Promise<{ inserted: number; deleted: number }> {
    return this.mutex.run(async () => {
      const current = Array.from(this.rga.text());
      const want = Array.from(target);
      if (want.length > this.opts.maxDocChars)
        throw new ProtocolError('doc_too_large', 'document too large');
      const { start, deleteCount, insert } = spanDiff(current, want);
      const ops: Op[] = [
        ...this.rga.planDelete(start, deleteCount),
        ...this.rga.planInsert(start, insert, SERVER_SITE),
      ];
      await this.commit(userId, SERVER_SITE, ops, true);
      return { inserted: Array.from(insert).length, deleted: deleteCount };
    });
  }

  flush(): Promise<void> {
    return this.mutex.run(() => this.snapshot());
  }

  // ---------- internals ----------

  private undoFor(userId: string): UndoManager {
    let m = this.undoers.get(userId);
    if (!m) {
      m = new UndoManager();
      this.undoers.set(userId, m);
    }
    return m;
  }

  /** Dry-run the batch against the replica; returns only ops that will change state. */
  private validate(ops: Op[], siteId: string): Op[] {
    const batchIns = new Set<string>();
    const batchDel = new Set<string>();
    const accepted: Op[] = [];
    let added = 0;
    for (const op of ops) {
      if (op.type === 'insert') {
        if (op.id.c !== siteId)
          throw new ProtocolError('bad_site', 'op id does not belong to your site');
        const k = idKey(op.id);
        if (this.rga.has(op.id) || batchIns.has(k)) continue; // duplicate delivery / retry
        if (op.ref && !this.rga.has(op.ref) && !batchIns.has(idKey(op.ref))) {
          throw new ProtocolError(
            'missing_dependency',
            'insert references an unknown element; resync',
          );
        }
        batchIns.add(k);
        accepted.push(op);
        added++;
      } else {
        const k = idKey(op.target);
        const existing = this.rga.get(op.target);
        if (!existing && !batchIns.has(k)) {
          throw new ProtocolError(
            'missing_dependency',
            'delete targets an unknown element; resync',
          );
        }
        if (existing?.deleted || batchDel.has(k)) continue;
        batchDel.add(k);
        accepted.push(op);
      }
    }
    if (this.rga.length + added > this.opts.maxDocChars) {
      throw new ProtocolError(
        'doc_too_large',
        `document would exceed ${this.opts.maxDocChars} characters`,
      );
    }
    return accepted;
  }

  private async commit(
    userId: string,
    siteId: string,
    ops: Op[],
    record: boolean,
    except?: ClientConn,
  ): Promise<number> {
    if (ops.length === 0) return this.seq;
    const rows = await this.store.appendOps(
      this.docId,
      ops.map((op) => ({ opId: opKey(op), userId, siteId, op })),
    );
    const persisted = new Set(rows.map((r) => r.opId));
    const applied = ops.filter((op) => persisted.has(opKey(op)));
    const entry: Entry = [];
    for (const op of applied) {
      if (op.type === 'insert') entry.push({ t: 'ins', id: op.id, ch: op.ch });
      else entry.push({ t: 'del', id: op.target, ch: this.rga.get(op.target)?.ch ?? '' });
      this.rga.apply(op);
    }
    for (const r of rows) if (r.seq > this.seq) this.seq = r.seq;
    if (record) this.undoFor(userId).record(entry);
    this.opsSinceSnapshot += applied.length;
    if (applied.length > 0) {
      this.broadcast({ type: 'ops', seq: this.seq, from: siteId, userId, ops: applied }, except);
    }
    if (this.opsSinceSnapshot >= this.opts.snapshotEvery) await this.snapshot();
    return this.seq;
  }

  private async snapshot(): Promise<void> {
    if (this.opsSinceSnapshot === 0 || this.rga.pendingCount > 0) return;
    await this.store.saveSnapshot(this.docId, this.seq, this.rga.toJSON());
    this.opsSinceSnapshot = 0;
  }
}

export type { InsertOp };
