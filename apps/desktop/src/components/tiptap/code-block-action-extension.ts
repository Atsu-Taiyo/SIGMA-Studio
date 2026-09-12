import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { CODE_BLOCK_NODE_NAME } from "@/components/tiptap/body-block-extensions";

interface CodeBlockActionOptions {
  onOpen: (codeBlockId: string, button: HTMLButtonElement) => void;
  getLabel: () => string;
}

const codeBlockActionKey = new PluginKey<DecorationSet>("codeBlockAction");

/**
 * コード本文の外に状態を持たない操作ボタン。
 *
 * Widget は文書位置を消費せず、コピーや SigmaDoc 変換にも混ざらない。コード本文を包む別 DOM を
 * 作ると改ページ・断片化の計測原点が変わるため、既存の `<pre>` をそのまま保つこの形にする。
 */
export function createCodeBlockActionDecorations(
  doc: ProseMirrorNode,
  onOpen: CodeBlockActionOptions["onOpen"],
  getLabel: CodeBlockActionOptions["getLabel"] = () => "",
): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== CODE_BLOCK_NODE_NAME) {
      return !node.isTextblock && !node.isLeaf;
    }

    const codeBlockId = typeof node.attrs.sigmaDocId === "string" ? node.attrs.sigmaDocId : null;
    if (!codeBlockId) {
      return false;
    }

    decorations.push(Decoration.widget(pos + 1, () => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sigma-doc-block-action-button sigma-doc-code-action-button";
      button.dataset.codeBlockActionButton = "true";
      button.dataset.codeBlockId = codeBlockId;
      button.contentEditable = "false";
      const label = getLabel();
      button.title = label;
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-haspopup", "dialog");
      button.textContent = "⋯";
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(codeBlockId, button);
      });
      return button;
    }, {
      key: `code-block-action:${codeBlockId}`,
      side: -1,
      stopEvent: (event) => event.target instanceof Element
        && Boolean(event.target.closest("[data-code-block-action-button='true']")),
      ignoreSelection: true,
    }));

    return false;
  });

  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

export const CodeBlockActionExtension = Extension.create<CodeBlockActionOptions>({
  name: "codeBlockAction",

  addOptions() {
    return {
      onOpen: () => {},
      getLabel: () => "",
    };
  },

  addProseMirrorPlugins() {
    const onOpen = this.options.onOpen;
    const getLabel = this.options.getLabel;
    return [
      new Plugin<DecorationSet>({
        key: codeBlockActionKey,
        state: {
          init: (_config, state) => createCodeBlockActionDecorations(state.doc, onOpen, getLabel),
          apply: (transaction, previous) => transaction.docChanged
            ? createCodeBlockActionDecorations(transaction.doc, onOpen, getLabel)
            : previous,
        },
        props: {
          decorations: (state) => codeBlockActionKey.getState(state) ?? DecorationSet.empty,
        },
      }),
    ];
  },
});
