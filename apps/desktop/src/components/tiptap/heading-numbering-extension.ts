import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface HeadingNumberingOptions {
  getNumbers: () => Readonly<Record<string, string>>;
  getLayoutKey: (blockId: string) => string;
}

export const headingNumberingKey = new PluginKey<DecorationSet>("headingNumbering");

export function createHeadingNumberingDecorations(
  doc: ProseMirrorNode,
  numbers: Readonly<Record<string, string>>,
  getLayoutKey: (blockId: string) => string = () => "flow",
): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    const sourceType = node.attrs.sigmaDocType;
    if (
      node.type.name !== "heading"
      || (sourceType && sourceType !== "heading" && sourceType !== "section")
    ) {
      return !node.isTextblock && !node.isLeaf;
    }
    const blockId = typeof node.attrs.sigmaDocId === "string" ? node.attrs.sigmaDocId : "";
    const number = blockId && Object.hasOwn(numbers, blockId) ? numbers[blockId] : undefined;
    if (!number) {
      return false;
    }
    const layoutKey = getLayoutKey(blockId);
    decorations.push(Decoration.widget(pos + 1, () => createHeadingNumberPrefix(number), {
      blockId,
      key: `heading-number-${blockId}-${number}-${layoutKey}`,
      side: -1,
    }));
    return false;
  });
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

export function shouldRebuildHeadingNumberingDecorations(transaction: Transaction): boolean {
  return transaction.docChanged || transaction.getMeta(headingNumberingKey) !== undefined;
}

function createHeadingNumberPrefix(number: string): HTMLElement {
  const prefix = document.createElement("span");
  prefix.className = "heading-number-prefix";
  prefix.contentEditable = "false";
  prefix.setAttribute("data-heading-number", number);
  prefix.textContent = `${number} `;
  return prefix;
}

export const HeadingNumberingExtension = Extension.create<HeadingNumberingOptions>({
  name: "headingNumbering",

  addOptions() {
    return {
      getNumbers: () => ({}),
      getLayoutKey: () => "flow",
    };
  },

  addProseMirrorPlugins() {
    const build = (doc: ProseMirrorNode) => createHeadingNumberingDecorations(
      doc,
      this.options.getNumbers(),
      this.options.getLayoutKey,
    );
    return [new Plugin<DecorationSet>({
      key: headingNumberingKey,
      state: {
        init: (_config, state) => build(state.doc),
        apply: (transaction, previous) => shouldRebuildHeadingNumberingDecorations(transaction)
          ? build(transaction.doc)
          : previous,
      },
      props: {
        decorations: (state) => headingNumberingKey.getState(state) ?? DecorationSet.empty,
      },
    })];
  },
});
