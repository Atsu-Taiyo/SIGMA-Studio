/** UTF-16 offsets in the plain-text projection (inline math includes its `$` delimiters). */
export interface ProtectedTextRange { from: number; to: number }

/** Transient reservation. Never persisted in SigmaDoc. */
export interface TextContentReservation {
  baselineText: string;
  ranges: readonly ProtectedTextRange[];
  inlineMathIds: readonly string[];
}

/**
 * Follow an unchanged fragment through edits around it. A deletion, replacement,
 * or insertion inside a reserved fragment returns null. Common edges make the
 * usual single keystroke linear; bounded LCS handles batched edits on both sides.
 * Ambiguous/large replacements fail closed rather than guessing an offset.
 */
export function rebaseProtectedTextRanges(
  before: string,
  after: string,
  ranges: readonly ProtectedTextRange[],
): ProtectedTextRange[] | null {
  if (ranges.some(({ from, to }) => !Number.isInteger(from) || !Number.isInteger(to)
    || from < 0 || to <= from || to > before.length)) return null;
  if (before === after) return ranges.map((range) => ({ ...range }));
  if (ranges.length === 0) return [];
  const mapped = new Int32Array(before.length).fill(-1);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    mapped[start] = start;
    start++;
  }
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    mapped[--oldEnd] = --newEnd;
  }
  const n = oldEnd - start;
  const m = newEnd - start;
  if (n * m <= 250_000) {
    const width = m + 1;
    const lengths = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lengths[i * width + j] = before[start + i] === after[start + j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (before[start + i] === after[start + j]) {
        mapped[start + i++] = start + j++;
      } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
        i++;
      } else {
        j++;
      }
    }
  }
  const result: ProtectedTextRange[] = [];
  for (const { from, to } of ranges) {
    const nextFrom = mapped[from];
    if (nextFrom < 0) return null;
    for (let offset = from + 1; offset < to; offset++) {
      if (mapped[offset] !== nextFrom + offset - from) return null;
    }
    result.push({ from: nextFrom, to: nextFrom + to - from });
  }
  return result;
}
