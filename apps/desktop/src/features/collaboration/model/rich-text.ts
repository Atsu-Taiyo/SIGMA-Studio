import * as Y from "yjs";
import { isObject, sameValue, type ObjectValue, type Value } from "./value";

interface Token {
  value: string | ObjectValue;
  attributes: ObjectValue;
  length: number;
}
function sameToken(a: Token, b: Token): boolean {
  return typeof a.value === "object" &&
    typeof b.value === "object" &&
    typeof a.value.id === "string"
    ? a.value.id === b.value.id
    : sameValue(a.value, b.value);
}
function mathEmbed(value: ObjectValue): Y.Map<ObjectValue> {
  const map = new Y.Map<ObjectValue>();
  map.set("node", structuredClone(value));
  return map;
}

export function isInlineContent(value: Value): value is ObjectValue[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        isObject(item) &&
        ((item.type === "text" && typeof item.text === "string") ||
          item.type === "mathInline"),
    )
  );
}

function tokens(nodes: readonly ObjectValue[]): Token[] {
  return nodes.flatMap((node): Token[] => {
    if (node.type !== "text")
      return [{ value: node, attributes: {}, length: 1 }];
    const { type: _type, text, ...attributes } = node;
    void _type;
    return Array.from(String(text)).map((value) => ({
      value,
      attributes,
      length: value.length,
    }));
  });
}

export function richText(fragment: Y.XmlFragment): Y.XmlText {
  const child = fragment.get(0);
  if (!(child instanceof Y.XmlText) || fragment.length !== 1)
    throw new Error("INVALID_RICH_TEXT");
  return child;
}

export function createRichFragment(
  nodes: readonly ObjectValue[] = [],
): Y.XmlFragment {
  const fragment = new Y.XmlFragment();
  const text = new Y.XmlText();
  fragment.insert(0, [text]);
  if (nodes.length && nodes.every(node => node.type === "text" && node.text === "")) text.setAttribute("sigmaEmptyText", structuredClone(nodes));
  let offset = 0;
  // Yjs assigns character clocks inside a string insert. Creating one deferred
  // insert per character before integration makes large initial documents quadratic.
  for (const node of nodes) {
    if (node.type === "text") {
      const { type: _type, text: value, ...attributes } = node;
      void _type;
      const content = String(value);
      if (content) text.insert(offset, content, attributes);
      offset += content.length;
    } else {
      text.insertEmbed(offset, mathEmbed(node), {});
      offset++;
    }
  }
  return fragment;
}

export function readRichFragment(fragment: Y.XmlFragment): ObjectValue[] {
  const result: ObjectValue[] = [];
  const text = richText(fragment);
  const empty = text.getAttribute("sigmaEmptyText");
  if (text.length === 0 && Array.isArray(empty) && empty.every(node => isObject(node) && node.type === "text" && node.text === "")) return structuredClone(empty);
  for (const part of text.toDelta()) {
    if (typeof part.insert === "string") {
      if (part.insert)
        result.push({ type: "text", text: part.insert, ...part.attributes });
    } else if (
      part.insert instanceof Y.Map &&
      isObject(part.insert.get("node")) &&
      part.insert.get("node").type === "mathInline"
    ) {
      result.push(structuredClone(part.insert.get("node") as ObjectValue));
    } else if (isObject(part.insert) && part.insert.type === "mathInline") {
      result.push(structuredClone(part.insert));
    } else throw new Error("INVALID_INLINE_NODE");
  }
  return result;
}

/**
 * Change only the edited places; retain CRDT identities everywhere else and for formatting.
 *
 * The text is diffed token by token (a character, or a formula as one token) into separate hunks, so two
 * edits far apart in one paragraph (an AI approval fixing a word at each end) leave the text between them
 * untouched: what someone typed there concurrently and the comment anchors on it stay where they were
 * (issue #249). When the edit distance is too large to diff (`MAX_EDIT_DISTANCE`), the differing middle
 * is replaced as one interval, as before.
 */
export function patchRichFragment(
  fragment: Y.XmlFragment,
  nodes: readonly ObjectValue[],
): void {
  const text = richText(fragment);
  if (nodes.length && nodes.every(node => node.type === "text" && node.text === "")) {
    if (!sameValue(text.getAttribute("sigmaEmptyText"), nodes)) text.setAttribute("sigmaEmptyText", structuredClone(nodes));
  } else if (text.getAttribute("sigmaEmptyText") !== undefined) text.removeAttribute("sigmaEmptyText");
  const before = tokens(readRichFragment(fragment));
  const after = tokens(nodes);
  const offsets = [0];
  for (const token of before) offsets.push(offsets[offsets.length - 1] + token.length);
  // Applied from the end, so the offsets of earlier hunks still read `before`.
  for (const hunk of diffTokens(before, after).reverse()) {
    let offset = offsets[hunk.beforeStart];
    const removed = offsets[hunk.beforeEnd] - offset;
    if (removed) text.delete(offset, removed);
    const inserted = after.slice(hunk.afterStart, hunk.afterEnd);
    for (let index = 0; index < inserted.length;) {
      const token = inserted[index];
      if (typeof token.value === "string") {
        const values: string[] = [];
        while (index < inserted.length && typeof inserted[index].value === "string" && sameValue(token.attributes, inserted[index].attributes)) values.push(inserted[index++].value as string);
        const value = values.join("");
        text.insert(offset, value, token.attributes);
        offset += value.length;
      } else {
        text.insertEmbed(offset, mathEmbed(token.value), token.attributes);
        offset += token.length;
        index++;
      }
    }
  }
  const actual = tokens(readRichFragment(fragment));
  const embeds = new Map<number, Y.Map<ObjectValue>>();
  let deltaOffset = 0;
  for (const part of text.toDelta()) {
    if (part.insert instanceof Y.Map) embeds.set(deltaOffset, part.insert);
    deltaOffset += typeof part.insert === "string" ? part.insert.length : 1;
  }
  let offset = 0;
  after.forEach((token, index) => {
    const embed = embeds.get(offset);
    if (
      embed &&
      typeof token.value !== "string" &&
      !sameValue(embed.get("node"), token.value)
    )
      embed.set("node", structuredClone(token.value));
    const previous = actual[index]?.attributes ?? {};
    if (!sameValue(previous, token.attributes)) {
      text.format(
        offset,
        token.length,
        Object.fromEntries(
          [
            ...new Set([
              ...Object.keys(previous),
              ...Object.keys(token.attributes),
            ]),
          ].map((key) => [key, token.attributes[key] ?? null]),
        ),
      );
    }
    offset += token.length;
  });
}

/** Above this many differing tokens the middle is replaced as one interval (bounded time and memory). */
const MAX_EDIT_DISTANCE = 512;

interface Hunk {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
}

/**
 * The hunks turning `before` into `after`, in order: a shortest edit script (Myers) over the middle left
 * after the common prefix and suffix, or that whole middle as one hunk when it differs too much.
 */
function diffTokens(before: readonly Token[], after: readonly Token[]): Hunk[] {
  let start = 0;
  while (start < before.length && start < after.length && sameToken(before[start], after[start])) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    sameToken(before[before.length - end - 1], after[after.length - end - 1])
  )
    end++;
  const a = before.slice(start, before.length - end);
  const b = after.slice(start, after.length - end);
  if (a.length === 0 && b.length === 0) return [];
  const whole = [{ beforeStart: start, beforeEnd: before.length - end, afterStart: start, afterEnd: after.length - end }];
  if (a.length === 0 || b.length === 0) return whole;
  const equal = commonRuns(a, b);
  if (!equal) return whole;
  const hunks: Hunk[] = [];
  let x = 0;
  let y = 0;
  for (const [ax, by, length] of [...equal, [a.length, b.length, 0] as const]) {
    if (ax > x || by > y) hunks.push({ beforeStart: start + x, beforeEnd: start + ax, afterStart: start + y, afterEnd: start + by });
    x = ax + length;
    y = by + length;
  }
  return hunks;
}

/**
 * The runs both sequences share, in order, as `[indexInA, indexInB, length]`, from a shortest edit
 * script (Myers' O(ND) algorithm); null when the edit distance exceeds `MAX_EDIT_DISTANCE`.
 */
function commonRuns(a: readonly Token[], b: readonly Token[]): Array<readonly [number, number, number]> | null {
  const n = a.length;
  const m = b.length;
  // trace[d][k + d] = the furthest x on diagonal k after d edits.
  const trace: Int32Array[] = [];
  let last: Int32Array | undefined;
  for (let d = 0; d <= Math.min(n + m, MAX_EDIT_DISTANCE); d++) {
    const current = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      const at = (diagonal: number) => last![diagonal + d - 1];
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && at(k - 1) < at(k + 1))) x = at(k + 1);
      else x = at(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && sameToken(a[x], b[y])) {
        x++;
        y++;
      }
      current[k + d] = x;
      if (x >= n && y >= m) {
        trace.push(current);
        return backtrack(trace, n, m);
      }
    }
    trace.push(current);
    last = current;
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): Array<readonly [number, number, number]> {
  const runs: Array<readonly [number, number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const previous = trace[d - 1];
    const at = (diagonal: number) => previous[diagonal + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    const snakeX = down ? previousX : previousX + 1;
    const snakeY = down ? previousY + 1 : previousY;
    if (x > snakeX) runs.push([snakeX, snakeY, x - snakeX]);
    x = previousX;
    y = previousY;
  }
  if (x > 0) runs.push([0, 0, x]);
  return runs.reverse();
}
