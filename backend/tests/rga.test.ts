import { describe, expect, it } from 'vitest';
import { Op, Rga, compareIds } from '../src/crdt/rga';
import { rng, shuffle } from './helpers/rng';

const applyAll = (r: Rga, ops: Op[]) => ops.forEach((o) => r.apply(o));

describe('RGA basics', () => {
  it('inserts and deletes text locally', () => {
    const r = new Rga();
    r.localInsert(0, 'hello', 'a');
    r.localInsert(5, ' world', 'a');
    expect(r.text()).toBe('hello world');
    r.localDelete(5, 6);
    expect(r.text()).toBe('hello');
    r.localInsert(0, '>> ', 'a');
    expect(r.text()).toBe('>> hello');
  });

  it('assigns unique, monotonically increasing ids', () => {
    const r = new Rga();
    const ops = r.localInsert(0, 'abc', 'a');
    const ids = ops.map((o) => o.id);
    expect(new Set(ids.map((i) => `${i.c}:${i.n}`)).size).toBe(3);
    expect(compareIds(ids[0], ids[1])).toBeLessThan(0);
    expect(compareIds(ids[1], ids[2])).toBeLessThan(0);
  });

  it('handles astral characters as single elements', () => {
    const r = new Rga();
    r.localInsert(0, 'a😀b', 'a');
    expect(r.length).toBe(3);
    r.localDelete(1, 1);
    expect(r.text()).toBe('ab');
  });

  it('keeps tombstones: a deleted element is still addressable as an anchor', () => {
    const r = new Rga();
    const [a, b] = r.localInsert(0, 'ab', 'x');
    r.localDelete(1, 1);
    expect(r.get(b.id)?.deleted).toBe(true);
    expect(r.cursorIndex(b.id)).toBe(1); // caret stays after 'a'
    expect(r.cursorIndex(a.id)).toBe(1);
    expect(r.cursorIndex(null)).toBe(0);
  });
});

describe('concurrent edits', () => {
  it('orders concurrent inserts at the same position deterministically', () => {
    const base = new Rga();
    const seed = base.localInsert(0, 'X', 'seed');
    const a = new Rga();
    const b = new Rga();
    applyAll(a, seed);
    applyAll(b, seed);
    const opsA = a.localInsert(1, 'A', 'alice');
    const opsB = b.localInsert(1, 'B', 'bob');
    applyAll(a, opsB);
    applyAll(b, opsA);
    expect(a.text()).toBe(b.text());
    expect(a.text()).toHaveLength(3);
    // same counter -> siteId tie-break: higher siteId first
    expect(a.text()).toBe('XBA');
  });

  it('does not interleave concurrently typed words', () => {
    const a = new Rga();
    const b = new Rga();
    const opsA = a.localInsert(0, 'hello', 'alice');
    const opsB = b.localInsert(0, 'world', 'bob');
    applyAll(a, opsB);
    applyAll(b, opsA);
    expect(a.text()).toBe(b.text());
    expect(['helloworld', 'worldhello']).toContain(a.text());
  });

  it('concurrent delete + insert next to the deleted char loses nothing', () => {
    const a = new Rga();
    const seed = a.localInsert(0, 'abc', 's');
    const b = Rga.fromJSON(a.toJSON());
    const del = a.localDelete(1, 1); // alice deletes 'b'
    const ins = b.localInsert(2, 'Z', 'bob'); // bob types after 'b'
    applyAll(a, ins);
    applyAll(b, del);
    expect(a.text()).toBe(b.text());
    expect(a.text()).toContain('Z');
    expect(a.text()).not.toContain('b');
    expect(seed).toHaveLength(3);
  });
});

describe('delivery robustness', () => {
  it('is idempotent: duplicate delivery changes nothing', () => {
    const src = new Rga();
    const ops = [...src.localInsert(0, 'dup', 'a'), ...src.localDelete(1, 1)];
    const r = new Rga();
    applyAll(r, ops);
    const once = r.text();
    applyAll(r, ops);
    applyAll(r, ops);
    expect(r.text()).toBe(once);
    expect(r.apply(ops[0])).toBe('duplicate');
  });

  it('buffers ops that arrive before their dependencies', () => {
    const src = new Rga();
    const ops = src.localInsert(0, 'abc', 'a');
    const r = new Rga();
    expect(r.apply(ops[2])).toBe('buffered');
    expect(r.apply(ops[1])).toBe('buffered');
    expect(r.pendingCount).toBe(2);
    expect(r.apply(ops[0])).toBe('applied');
    expect(r.pendingCount).toBe(0);
    expect(r.text()).toBe('abc');
  });

  it('buffers a delete that arrives before its insert', () => {
    const src = new Rga();
    const [ins] = src.localInsert(0, 'q', 'a');
    const [del] = src.localDelete(0, 1);
    const r = new Rga();
    r.apply(del);
    r.apply(ins);
    expect(r.text()).toBe('');
    expect(r.get(ins.id)?.deleted).toBe(true);
  });

  it('snapshot round-trip preserves state, tombstones and clock', () => {
    const r = new Rga();
    r.localInsert(0, 'hello', 'a');
    r.localDelete(1, 2);
    const copy = Rga.fromJSON(JSON.parse(JSON.stringify(r.toJSON())));
    expect(copy.text()).toBe(r.text());
    expect(copy.clock).toBe(r.clock);
    expect(copy.toJSON()).toEqual(r.toJSON());
  });
});

describe('property: convergence under arbitrary delivery order', () => {
  it('3 replicas, random edits, partial syncs, shuffled + duplicated delivery', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rand = rng(seed);
      const sites = ['alice', 'bob', 'carol'];
      const reps = sites.map(() => new Rga());
      const all: Op[] = [];
      const inbox: Op[][] = sites.map(() => []);

      for (let step = 0; step < 60; step++) {
        const i = Math.floor(rand() * 3);
        const r = reps[i];
        let ops: Op[];
        if (r.length > 0 && rand() < 0.35) {
          const idx = Math.floor(rand() * r.length);
          ops = r.localDelete(idx, 1 + Math.floor(rand() * Math.min(3, r.length - idx)));
        } else {
          const idx = Math.floor(rand() * (r.length + 1));
          const word = 'abcdefghij'
            .slice(0, 1 + Math.floor(rand() * 4))
            .split('')
            .map((c) => c + (step % 10))
            .join('');
          ops = r.localInsert(idx, word, sites[i]);
        }
        all.push(...ops);
        for (let j = 0; j < 3; j++) if (j !== i) inbox[j].push(...ops);
        // occasionally deliver some pending ops (in shuffled order) to a replica
        if (rand() < 0.3) {
          const j = Math.floor(rand() * 3);
          for (const op of shuffle(inbox[j].splice(0), rand)) reps[j].apply(op);
        }
      }
      // final: everyone gets everything left, shuffled, with duplicates
      for (let j = 0; j < 3; j++) {
        const rest = [...inbox[j], ...inbox[j].slice(0, 5)];
        for (const op of shuffle(rest, rand)) reps[j].apply(op);
      }
      const texts = reps.map((r) => r.text());
      expect(new Set(texts).size, `seed ${seed}`).toBe(1);

      // a fresh replica fed the full op set in random order must match too
      const fresh = new Rga();
      for (const op of shuffle([...all, ...all.slice(0, 10)], rng(seed + 999))) fresh.apply(op);
      expect(fresh.text(), `fresh seed ${seed}`).toBe(texts[0]);
      expect(fresh.pendingCount).toBe(0);
    }
  });
});
