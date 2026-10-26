import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import {
  defaultListIndentEm,
  LIST_INDENT_CSS_VARIABLE,
  normalizeListIndentEm,
  normalizeOrderedListMarkerStyle,
} from "@/features/document";

const LIST_NODE_NAMES = new Set(["bulletList", "orderedList"]);

export interface ListIndentTarget {
  /** リストの直前の位置 (`setNodeMarkup` に渡す)。 */
  pos: number;
  node: ProseMirrorNode;
}

/** キャレットを含むいちばん内側のリスト。選択がリストをまたぐときは選択の始点側。 */
export function findListIndentTarget($from: ResolvedPos): ListIndentTarget | null {
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (LIST_NODE_NAMES.has(node.type.name)) {
      return { pos: $from.before(depth), node };
    }
  }
  return null;
}

/** そのリストの既定の字下げ (`indentEm` が無いときに描かれる値)。 */
export function defaultListIndentEmForNode(node: ProseMirrorNode): number {
  return node.type.name === "orderedList"
    ? defaultListIndentEm("ordered", normalizeOrderedListMarkerStyle(node.attrs.markerStyle))
    : defaultListIndentEm("bullet");
}

/** 描かれている字下げ。保存値が無ければ既定。 */
export function listIndentEmForNode(node: ProseMirrorNode): number {
  return normalizeListIndentEm(node.attrs.indentEm) ?? defaultListIndentEmForNode(node);
}

interface ListIndentPreview {
  pos: number;
  indentEm: number;
}

const listIndentPreviewKey = new PluginKey<ListIndentPreview | null>("listIndentPreview");

/**
 * つまみを引いている間の見た目。文書は変えず、そのリストに字下げの変数だけを node decoration で
 * 重ねる — 引くたびに文書を変えると、毎フレーム SigmaDoc への同期と保存が走る。離したときに
 * `commitListIndent` が 1 回だけ文書へ書く (元に戻す 1 回分)。
 */
export function setListIndentPreview(tr: Transaction, preview: ListIndentPreview | null): Transaction {
  return tr.setMeta(listIndentPreviewKey, preview).setMeta("addToHistory", false);
}

/** 字下げを文書へ書く。既定と同じ値は書かない (マーカー形式を変えたとき既定に追従させる)。 */
export function commitListIndent(state: EditorState, target: ListIndentTarget, indentEm: number | null): Transaction {
  const normalized = indentEm === null ? undefined : normalizeListIndentEm(indentEm);
  const value = normalized === undefined || normalized === defaultListIndentEmForNode(target.node) ? null : normalized;
  return state.tr
    .setNodeMarkup(target.pos, undefined, { ...target.node.attrs, indentEm: value })
    .setMeta(listIndentPreviewKey, null);
}

export const ListIndentExtension = Extension.create({
  name: "listIndent",

  addProseMirrorPlugins() {
    return [
      new Plugin<ListIndentPreview | null>({
        key: listIndentPreviewKey,
        state: {
          init: () => null,
          apply: (tr, value) => {
            const meta = tr.getMeta(listIndentPreviewKey) as ListIndentPreview | null | undefined;
            if (meta !== undefined) {
              return meta;
            }
            // 引いている途中に文書が変わったら (共同編集・AI) 見た目だけの重ねは捨てる。
            return tr.docChanged ? null : value;
          },
        },
        props: {
          decorations: (state) => {
            const preview = listIndentPreviewKey.getState(state);
            const node = preview ? state.doc.nodeAt(preview.pos) : null;
            if (!preview || !node || !LIST_NODE_NAMES.has(node.type.name)) {
              return null;
            }
            return DecorationSet.create(state.doc, [
              Decoration.node(preview.pos, preview.pos + node.nodeSize, {
                style: `${LIST_INDENT_CSS_VARIABLE}: ${preview.indentEm}em`,
              }),
            ]);
          },
        },
      }),
    ];
  },
});
