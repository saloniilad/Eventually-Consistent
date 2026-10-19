import { Id, Op, Rga } from './rga';

/**
 * Per-user undo/redo built on compensating CRDT operations.
 *
 * We never restore an old snapshot. Undoing an insert deletes exactly the characters
 * this user inserted (if still visible). Undoing a delete inserts a *new* character
 * right after the tombstone, so it lands where the old one was. Other users' edits
 * are never touched.
 *
 * Known limitation: if two users delete the same character and both undo, the
 * character is re-inserted twice.
 */
export type Action = { t: 'ins' | 'del'; id: Id; ch: string };
export type Entry = Action[];

const LIMIT = 200;

export class UndoManager {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];

  get undoDepth(): number {
    return this.undoStack.length;
  }
  get redoDepth(): number {
    return this.redoStack.length;
  }

  /** Record one user-level edit (e.g. one websocket batch). Clears the redo stack. */
  record(entry: Entry): void {
    if (entry.length === 0) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(rga: Rga, newId: () => Id): Op[] {
    return this.step(this.undoStack, this.redoStack, rga, newId);
  }

  redo(rga: Rga, newId: () => Id): Op[] {
    return this.step(this.redoStack, this.undoStack, rga, newId);
  }

  private step(from: Entry[], to: Entry[], rga: Rga, newId: () => Id): Op[] {
    while (from.length > 0) {
      const entry = from.pop() as Entry;
      const { ops, inverse } = invert(entry, rga, newId);
      if (ops.length > 0) {
        to.push(inverse);
        return ops;
      }
    }
    return [];
  }
}

function invert(entry: Entry, rga: Rga, newId: () => Id): { ops: Op[]; inverse: Entry } {
  const ops: Op[] = [];
  const inverse: Entry = [];
  for (const action of [...entry].reverse()) {
    const elem = rga.get(action.id);
    if (!elem) continue;
    if (action.t === 'ins') {
      if (elem.deleted) continue; // someone else already removed it
      ops.push({ type: 'delete', target: action.id });
      inverse.push({ t: 'del', id: action.id, ch: action.ch });
    } else {
      if (!elem.deleted) continue;
      const id = newId();
      ops.push({ type: 'insert', id, ref: action.id, ch: action.ch });
      inverse.push({ t: 'ins', id, ch: action.ch });
    }
  }
  return { ops, inverse: inverse.reverse() };
}
