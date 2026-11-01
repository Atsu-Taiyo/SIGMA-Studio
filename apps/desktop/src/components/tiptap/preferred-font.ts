import { DEFAULT_BODY_FONT_FAMILY } from "@/features/document";
import type { Editor } from "@tiptap/core";
import { readProblemFontFamily, resolveBoxFontContext } from "./text-format-controller";

/** Arm an unformatted empty paragraph; the next input writes the font into SigmaDoc. */
export function applyPreferredFontToEmptyParagraph(editor: Editor, fontFamily: string | undefined): void {
  if (!fontFamily || fontFamily === DEFAULT_BODY_FONT_FAMILY || editor.isDestroyed || !editor.isEditable) return;
  const { selection, storedMarks } = editor.state;
  if (!selection.empty || selection.$from.parent.type.name !== "paragraph" || selection.$from.parent.content.size !== 0) return;
  if (storedMarks?.some((mark) => mark.type.name === "styledText" && mark.attrs.fontFamily)) return;
  const frame = resolveBoxFontContext(editor.state);
  if (frame.inBoxTitle ? frame.titleFontFamily : frame.bodyFontFamily) return;
  // 書体を決めた問題の中では、その書体で書く。好みの書体で上書きしない。
  if (readProblemFontFamily(editor.view.dom)) return;
  editor.chain().command(({ tr }) => {
    tr.setMeta("addToHistory", false);
    return true;
  }).setFontFamily(fontFamily).run();
}
