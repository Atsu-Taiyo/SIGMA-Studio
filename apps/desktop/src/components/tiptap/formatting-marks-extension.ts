import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface FormattingMarksOptions {
  /** Non-empty when this editor shows the empty-document CSS placeholder. */
  getPlaceholder: () => string;
}

/** Editing decorations only: absent from clipboard serialization and SigmaDoc. */
export const FormattingMarksExtension = Extension.create<FormattingMarksOptions>({
  name: "formattingMarks",
  addOptions() {
    return { getPlaceholder: () => "" };
  },
  addProseMirrorPlugins() {
    const getPlaceholder = () => this.options.getPlaceholder();
    return [new Plugin({
      props: {
        decorations: (state) => createFormattingMarkDecorations(state.doc, getPlaceholder),
      },
    })];
  },
});

export function createFormattingMarkDecorations(
  doc: ProseMirrorNode,
  getPlaceholder: () => string = () => "",
): DecorationSet {
  const marks: Decoration[] = [];
  const placeholder = getPlaceholder();
  const mark = (pos: number, kind: "paragraph" | "line") => {
    // 入力は記号より前に置く。side: -1 だと末尾への打鍵が記号の後ろへ入り、
    // 次の装飾更新が合成中のDOMを分断して IME 確定や矢印移動を妨げる。
    marks.push(Decoration.widget(pos, () => {
      const span = document.createElement("span");
      span.className = "text-formatting-mark";
      span.dataset.formattingMark = kind;
      span.setAttribute("aria-hidden", "true");
      span.contentEditable = "false";
      return span;
    }, { side: 1, key: `formatting-${kind}-${pos}` }));
  };
  doc.descendants((node, pos) => {
    if (node.type.name === "hardBreak") {
      mark(pos, "line");
      return;
    }
    if (node.type.name !== "paragraph" && node.type.name !== "heading") {
      return;
    }
    if (shouldHideParagraphFormattingMark(doc, node, placeholder)) {
      return;
    }
    mark(pos + node.nodeSize - 1, "paragraph");
  });
  return DecorationSet.create(doc, marks);
}

export function shouldHideParagraphFormattingMark(
  doc: ProseMirrorNode,
  node: ProseMirrorNode,
  placeholder: string,
): boolean {
  return placeholder.length > 0 && isEmptyEditorPlaceholderParagraph(doc, node);
}

function isEmptyEditorPlaceholderParagraph(doc: ProseMirrorNode, node: ProseMirrorNode): boolean {
  return node.type.name === "paragraph"
    && node.content.size === 0
    && doc.firstChild === node
    && !docHasVisibleText(doc);
}

function docHasVisibleText(doc: ProseMirrorNode): boolean {
  let hasText = false;
  doc.descendants((node) => {
    if (node.isText && (node.text?.length ?? 0) > 0) {
      hasText = true;
      return false;
    }
    if (node.type.name === "hardBreak") {
      hasText = true;
      return false;
    }
    return true;
  });
  return hasText;
}
