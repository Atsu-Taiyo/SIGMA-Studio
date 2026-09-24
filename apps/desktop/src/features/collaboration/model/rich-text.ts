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
  for (const part of richText(fragment).toDelta()) {
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

/** Change only the edited interval; retain CRDT identities outside it and for formatting. */
export function patchRichFragment(
  fragment: Y.XmlFragment,
  nodes: readonly ObjectValue[],
): void {
  const text = richText(fragment);
  const before = tokens(readRichFragment(fragment));
  const after = tokens(nodes);
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    sameToken(before[start], after[start])
  )
    start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    sameToken(before[before.length - end - 1], after[after.length - end - 1])
  )
    end++;
  let offset = before
    .slice(0, start)
    .reduce((sum, token) => sum + token.length, 0);
  const removed = before
    .slice(start, before.length - end)
    .reduce((sum, token) => sum + token.length, 0);
  if (removed) text.delete(offset, removed);
  const inserted = after.slice(start, after.length - end);
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
  const actual = tokens(readRichFragment(fragment));
  const embeds = new Map<number, Y.Map<ObjectValue>>();
  let deltaOffset = 0;
  for (const part of text.toDelta()) {
    if (part.insert instanceof Y.Map) embeds.set(deltaOffset, part.insert);
    deltaOffset += typeof part.insert === "string" ? part.insert.length : 1;
  }
  offset = 0;
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
