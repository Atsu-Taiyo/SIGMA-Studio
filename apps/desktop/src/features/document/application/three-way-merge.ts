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
 *
 * Known limits:
 * - Inputs are serialized values (as after IPC / JSON): base, ours and theirs share no objects.
 *   Whether a formula came from ours is told by object identity.
 * - When one side's diff of a huge run hits `maxEditDistance`, that side's whole differing middle
 *   counts as replaced, so the other side's insertions inside it land after the replacement text.
 *   The run is listed in `cappedPaths`.
 * - Text both sides inserted is emitted once when it lands in one gap (also when one side glued
 *   an edit of its own to it). Where repeated characters let a diff read "insert `aba`, delete the
 *   `a` before it" as "insert `ab`", the two sides' edits no longer look alike and text may be kept
 *   twice. The merge prefers keeping text twice to deleting it twice: a deletion both sides made is
 *   placed on the same characters whenever its run can slide there.
 * - Only `type` tells node kinds apart. A Graph3D object switched from `point` to `segment`
 *   (`kind`) by one side while the other edits it is merged key by key and may mix both kinds.
 * - `editBeatsDelete` counts any change as an edit, including values the editor re-measures and
 *   writes back (a text shape's height); the kernel knows no derived values.
 * - Values merge per key: base `{x: 0, y: 0}`, ours `{x: 10, y: 10}`, theirs `{x: 5, y: 0}` give
 *   `{x: 5, y: 10}`. Nothing is lost, but coupled keys (x/y, w/h) can combine both sides.
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
   * or a copy renamed to `<id>-<n>` because the merge repeated that id.
   */
  reidentified: number;
  /**
   * Values one side deleted and the other edited, kept with the edit: identified elements
   * (`$[#id]`) and object keys (`$.title`).
   */
  editBeatsDelete: string[];
  /**
   * Ids of array elements (blocks, shapes, rows...) that the merge made appear in more places than
   * in any input. Not resolved by the kernel: the caller treats the entity as invalid after the
   * merge. Formula ids are never listed here; they are renamed instead.
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

// ----- canonical edit scripts -----

/** Two tokens either side of an alignment could be swapped for without changing anything. */
function interchangeable(left: InlineToken, right: InlineToken): boolean {
  return left === right || (
    sameToken(left, right)
    && (left.kind !== "math" || (right.kind === "math" && left.id === right.id))
  );
}

/**
 * Rewrites both sides' alignments so that the same edit made by both sides is represented the same
 * way on both. Without this, a repeated character makes one edit look like another:
 *
 * - Inserting "と最小値" after "最大値" and inserting "値と最小" after "最大" give the same text; a
 *   diff picks either depending on what else the side changed, and the two identical insertions
 *   would land in different gaps and both be kept.
 * - Deleting one "0" of "1000" can be any of the three; if one side's deletion is glued to another
 *   edit ("0円" removed together) and the other side's is not, the two would remove different
 *   zeros and the merge would remove both.
 *
 * Runs of changed tokens are first compacted like git's hunks (`xdl_change_compact`): a run slides
 * by one when the token it uncovers is interchangeable with the one it covers, runs that touch
 * merge, and each run slides up and down until it stops growing (this joins pieces of one edit that
 * the diff split). Then each run is placed within the positions it can slide to:
 * - an inserted run at its leftmost position (insertions are per side, so a fixed rule makes equal
 *   insertions coincide);
 * - a deleted run where it overlaps the other side's deletions the most, else leftmost. Deletions
 *   live on the same base, so a run that can move goes to where the other side deleted — also when
 *   the other side's run is glued in place.
 * Unchanged tokens still pair up in order, so each alignment stays valid.
 */
function canonicalizeAlignments(
  base: readonly InlineToken[],
  ours: readonly InlineToken[],
  oursMatch: SequenceMatch,
  theirs: readonly InlineToken[],
  theirsMatch: SequenceMatch,
): void {
  const changedFlags = (links: Int32Array) => Uint8Array.from(links, (link) => (link < 0 ? 1 : 0));
  const oursInserted = changedFlags(oursMatch.sideToBase);
  const theirsInserted = changedFlags(theirsMatch.sideToBase);
  const oursDeleted = changedFlags(oursMatch.baseToSide);
  const theirsDeleted = changedFlags(theirsMatch.baseToSide);
  for (const [tokens, inserted] of [[ours, oursInserted], [theirs, theirsInserted]] as const) {
    compactChanges(tokens, inserted);
    placeChanges(tokens, inserted, () => 0);
  }
  compactChanges(base, oursDeleted);
  compactChanges(base, theirsDeleted);
  const overlapWith = (other: Uint8Array) => (start: number, end: number) => {
    let overlap = 0;
    for (let index = start; index < end; index += 1) {
      overlap += other[index];
    }
    return overlap;
  };
  // Ours goes where theirs could delete (theirs has not been placed yet), then theirs goes where
  // ours did delete.
  placeChanges(base, oursDeleted, overlapWith(reachOf(base, theirsDeleted)));
  placeChanges(base, theirsDeleted, overlapWith(oursDeleted));
  relink(oursMatch, oursDeleted, oursInserted);
  relink(theirsMatch, theirsDeleted, theirsInserted);
}

/** Pairs the unchanged base tokens with the unchanged side tokens in order. */
function relink(match: SequenceMatch, deleted: Uint8Array, inserted: Uint8Array): void {
  match.baseToSide.fill(-1);
  match.sideToBase.fill(-1);
  let baseIndex = 0;
  let sideIndex = 0;
  for (;;) {
    while (baseIndex < deleted.length && deleted[baseIndex]) {
      baseIndex += 1;
    }
    while (sideIndex < inserted.length && inserted[sideIndex]) {
      sideIndex += 1;
    }
    if (baseIndex >= deleted.length || sideIndex >= inserted.length) {
      return;
    }
    match.baseToSide[baseIndex] = sideIndex;
    match.sideToBase[sideIndex] = baseIndex;
    baseIndex += 1;
    sideIndex += 1;
  }
}

/** git's compaction: each run ends at the bottom of its range, merged with every run it can reach. */
function compactChanges(tokens: readonly InlineToken[], changed: Uint8Array): void {
  const group = { start: 0, end: 0 };
  const slideUp = (): boolean => {
    if (group.start === 0 || !interchangeable(tokens[group.start - 1], tokens[group.end - 1])) {
      return false;
    }
    group.start -= 1;
    group.end -= 1;
    changed[group.start] = 1;
    changed[group.end] = 0;
    while (group.start > 0 && changed[group.start - 1]) {
      group.start -= 1;
    }
    return true;
  };
  const slideDown = (): boolean => {
    if (group.end === tokens.length || !interchangeable(tokens[group.start], tokens[group.end])) {
      return false;
    }
    changed[group.start] = 0;
    changed[group.end] = 1;
    group.start += 1;
    group.end += 1;
    while (group.end < tokens.length && changed[group.end]) {
      group.end += 1;
    }
    return true;
  };
  let start = 0;
  while (start < tokens.length) {
    if (!changed[start]) {
      start += 1;
      continue;
    }
    group.start = start;
    group.end = start;
    while (group.end < tokens.length && changed[group.end]) {
      group.end += 1;
    }
    let size: number;
    do {
      size = group.end - group.start;
      while (slideUp()) {
        // keep sliding
      }
      while (slideDown()) {
        // keep sliding
      }
    } while (size !== group.end - group.start);
    start = group.end;
  }
}

/** Every token some run could cover at some position of its range. */
function reachOf(tokens: readonly InlineToken[], changed: Uint8Array): Uint8Array {
  const reach = Uint8Array.from(changed);
  let start = 0;
  while (start < tokens.length) {
    if (!changed[start]) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < tokens.length && changed[end]) {
      end += 1;
    }
    for (
      let top = start, bottom = end;
      top > 0 && !changed[top - 1] && interchangeable(tokens[top - 1], tokens[bottom - 1]);
    ) {
      top -= 1;
      bottom -= 1;
      reach[top] = 1;
    }
    start = end;
  }
  return reach;
}

/**
 * Moves each run (sitting at the bottom of its range after `compactChanges`) to the position in
 * its range with the highest score; ties go to the leftmost position.
 */
function placeChanges(
  tokens: readonly InlineToken[],
  changed: Uint8Array,
  score: (start: number, end: number) => number,
): void {
  let start = 0;
  while (start < tokens.length) {
    if (!changed[start]) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < tokens.length && changed[end]) {
      end += 1;
    }
    let best = start;
    let bestScore = score(start, end);
    for (
      let top = start, bottom = end;
      top > 0 && !changed[top - 1] && interchangeable(tokens[top - 1], tokens[bottom - 1]);
    ) {
      top -= 1;
      bottom -= 1;
      const value = score(top, bottom);
      if (value >= bestScore) {
        best = top;
        bestScore = value;
      }
    }
    changed.fill(0, start, end);
    changed.fill(1, best, best + end - start);
    start = end;
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
  canonicalizeAlignments(base, ours, oursMatch, theirs, theirsMatch);

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
  const emitTheirs = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      fromTheirs.add(merged.length);
      merged.push(theirs[index]);
    }
  };
  /**
   * Both sides inserted into the same gap. Identical text is emitted once. When one side's text
   * starts or ends with the other side's (the same insertion, plus an edit of its own right next to
   * it), the shared part is emitted once too. Otherwise ours, then theirs.
   */
  const emitInsertionsInOneGap = ([oursStart, oursEnd]: [number, number], [theirsStart, theirsEnd]: [number, number]) => {
    const oursLength = oursEnd - oursStart;
    const theirsLength = theirsEnd - theirsStart;
    if (oursLength >= theirsLength) {
      if (sameRange(ours, oursStart, oursStart + theirsLength, theirs, theirsStart, theirsEnd)) {
        keepOursRange(oursStart, oursStart + theirsLength, theirsStart);
        merged.push(...ours.slice(oursStart + theirsLength, oursEnd));
        return;
      }
      if (sameRange(ours, oursEnd - theirsLength, oursEnd, theirs, theirsStart, theirsEnd)) {
        merged.push(...ours.slice(oursStart, oursEnd - theirsLength));
        keepOursRange(oursEnd - theirsLength, oursEnd, theirsStart);
        return;
      }
    } else {
      if (sameRange(ours, oursStart, oursEnd, theirs, theirsStart, theirsStart + oursLength)) {
        keepOursRange(oursStart, oursEnd, theirsStart);
        emitTheirs(theirsStart + oursLength, theirsEnd);
        return;
      }
      if (sameRange(ours, oursStart, oursEnd, theirs, theirsEnd - oursLength, theirsEnd)) {
        emitTheirs(theirsStart, theirsEnd - oursLength);
        keepOursRange(oursStart, oursEnd, theirsEnd - oursLength);
        return;
      }
    }
    merged.push(...ours.slice(oursStart, oursEnd));
    emitTheirs(theirsStart, theirsEnd);
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
      if (oursRun && theirsRun) {
        emitInsertionsInOneGap(oursRun, theirsRun);
        continue;
      }
      if (oursRun) {
        merged.push(...ours.slice(oursRun[0], oursRun[1]));
      }
      if (theirsRun) {
        emitTheirs(theirsRun[0], theirsRun[1]);
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
 * - If only one side changed the run, that side's run is returned as it is: in a run ours did not
 *   change, theirs' formula ids pass through.
 * - Text is compared per code point and each formula as one token matched by its TeX, so in a run
 *   both sides changed, a formula the MCP tools re-emitted under a new id still counts as kept and
 *   keeps ours' id.
 * - A base token either side deleted is deleted. Insertions into the same gap are emitted ours
 *   first, then theirs; an identical insertion on both sides is emitted once, also when the two
 *   diffs placed it at different but equivalent positions (see `canonicalizeAlignments`).
 * - Words are not special: two different replacements of one word merge character by character
 *   (`cat` → `dog` / `cow` gives `dogow`), like a CRDT; nothing is duplicated or dropped.
 * - Formatting is merged per character and per key; each mark is its own key.
 * - A formula id the merge repeats gets `<id>-<n>` on theirs' copy; ids the inputs already repeat
 *   are left alone.
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
 * - Other arrays of equal length on all three sides are merged element by element when the two
 *   sides changed different positions; otherwise (a length change, or a position both changed)
 *   they are values.
 * - A key both sides added is merged against an empty object / identified array / inline run, so
 *   both inline texts are kept; other values (plain strings...) take theirs.
 * - A node one side changed the `type` or `kind` of is taken whole from that side (theirs if both
 *   changed it differently); keys of two kinds of node are never mixed.
 * - A value one side removed (key or root) and the other changed is kept with the change
 *   (`editBeatsDelete`); removed by one side and untouched by the other, it is removed.
 * - Everything else is a value: if both sides changed it differently, theirs (AI) wins and the path
 *   is reported in `overlaps`.
 * - `updatedAt` is never compared (MISS R1); where keys are merged, ours' timestamp is kept.
 * - A formula id the merge repeats anywhere in the result is renamed on theirs' copy (see
 *   `mergeInline3`); other ids the merge repeats are only reported (`duplicateIds`). Ids the inputs
 *   already repeat are left alone and not reported.
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
  if (base !== undefined && (ours === undefined) !== (theirs === undefined)) {
    // One side removed the value, the other changed it: keep the change, like an edited element
    // one side deleted from an identified array.
    context.report.editBeatsDelete.push(path);
    return ours ?? theirs;
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
    if (base === undefined) {
      // Both sides added the run: both texts are kept, ours first.
      return mergeInlineValue([], ours, theirs, path, context);
    }
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
    // Element by element only when the sides changed different positions. Positions both changed
    // (a swap on one side, an edit on the other) only mean something together, so the array is
    // then a single value.
    const oursChanged = changedPositions(base, ours);
    if (!changedPositions(base, theirs).some((index) => oursChanged.includes(index))) {
      return base.map((element, index) => (
        mergeValue(element, ours[index], theirs[index], `${path}[${index}]`, context)
      ));
    }
  }
  return undefined;
}

function changedPositions(base: readonly unknown[], side: readonly unknown[]): number[] {
  return base.flatMap((element, index) => (isEqual(element, side[index]) ? [] : [index]));
}

/**
 * Keys whose string value says what kind of node an object is. Only `type`: `kind` is mostly a
 * setting (a line's polyline/curve, an arc's arc/sector, a chart's bar/line) that one side may
 * change while the other edits the rest.
 */
const DISCRIMINATOR_KEYS = ["type"] as const;

function nodeKind(record: Record<string, unknown>): Array<string | undefined> {
  return DISCRIMINATOR_KEYS.map((key) => (typeof record[key] === "string" ? record[key] : undefined));
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
  const theirsKind = nodeKind(theirs);
  if (isEqual(nodeKind(ours), theirsKind)) {
    return mergeObject(base, ours, theirs, path, context);
  }
  // The structural change wins whole; the other side's edits to this node are dropped.
  addPath(context.report.overlaps, path);
  return isEqual(theirsKind, nodeKind(base)) ? ours : theirs;
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
 * Fixes ids that the merge itself repeated: the inputs' own repeats are left as they are, so a side
 * returned unchanged stays exactly that side.
 *
 * A formula id the result holds more often than any input does is renamed on the surplus
 * occurrences: occurrences that came from ours keep it first (comments anchor to ours' ids), then
 * the earliest others; each renamed one gets the first `<id>-<n>` unused by the inputs and the
 * result. Other element ids held more often than in any input are only listed in `duplicateIds`.
 */
function finalizeIdentities<T>(value: T, inputs: readonly unknown[], context: MergeContext): T {
  const inputElementCounts = inputs.map(countElementIds);
  for (const [id, count] of countElementIds(value)) {
    if (count > 1 && count > Math.max(...inputElementCounts.map((counts) => counts.get(id) ?? 0))) {
      context.report.duplicateIds.push(id);
    }
  }

  const occurrences: Array<{ id: string; fromOurs: boolean }> = [];
  visitMathNodes(value, (node) => {
    occurrences.push({ id: node.id, fromOurs: context.oursMathNodes.has(node) });
  });
  const inputMathCounts = inputs.map(countMathIds);
  const positionsById = new Map<string, number[]>();
  occurrences.forEach((occurrence, index) => {
    positionsById.set(occurrence.id, [...(positionsById.get(occurrence.id) ?? []), index]);
  });
  const surplus: number[] = [];
  for (const [id, positions] of positionsById) {
    const allowed = Math.max(1, ...inputMathCounts.map((counts) => counts.get(id) ?? 0));
    if (positions.length <= allowed) {
      continue;
    }
    const kept = new Set([
      ...positions.filter((position) => occurrences[position].fromOurs),
      ...positions.filter((position) => !occurrences[position].fromOurs),
    ].slice(0, allowed));
    surplus.push(...positions.filter((position) => !kept.has(position)));
  }
  if (surplus.length === 0) {
    return value;
  }
  const known = new Set(occurrences.map((occurrence) => occurrence.id));
  for (const counts of inputMathCounts) {
    for (const id of counts.keys()) {
      known.add(id);
    }
  }
  const renamed = new Map<number, string>();
  for (const position of surplus.sort((left, right) => left - right)) {
    const original = occurrences[position].id;
    let suffix = 2;
    while (known.has(`${original}-${suffix}`)) {
      suffix += 1;
    }
    const id = `${original}-${suffix}`;
    known.add(id);
    renamed.set(position, id);
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

function countMathIds(value: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  visitMathNodes(value, (node) => counts.set(node.id, (counts.get(node.id) ?? 0) + 1));
  return counts;
}

/** How often each id appears on an array element (formulas excluded) anywhere in the value. */
function countElementIds(value: unknown): Map<string, number> {
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
  return counts;
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
