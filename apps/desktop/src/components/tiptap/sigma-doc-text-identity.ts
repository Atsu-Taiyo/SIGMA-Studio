import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorModelNode } from "@tiptap/pm/model";
import { Plugin, type EditorState, type Transaction } from "@tiptap/pm/state";

import { idPrefixForTextNode } from "@/features/text-editing";
import { createId } from "@/lib/id";
import { countDecorationBlockWalk } from "./decoration-walk-metrics";
import { isEmptyEditorTextBlock } from "./node-queries";

export const SigmaDocTextIdentity = Extension.create({
  name: "sigmaDocTextIdentity",

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { state } = this.editor;
        const parent = state.selection.$from.parent;

        if (parent.type.name !== "heading") {
          return false;
        }

        const activeMarks = state.storedMarks ?? (
          state.selection.$to.parentOffset > 0
            ? state.selection.$from.marks()
            : null
        );
        const marks = activeMarks?.filter((mark) => (
          this.editor.extensionManager.splittableMarks.includes(mark.type.name)
        )) ?? null;

        return this.editor
          .chain()
          .splitBlock()
          .setParagraph()
          .updateAttributes("paragraph", {
            sigmaDocId: createId("p"),
            sigmaDocType: "paragraph",
          })
          // setParagraph / updateAttributes add node-markup steps after splitBlock has restored
          // the active marks. ProseMirror clears storedMarks for each added step, so restore them
          // once more at the end of this compound Enter command.
          .command(({ tr }) => {
            if (marks !== null) {
              tr.setStoredMarks(marks);
            }
            return true;
          })
          .run();
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: appendSigmaDocTextIdentityTransaction,
      }),
    ];
  },
});

export function appendSigmaDocTextIdentityTransaction(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  if (!transactions.some((transaction) => transaction.docChanged)) {
    return null;
  }

  const textNodes: Array<{
    node: ProseMirrorModelNode;
    pos: number;
    currentId: string;
    currentType: string;
    nextType: string;
  }> = [];

  // id を配るのは本文のブロック (段落/見出し/引用/コード/区切り線) だけ。その中身
  // (テキスト・数式) に降りても用は無いので降りない — 打鍵のたびに本文の全ノードを
  // 歩くのはここだった。
  //
  // 引用・コード・区切り線を外すと、PM のコマンド (`toggleQuoteBlock` 等) が作った
  // ノードが id 無しのまま残る。段組みのブロック配置は id で引くので、id が付くまで
  // そのブロックだけ配置されず「潰れた編集面 root の原点 = 1 ページ目上端」に取り残される。
  countDecorationBlockWalk();
  newState.doc.descendants((node, pos, parent, index) => {
    const typeName = node.type.name;
    const isIdentityTarget = typeName === "paragraph" || typeName === "heading"
      || typeName === "quote" || typeName === "codeBlock" || typeName === "divider";
    if (!isIdentityTarget) {
      // 入れ子のリスト項目や枠の中に段落があるので、構造には降り続ける。
      return !node.isTextblock && !node.isLeaf;
    }

    const currentType =
      typeof node.attrs.sigmaDocType === "string" ? node.attrs.sigmaDocType : typeName;
    const isListItemLead = parent?.type.name === "listItem" && index === 0;
    textNodes.push({
      node,
      pos,
      currentId: typeof node.attrs.sigmaDocId === "string" ? node.attrs.sigmaDocId : "",
      currentType,
      nextType: isListItemLead ? "listItem" : currentType === "section" && typeName === "heading" ? "section" : typeName,
    });
    // 引用は中に段落を持つ入れ物なので、中の id も配るために降り続ける。
    return typeName === "quote";
  });

  const textNodeCountById = new Map<string, number>();
  textNodes.forEach((entry) => {
    if (entry.currentId) {
      textNodeCountById.set(entry.currentId, (textNodeCountById.get(entry.currentId) ?? 0) + 1);
    }
  });
  const splitCreatedDuplicateId = [...textNodeCountById.values()].some((count) => count > 1);

  const keepIndexById = new Map<string, number>();
  textNodes.forEach((entry, index) => {
    if (!entry.currentId) {
      return;
    }

    const previousIndex = keepIndexById.get(entry.currentId);
    if (previousIndex === undefined) {
      keepIndexById.set(entry.currentId, index);
      return;
    }

    const previous = textNodes[previousIndex];
    // A manual-break owner anchors an editing surface. Keep its identity on
    // the leading empty half; moving it to the text tail would create another
    // surface for the boundary and temporarily remove that page from layout.
    if (isEmptyEditorTextBlock(previous.node) && !isEmptyEditorTextBlock(entry.node)
      && previous.node.attrs.pagination?.break !== true) {
      keepIndexById.set(entry.currentId, index);
    }
  });

  const usedIds = new Set<string>();
  const seenSourceIds = new Set<string>();
  const transaction = newState.tr;
  const marksBeforeSplit = oldState.selection.empty
    ? oldState.storedMarks ?? (
      oldState.selection.$from.parentOffset > 0
        ? oldState.selection.$from.marks().filter((mark) => mark.type.name !== "link")
        : null
    )
    : null;
  const storedMarks = newState.storedMarks ?? (splitCreatedDuplicateId ? marksBeforeSplit : null);
  let changed = false;

  textNodes.forEach((entry, index) => {
    const isSplitTail = Boolean(entry.currentId) && seenSourceIds.has(entry.currentId);
    seenSourceIds.add(entry.currentId);
    const shouldKeepCurrentId = Boolean(entry.currentId) &&
      keepIndexById.get(entry.currentId) === index &&
      !usedIds.has(entry.currentId);
    const nextId = shouldKeepCurrentId
      ? entry.currentId
      : createId(idPrefixForTextNode(entry.currentType, entry.node.type.name));

    usedIds.add(nextId);

    // PM copies attributes when splitting inside a paragraph. Remove the tail's
    // break before assigning fresh ids: the SigmaDoc adapter can no longer spot
    // duplicate ids after this transaction. The leading half owns the original
    // boundary id even when Enter makes that half empty.
    const clearSplitPagination = isSplitTail && entry.node.attrs.pagination != null;
    if (entry.currentId !== nextId || entry.node.attrs.sigmaDocType !== entry.nextType || clearSplitPagination) {
      transaction.setNodeMarkup(entry.pos, undefined, {
        ...entry.node.attrs,
        ...(clearSplitPagination ? { pagination: null } : {}),
        sigmaDocId: nextId,
        sigmaDocType: entry.nextType,
      });
      changed = true;
    }
  });

  // Splitting a block deliberately arms stored marks for the next typed character. Assigning a
  // fresh SigmaDoc id is metadata-only, but setNodeMarkup clears those marks unless restored.
  if (changed && storedMarks !== null) {
    transaction.setStoredMarks(storedMarks);
  }

  return changed ? transaction : null;
}
