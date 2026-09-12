import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { CODE_BLOCK_NODE_NAME } from "@/components/tiptap/body-block-extensions";
import { codeHighlightRanges, normalizeCodeLanguage } from "@/features/rendering/adapters";

import { countDecorationBlockWalk } from "./decoration-walk-metrics";

/**
 * コードブロックの色分けを ProseMirror の装飾として出す。
 *
 * **文書には何も書かない。** 色は本文と言語から毎回引き直す派生値で、リストマーカーの
 * 字体継承と同じ考え方。静的描画 (TextFlowStaticBlock) は同じ `codeHighlightRanges` を
 * 呼ぶので、編集中と印刷で色の付く範囲が食い違うことがない。
 *
 * 位置合わせの肝は `textBetween` の leafText。改行は `hardBreak` ノード (サイズ 1) で持つので
 * 1 文字として写し、数式などの atom も 1 文字として写す。こうすると **文字列の添字と PM の
 * ブロック内オフセットが 1 対 1 で一致する**ので、トークンの長さをそのまま位置に使える。
 */

/** hardBreak を写す 1 文字。実際の改行文字にしておくと、言語判定も行を認識できる。 */
const LINE_BREAK_CHAR = "\n";
/** 数式などの atom を写す 1 文字。コードの中で色を持たない「何か」を表す。 */
const ATOM_CHAR = "￼";

export function createCodeHighlightDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];

  countDecorationBlockWalk();
  doc.descendants((node, pos) => {
    if (node.type.name !== CODE_BLOCK_NODE_NAME) {
      // テキストブロックの中には入らない。打鍵のたびに inline を全部走るのが、
      // このエディタを重くしていた原因だった。
      return !node.isTextblock && !node.isLeaf;
    }

    const code = codeBlockText(node);
    const language = normalizeCodeLanguage(node.attrs.language);
    const contentStart = pos + 1;
    for (const range of codeHighlightRanges(code, language)) {
      decorations.push(Decoration.inline(
        contentStart + range.from,
        contentStart + range.to,
        { class: range.className },
      ));
    }
    return false;
  });

  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/** ブロックの中身を、PM のオフセットと 1 対 1 で対応する文字列にする。 */
export function codeBlockText(node: ProseMirrorNode): string {
  return node.textBetween(0, node.content.size, LINE_BREAK_CHAR, (leaf) => (
    leaf.type.name === "hardBreak" ? LINE_BREAK_CHAR : ATOM_CHAR
  ));
}

const codeHighlightPluginKey = new PluginKey<DecorationSet>("codeHighlight");

export const CodeHighlightExtension = Extension.create({
  name: "codeHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: codeHighlightPluginKey,
        state: {
          init: (_config, state) => createCodeHighlightDecorations(state.doc),
          // `props.decorations` は毎更新で呼ばれるので、集合は plugin state に置いて
          // 文書が実際に変わったときだけ組み直す (list-marker-typography と同じ形)。
          apply: (transaction, previous) => (
            transaction.docChanged
              ? createCodeHighlightDecorations(transaction.doc)
              : previous
          ),
        },
        props: {
          decorations: (state) => codeHighlightPluginKey.getState(state) ?? DecorationSet.empty,
        },
      }),
    ];
  },
});
