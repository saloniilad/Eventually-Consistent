import { describe, expect, it } from 'vitest';
import { Rga } from '../crdt/rga';
import { cpToUtf16, diffText, utf16ToCp } from './textdiff';

function applyDiff(rga: Rga, next: string, site: string) {
  const { start, deleteCount, insert } = diffText(rga.text(), next);
  rga.localDelete(start, deleteCount);
  rga.localInsert(start, insert, site);
}

describe('diffText', () => {
  it('finds a pure insertion', () => {
    expect(diffText('helo', 'hello')).toEqual({ start: 3, deleteCount: 0, insert: 'l' });
  });
  it('finds a pure deletion', () => {
    expect(diffText('hello', 'hlo')).toEqual({ start: 1, deleteCount: 2, insert: '' });
  });
  it('finds a replacement', () => {
    expect(diffText('abcd', 'aXYd')).toEqual({ start: 1, deleteCount: 2, insert: 'XY' });
  });
  it('is a no-op for equal strings', () => {
    expect(diffText('same', 'same')).toEqual({ start: 4, deleteCount: 0, insert: '' });
  });
  it('counts astral characters as one element', () => {
    expect(diffText('a😀b', 'ab')).toEqual({ start: 1, deleteCount: 1, insert: '' });
  });
});

describe('index conversion', () => {
  it('round-trips with surrogate pairs', () => {
    const t = 'a😀b';
    expect(utf16ToCp(t, 3)).toBe(2);
    expect(cpToUtf16(t, 2)).toBe(3);
    expect(cpToUtf16(t, 99)).toBe(t.length);
  });
});

describe('driving the RGA from textarea values', () => {
  it('keeps the replica equal to the typed text', () => {
    const r = new Rga();
    const steps = ['h', 'he', 'hel', 'hello', 'hello world', 'hllo world', 'hi world', ''];
    for (const s of steps) {
      applyDiff(r, s, 'u~t');
      expect(r.text()).toBe(s);
    }
  });
});
