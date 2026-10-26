import { Extension, InputRule, wrappingInputRule } from "@tiptap/core";
import type { Node as ProseMirrorNode, NodeType } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";

import { countDecorationBlockWalk } from "./decoration-walk-metrics";

import type { OrderedListMarkerStyle } from "@/features/document";

const ORDERED_LIST_NODE_NAME = "orderedList";
const LIST_ITEM_NODE_NAME = "listItem";

/**
 * The marker forms `(1)` style numbering understands, one row each.
 *
 * `token` must match the whole text between the parentheses and `toNumber` reads the counter
 * value from it (`null` = this form does not apply). `markerStyle` has to be a value the SigmaDoc
 * `ListNode` and `document-surface.css` already know, so a new form also needs one enum value and
 * one `@counter-style`.
 */
export const ORDERED_LIST_MARKER_INPUT_RULES: ReadonlyArray<{
  markerStyle: OrderedListMarkerStyle;
  token: RegExp;
  toNumber: (token: string) => number | null;
}> = [
  { markerStyle: "paren", token: /^\d+$/, toNumber: (token) => Number(token) || null },
  { markerStyle: "parenLowerAlpha", token: /^[a-z]$/, toNumber: alphaValue },
  { markerStyle: "parenUpperAlpha", token: /^[A-Z]$/, toNumber: alphaValue },
  { markerStyle: "parenLowerRoman", token: /^[ivxlcdm]+$/, toNumber: romanValue },
  { markerStyle: "parenUpperRoman", token: /^[IVXLCDM]+$/, toNumber: romanValue },
];

/** 行頭の `(…) ` 全部をこの 1 本で拾い、どの形式かは `resolveOrderedListMarkerInput` が決める。 */
const ORDERED_LIST_MARKER_INPUT = /^\(([0-9]+|[a-z]+|[A-Z]+)\)\s$/;

function alphaValue(token: string): number {
  return token.toLowerCase().charCodeAt(0) - 96;
}

const ROMAN_NUMERAL = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;
const ROMAN_DIGITS: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

function romanValue(token: string): number | null {
  const lower = token.toLowerCase();
  if (!ROMAN_NUMERAL.test(lower)) {
    return null;
  }
  let value = 0;
  for (let index = 0; index < lower.length; index += 1) {
    const digit = ROMAN_DIGITS[lower[index]!]!;
    const next = ROMAN_DIGITS[lower[index + 1] ?? ""] ?? 0;
    value += digit < next ? -digit : digit;
  }
  return value || null;
}

function isRomanMarkerStyle(markerStyle: OrderedListMarkerStyle): boolean {
  return markerStyle === "parenLowerRoman" || markerStyle === "parenUpperRoman";
}

/**
 * `(c)` は英字の3番目にもローマ数字の100にも読める。決め方:
 * 1. 直前の番号付きリストの続き (同じ形式で次の番号) に読めるなら、その形式 — `(h)` の次の `(i)` は英字。
 * 2. 1文字なら `i` / `I` だけをローマ数字の始まりと読み、他は英字 — `(c)` から始めるローマ数字は無い。
 * 3. 2文字以上はローマ数字 (`(ii)`)。
 */
export function resolveOrderedListMarkerInput(
  token: string,
  previousList: ProseMirrorNode | null,
): { markerStyle: OrderedListMarkerStyle; start: number } | null {
  const candidates = ORDERED_LIST_MARKER_INPUT_RULES.flatMap((rule) => {
    const start = rule.token.test(token) ? rule.toNumber(token) : null;
    return start ? [{ markerStyle: rule.markerStyle, start }] : [];
  });
  if (previousList?.type.name === ORDERED_LIST_NODE_NAME) {
    const continuing = candidates.find((candidate) => (
      previousList.attrs.markerStyle === candidate.markerStyle
      && previousList.childCount + (previousList.attrs.start ?? 1) === candidate.start
    ));
    if (continuing) {
      return continuing;
    }
  }
  if (candidates.length < 2) {
    return candidates[0] ?? null;
  }
  const preferRoman = token.length > 1 || token.toLowerCase() === "i";
  return candidates.find((candidate) => isRomanMarkerStyle(candidate.markerStyle) === preferRoman) ?? candidates[0]!;
}

/**
 * Built from the schema's `orderedList` type rather than read off `this.editor` so the rules can be
 * exercised without an editor view.
 */
export function createParenOrderedListInputRules(type: NodeType | undefined): InputRule[] {
  if (!type) {
    return [];
  }

  return [new InputRule({
    find: ORDERED_LIST_MARKER_INPUT,
    handler: (props) => {
      const $from = props.state.doc.resolve(props.range.from);
      const previousList = $from.depth > 0 ? props.state.doc.resolve($from.before()).nodeBefore : null;
      const resolved = resolveOrderedListMarkerInput(props.match[1] ?? "", previousList);
      if (!resolved) {
        return null;
      }
      // 結合の判定は上で済んでいる (続きに読めた形式を選んだ) ので、同じ形式・続きの番号のときだけ繋ぐ。
      return wrappingInputRule({
        find: ORDERED_LIST_MARKER_INPUT,
        type,
        getAttributes: () => ({ start: resolved.start, markerStyle: resolved.markerStyle }),
        joinPredicate: (_match, node) => node.attrs.markerStyle === resolved.markerStyle
          && node.childCount + (node.attrs.start ?? 1) === resolved.start,
      }).handler(props);
    },
  })];
}

function nestedOrderedLists(
  list: ProseMirrorNode,
  listPos: number,
): Array<{ node: ProseMirrorNode; pos: number }> {
  const nested: Array<{ node: ProseMirrorNode; pos: number }> = [];
  list.forEach((item, itemOffset) => {
    if (item.type.name !== LIST_ITEM_NODE_NAME) {
      return;
    }
    const itemPos = listPos + 1 + itemOffset;
    item.forEach((child, childOffset) => {
      if (child.type.name === ORDERED_LIST_NODE_NAME) {
        nested.push({ node: child, pos: itemPos + 1 + childOffset });
      }
    });
  });
  return nested;
}

/**
 * `sinkListItem` (Tab) creates the nested `orderedList` with default attributes, so a child of a
 * `(1)` list would otherwise render as `1.`. The parent's marker style is therefore pushed down —
 * but **only into a nested list that has none of its own**. A nested list that already carries a
 * marker style was authored that way (pasted Markdown and AI proposals can nest a `(1)` list under
 * a `1.` parent), and overwriting it would silently rewrite the document.
 *
 * `setNodeMarkup` keeps node sizes, so positions taken from `state.doc` stay valid for the whole
 * pass, and a second pass over the normalized document finds nothing to do (no append loop).
 */
export function normalizeNestedOrderedListMarkerStyles(state: EditorState): Transaction | null {
  let transaction: Transaction | null = null;

  // 装飾ではないが、打鍵のたびに走る文書走査という点は同じなので同じ物差しで数える
  // (`decoration-walk-metrics.ts`)。
  countDecorationBlockWalk();
  state.doc.descendants((node, pos) => {
    // Textblocks and leaves cannot contain a list; not descending into them keeps this off the
    // per-keystroke cost of inline content in a long document.
    if (node.isTextblock || node.isLeaf) {
      return false;
    }
    if (node.type.name !== ORDERED_LIST_NODE_NAME) {
      return true;
    }

    const parentMarkerStyle = node.attrs.markerStyle ?? null;
    if (parentMarkerStyle === null) {
      return true;
    }

    for (const nested of nestedOrderedLists(node, pos)) {
      if ((nested.node.attrs.markerStyle ?? null) !== null) {
        continue;
      }
      transaction = (transaction ?? state.tr).setNodeMarkup(nested.pos, undefined, {
        ...nested.node.attrs,
        markerStyle: parentMarkerStyle,
      });
    }
    return true;
  });

  return transaction;
}

const parenOrderedListPluginKey = new PluginKey("parenOrderedListMarkerStyle");

/**
 * `(1) ` at the start of a line becomes an ordered list whose marker is drawn as `(1)`.
 *
 * The list stays `listType: "ordered"` in SigmaDoc — only `markerStyle` differs — so every existing
 * ordered-list branch keeps working and an untouched surface falls back to plain decimals.
 */
export const ParenOrderedListExtension = Extension.create({
  name: "parenOrderedList",

  addInputRules() {
    return createParenOrderedListInputRules(this.editor.schema.nodes[ORDERED_LIST_NODE_NAME]);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: parenOrderedListPluginKey,
        appendTransaction: (transactions, _oldState, newState) => (
          transactions.some((transaction) => transaction.docChanged)
            ? normalizeNestedOrderedListMarkerStyles(newState)
            : null
        ),
      }),
    ];
  },
});
