import type { InlineNode } from "../model";

/**
 * Three-way merge (diff3) of `base` (what the AI proposal was made from), `ours` (the current
 * document — the human's side) and `theirs` (the AI's result).
 *
 * Edits to different places are both kept. Where both sides changed the same place, both
 * insertions are kept in the fixed order ours (human) → theirs (AI), and a value both sides set
 * differently takes theirs. The result depends only on the inputs (no ids are drawn, no clocks are
 * read), so the same three inputs always merge to the same value.
 *
 * Pure: the module depends on the canonical model types only (no Yjs, AI or editor code), so main
 * and renderer can both run it.
 *
 * What the kernel deliberately leaves to the caller:
 * - Validity of the result. The kernel is generic and knows no schema: references between arrays
 *   (a cell's `rowId` pointing at a row the other side deleted) and ids the result holds in more
 *   than one place (`report.duplicateIds`, e.g. the AI moved a paragraph into a box while the
 *   human edited it where it was) are not resolved here. The caller validates the merged entity
 *   and falls back to the AI's version of that entity when it is invalid.
 * - Document-level equivalence. Values are compared structurally with `updatedAt` ignored at any
 *   depth; `lib/document-equivalence.ts` (`comparableDocumentValue`) is outside this feature and is
 *   not needed, because callers merge the units a proposal touches (a block, a shape), not whole
 *   documents.
 */

/** What the merge had to decide, so callers can count fallbacks (MISS R3) without re-diffing. */
export interface ThreeWayMergeReport {
  /**
   * Paths where both sides changed the same place: a value both set differently (theirs was kept),
   * insertions both made into the same gap of an inline run (both were kept), or orders both
   * changed differently (theirs was kept). Paths look like `$.children` or `$[#blockId].children`.
   */
  overlaps: string[];
  /** Whether some inline run was merged at a coarser granularity because of a size bound. */
  capped: boolean;
  /** The inline runs that were merged coarsely. Nothing is dropped there, but text may repeat. */
  cappedPaths: string[];
  /**
   * Formulas whose id was rewritten: ours' id kept for a formula theirs re-emitted under a new id,
   * or theirs' copy renamed to `<id>-<n>` because ours already uses that id.
   */
  reidentified: number;
  /** Identified elements one side deleted and the other edited; they were kept with the edit. */
  editBeatsDelete: string[];
  /**
   * Ids of array elements (blocks, shapes, rows...) that the merged value holds in more than one
   * place. Not resolved by the kernel: the caller treats the entity as invalid after the merge.
   * Formula ids are never listed here; they are renamed to stay unique instead.
   */
  duplicateIds: string[];
}

export interface ThreeWayMergeResult<T> {
  value: T;
  report: ThreeWayMergeReport;
}

export interface ThreeWayMergeOptions {
  /**
   * Upper bound of the edit distance computed for one inline run and one side (default 1,000).
   * Beyond it, the differing middle of that run is treated as replaced wholesale and the run is
   * reported in `cappedPaths`.
   */
  maxEditDistance?: number;
}

const DEFAULT_MAX_EDIT_DISTANCE = 1_000;
/** Above this many UTF-16 units in one run, whole text nodes are aligned instead of characters. */
const MAX_CHARACTER_ALIGNED_LENGTH = 50_000;
const ROOT_PATH = "$";
/** A write timestamp, not content (MISS R1): never compared, never a reason to merge. */
const VOLATILE_KEY = "updatedAt";

interface MergeContext {
  report: ThreeWayMergeReport;
  maxEditDistance: number;
  /** Formula nodes that came from ours (input references and nodes rebuilt from ours' tokens). */
  oursMathNodes: Set<object>;
}

function createContext(options: ThreeWayMergeOptions, ours: unknown): MergeContext {
  const oursMathNodes = new Set<object>();
  visitMathNodes(ours, (node) => oursMathNodes.add(node));
  return {
    report: {
      overlaps: [],
      capped: false,
      cappedPaths: [],
      reidentified: 0,
      editBeatsDelete: [],
      duplicateIds: [],
    },
    maxEditDistance: options.maxEditDistance ?? DEFAULT_MAX_EDIT_DISTANCE,
    oursMathNodes,
  };
}

function addPath(paths: string[], path: string): void {
  if (!paths.includes(path)) {
    paths.push(path);
  }
}

function reportCapped(path: string, context: MergeContext): void {
  context.report.capped = true;
  addPath(context.report.cappedPaths, path);
}

// ----- equality -----

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function comparableKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((key) => key !== VOLATILE_KEY && record[key] !== undefined);
}

function isEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => isEqual(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }
  const leftKeys = comparableKeys(left);
  const rightKeys = comparableKeys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => (
      Object.prototype.hasOwnProperty.call(right, key) && isEqual(left[key], right[key])
    ));
}

// ----- inline tokens -----

type Attributes = Record<string, unknown>;

interface CharToken {
  kind: "char";
  char: string;
  attrs: Attributes;
}

interface MathToken {
  kind: "math";
  id: string;
  tex: string;
  attrs: Attributes;
}

type InlineToken = CharToken | MathToken;

const TEXT_CONTENT_KEYS = new Set(["type", "text"]);
const MATH_CONTENT_KEYS = new Set(["type", "id", "tex"]);

function attributesOf(node: object, contentKeys: ReadonlySet<string>): Attributes {
  const attrs: Attributes = {};
  for (const [key, value] of Object.entries(node)) {
    if (!contentKeys.has(key) && value !== undefined) {
      attrs[key] = value;
    }
  }
  return attrs;
}

/**
 * One token per code point and per formula. With `byCharacter` false, one token per text node
 * (`char` then holds the whole text): coarser, but bounded in memory for huge runs.
 */
function tokenize(nodes: readonly InlineNode[], byCharacter: boolean): InlineToken[] {
  const tokens: InlineToken[] = [];
  for (const node of nodes) {
    if (node.type === "mathInline") {
      tokens.push({ kind: "math", id: node.id, tex: node.tex, attrs: attributesOf(node, MATH_CONTENT_KEYS) });
      continue;
    }
    const attrs = attributesOf(node, TEXT_CONTENT_KEYS);
    for (const char of byCharacter ? Array.from(node.text) : [node.text]) {
      tokens.push({ kind: "char", char, attrs });
    }
  }
  return tokens;
}

function textLength(nodes: readonly InlineNode[]): number {
  return nodes.reduce((length, node) => length + (node.type === "text" ? node.text.length : 0), 0);
}

/** Content identity used to align the sequences. Formatting and math ids are merged separately. */
function tokenKey(token: InlineToken): string {
  return token.kind === "char" ? `c${token.char}` : `m${token.tex}`;
}

function sameToken(left: InlineToken, right: InlineToken): boolean {
  return tokenKey(left) === tokenKey(right) && isEqual(left.attrs, right.attrs);
}

function tokensToNodes(
  tokens: readonly InlineToken[],
  fromTheirs: ReadonlySet<number>,
  context: MergeContext,
): InlineNode[] {
  const nodes: InlineNode[] = [];
  let run: { text: string; attrs: Attributes } | null = null;
  const flush = () => {
    if (run) {
      nodes.push({ type: "text", text: run.text, ...run.attrs } as InlineNode);
    }
    run = null;
  };
  tokens.forEach((token, index) => {
    if (token.kind === "math") {
      flush();
      const node = { type: "mathInline", id: token.id, tex: token.tex, ...token.attrs } as InlineNode;
      if (!fromTheirs.has(index)) {
        context.oursMathNodes.add(node);
      }
      nodes.push(node);
      return;
    }
    if (run && isEqual(run.attrs, token.attrs)) {
      run.text += token.char;
    } else {
      flush();
      run = { text: token.char, attrs: token.attrs };
    }
  });
  flush();
  return nodes;
}

// ----- sequence diff (Myers) -----

interface SequenceMatch {
  /** base index -> side index, or -1 when the side removed that base token. */
  baseToSide: Int32Array;
  /** side index -> base index, or -1 when the side inserted that token. */
  sideToBase: Int32Array;
  capped: boolean;
}

function mathIds(tokens: readonly InlineToken[]): Set<string> {
  return new Set(tokens.flatMap((token) => token.kind === "math" ? [token.id] : []));
}

/**
 * Content keys used to align the sides against base. A formula is matched by its TeX, so a formula
 * the MCP tools re-emitted under a new id still counts as kept. A formula whose id survives on all
 * three sequences is pinned to that id: otherwise a formula the AI deleted could be paired with a
 * new copy of the same TeX, and the original would come back as a second formula.
 *
 * The pinning rule is the same for both sides on purpose. If one side were aligned by id and the
 * other by TeX alone, the same repeated formula could be paired with different base tokens on each
 * side, and the merge would then keep it twice.
 */
function alignmentKeys(
  tokens: readonly InlineToken[],
  pinnedMathIds: ReadonlySet<string>,
  table: Map<string, number>,
): Int32Array {
  const keys = new Int32Array(tokens.length);
  tokens.forEach((token, index) => {
    const key = token.kind === "math" && pinnedMathIds.has(token.id)
      ? `${tokenKey(token)}#${token.id}`
      : tokenKey(token);
    let id = table.get(key);
    if (id === undefined) {
      id = table.size;
      table.set(key, id);
    }
    keys[index] = id;
  });
  return keys;
}

function matchSequences(base: Int32Array, side: Int32Array, maxEditDistance: number): SequenceMatch {
  const baseToSide = new Int32Array(base.length).fill(-1);
  const sideToBase = new Int32Array(side.length).fill(-1);
  const link = (baseIndex: number, sideIndex: number) => {
    baseToSide[baseIndex] = sideIndex;
    sideToBase[sideIndex] = baseIndex;
  };

  let prefix = 0;
  while (prefix < base.length && prefix < side.length && base[prefix] === side[prefix]) {
    link(prefix, prefix);
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < base.length - prefix
    && suffix < side.length - prefix
    && base[base.length - 1 - suffix] === side[side.length - 1 - suffix]
  ) {
    link(base.length - 1 - suffix, side.length - 1 - suffix);
    suffix += 1;
  }

  const capped = !myersMiddle(
    base,
    prefix,
    base.length - suffix,
    side,
    prefix,
    side.length - suffix,
    maxEditDistance,
    link,
  );
  return { baseToSide, sideToBase, capped };
}

/**
 * Myers' O(ND) greedy diff over `a[aStart, aEnd)` and `b[bStart, bEnd)`, linking the matched
 * pairs. Returns false (and links nothing) when the edit distance exceeds `maxEditDistance`.
 */
function myersMiddle(
  a: Int32Array,
  aStart: number,
  aEnd: number,
  b: Int32Array,
  bStart: number,
  bEnd: number,
  maxEditDistance: number,
  link: (aIndex: number, bIndex: number) => void,
): boolean {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  if (n === 0 || m === 0) {
    return true;
  }
  if (Math.abs(n - m) > maxEditDistance) {
    // The edit distance is at least the length difference: the bound is exceeded before searching.
    return false;
  }
  const limit = Math.min(n + m, maxEditDistance);
  const offset = limit + 1;
  const frontier = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1])
        ? frontier[offset + k + 1]
        : frontier[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(frontier.slice(offset - d, offset + d + 1));
        backtrack(trace, n, m, (ai, bi) => link(aStart + ai, bStart + bi));
        return true;
      }
    }
    trace.push(frontier.slice(offset - d, offset + d + 1));
  }
  return false;
}

function backtrack(
  trace: readonly Int32Array[],
  n: number,
  m: number,
  link: (aIndex: number, bIndex: number) => void,
): void {
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const previous = trace[d - 1];
    // `previous` covers diagonals -(d-1)..(d-1); diagonal k sits at index k + d - 1.
    const at = (diagonal: number) => previous[diagonal + d - 1];
    const k = x - y;
    const fromAbove = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = fromAbove ? k + 1 : k - 1;
    const previousX = at(previousK);
    const snakeStartX = fromAbove ? previousX : previousX + 1;
    while (x > snakeStartX) {
      x -= 1;
      y -= 1;
      link(x, y);
    }
    x = previousX;
    y = previousX - previousK;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    link(x, y);
  }
}

// Letters of space-delimited scripts (Latin, Greek, Cyrillic, Hangul, digits...). Japanese and
// Chinese characters are words on their own, so they stay character-level.
const WORD_CHARACTER = /^[\p{L}\p{N}\p{M}_]$/u;
const UNSPACED_SCRIPT_CHARACTER = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;

function isSpacedWordCharacter(token: InlineToken): boolean {
  return token.kind === "char"
    && WORD_CHARACTER.test(token.char)
    && !UNSPACED_SCRIPT_CHARACTER.test(token.char);
}

/** For each base gap, the first and last index of the side's tokens inserted there (or -1). */
interface GapInsertions {
  first: Int32Array;
  last: Int32Array;
}

function insertionsByGap(match: SequenceMatch, baseLength: number): GapInsertions {
  const first = new Int32Array(baseLength + 1).fill(-1);
  const last = new Int32Array(baseLength + 1).fill(-1);
  let gap = 0;
  for (let index = 0; index < match.sideToBase.length; index += 1) {
    const baseIndex = match.sideToBase[index];
    if (baseIndex >= 0) {
      gap = baseIndex + 1;
      continue;
    }
    if (first[gap] < 0) {
      first[gap] = index;
    }
    last[gap] = index;
  }
  return { first, last };
}

type WordEdit = "none" | "extended" | "replaced";

/**
 * How a side edited the base word `[start, end)`: "replaced" when it removed one of its letters,
 * "extended" when it only inserted letters inside the word or glued to its edges. An insertion
 * that ends (or starts) with a space or punctuation next to the word is a separate word, not an
 * edit of this one.
 */
function wordEditOf(
  side: readonly InlineToken[],
  match: SequenceMatch,
  insertions: GapInsertions,
  start: number,
  end: number,
): WordEdit {
  for (let index = start; index < end; index += 1) {
    if (match.baseToSide[index] < 0) {
      return "replaced";
    }
  }
  for (let gap = start + 1; gap < end; gap += 1) {
    if (insertions.first[gap] >= 0) {
      return "extended";
    }
  }
  const before = insertions.last[start];
  const after = insertions.first[end];
  return (before >= 0 && isSpacedWordCharacter(side[before]))
    || (after >= 0 && isSpacedWordCharacter(side[after]))
    ? "extended"
    : "none";
}

/**
 * Treats a space-delimited word that both sides edited, at least one of them by removing letters,
 * as replaced as a whole by each side.
 *
 * A character diff aligns stray letters ("cat" -> "cow" keeps the "c"), and when the other side
 * replaced the same word, the deletion of that shared letter would cut it out of the other side's
 * word ("dog" + "ow"). Unlinking the word's letters on both sides turns both edits into "delete the
 * word, insert my word", so both words survive intact, ours first. A word only one side touched,
 * or that both sides only extended, stays character-level so the edits interleave normally.
 */
function expandEditsToWords(
  base: readonly InlineToken[],
  ours: readonly InlineToken[],
  oursMatch: SequenceMatch,
  theirs: readonly InlineToken[],
  theirsMatch: SequenceMatch,
): void {
  const oursInsertions = insertionsByGap(oursMatch, base.length);
  const theirsInsertions = insertionsByGap(theirsMatch, base.length);
  let start = 0;
  while (start < base.length) {
    if (!isSpacedWordCharacter(base[start])) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < base.length && isSpacedWordCharacter(base[end])) {
      end += 1;
    }
    const oursEdit = wordEditOf(ours, oursMatch, oursInsertions, start, end);
    const theirsEdit = wordEditOf(theirs, theirsMatch, theirsInsertions, start, end);
    if (oursEdit !== "none" && theirsEdit !== "none" && (oursEdit === "replaced" || theirsEdit === "replaced")) {
      unlinkRange(oursMatch, start, end);
      unlinkRange(theirsMatch, start, end);
    }
    start = end;
  }
}

function unlinkRange(match: SequenceMatch, start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    const sideIndex = match.baseToSide[index];
    if (sideIndex >= 0) {
      match.sideToBase[sideIndex] = -1;
      match.baseToSide[index] = -1;
    }
  }
}

// ----- inline merge -----

interface MergedTokens {
  tokens: InlineToken[];
  /** Positions in `tokens` holding theirs' own insertions (the only tokens that carry theirs' ids). */
  fromTheirs: Set<number>;
}

function mergeInlineTokens(
  base: readonly InlineToken[],
  ours: readonly InlineToken[],
  theirs: readonly InlineToken[],
  path: string,
  context: MergeContext,
): MergedTokens {
  const oursMathIds = mathIds(ours);
  const theirsMathIds = mathIds(theirs);
  const pinnedMathIds = new Set([...mathIds(base)].filter((id) => oursMathIds.has(id) && theirsMathIds.has(id)));
  const table = new Map<string, number>();
  const baseKeys = alignmentKeys(base, pinnedMathIds, table);
  const oursMatch = matchSequences(baseKeys, alignmentKeys(ours, pinnedMathIds, table), context.maxEditDistance);
  const theirsMatch = matchSequences(baseKeys, alignmentKeys(theirs, pinnedMathIds, table), context.maxEditDistance);
  if (oursMatch.capped || theirsMatch.capped) {
    reportCapped(path, context);
  }
  expandEditsToWords(base, ours, oursMatch, theirs, theirsMatch);

  const merged: InlineToken[] = [];
  const fromTheirs = new Set<number>();
  let overlapped = false;
  const noteReidentified = (oursToken: InlineToken, theirsToken: InlineToken) => {
    if (oursToken.kind === "math" && theirsToken.kind === "math" && oursToken.id !== theirsToken.id) {
      context.report.reidentified += 1;
    }
  };
  // The same content on both sides is emitted once, with ours' tokens (and therefore ours' math ids).
  const keepOursRange = (oursStart: number, oursEnd: number, theirsStart: number) => {
    for (let offset = 0; offset < oursEnd - oursStart; offset += 1) {
      noteReidentified(ours[oursStart + offset], theirs[theirsStart + offset]);
      merged.push(ours[oursStart + offset]);
    }
  };

  const emitChunk = (
    baseStart: number,
    baseEnd: number,
    oursStart: number,
    oursEnd: number,
    theirsStart: number,
    theirsEnd: number,
  ) => {
    const oursChanged = sideChangedChunk(base, ours, oursMatch, baseStart, baseEnd, oursStart, oursEnd);
    const theirsChanged = sideChangedChunk(base, theirs, theirsMatch, baseStart, baseEnd, theirsStart, theirsEnd);
    if (oursChanged && theirsChanged && sameRange(ours, oursStart, oursEnd, theirs, theirsStart, theirsEnd)) {
      keepOursRange(oursStart, oursEnd, theirsStart);
      return;
    }
    if (oursChanged && theirsChanged) {
      overlapped = true;
    }
    const oursRuns = insertionRuns(oursMatch.sideToBase, oursStart, oursEnd, baseStart, baseEnd);
    const theirsRuns = insertionRuns(theirsMatch.sideToBase, theirsStart, theirsEnd, baseStart, baseEnd);
    // Base tokens inside a chunk are never kept by both sides, so only the insertions survive.
    for (let gap = 0; gap <= baseEnd - baseStart; gap += 1) {
      const oursRun = oursRuns[gap];
      const theirsRun = theirsRuns[gap];
      if (oursRun && theirsRun && sameRange(ours, oursRun[0], oursRun[1], theirs, theirsRun[0], theirsRun[1])) {
        keepOursRange(oursRun[0], oursRun[1], theirsRun[0]);
        continue;
      }
      if (oursRun) {
        merged.push(...ours.slice(oursRun[0], oursRun[1]));
      }
      if (theirsRun) {
        for (let index = theirsRun[0]; index < theirsRun[1]; index += 1) {
          fromTheirs.add(merged.length);
          merged.push(theirs[index]);
        }
      }
    }
  };

  let previousBase = -1;
  let previousOurs = -1;
  let previousTheirs = -1;
  for (let index = 0; index <= base.length; index += 1) {
    const atEnd = index === base.length;
    if (!atEnd && (oursMatch.baseToSide[index] < 0 || theirsMatch.baseToSide[index] < 0)) {
      continue;
    }
    const oursIndex = atEnd ? ours.length : oursMatch.baseToSide[index];
    const theirsIndex = atEnd ? theirs.length : theirsMatch.baseToSide[index];
    emitChunk(previousBase + 1, index, previousOurs + 1, oursIndex, previousTheirs + 1, theirsIndex);
    if (!atEnd) {
      const oursToken = ours[oursIndex];
      const theirsToken = theirs[theirsIndex];
      noteReidentified(oursToken, theirsToken);
      const attrs = isEqual(oursToken.attrs, theirsToken.attrs)
        ? oursToken.attrs
        : mergeAttributes(base[index].attrs, oursToken.attrs, theirsToken.attrs, () => {
          overlapped = true;
        });
      merged.push({ ...oursToken, attrs });
    }
    previousBase = index;
    previousOurs = oursIndex;
    previousTheirs = theirsIndex;
  }

  if (overlapped) {
    addPath(context.report.overlaps, path);
  }
  return { tokens: merged, fromTheirs };
}

/** "Only one side changed it → that value; both changed it differently → theirs (AI)." */
function mergeLeaf(base: unknown, ours: unknown, theirs: unknown, onConflict: () => void): unknown {
  if (isEqual(ours, theirs) || isEqual(theirs, base)) {
    return ours;
  }
  if (isEqual(ours, base)) {
    return theirs;
  }
  onConflict();
  return theirs;
}

function orderedKeys(...records: readonly Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      keys.add(key);
    }
  }
  return [...keys];
}

/** Formatting of a character kept by both sides, merged key by key (each mark is its own key). */
function mergeAttributes(
  base: Attributes,
  ours: Attributes,
  theirs: Attributes,
  onConflict: () => void,
): Attributes {
  const merged: Attributes = {};
  for (const key of orderedKeys(ours, theirs, base)) {
    const value = key === "marks"
      ? mergeMarks(base.marks, ours.marks, theirs.marks)
      : mergeLeaf(base[key], ours[key], theirs[key], onConflict);
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function markNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((mark): mark is string => typeof mark === "string") : [];
}

function sameMarkSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((mark) => right.includes(mark));
}

/**
 * Each mark is an on/off flag, so it never conflicts: a flag one side toggled follows that side.
 * The result keeps ours' mark order, then appends marks only theirs carries.
 */
function mergeMarks(base: unknown, ours: unknown, theirs: unknown): unknown {
  const baseMarks = markNames(base);
  const oursMarks = markNames(ours);
  const theirsMarks = markNames(theirs);
  const candidates = [...new Set([...oursMarks, ...theirsMarks])];
  const merged = candidates.filter((mark) => {
    const inOurs = oursMarks.includes(mark);
    const inTheirs = theirsMarks.includes(mark);
    return inOurs === inTheirs ? inOurs : inOurs === baseMarks.includes(mark) ? inTheirs : inOurs;
  });
  if (sameMarkSet(merged, oursMarks)) {
    return ours;
  }
  if (sameMarkSet(merged, theirsMarks)) {
    return theirs;
  }
  return merged.length > 0 ? merged : undefined;
}

function sideChangedChunk(
  base: readonly InlineToken[],
  side: readonly InlineToken[],
  match: SequenceMatch,
  baseStart: number,
  baseEnd: number,
  sideStart: number,
  sideEnd: number,
): boolean {
  if (sideEnd - sideStart !== baseEnd - baseStart) {
    return true;
  }
  for (let index = baseStart; index < baseEnd; index += 1) {
    const sideIndex = match.baseToSide[index];
    if (sideIndex < 0 || !isEqual(base[index].attrs, side[sideIndex].attrs)) {
      return true;
    }
  }
  return false;
}

function sameRange(
  left: readonly InlineToken[],
  leftStart: number,
  leftEnd: number,
  right: readonly InlineToken[],
  rightStart: number,
  rightEnd: number,
): boolean {
  if (leftEnd - leftStart !== rightEnd - rightStart) {
    return false;
  }
  for (let offset = 0; offset < leftEnd - leftStart; offset += 1) {
    if (!sameToken(left[leftStart + offset], right[rightStart + offset])) {
      return false;
    }
  }
  return true;
}

/**
 * Groups a side's inserted tokens by the base gap they were inserted into. Gap `g` (relative to
 * `baseStart`) is "right before base token `baseStart + g`": an insertion is anchored right after
 * the last base token that side kept.
 */
function insertionRuns(
  sideToBase: Int32Array,
  sideStart: number,
  sideEnd: number,
  baseStart: number,
  baseEnd: number,
): Array<[number, number] | undefined> {
  const runs: Array<[number, number] | undefined> = new Array(baseEnd - baseStart + 1);
  let gap = 0;
  for (let index = sideStart; index < sideEnd; index += 1) {
    const baseIndex = sideToBase[index];
    if (baseIndex >= 0) {
      gap = baseIndex - baseStart + 1;
      continue;
    }
    const run = runs[gap];
    if (run) {
      run[1] = index + 1;
    } else {
      runs[gap] = [index, index + 1];
    }
  }
  return runs;
}

/**
 * Three-way merges two edits of the same inline run, character by character.
 *
 * - If only one side changed the run, that side's run is returned as it is.
 * - Text is compared per code point and each formula as one token matched by its TeX, so a
 *   formula the MCP tools re-emitted under a new id still counts as kept, and keeps ours' id.
 * - A base token either side deleted is deleted. Insertions into the same gap are emitted ours
 *   first, then theirs; an identical insertion on both sides is emitted once.
 * - A space-delimited word (Latin, digits...) that both sides edited, at least one by removing
 *   letters, is replaced as a whole by each side, so two replacements of one word keep both words.
 * - Formatting is merged per character and per key; each mark is its own key.
 * - Formula ids are unique within the result: a copy that would repeat an id gets `<id>-<n>`,
 *   theirs' copy rather than ours'.
 */
export function mergeInline3(
  base: readonly InlineNode[],
  ours: readonly InlineNode[],
  theirs: readonly InlineNode[],
  options: ThreeWayMergeOptions = {},
): ThreeWayMergeResult<InlineNode[]> {
  const context = createContext(options, ours);
  const merged = mergeInlineValue(base, ours, theirs, ROOT_PATH, context);
  const value = finalizeIdentities(merged, [base, ours, theirs], context);
  return { value, report: context.report };
}

function mergeInlineValue(
  base: readonly InlineNode[],
  ours: readonly InlineNode[],
  theirs: readonly InlineNode[],
  path: string,
  context: MergeContext,
): InlineNode[] {
  if (isEqual(ours, theirs) || isEqual(theirs, base)) {
    return [...ours];
  }
  if (isEqual(ours, base)) {
    return [...theirs];
  }
  const byCharacter = [base, ours, theirs].every((run) => textLength(run) <= MAX_CHARACTER_ALIGNED_LENGTH);
  if (!byCharacter) {
    reportCapped(path, context);
  }
  const merged = mergeInlineTokens(
    tokenize(base, byCharacter),
    tokenize(ours, byCharacter),
    tokenize(theirs, byCharacter),
    path,
    context,
  );
  return tokensToNodes(merged.tokens, merged.fromTheirs, context);
}

/**
 * Three-way merges one entity (a block, a shape, any JSON value) key by key.
 *
 * - If only one side changed a value, that side's value is returned as it is (at any depth).
 * - Inline runs (`InlineNode[]`) go through `mergeInline3`.
 * - Arrays whose elements all carry a unique string `id` are merged as identified elements: the
 *   order follows the side that reordered (theirs if both did), insertions are anchored after the
 *   preceding kept element (ours before theirs at the same anchor), and an element one side deleted
 *   while the other edited it is kept with the edit.
 * - Other arrays of equal length on all three sides are merged element by element; arrays whose
 *   length changed are values.
 * - A key both sides added is merged against an empty object / empty identified array.
 * - A node one side changed the `type` of is taken whole from that side (theirs if both changed it
 *   differently); keys of two kinds of node are never mixed.
 * - Everything else is a value: if both sides changed it differently, theirs (AI) wins and the path
 *   is reported in `overlaps`.
 * - `updatedAt` is never compared (MISS R1); where keys are merged, ours' timestamp is kept.
 * - Formula ids are unique within the whole result (see `mergeInline3`); other duplicated ids are
 *   only reported (`duplicateIds`).
 *
 * The result may share unchanged sub-objects with the inputs; treat all of them as immutable.
 */
export function mergeEntity3<T>(
  base: T,
  ours: T,
  theirs: T,
  options: ThreeWayMergeOptions = {},
): ThreeWayMergeResult<T> {
  const context = createContext(options, ours);
  const merged = mergeValue(base, ours, theirs, ROOT_PATH, context) as T;
  const value = finalizeIdentities(merged, [base, ours, theirs], context);
  return { value, report: context.report };
}

function mergeValue(base: unknown, ours: unknown, theirs: unknown, path: string, context: MergeContext): unknown {
  if (isEqual(ours, theirs) || isEqual(theirs, base)) {
    return ours;
  }
  if (isEqual(ours, base)) {
    return theirs;
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    const merged = mergeArrays(base, ours, theirs, path, context);
    if (merged) {
      return merged;
    }
  } else if (isPlainObject(ours) && isPlainObject(theirs) && (base === undefined || isPlainObject(base))) {
    return mergeNode(base ?? {}, ours, theirs, path, context);
  }
  return mergeLeaf(base, ours, theirs, () => addPath(context.report.overlaps, path));
}

/** Returns undefined when the arrays have to be treated as a single value. */
function mergeArrays(
  base: unknown,
  ours: readonly unknown[],
  theirs: readonly unknown[],
  path: string,
  context: MergeContext,
): unknown[] | undefined {
  if (isInlineRun(ours) && isInlineRun(theirs)) {
    return Array.isArray(base) && isInlineRun(base)
      ? mergeInlineValue(base, ours, theirs, path, context)
      : undefined;
  }
  if (isIdentifiedArray(ours) && isIdentifiedArray(theirs)) {
    if (base === undefined) {
      return mergeIdentifiedArray([], ours, theirs, path, context);
    }
    if (Array.isArray(base) && isIdentifiedArray(base)) {
      return mergeIdentifiedArray(base, ours, theirs, path, context);
    }
  }
  if (Array.isArray(base) && base.length === ours.length && ours.length === theirs.length) {
    return base.map((element, index) => (
      mergeValue(element, ours[index], theirs[index], `${path}[${index}]`, context)
    ));
  }
  return undefined;
}

function nodeType(record: Record<string, unknown>): string | undefined {
  return typeof record.type === "string" ? record.type : undefined;
}

/**
 * Both sides changed this object. Keys are merged one by one unless the two sides disagree on
 * what kind of node it is: mixing them would leave e.g. a `list` with a paragraph's `children`.
 */
function mergeNode(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  path: string,
  context: MergeContext,
): Record<string, unknown> {
  const oursType = nodeType(ours);
  const theirsType = nodeType(theirs);
  if (oursType === theirsType) {
    return mergeObject(base, ours, theirs, path, context);
  }
  // The structural change wins whole; the other side's edits to this node are dropped.
  addPath(context.report.overlaps, path);
  return theirsType === nodeType(base) ? ours : theirs;
}

function mergeObject(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  path: string,
  context: MergeContext,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of orderedKeys(ours, theirs, base)) {
    const value = key === VOLATILE_KEY
      ? ours[key] ?? theirs[key]
      : mergeValue(base[key], ours[key], theirs[key], `${path}.${key}`, context);
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

// ----- ids across the whole result -----

function isMathNode(value: unknown): value is Record<string, unknown> & { id: string } {
  return isPlainObject(value) && value.type === "mathInline" && typeof value.id === "string";
}

/** Visits formula nodes depth-first: array elements in order, object keys in insertion order. */
function visitMathNodes(value: unknown, visit: (node: Record<string, unknown> & { id: string }) => void): void {
  if (Array.isArray(value)) {
    for (const element of value) {
      visitMathNodes(element, visit);
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  if (isMathNode(value)) {
    visit(value);
    return;
  }
  for (const key of Object.keys(value)) {
    visitMathNodes(value[key], visit);
  }
}

/**
 * Makes formula ids unique across the whole merged value and lists other ids held more than once.
 *
 * For each repeated formula id, the first occurrence that came from ours keeps it (comments anchor
 * to ours' ids); without one, the first occurrence keeps it. Every other occurrence gets the first
 * `<id>-<n>` unused by the inputs and the result.
 */
function finalizeIdentities<T>(value: T, inputs: readonly unknown[], context: MergeContext): T {
  const occurrences: Array<{ id: string; fromOurs: boolean }> = [];
  visitMathNodes(value, (node) => {
    occurrences.push({ id: node.id, fromOurs: context.oursMathNodes.has(node) });
  });
  collectDuplicateElementIds(value, context.report.duplicateIds);

  const keeperById = new Map<string, number>();
  occurrences.forEach((occurrence, index) => {
    const keeper = keeperById.get(occurrence.id);
    if (keeper === undefined || (!occurrences[keeper].fromOurs && occurrence.fromOurs)) {
      keeperById.set(occurrence.id, index);
    }
  });
  const known = new Set(occurrences.map((occurrence) => occurrence.id));
  for (const input of inputs) {
    visitMathNodes(input, (node) => known.add(node.id));
  }
  const renamed = new Map<number, string>();
  occurrences.forEach((occurrence, index) => {
    if (keeperById.get(occurrence.id) === index) {
      return;
    }
    let suffix = 2;
    while (known.has(`${occurrence.id}-${suffix}`)) {
      suffix += 1;
    }
    const id = `${occurrence.id}-${suffix}`;
    known.add(id);
    renamed.set(index, id);
  });
  if (renamed.size === 0) {
    return value;
  }
  context.report.reidentified += renamed.size;

  let cursor = 0;
  const rebuild = (current: unknown): unknown => {
    if (Array.isArray(current)) {
      const next = current.map(rebuild);
      return next.some((element, index) => element !== current[index]) ? next : current;
    }
    if (!isPlainObject(current)) {
      return current;
    }
    if (isMathNode(current)) {
      const id = renamed.get(cursor);
      cursor += 1;
      return id === undefined ? current : { ...current, id };
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(current)) {
      next[key] = rebuild(current[key]);
      changed ||= next[key] !== current[key];
    }
    return changed ? next : current;
  };
  return rebuild(value) as T;
}

function collectDuplicateElementIds(value: unknown, duplicates: string[]): void {
  const counts = new Map<string, number>();
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      for (const element of current) {
        if (isPlainObject(element) && typeof element.id === "string" && !isMathNode(element)) {
          counts.set(element.id, (counts.get(element.id) ?? 0) + 1);
        }
        visit(element);
      }
    } else if (isPlainObject(current) && !isMathNode(current)) {
      for (const key of Object.keys(current)) {
        visit(current[key]);
      }
    }
  };
  visit(value);
  for (const [id, count] of counts) {
    if (count > 1) {
      duplicates.push(id);
    }
  }
}

function isInlineRun(values: readonly unknown[]): values is InlineNode[] {
  return values.every((value) => (
    isPlainObject(value)
    && (
      (value.type === "text" && typeof value.text === "string")
      || (value.type === "mathInline" && typeof value.tex === "string" && typeof value.id === "string")
    )
  ));
}

type Identified = Record<string, unknown> & { id: string };

function isIdentifiedArray(values: readonly unknown[]): values is Identified[] {
  const ids = new Set<string>();
  for (const value of values) {
    if (!isPlainObject(value) || typeof value.id !== "string" || ids.has(value.id)) {
      return false;
    }
    ids.add(value.id);
  }
  return true;
}

const HEAD_ANCHOR = Symbol("head");

type InsertionAnchor = string | typeof HEAD_ANCHOR;

/** Generalizes `lib/document-block-merge.ts` `mergeIdentifiedUnits` without its failure modes. */
function mergeIdentifiedArray(
  base: readonly Identified[],
  ours: readonly Identified[],
  theirs: readonly Identified[],
  path: string,
  context: MergeContext,
): Identified[] {
  const baseById = new Map(base.map((element) => [element.id, element]));
  const oursById = new Map(ours.map((element) => [element.id, element]));
  const theirsById = new Map(theirs.map((element) => [element.id, element]));
  const elementPath = (id: string) => `${path}[#${id}]`;

  // 1. Which base elements survive. A deletion only wins over an untouched element.
  const removed = new Set<string>();
  for (const element of base) {
    const oursElement = oursById.get(element.id);
    const theirsElement = theirsById.get(element.id);
    if (oursElement && theirsElement) {
      continue;
    }
    const survivor = oursElement ?? theirsElement;
    if (!survivor || isEqual(survivor, element)) {
      removed.add(element.id);
      continue;
    }
    context.report.editBeatsDelete.push(elementPath(element.id));
  }

  // 2. The order of the surviving base elements.
  const survivors = base.map((element) => element.id).filter((id) => !removed.has(id));
  const survivorSet = new Set(survivors);
  const oursOrder = ours.map((element) => element.id).filter((id) => survivorSet.has(id));
  const theirsOrder = theirs.map((element) => element.id).filter((id) => survivorSet.has(id));
  const oursReordered = isReordered(oursOrder, survivors);
  const theirsReordered = isReordered(theirsOrder, survivors);
  let spine = survivors;
  if (theirsReordered) {
    spine = completeOrder(theirsOrder, survivors);
    if (oursReordered && !isEqual(completeOrder(oursOrder, survivors), spine)) {
      addPath(context.report.overlaps, path);
    }
  } else if (oursReordered) {
    spine = completeOrder(oursOrder, survivors);
  }

  // 3. Insertions, anchored after the preceding element that is kept.
  const spineSet = new Set(spine);
  const insertionsOf = (side: readonly Identified[]) => {
    const byAnchor = new Map<InsertionAnchor, string[]>();
    let anchor: InsertionAnchor = HEAD_ANCHOR;
    for (const { id } of side) {
      if (spineSet.has(id)) {
        anchor = id;
      } else if (!baseById.has(id)) {
        const inserted = byAnchor.get(anchor);
        if (inserted) {
          inserted.push(id);
        } else {
          byAnchor.set(anchor, [id]);
        }
      }
    }
    return byAnchor;
  };
  const oursInsertions = insertionsOf(ours);
  const theirsInsertions = insertionsOf(theirs);
  const orderedIds: string[] = [];
  const emitted = new Set<string>();
  const emitInsertions = (anchor: InsertionAnchor) => {
    for (const id of [...(oursInsertions.get(anchor) ?? []), ...(theirsInsertions.get(anchor) ?? [])]) {
      if (!emitted.has(id)) {
        emitted.add(id);
        orderedIds.push(id);
      }
    }
  };
  emitInsertions(HEAD_ANCHOR);
  for (const id of spine) {
    orderedIds.push(id);
    emitInsertions(id);
  }

  // 4. The content of each element.
  return orderedIds.map((id) => {
    const baseElement = baseById.get(id);
    const oursElement = oursById.get(id);
    const theirsElement = theirsById.get(id);
    if (oursElement && theirsElement) {
      return mergeValue(baseElement, oursElement, theirsElement, elementPath(id), context) as Identified;
    }
    return (oursElement ?? theirsElement)!;
  });
}

/** Whether a side moved surviving elements relative to each other (ignoring ones it lacks). */
function isReordered(sideOrder: readonly string[], survivors: readonly string[]): boolean {
  const present = new Set(sideOrder);
  const expected = survivors.filter((id) => present.has(id));
  return !isEqual(sideOrder, expected);
}

/**
 * A side's order of the survivors, plus the survivors it deleted but that are kept because the
 * other side edited them: each goes right after its nearest preceding base survivor.
 */
function completeOrder(sideOrder: readonly string[], survivors: readonly string[]): string[] {
  const order = [...sideOrder];
  const present = new Set(sideOrder);
  survivors.forEach((id, index) => {
    if (present.has(id)) {
      return;
    }
    let position = 0;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const at = order.indexOf(survivors[previous]);
      if (at >= 0) {
        position = at + 1;
        break;
      }
    }
    order.splice(position, 0, id);
    present.add(id);
  });
  return order;
}
