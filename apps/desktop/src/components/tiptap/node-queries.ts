import type { EditorState } from "@tiptap/pm/state";

export function findAncestorNodeDepth(
  position: EditorState["selection"]["$from"],
  nodeTypeName: string,
): number {
  for (let depth = position.depth; depth > 0; depth -= 1) {
    if (position.node(depth).type.name === nodeTypeName) {
      return depth;
    }
  }
  return -1;
}

/** 箱のタイトル欄 (タイトルとサブタイトル)。どちらもインラインだけを持つ見出しで、扱いは同じ。 */
export function isBoxTitleNodeName(name: string): boolean {
  return name === "boxBlockTitle" || name === "boxBlockSubtitle";
}

/** キャレット位置の祖先にあるタイトル欄の深さ。無ければ -1。 */
export function findBoxTitleAncestorDepth(position: EditorState["selection"]["$from"]): number {
  for (let depth = position.depth; depth > 0; depth -= 1) {
    if (isBoxTitleNodeName(position.node(depth).type.name)) {
      return depth;
    }
  }
  return -1;
}

export function isEmptyEditorTextBlock(node: EditorState["doc"]): boolean {
  if (node.content.size === 0) {
    return true;
  }

  let hasNonTextInline = false;
  node.descendants((child) => {
    if (child.type.name !== "text") {
      hasNonTextInline = true;
      return false;
    }
    return undefined;
  });

  return !hasNonTextInline && node.textContent.trim().length === 0;
}
