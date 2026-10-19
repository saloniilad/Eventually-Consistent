export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** Line-level diff (LCS). Falls back to a whole-document replace for very large inputs. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 4_000_000) {
    return [
      ...x.map((text) => ({ type: 'del' as const, text })),
      ...y.map((text) => ({ type: 'add' as const, text })),
    ];
  }
  const dp: number[][] = Array.from({ length: x.length + 1 }, () =>
    new Array(y.length + 1).fill(0),
  );
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ type: 'same', text: x[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: x[i++] });
    } else {
      out.push({ type: 'add', text: y[j++] });
    }
  }
  while (i < x.length) out.push({ type: 'del', text: x[i++] });
  while (j < y.length) out.push({ type: 'add', text: y[j++] });
  return out;
}

/** Common-prefix / common-suffix diff on code points: the minimal single-span replace. */
export function spanDiff(
  current: string[],
  target: string[],
): { start: number; deleteCount: number; insert: string } {
  let start = 0;
  while (start < current.length && start < target.length && current[start] === target[start])
    start++;
  let endC = current.length;
  let endT = target.length;
  while (endC > start && endT > start && current[endC - 1] === target[endT - 1]) {
    endC--;
    endT--;
  }
  return { start, deleteCount: endC - start, insert: target.slice(start, endT).join('') };
}
