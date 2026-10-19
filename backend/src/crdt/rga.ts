/**
 * RGA (Replicated Growable Array) sequence CRDT.
 *
 * - Every character gets a unique id `{ c: siteId, n: lamportCounter }`.
 * - An insert names the element it was typed after (`ref`, null = document start).
 * - Concurrent inserts after the same `ref` are ordered by id, higher id first
 *   (counter, then siteId as a deterministic tie-break).
 * - Deletes only set a tombstone flag, so they commute with everything.
 * - `apply` is idempotent, and operations whose dependencies have not arrived yet
 *   are buffered, so any delivery order (including duplicates) converges.
 *
 * This file has no I/O and no dependencies so it can be tested in isolation.
 */

export interface Id {
  c: string;
  n: number;
}

export interface InsertOp {
  type: 'insert';
  id: Id;
  ref: Id | null;
  ch: string;
}

export interface DeleteOp {
  type: 'delete';
  target: Id;
}

export type Op = InsertOp | DeleteOp;

export interface Elem {
  id: Id;
  ch: string;
  ref: Id | null;
  deleted: boolean;
}

export interface RgaSnapshot {
  v: 1;
  clock: number;
  elements: Array<{
    id: [string, number];
    ch: string;
    ref: [string, number] | null;
    del: boolean;
  }>;
}

export type OpStatus = 'ready' | 'duplicate' | 'missing';
export type ApplyResult = 'applied' | 'duplicate' | 'buffered';

export const idKey = (id: Id): string => `${id.c}:${id.n}`;

/** Total order on ids: Lamport counter first, siteId as tie-break. */
export function compareIds(a: Id, b: Id): number {
  if (a.n !== b.n) return a.n - b.n;
  if (a.c === b.c) return 0;
  return a.c < b.c ? -1 : 1;
}

/** Stable key identifying an operation; used to de-duplicate in the operation log. */
export const opKey = (op: Op): string =>
  op.type === 'insert' ? `i:${idKey(op.id)}` : `d:${idKey(op.target)}`;

export class Rga {
  private elems: Elem[] = [];
  private byKey = new Map<string, Elem>();
  private pendingOps: Op[] = [];
  /** Highest Lamport counter seen so far. New local ids use clock + 1. */
  clock = 0;

  // ---------- queries ----------

  get pendingCount(): number {
    return this.pendingOps.length;
  }

  has(id: Id): boolean {
    return this.byKey.has(idKey(id));
  }

  get(id: Id): Elem | undefined {
    return this.byKey.get(idKey(id));
  }

  text(): string {
    let out = '';
    for (const e of this.elems) if (!e.deleted) out += e.ch;
    return out;
  }

  /** Number of visible characters (code points). */
  get length(): number {
    let n = 0;
    for (const e of this.elems) if (!e.deleted) n++;
    return n;
  }

  visibleIds(): Id[] {
    return this.elems.filter((e) => !e.deleted).map((e) => e.id);
  }

  /** Id of the visible character at `index`, or null when out of range. */
  idAtVisible(index: number): Id | null {
    if (index < 0) return null;
    let seen = -1;
    for (const e of this.elems) {
      if (e.deleted) continue;
      seen++;
      if (seen === index) return e.id;
    }
    return null;
  }

  /**
   * Convert a cursor anchored to an element id back to a visible index
   * (the caret sits just after that element). null = start of document.
   */
  cursorIndex(id: Id | null): number {
    if (!id) return 0;
    const target = this.get(id);
    if (!target) return this.length;
    let count = 0;
    for (const e of this.elems) {
      if (!e.deleted) count++;
      if (e === target) break;
    }
    return count;
  }

  // ---------- applying operations ----------

  status(op: Op): OpStatus {
    if (op.type === 'insert') {
      if (this.has(op.id)) return 'duplicate';
      if (op.ref && !this.has(op.ref)) return 'missing';
      return 'ready';
    }
    const target = this.get(op.target);
    if (!target) return 'missing';
    return target.deleted ? 'duplicate' : 'ready';
  }

  /** Apply a remote (or local) operation. Idempotent; buffers ops that arrive early. */
  apply(op: Op): ApplyResult {
    const s = this.status(op);
    if (s === 'duplicate') return 'duplicate';
    if (s === 'missing') {
      const k = opKey(op);
      if (!this.pendingOps.some((p) => opKey(p) === k)) this.pendingOps.push(op);
      return 'buffered';
    }
    this.applyReady(op);
    this.drainPending();
    return 'applied';
  }

  private applyReady(op: Op): void {
    if (op.type === 'delete') {
      const target = this.get(op.target);
      if (target) target.deleted = true;
      return;
    }
    const elem: Elem = { id: op.id, ch: op.ch, ref: op.ref, deleted: false };
    let i = 0;
    if (op.ref) {
      const refElem = this.get(op.ref) as Elem;
      i = this.elems.indexOf(refElem) + 1;
    }
    // Skip over concurrent siblings (and their subtrees) that have a higher id.
    while (i < this.elems.length && compareIds(this.elems[i].id, op.id) > 0) i++;
    this.elems.splice(i, 0, elem);
    this.byKey.set(idKey(op.id), elem);
    if (op.id.n > this.clock) this.clock = op.id.n;
  }

  private drainPending(): void {
    let progress = true;
    while (progress && this.pendingOps.length > 0) {
      progress = false;
      for (let i = 0; i < this.pendingOps.length;) {
        const p = this.pendingOps[i];
        const s = this.status(p);
        if (s === 'missing') {
          i++;
          continue;
        }
        this.pendingOps.splice(i, 1);
        if (s === 'ready') this.applyReady(p);
        progress = true;
      }
    }
  }

  // ---------- generating operations ----------

  /** Build insert ops for `text` at visible `index` without mutating the replica. */
  planInsert(index: number, text: string, siteId: string): InsertOp[] {
    const chars = Array.from(text);
    const at = Math.max(0, Math.min(index, this.length));
    let ref = this.idAtVisible(at - 1);
    let n = this.clock;
    const ops: InsertOp[] = [];
    for (const ch of chars) {
      n++;
      const id = { c: siteId, n };
      ops.push({ type: 'insert', id, ref, ch });
      ref = id;
    }
    return ops;
  }

  /** Build delete ops for `length` visible chars starting at `index`. */
  planDelete(index: number, length: number): DeleteOp[] {
    const from = Math.max(0, index);
    const ids = this.visibleIds().slice(from, from + Math.max(0, length));
    return ids.map((target) => ({ type: 'delete' as const, target }));
  }

  /** Local edit: plan and apply immediately, returning the ops to broadcast. */
  localInsert(index: number, text: string, siteId: string): InsertOp[] {
    const ops = this.planInsert(index, text, siteId);
    for (const op of ops) this.apply(op);
    return ops;
  }

  localDelete(index: number, length: number): DeleteOp[] {
    const ops = this.planDelete(index, length);
    for (const op of ops) this.apply(op);
    return ops;
  }

  // ---------- (de)serialisation ----------

  toJSON(): RgaSnapshot {
    return {
      v: 1,
      clock: this.clock,
      elements: this.elems.map((e) => ({
        id: [e.id.c, e.id.n],
        ch: e.ch,
        ref: e.ref ? [e.ref.c, e.ref.n] : null,
        del: e.deleted,
      })),
    };
  }

  static fromJSON(snap: RgaSnapshot): Rga {
    const rga = new Rga();
    rga.clock = snap.clock;
    for (const e of snap.elements) {
      const elem: Elem = {
        id: { c: e.id[0], n: e.id[1] },
        ch: e.ch,
        ref: e.ref ? { c: e.ref[0], n: e.ref[1] } : null,
        deleted: e.del,
      };
      rga.elems.push(elem);
      rga.byKey.set(idKey(elem.id), elem);
    }
    return rga;
  }
}
