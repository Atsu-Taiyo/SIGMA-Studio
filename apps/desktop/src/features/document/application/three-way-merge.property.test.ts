import { describe, expect, it } from "vitest";

import type { InlineNode, ParagraphNode } from "../model";
import { mergeEntity3, mergeInline3 } from "./three-way-merge";

/**
 * 乱数で作った三者 (base / ours=人間 / theirs=AI) の文字列に対して、マージの性質を確かめる。
 *
 * M1 merge(b, b, t) = t、merge(b, o, b) = o、merge(b, o, o) = o (同じ変更は二重に入らない)。
 * M2 各側が挿入したトークンはちょうど 1 回現れる。
 * M3 どちらかの側が消した base のトークンは現れない。両側が残したトークンはちょうど 1 回現れる。
 * M4 各側のトークンの相対順序が保たれる。
 * M5 書式は「1文字×1キー」: 片側だけ変えたらその値、両側が違う値にしたら theirs。
 * M6 数式の id は ours を残す (人間が触っていない列は AI の列がそのまま返る)。
 * M7 決定的で、入力を書き換えない。
 *
 * M2〜M6 は「どのトークンが残ったか」で判定するので、トークンを一意な文字 (漢字) と一意な TeX で作る。
 */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GeneratedToken {
  /** 文字そのもの、または `$tex`。`uniqueAlphabet` では生成した列の中で一意。 */
  identity: string;
  kind: "char" | "math";
  id?: string;
  /** 文字なら太字、数式なら下線。 */
  marked: boolean;
  color?: string;
}

interface Alphabet {
  fresh(): Omit<GeneratedToken, "marked" | "color">;
}

function uniqueAlphabet(): Alphabet {
  let serial = 0;
  return {
    fresh() {
      serial += 1;
      return serial % 7 === 0
        ? { identity: `$t${serial}`, kind: "math", id: `m${serial}` }
        : { identity: String.fromCodePoint(0x4E00 + serial), kind: "char" };
    },
  };
}

/** 繰り返しの多い英字・空白・同じ TeX の数式。トークンが一意でないので M1 だけを確かめる。 */
function repetitiveAlphabet(random: () => number): Alphabet {
  let serial = 0;
  return {
    fresh() {
      serial += 1;
      const roll = random();
      if (roll < 0.1) {
        return { identity: `$x${Math.floor(random() * 3)}`, kind: "math", id: `m${serial}` };
      }
      return { identity: "ab c"[Math.floor(random() * 4)], kind: "char" };
    },
  };
}

function freshToken(alphabet: Alphabet, random: () => number, colors: readonly string[]): GeneratedToken {
  return {
    ...alphabet.fresh(),
    marked: random() < 0.2,
    color: random() < 0.2 ? colors[Math.floor(random() * colors.length)] : undefined,
  };
}

function generateBase(alphabet: Alphabet, random: () => number): GeneratedToken[] {
  const length = Math.floor(random() * 40);
  return Array.from({ length }, () => freshToken(alphabet, random, ["#111111", "#222222"]));
}

interface DeriveOptions {
  /** この側が付ける色。両側が別の色を付けると書式の衝突になる。 */
  color: string;
  /** 残した数式に新しい id を振る (MCP の id 振り直し)。 */
  reidentify: boolean;
}

function deriveSide(
  base: readonly GeneratedToken[],
  alphabet: Alphabet,
  random: () => number,
  options: DeriveOptions,
): GeneratedToken[] {
  const side: GeneratedToken[] = [];
  const maybeInsert = () => {
    if (random() < 0.15) {
      const count = 1 + Math.floor(random() * 3);
      for (let index = 0; index < count; index += 1) {
        side.push(freshToken(alphabet, random, [options.color]));
      }
    }
  };
  for (const token of base) {
    maybeInsert();
    if (random() < 0.2) {
      continue;
    }
    const next = { ...token };
    if (random() < 0.15) {
      next.marked = !next.marked;
    }
    if (random() < 0.15) {
      next.color = random() < 0.3 ? undefined : options.color;
    }
    if (next.kind === "math" && options.reidentify && random() < 0.5) {
      next.id = `${next.id}-${options.color}`;
    }
    side.push(next);
  }
  maybeInsert();
  return side;
}

/** 隣り合う同じ書式の文字を 1 つの text にまとめた (正規化済みの) InlineNode 列。 */
function toNodes(tokens: readonly GeneratedToken[]): InlineNode[] {
  const nodes: InlineNode[] = [];
  for (const token of tokens) {
    const color = token.color ? { color: token.color } : {};
    if (token.kind === "math") {
      const marks = token.marked ? { marks: ["underline" as const] } : {};
      nodes.push({ type: "mathInline", id: token.id!, tex: token.identity.slice(1), display: "inline", ...marks, ...color });
      continue;
    }
    const last = nodes.at(-1);
    if (last?.type === "text" && sameAttrs(last, token)) {
      last.text += token.identity;
    } else {
      nodes.push({ type: "text", text: token.identity, ...(token.marked ? { marks: ["bold"] } : {}), ...color });
    }
  }
  return nodes;
}

function fromNode(node: InlineNode): Pick<GeneratedToken, "marked" | "color"> {
  const marked = node.type === "text" ? node.marks?.includes("bold") : node.marks?.includes("underline");
  return { marked: marked ?? false, color: node.color };
}

function sameAttrs(node: InlineNode, token: GeneratedToken): boolean {
  const current = fromNode(node);
  return current.marked === token.marked && current.color === token.color;
}

interface FlatToken {
  identity: string;
  id?: string;
  marked: boolean;
  color?: string;
}

function flatten(nodes: readonly InlineNode[]): FlatToken[] {
  return nodes.flatMap((node): FlatToken[] => {
    const attrs = fromNode(node);
    if (node.type === "mathInline") {
      return [{ identity: `$${node.tex}`, id: node.id, ...attrs }];
    }
    return Array.from(node.text, (char) => ({ identity: char, ...attrs }));
  });
}

function count(tokens: readonly FlatToken[], identity: string): number {
  return tokens.filter((token) => token.identity === identity).length;
}

function restrictTo(identities: readonly string[], allowed: ReadonlySet<string>): string[] {
  return identities.filter((identity) => allowed.has(identity));
}

/** 片側だけ変えたらその値、両側が変えたら theirs。 */
function expectedValue<T>(base: T, ours: T, theirs: T): T {
  return theirs === base ? ours : theirs;
}

interface Scenario {
  base: GeneratedToken[];
  ours: GeneratedToken[];
  theirs: GeneratedToken[];
}

function scenario(seed: number, reidentify: boolean): Scenario {
  const random = mulberry32(seed);
  const alphabet = uniqueAlphabet();
  const base = generateBase(alphabet, random);
  return {
    base,
    ours: deriveSide(base, alphabet, random, { color: "#0000ff", reidentify: false }),
    theirs: deriveSide(base, alphabet, random, { color: "#ff0000", reidentify }),
  };
}

const SEEDS = Array.from({ length: 400 }, (_, index) => index + 1);
const MIXED_SEEDS = Array.from({ length: 5000 }, (_, index) => index + 1);

describe("mergeInline3 properties", () => {
  it("M1 returns the changed side when only one side changed, and an identical change once", () => {
    for (const seed of SEEDS) {
      const { base, ours, theirs } = scenario(seed, false);
      const [b, o, t] = [toNodes(base), toNodes(ours), toNodes(theirs)];

      expect(mergeInline3(b, b, t).value, `seed ${seed}`).toEqual(t);
      expect(mergeInline3(b, o, b).value, `seed ${seed}`).toEqual(o);
      expect(mergeInline3(b, o, o).value, `seed ${seed}`).toEqual(o);
    }
  });

  it("M1 holds with repeated letters and formulas, and when the sides differ only by re-issued math ids", () => {
    for (const seed of SEEDS) {
      const random = mulberry32(seed);
      const alphabet = repetitiveAlphabet(random);
      const base = generateBase(alphabet, random);
      const ours = deriveSide(base, alphabet, random, { color: "#0000ff", reidentify: false });
      const theirs = deriveSide(base, alphabet, random, { color: "#ff0000", reidentify: false });
      const reissued = (tokens: readonly GeneratedToken[]) => tokens.map((token) => (
        token.kind === "math" ? { ...token, id: `${token.id}-again` } : token
      ));
      const [b, o, t] = [toNodes(base), toNodes(ours), toNodes(theirs)];

      expect(mergeInline3(b, b, t).value, `seed ${seed}`).toEqual(t);
      // 人間が触っていなければ AI の列がそのまま返る (id も AI のもの)。触っていれば、id の振り直し
      // だけの AI の列は人間の列を変えない。同じ TeX が何度も出ても、並びの取り違えで重複しない。
      const reissuedBase = toNodes(reissued(base));
      const reissuedOurs = toNodes(reissued(ours));
      const untouched = JSON.stringify(o) === JSON.stringify(b);
      expect(mergeInline3(b, o, reissuedBase).value, `seed ${seed}`).toEqual(untouched ? reissuedBase : o);
      expect(mergeInline3(b, o, reissuedOurs).value, `seed ${seed}`).toEqual(untouched ? reissuedOurs : o);
    }
  });

  it("M2-M4 keeps every insertion once, drops every deletion and preserves each side's order", () => {
    for (const seed of SEEDS) {
      const { base, ours, theirs } = scenario(seed, true);
      const merged = flatten(mergeInline3(toNodes(base), toNodes(ours), toNodes(theirs)).value);
      const mergedIdentities = merged.map((token) => token.identity);
      const baseIds = new Set(base.map((token) => token.identity));
      const oursIds = new Set(ours.map((token) => token.identity));
      const theirsIds = new Set(theirs.map((token) => token.identity));

      for (const token of [...ours, ...theirs]) {
        if (!baseIds.has(token.identity)) {
          expect(count(merged, token.identity), `seed ${seed} inserted ${token.identity}`).toBe(1);
        }
      }
      for (const token of base) {
        const expected = oursIds.has(token.identity) && theirsIds.has(token.identity) ? 1 : 0;
        expect(count(merged, token.identity), `seed ${seed} base ${token.identity}`).toBe(expected);
      }
      expect(merged.length, `seed ${seed}`).toBe(new Set(mergedIdentities).size);
      expect(new Set(merged.flatMap((token) => token.id ? [token.id] : [])).size, `seed ${seed} ids`)
        .toBe(merged.filter((token) => token.id).length);
      const mergedSet = new Set(mergedIdentities);
      for (const side of [ours, theirs]) {
        const sideIdentities = side.map((token) => token.identity);
        const sideSet = new Set(sideIdentities);
        expect(restrictTo(mergedIdentities, sideSet), `seed ${seed}`)
          .toEqual(restrictTo(sideIdentities, mergedSet));
      }
    }
  });

  it("M5-M6 merges formatting per character and key, and keeps ours' math ids", () => {
    for (const seed of SEEDS) {
      const { base, ours, theirs } = scenario(seed, true);
      const merged = flatten(mergeInline3(toNodes(base), toNodes(ours), toNodes(theirs)).value);
      // 人間が触っていない列は AI の列がそのまま返るので、id も AI のもの。
      const untouched = JSON.stringify(toNodes(ours)) === JSON.stringify(toNodes(base));
      const byIdentity = (tokens: readonly GeneratedToken[]) => new Map(tokens.map((token) => [token.identity, token]));
      const oursById = byIdentity(ours);
      const theirsById = byIdentity(theirs);

      for (const baseToken of base) {
        const oursToken = oursById.get(baseToken.identity);
        const theirsToken = theirsById.get(baseToken.identity);
        if (!oursToken || !theirsToken) {
          continue;
        }
        const token = merged.find((candidate) => candidate.identity === baseToken.identity)!;
        expect(token.marked, `seed ${seed} mark ${baseToken.identity}`)
          .toBe(expectedValue(baseToken.marked, oursToken.marked, theirsToken.marked));
        expect(token.color, `seed ${seed} color ${baseToken.identity}`)
          .toBe(expectedValue(baseToken.color, oursToken.color, theirsToken.color));
        if (baseToken.kind === "math") {
          expect(token.id, `seed ${seed} id ${baseToken.identity}`).toBe(untouched ? theirsToken.id : oursToken.id);
        }
      }
    }
  });

  it("M7 is deterministic and does not modify its inputs", () => {
    for (const seed of SEEDS) {
      const { base, ours, theirs } = scenario(seed, true);
      const inputs = [toNodes(base), toNodes(ours), toNodes(theirs)] as const;
      const snapshot = structuredClone(inputs);

      const first = mergeInline3(...inputs);
      const second = mergeInline3(...structuredClone(inputs));

      expect(second, `seed ${seed}`).toEqual(first);
      expect(inputs, `seed ${seed}`).toEqual(snapshot);
    }
  });
});

/**
 * 両側が同じ挿入をし、それぞれ別の所も直した場合 (D1)。
 *
 * 同じ文字が続く所への挿入は、前後どちらに入れても同じ文字列になる (「最大値」の後ろに「と最小値」=
 * 「最大」の後ろに「値と最小」)。各側の差分が別々の位置を選んでも、同じ挿入はちょうど 1 回だけ入る。
 * 文書は、繰り返しの多い文字で作った区間を一意な区切り (3 文字) で並べたもの。編集は区間ごとに
 * 1 つだけなので、期待する結果を区間ごとに組み立てられる。同じ挿入のすぐ隣を片側が消すと、その側の
 * 変更は 1 つの置き換えになり (どちらの位置合わせも同じ手数)、競合として両方残る。それはここでは扱わない。
 */
const REPEATING = ["あ", "い", "と", "値", "最", "s", "o", " "];

interface SegmentEdit {
  at: number;
  remove: number;
  insert: string;
}

function applySegmentEdit(segment: string, edit: SegmentEdit | undefined): string {
  if (!edit) {
    return segment;
  }
  const chars = Array.from(segment);
  chars.splice(edit.at, edit.remove, ...Array.from(edit.insert));
  return chars.join("");
}

function sharedInsertionScenario(seed: number): { base: string; ours: string; theirs: string; expected: string } {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  let unique = 0;
  const uniqueText = (length: number) => Array.from({ length }, () => String.fromCodePoint(0xAC00 + (unique += 1))).join("");
  const segments = Array.from({ length: 3 + Math.floor(random() * 4) }, () => (
    Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(REPEATING)).join("")
  ));
  // Three distinct characters between segments: deleting and re-inserting a separator to pair
  // letters across it would cost more than any edit here saves, so every alignment keeps the
  // segments apart and each segment's edit stays one change.
  const fence = (index: number) => Array.from({ length: 3 }, (_, offset) => String.fromCodePoint(0x3400 + index * 3 + offset)).join("");
  const otherEdit = (segment: string): SegmentEdit => {
    const length = Array.from(segment).length;
    const at = Math.floor(random() * (length + 1));
    const remove = at < length && random() < 0.6 ? 1 + Math.floor(random() * Math.min(2, length - at)) : 0;
    return { at, remove, insert: remove > 0 && random() < 0.5 ? "" : uniqueText(1 + Math.floor(random() * 2)) };
  };

  // Each segment holds at most one edit: the shared insertion, or one side's own edit.
  const order = segments.map((_, index) => index).sort(() => random() - 0.5);
  const sharedIndex = order[0];
  const shared: SegmentEdit = {
    at: Math.floor(random() * (Array.from(segments[sharedIndex]).length + 1)),
    remove: 0,
    insert: Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(REPEATING)).join(""),
  };
  const oursEdits = new Map<number, SegmentEdit>([[sharedIndex, shared]]);
  const theirsEdits = new Map<number, SegmentEdit>([[sharedIndex, shared]]);
  for (const index of order.slice(1)) {
    const roll = random();
    if (roll < 0.35 && oursEdits.size < 3) {
      oursEdits.set(index, otherEdit(segments[index]));
    } else if (roll < 0.7 && theirsEdits.size < 3) {
      theirsEdits.set(index, otherEdit(segments[index]));
    }
  }
  const build = (edits: ReadonlyMap<number, SegmentEdit>[]) => segments.map((segment, index) => (
    applySegmentEdit(segment, edits.map((side) => side.get(index)).find(Boolean)) + fence(index)
  )).join("");
  return {
    base: build([]),
    ours: build([oursEdits]),
    theirs: build([theirsEdits]),
    expected: build([oursEdits, theirsEdits]),
  };
}

describe("mergeInline3 with the same insertion on both sides", () => {
  it("D1 keeps an insertion both sides made exactly once, whatever else each side changed", () => {
    const run = (value: string): InlineNode[] => [{ type: "text", text: value }];
    const plainText = (nodes: readonly InlineNode[]) => nodes.map((node) => node.type === "text" ? node.text : "").join("");
    for (const seed of SEEDS) {
      const { base, ours, theirs, expected } = sharedInsertionScenario(seed);

      expect(plainText(mergeInline3(run(base), run(ours), run(theirs)).value), `seed ${seed}`).toBe(expected);
      expect(plainText(mergeInline3(run(base), run(theirs), run(ours)).value), `seed ${seed} swapped`).toBe(expected);
    }
  });
});

/**
 * 同じ文字が続く所での、両側の同じ削除と、挿入・削除・置換の混在 (D2・D3)。
 *
 * 文書は `aaab`、`000円`、`the the cat` のような繰り返しの多い区間を一意な区切り (3 文字) で並べたもの。
 * 編集はすべて「base の何文字目から何文字消し、その位置に何を入れるか」で持つので、期待する結果は
 * 編集を 1 回ずつ当てた文字列として組み立てられる (両側の同じ編集も 1 回)。各側だけの挿入には
 * 一意な文字を使うので「ちょうど 1 回現れる」も文字を数えて確かめられる。
 *
 * D3 (混在) は期待する文字列との一致までは求めない。同じ挿入の隣を片側が消す・書き換えると、差分は
 * それを「もっと小さな挿入」と見ることがあり (`aaaab` に `aba` を足して先頭の `a` を消す = `ab` を足す)、
 * どの文字が誰の編集かは差分から一意に決まらない。代わりに、データを消さないこと (期待する結果の
 * 文字はすべて、その数以上残る)、各側だけの挿入がちょうど 1 回、決定的であることを確かめる。
 * 一致しない場合は二重化 (同じ文字が余分に残る) で、5,000 シード×両方向の約 22%。正準化しないと
 * 不一致は約 46% に増え、約 1 割の実行で文字が消える。
 */
const UNITS = ["a", "0", "う", "the ", "ab", "とう"];
const TAILS = ["", "b", "円", "。", "cat", "!"];

interface Placed {
  segment: number;
  edit: SegmentEdit;
}

interface EditScenario {
  base: string;
  ours: string;
  theirs: string;
  expected: string;
  /** Characters only one side inserted; each must appear exactly once. */
  ownInsertions: string[];
}

/** Applies edits given against base positions: insertions go before `at`, removals drop `[at, at+remove)`. */
function applyEdits(segment: string, edits: readonly SegmentEdit[]): string {
  const chars = Array.from(segment);
  const removed = new Set<number>();
  for (const edit of edits) {
    for (let index = edit.at; index < edit.at + edit.remove; index += 1) {
      removed.add(index);
    }
  }
  let result = "";
  for (let index = 0; index <= chars.length; index += 1) {
    for (const edit of edits) {
      if (edit.at === index) {
        result += edit.insert;
      }
    }
    if (index < chars.length && !removed.has(index)) {
      result += chars[index];
    }
  }
  return result;
}

function editScenario(seed: number, mode: "shared-deletion" | "mixed"): EditScenario {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  let unique = 0;
  const uniqueText = (length: number) => Array.from({ length }, () => String.fromCodePoint(0xAC00 + (unique += 1))).join("");
  const units = Array.from({ length: between(3, 6) }, () => ({ unit: pick(UNITS), reps: between(1, 4), tail: pick(TAILS) }));
  const segments = units.map(({ unit, reps, tail }) => unit.repeat(reps) + tail);
  const fence = (index: number) => Array.from({ length: 3 }, (_, offset) => String.fromCodePoint(0x3400 + index * 3 + offset)).join("");
  const lengthOf = (index: number) => Array.from(segments[index]).length;

  const ours: Placed[] = [];
  const theirs: Placed[] = [];
  const both = (placed: Placed) => {
    ours.push(placed);
    theirs.push(placed);
  };
  /** A side's own edit right before or right after `[start, end)` of the segment, if there is room. */
  const adjacentEdit = (segment: number, start: number, end: number): SegmentEdit | undefined => {
    const length = lengthOf(segment);
    const after = random() < 0.5;
    const room = after ? length - end : start;
    const roll = random();
    if (roll < 0.35 && room > 0) {
      const remove = between(1, Math.min(2, room));
      return { at: after ? end : start - remove, remove, insert: "" };
    }
    if (roll < 0.7 && room > 0) {
      return after ? { at: end, remove: 1, insert: uniqueText(1) } : { at: start - 1, remove: 1, insert: uniqueText(1) };
    }
    // Inserting right before the removed range would put the text at `start`, where the shared
    // edit's own insertion goes too; keep own insertions after the range.
    return { at: end, remove: 0, insert: uniqueText(between(1, 2)) };
  };
  const ownEdit = (segment: number): SegmentEdit => {
    const length = lengthOf(segment);
    const at = between(0, length);
    const remove = at < length && random() < 0.6 ? between(1, Math.min(2, length - at)) : 0;
    return { at, remove, insert: remove > 0 && random() < 0.5 ? "" : uniqueText(between(1, 2)) };
  };
  const sharedRemoval = (segment: number): SegmentEdit => {
    const { unit, reps } = units[segment];
    const repeated = Array.from(unit).length * reps;
    const remove = Math.min(repeated, random() < 0.5 ? 1 : Array.from(unit).length);
    return { at: between(0, repeated - remove), remove, insert: "" };
  };
  const sharedInsertion = (segment: number): SegmentEdit => ({
    at: between(0, lengthOf(segment)),
    remove: 0,
    insert: Array.from({ length: between(1, 3) }, () => pick(Array.from(segments[segment]))).join(""),
  });

  const order = segments.map((_, index) => index).sort(() => random() - 0.5);
  if (mode === "shared-deletion") {
    const [shared, ...rest] = order;
    const removal = sharedRemoval(shared);
    both({ segment: shared, edit: removal });
    const adjacent = adjacentEdit(shared, removal.at, removal.at + removal.remove);
    if (adjacent) {
      (random() < 0.5 ? ours : theirs).push({ segment: shared, edit: adjacent });
    }
    for (const segment of rest) {
      const roll = random();
      if (roll < 0.3 && ours.length < 3) {
        ours.push({ segment, edit: ownEdit(segment) });
      } else if (roll < 0.6 && theirs.length < 3) {
        theirs.push({ segment, edit: ownEdit(segment) });
      }
    }
  } else {
    for (const segment of order) {
      const roll = random();
      if (roll < 0.45) {
        const shared = roll < 0.15
          ? sharedInsertion(segment)
          : roll < 0.3
            ? sharedRemoval(segment)
            : { ...sharedRemoval(segment), insert: pick(UNITS) };
        both({ segment, edit: shared });
        if (random() < 0.5) {
          const adjacent = adjacentEdit(segment, shared.at, shared.at + shared.remove);
          if (adjacent && !(adjacent.remove === 0 && adjacent.at === shared.at)) {
            (random() < 0.5 ? ours : theirs).push({ segment, edit: adjacent });
          }
        }
      } else if (roll < 0.7) {
        ours.push({ segment, edit: ownEdit(segment) });
      } else if (roll < 0.95) {
        theirs.push({ segment, edit: ownEdit(segment) });
      }
    }
  }

  const build = (...sides: readonly Placed[][]) => segments.map((segment, index) => {
    const edits = [...new Set(sides.flat())].filter((placed) => placed.segment === index).map((placed) => placed.edit);
    return applyEdits(segment, edits) + fence(index);
  }).join("");
  // Only one side's own edits insert these characters; the shared edits use the segments' letters.
  const ownInsertions = [...ours, ...theirs].flatMap(({ edit }) => Array.from(edit.insert))
    .filter((char) => char.codePointAt(0)! >= 0xAC00);
  return { base: build(), ours: build(ours), theirs: build(theirs), expected: build(ours, theirs), ownInsertions };
}

describe("mergeInline3 with the same deletion on both sides and mixed edits", () => {
  const run = (value: string): InlineNode[] => [{ type: "text", text: value }];
  const plainText = (nodes: readonly InlineNode[]) => nodes.map((node) => node.type === "text" ? node.text : "").join("");
  const countOf = (value: string) => {
    const counts = new Map<string, number>();
    for (const char of value) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    return counts;
  };
  /** Nothing the merge should keep is lost; own insertions appear once; the result is stable. */
  const checkSafe = (scenario: EditScenario, base: string, ours: string, theirs: string, label: string) => {
    const merged = plainText(mergeInline3(run(base), run(ours), run(theirs)).value);
    const mergedCounts = countOf(merged);
    for (const [char, count] of countOf(scenario.expected)) {
      expect(mergedCounts.get(char) ?? 0, `${label} keeps ${char}`).toBeGreaterThanOrEqual(count);
    }
    for (const char of scenario.ownInsertions) {
      expect(mergedCounts.get(char), `${label} inserts ${char} once`).toBe(1);
    }
    expect(plainText(mergeInline3(run(base), run(ours), run(theirs)).value), `${label} again`).toBe(merged);
    return merged;
  };

  it("D2 deletes a character both sides deleted once, next to another edit on one side", () => {
    for (const seed of SEEDS) {
      const scenario = editScenario(seed, "shared-deletion");
      const { base, ours, theirs, expected } = scenario;
      expect(checkSafe(scenario, base, ours, theirs, `seed ${seed}`), `seed ${seed}`).toBe(expected);
      expect(checkSafe(scenario, base, theirs, ours, `seed ${seed} swapped`), `seed ${seed} swapped`).toBe(expected);
    }
  });

  it("D3 never loses text when shared and own insertions, deletions and replacements mix", () => {
    for (const seed of MIXED_SEEDS) {
      const scenario = editScenario(seed, "mixed");
      const { base, ours, theirs } = scenario;
      checkSafe(scenario, base, ours, theirs, `seed ${seed}`);
      checkSafe(scenario, base, theirs, ours, `seed ${seed} swapped`);
    }
  });
});

/**
 * id 付きの要素の列 (ブロック列) の性質。
 *
 * E1 merge(b, b, t) = t、merge(b, o, b) = o、merge(b, o, o) = o。
 * E2 各側が足した要素はちょうど 1 回、両側が残した要素もちょうど 1 回現れる。片側が消した要素は、
 *    もう片側が編集していなければ現れず、編集していれば編集した内容で残る (editBeatsDelete)。
 * E3 各側の要素の相対順序が保たれる。
 * E4 片側だけが編集した要素はその側の内容、両側が編集した要素は両方の編集を含む。
 * E5 決定的で、入力を書き換えない。
 */
interface BlockScenario {
  base: ParagraphNode[];
  ours: ParagraphNode[];
  theirs: ParagraphNode[];
}

function block(id: string, value: string): ParagraphNode {
  return { id, type: "paragraph", children: [{ type: "text", text: value }] };
}

function blockText(node: ParagraphNode): string {
  return node.children.map((child) => child.type === "text" ? child.text : child.tex).join("");
}

function blockScenario(seed: number): BlockScenario {
  const random = mulberry32(seed);
  let serial = 0;
  const freshChar = () => String.fromCodePoint(0x4E00 + (serial += 1));
  const base = Array.from({ length: Math.floor(random() * 12) }, (_, index) => block(`b${index}`, freshChar()));
  const derive = (name: string): ParagraphNode[] => {
    const side: ParagraphNode[] = [];
    const maybeInsert = () => {
      if (random() < 0.2) {
        side.push(block(`${name}${serial}`, freshChar()));
      }
    };
    for (const element of base) {
      maybeInsert();
      const roll = random();
      if (roll < 0.2) {
        continue;
      }
      side.push(roll < 0.4 ? block(element.id, `${blockText(element)}${freshChar()}`) : element);
    }
    maybeInsert();
    return side;
  };
  return { base, ours: derive("o"), theirs: derive("t") };
}

describe("mergeEntity3 properties over identified arrays", () => {
  it("E1 returns the changed side when only one side changed, and an identical change once", () => {
    for (const seed of SEEDS) {
      const { base, ours, theirs } = blockScenario(seed);

      expect(mergeEntity3(base, base, theirs).value, `seed ${seed}`).toEqual(theirs);
      expect(mergeEntity3(base, ours, base).value, `seed ${seed}`).toEqual(ours);
      expect(mergeEntity3(base, ours, ours).value, `seed ${seed}`).toEqual(ours);
    }
  });

  it("E2-E4 keeps insertions once, resolves deletions, preserves order and keeps every edit", () => {
    for (const seed of SEEDS) {
      const { base, ours, theirs } = blockScenario(seed);
      const merged = mergeEntity3(base, ours, theirs);
      const ids = merged.value.map((element) => element.id);
      const byId = (blocks: readonly ParagraphNode[]) => new Map(blocks.map((element) => [element.id, element]));
      const [baseById, oursById, theirsById, mergedById] = [byId(base), byId(ours), byId(theirs), byId(merged.value)];

      expect(new Set(ids).size, `seed ${seed} unique`).toBe(ids.length);
      expect(merged.report.duplicateIds, `seed ${seed} duplicates`).toEqual([]);
      for (const element of [...ours, ...theirs]) {
        if (!baseById.has(element.id)) {
          expect(mergedById.get(element.id), `seed ${seed} inserted ${element.id}`).toEqual(element);
        }
      }
      for (const element of base) {
        const oursElement = oursById.get(element.id);
        const theirsElement = theirsById.get(element.id);
        const mergedElement = mergedById.get(element.id);
        const label = `seed ${seed} base ${element.id}`;
        if (oursElement && theirsElement) {
          const oursSuffix = blockText(oursElement).slice(blockText(element).length);
          const theirsSuffix = blockText(theirsElement).slice(blockText(element).length);
          expect(mergedElement && blockText(mergedElement), label)
            .toBe(blockText(element) + (oursSuffix === theirsSuffix ? oursSuffix : oursSuffix + theirsSuffix));
        } else {
          const survivor = oursElement ?? theirsElement;
          const edited = survivor !== undefined && survivor !== element;
          expect(mergedElement, label).toEqual(edited ? survivor : undefined);
          expect(merged.report.editBeatsDelete.includes(`$[#${element.id}]`), label).toBe(edited);
        }
      }
      const mergedSet = new Set(ids);
      for (const side of [ours, theirs]) {
        const sideIds = side.map((element) => element.id);
        const sideSet = new Set(sideIds);
        expect(restrictTo(ids, sideSet), `seed ${seed} order`).toEqual(restrictTo(sideIds, mergedSet));
      }
    }
  });

  it("E5 is deterministic and does not modify its inputs", () => {
    for (const seed of SEEDS) {
      const { base, ours, theirs } = blockScenario(seed);
      const snapshot = structuredClone([base, ours, theirs]);

      const first = mergeEntity3(base, ours, theirs);
      const second = mergeEntity3(...structuredClone([base, ours, theirs] as const));

      expect(second, `seed ${seed}`).toEqual(first);
      expect([base, ours, theirs], `seed ${seed}`).toEqual(snapshot);
    }
  });
});

