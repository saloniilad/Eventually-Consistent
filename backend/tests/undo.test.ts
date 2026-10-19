import { describe, expect, it } from 'vitest';
import { Id, Op, Rga } from '../src/crdt/rga';
import { Entry, UndoManager } from '../src/crdt/undo';

function setup() {
  const rga = new Rga();
  let n = 0;
  const newId = (): Id => ({ c: 'server', n: rga.clock + ++n });
  const entryOf = (ops: Op[]): Entry =>
    ops.map((o) =>
      o.type === 'insert'
        ? { t: 'ins' as const, id: o.id, ch: o.ch }
        : { t: 'del' as const, id: o.target, ch: rga.get(o.target)?.ch ?? '' },
    );
  const run = (ops: Op[]) => {
    ops.forEach((o) => rga.apply(o));
    n = 0;
  };
  return { rga, newId, entryOf, run };
}

describe('per-user undo/redo with compensating ops', () => {
  it("undoes only the user's own insert, leaving a collaborator's text intact", () => {
    const { rga, newId, entryOf, run } = setup();
    const alice = new UndoManager();
    const a = rga.planInsert(0, 'Hello', 'alice');
    alice.record(entryOf(a));
    run(a);
    const b = rga.planInsert(5, ' World', 'bob'); // bob's edit, not tracked by alice
    run(b);
    expect(rga.text()).toBe('Hello World');
    run(alice.undo(rga, newId));
    expect(rga.text()).toBe(' World');
    run(alice.redo(rga, newId));
    expect(rga.text()).toBe('Hello World');
  });

  it('undoing a delete re-inserts the text where it was', () => {
    const { rga, newId, entryOf, run } = setup();
    const alice = new UndoManager();
    run(rga.planInsert(0, 'abcdef', 'bob'));
    const del = rga.planDelete(2, 2); // delete 'cd'
    alice.record(entryOf(del));
    run(del);
    expect(rga.text()).toBe('abef');
    run(rga.planInsert(0, '!', 'bob')); // concurrent-ish edit elsewhere
    run(alice.undo(rga, newId));
    expect(rga.text()).toBe('!abcdef');
    run(alice.redo(rga, newId));
    expect(rga.text()).toBe('!abef');
  });

  it('skips characters someone else already deleted and does nothing when stacks are empty', () => {
    const { rga, newId, entryOf, run } = setup();
    const alice = new UndoManager();
    const a = rga.planInsert(0, 'xy', 'alice');
    alice.record(entryOf(a));
    run(a);
    run(rga.planDelete(0, 2)); // bob wipes it
    expect(alice.undo(rga, newId)).toEqual([]);
    expect(alice.undo(rga, newId)).toEqual([]);
    expect(alice.redo(rga, newId)).toEqual([]);
  });

  it('a new edit clears the redo stack', () => {
    const { rga, newId, entryOf, run } = setup();
    const alice = new UndoManager();
    const a = rga.planInsert(0, 'one', 'alice');
    alice.record(entryOf(a));
    run(a);
    run(alice.undo(rga, newId));
    expect(alice.redoDepth).toBe(1);
    const b = rga.planInsert(0, 'two', 'alice');
    alice.record(entryOf(b));
    run(b);
    expect(alice.redoDepth).toBe(0);
  });
});
