import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorModelNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { countDecorationBlockWalk } from "./decoration-walk-metrics";

import {
  EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT,
  getTextRangeForBlock,
} from "@/features/text-editing";
import type { SigmaTextRangeCommentAnchor } from "@/features/document";

export {
  EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT,
  getTextRangeForBlock,
} from "@/features/text-editing";

const externalTextRangeHighlightKey = new PluginKey<{ anchors: SigmaTextRangeCommentAnchor[] }>(
  "externalTextRangeHighlight",
);

/**
 * Highlights host-owned text ranges without teaching the reusable text editor
 * why those ranges are important. The host controls them through one event.
 */
export const ExternalTextRangeHighlightExtension = Extension.create({
  name: "externalTextRangeHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: externalTextRangeHighlightKey,
        state: {
          init: () => ({ anchors: [] as SigmaTextRangeCommentAnchor[] }),
          apply(transaction, previous) {
            const anchors = transaction.getMeta(externalTextRangeHighlightKey);
            return Array.isArray(anchors)
              ? { anchors: anchors as SigmaTextRangeCommentAnchor[] }
              : previous;
          },
        },
        props: {
          decorations(state) {
            const anchors = externalTextRangeHighlightKey.getState(state)?.anchors ?? [];
            if (anchors.length === 0) {
              return DecorationSet.empty;
            }

            const blockIds: string[] = [];
            countDecorationBlockWalk();
            state.doc.descendants((node) => {
              if (node.type.name !== "paragraph" && node.type.name !== "heading") {
                // 入れ子のブロックには降りるが、textblock の中身 (テキスト・数式) には用が無い。
                return !node.isTextblock && !node.isLeaf;
              }
              const blockId = typeof node.attrs.sigmaDocId === "string" ? node.attrs.sigmaDocId : "";
              if (blockId) {
                blockIds.push(blockId);
              }
              return false;
            });
            const order = new Map(blockIds.map((id, index) => [id, index]));
            const decorations: Decoration[] = [];
            countDecorationBlockWalk();
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "paragraph" && node.type.name !== "heading") {
                return !node.isTextblock && !node.isLeaf;
              }
              const blockId = typeof node.attrs.sigmaDocId === "string" ? node.attrs.sigmaDocId : "";
              if (!blockId) {
                return false;
              }
              for (const anchor of anchors) {
                const range = getTextRangeForBlock(anchor, blockId, order, getPlainTextBlockLength(node));
                if (range) {
                  // 中身の走査は範囲装飾の生成側が自分で行う (このブロックの中だけ)。
                  decorations.push(...createExternalTextRangeDecorations(node, pos, range.from, range.to));
                }
              }
              return false;
            });
            return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
          },
        },
        view(view) {
          const listener = (event: Event) => {
            const detail = event instanceof CustomEvent ? event.detail?.anchors : null;
            const anchors = Array.isArray(detail)
              ? (detail as SigmaTextRangeCommentAnchor[]).filter(
                  (anchor) => anchor && typeof anchor === "object" && anchor.type === "textRange",
                )
              : [];
            view.dispatch(view.state.tr.setMeta(externalTextRangeHighlightKey, anchors));
          };

          window.addEventListener(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT, listener);
          return {
            destroy() {
              window.removeEventListener(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT, listener);
            },
          };
        },
      }),
    ];
  },
});

export function getPlainTextBlockLength(node: ProseMirrorModelNode): number {
  let length = 0;
  node.descendants((child) => {
    if (child.type.name === "text" || child.type.name === "mathInline") {
      length += getPlainTextInlineLength(child);
    }
  });
  return length;
}

function createExternalTextRangeDecorations(
  node: ProseMirrorModelNode,
  blockPos: number,
  fromOffset: number,
  toOffset: number,
): Decoration[] {
  if (toOffset <= fromOffset) {
    return [];
  }

  const decorations: Decoration[] = [];
  let cursor = 0;
  node.descendants((child, childPos) => {
    if (child.type.name !== "text" && child.type.name !== "mathInline") {
      return undefined;
    }
    const length = getPlainTextInlineLength(child);
    const inlineStart = cursor;
    const inlineEnd = cursor + length;
    cursor = inlineEnd;
    const overlapStart = Math.max(fromOffset, inlineStart);
    const overlapEnd = Math.min(toOffset, inlineEnd);
    if (overlapEnd <= overlapStart) {
      return undefined;
    }

    const absoluteStart = blockPos + 1 + childPos;
    if (child.type.name === "mathInline") {
      decorations.push(Decoration.node(absoluteStart, absoluteStart + child.nodeSize, {
        class: "external-text-range-inline-math-highlight",
      }));
      return false;
    }
    decorations.push(Decoration.inline(
      absoluteStart + (overlapStart - inlineStart),
      absoluteStart + (overlapEnd - inlineStart),
      { class: "external-text-range-highlight" },
    ));
    return undefined;
  });
  return decorations;
}

function getPlainTextInlineLength(node: ProseMirrorModelNode): number {
  if (node.type.name === "mathInline") {
    const tex = typeof node.attrs.tex === "string" ? node.attrs.tex : "";
    return tex ? tex.length + 2 : 1;
  }
  const text = typeof node.text === "string" ? node.text : node.textContent;
  return text.length;
}
