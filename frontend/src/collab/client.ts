import { Id, Op, Rga, RgaSnapshot } from '../crdt/rga';
import { diffText } from '../lib/textdiff';

export type ConnStatus = 'connecting' | 'online' | 'reconnecting' | 'denied' | 'closed';

export interface Cursor {
  anchor: Id | null;
  head: Id | null;
}

export interface Collaborator {
  siteId: string;
  userId: string;
  name: string;
  color: string;
  cursor: Cursor | null;
}

type ServerMessage =
  | { type: 'joined'; siteId: string; role: string; seq: number; collaborators: Collaborator[] }
  | { type: 'snapshot'; seq: number; state: RgaSnapshot }
  | { type: 'sync'; seq: number; ops: Array<{ seq: number; siteId: string; op: Op }> }
  | { type: 'ops'; seq: number; from: string; userId: string; ops: Op[] }
  | { type: 'ack'; msgId?: string; seq: number }
  | ({ type: 'presence' } & Collaborator)
  | { type: 'presence_leave'; siteId: string }
  | { type: 'meta'; title: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

export interface CollabHandlers {
  /** The replica changed. `remote` is false for edits typed in this tab. */
  onChange(remote: boolean): void;
  onStatus(status: ConnStatus): void;
  onRole(role: string): void;
  onPresence(list: Collaborator[]): void;
  onMeta(title: string): void;
  onError(message: string): void;
  onSeq(seq: number): void;
}

export interface CollabOptions {
  wsUrl: string;
  token: string;
  docId: string;
  userId: string;
}

/** Batches are kept small so a single websocket message stays far below the 1 MB limit. */
const MAX_BATCH = 500;
const PING_MS = 25_000;

/** Errors after which our local replica may contain ops the server rejected: throw them away and resync. */
const RESYNC_CODES = new Set(['bad_message', 'bad_site', 'missing_dependency', 'doc_too_large', 'forbidden']);

const randomSuffix = (): string => Math.random().toString(36).slice(2, 10);

/**
 * One browser tab's connection to one document: a local RGA replica + a websocket.
 *
 * - Local edits are applied to the replica immediately, then sent as `ops` batches.
 * - Un-acked batches are kept and re-sent after a reconnect (the server de-duplicates).
 * - On reconnect we rejoin with `since = lastSeq` and only receive the ops we missed.
 */
export class CollabClient {
  rga = new Rga();
  seq = 0;
  role = 'viewer';
  readonly siteId: string;

  private ws: WebSocket | null = null;
  private status: ConnStatus = 'connecting';
  private synced = false; // have we ever received a snapshot/sync for the current replica?
  private closedByUs = false;
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private unacked = new Map<string, Op[]>();
  private msgCounter = 0;
  private collaborators = new Map<string, Collaborator>();
  private lastCursor: Cursor | null = null;

  constructor(
    private opts: CollabOptions,
    private h: CollabHandlers,
  ) {
    this.siteId = `${opts.userId}~${randomSuffix()}`;
  }

  get canEdit(): boolean {
    return this.role !== 'viewer';
  }

  // ---------- lifecycle ----------

  connect(): void {
    this.closedByUs = false;
    this.setStatus(this.synced ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(`${this.opts.wsUrl}/ws?token=${encodeURIComponent(this.opts.token)}`);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.send({
        type: 'join',
        docId: this.opts.docId,
        siteId: this.siteId,
        ...(this.synced ? { since: this.seq } : {}),
      });
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_MS);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      try {
        this.handle(JSON.parse(String(ev.data)) as ServerMessage);
      } catch (err) {
        console.error('bad server message', err);
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.collaborators.clear();
      this.h.onPresence([]);
      if (this.closedByUs) return;
      if (ev.code === 4403) {
        this.setStatus('denied');
        this.h.onError('You do not have access to this document.');
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows and handles the retry */
    };
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('closed');
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    const delay = Math.min(8000, 400 * 2 ** this.retry++) + Math.random() * 250;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Throw the local replica away and fetch a fresh snapshot (used after server-side rejections). */
  private resync(): void {
    this.unacked.clear();
    this.synced = false;
    this.ws?.close(); // onclose -> reconnect -> join without `since` -> fresh snapshot
  }

  private setStatus(s: ConnStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.h.onStatus(s);
  }

  // ---------- incoming ----------

  private handle(m: ServerMessage): void {
    switch (m.type) {
      case 'joined':
        this.role = m.role;
        this.h.onRole(m.role);
        this.collaborators = new Map(m.collaborators.map((c) => [c.siteId, c]));
        this.emitPresence();
        break;
      case 'snapshot':
        this.rga = Rga.fromJSON(m.state);
        this.bumpSeq(m.seq);
        // Our un-acked edits are not in the snapshot yet: put them back on top of it.
        for (const ops of this.unacked.values()) for (const op of ops) this.rga.apply(op);
        this.afterSync();
        this.h.onChange(true);
        break;
      case 'sync':
        for (const r of m.ops) this.rga.apply(r.op);
        this.bumpSeq(m.seq);
        this.afterSync();
        this.h.onChange(true);
        break;
      case 'ops':
        for (const op of m.ops) this.rga.apply(op);
        this.bumpSeq(m.seq);
        this.h.onChange(true);
        break;
      case 'ack':
        if (m.msgId) this.unacked.delete(m.msgId);
        this.bumpSeq(m.seq);
        break;
      case 'presence':
        this.collaborators.set(m.siteId, {
          siteId: m.siteId,
          userId: m.userId,
          name: m.name,
          color: m.color,
          cursor: m.cursor,
        });
        this.emitPresence();
        break;
      case 'presence_leave':
        this.collaborators.delete(m.siteId);
        this.emitPresence();
        break;
      case 'meta':
        this.h.onMeta(m.title);
        break;
      case 'error':
        this.h.onError(m.message);
        if (this.synced && RESYNC_CODES.has(m.code)) this.resync();
        break;
      case 'pong':
        break;
    }
  }

  private afterSync(): void {
    this.synced = true;
    this.retry = 0;
    this.setStatus('online');
    // Re-send everything the server has not acknowledged (duplicates are harmless).
    for (const [msgId, ops] of this.unacked) this.send({ type: 'ops', msgId, ops });
    if (this.lastCursor) this.send({ type: 'presence', cursor: this.lastCursor });
  }

  private bumpSeq(seq: number): void {
    if (seq > this.seq) {
      this.seq = seq;
      this.h.onSeq(seq);
    }
  }

  private emitPresence(): void {
    this.h.onPresence([...this.collaborators.values()]);
  }

  // ---------- outgoing ----------

  private send(msg: unknown): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Turn the textarea's new value into CRDT ops, apply them locally and send them. */
  edit(newText: string): void {
    if (!this.canEdit) return;
    const { start, deleteCount, insert } = diffText(this.rga.text(), newText);
    const ops: Op[] = [
      ...this.rga.localDelete(start, deleteCount),
      ...this.rga.localInsert(start, insert, this.siteId),
    ];
    if (ops.length === 0) return;
    for (let i = 0; i < ops.length; i += MAX_BATCH) {
      const batch = ops.slice(i, i + MAX_BATCH);
      const msgId = `${this.siteId}:${++this.msgCounter}`;
      this.unacked.set(msgId, batch);
      if (this.status === 'online') this.send({ type: 'ops', msgId, ops: batch });
    }
    this.h.onChange(false);
  }

  undo(): void {
    if (this.canEdit && this.status === 'online') this.send({ type: 'undo' });
  }

  redo(): void {
    if (this.canEdit && this.status === 'online') this.send({ type: 'redo' });
  }

  sendPresence(cursor: Cursor | null): void {
    this.lastCursor = cursor;
    if (this.status === 'online') this.send({ type: 'presence', cursor });
  }
}
