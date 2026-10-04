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
 * 漢字は 1 文字ずつ比較する文字種なので、英単語をまとめて置き換える扱いはここでは効かない。
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

