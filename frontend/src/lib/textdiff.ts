/** Helpers that translate between textarea strings (UTF-16) and CRDT indexes (code points). */

export interface Splice {
  /** Code-point index where the change starts. */
  start: number;
  /** Number of code points removed. */
  deleteCount: number;
  /** Text inserted at `start`. */
  insert: string;
}

/** Minimal single-span replace turning `oldText` into `newText` (common prefix/suffix). */
export function diffText(oldText: string, newText: string): Splice {
  const a = Array.from(oldText);
  const b = Array.from(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { start, deleteCount: endA - start, insert: b.slice(start, endB).join('') };
}

/** UTF-16 offset in `text` -> code-point index. */
export function utf16ToCp(text: string, offset: number): number {
  let cp = 0;
  let i = 0;
  while (i < offset && i < text.length) {
    const code = text.codePointAt(i) as number;
    i += code > 0xffff ? 2 : 1;
    cp++;
  }
  return cp;
}

/** Code-point index -> UTF-16 offset in `text`. */
export function cpToUtf16(text: string, cpIndex: number): number {
  let i = 0;
  let cp = 0;
  while (cp < cpIndex && i < text.length) {
    const code = text.codePointAt(i) as number;
    i += code > 0xffff ? 2 : 1;
    cp++;
  }
  return i;
}

export function countWords(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}
