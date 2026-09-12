import { Extension, wrappingInputRule, type InputRule } from "@tiptap/core";
import type { Node as ProseMirrorNode, NodeType } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";

import { countDecorationBlockWalk } from "./decoration-walk-metrics";

import type { OrderedListMarkerStyle } from "@/features/document";

const ORDERED_LIST_NODE_NAME = "orderedList";
const LIST_ITEM_NODE_NAME = "listItem";

/**
 * The marker forms `(1)` style numbering understands, one row each.
 *
 * Adding a近い形式 (全角括弧 `（1）`, `1)` など) is one row here: the regex must capture the number
 * in group 1 and end with the whitespace that triggers the rule. `markerStyle` has to be a value the
 * SigmaDoc `ListNode` and `document-surface.css` already know, so a new form also needs one enum
 * value and one `@counter-style`.
 */
export const ORDERED_LIST_MARKER_INPUT_RULES: ReadonlyArray<{
  find: RegExp;
  markerStyle: OrderedListMarkerStyle;
}> = [
  { find: /^\((\d+)\)\s$/, markerStyle: "paren" },
];

/**
 * Built from the schema's `orderedList` type rather than read off `this.editor` so the rules can be
 * exercised without an editor view.
 */
export function createParenOrderedListInputRules(type: NodeType | undefined): InputRule[] {
  if (!type) {
    return [];
  }

  return ORDERED_LIST_MARKER_INPUT_RULES.map(({ find, markerStyle }) => wrappingInputRule({
    find,
    type,
    getAttributes: (match) => ({ start: Number(match[1]), markerStyle }),
    joinPredicate: (match, node) => node.attrs.markerStyle === markerStyle
      && node.childCount + node.attrs.start === Number(match[1]),
  }));
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
