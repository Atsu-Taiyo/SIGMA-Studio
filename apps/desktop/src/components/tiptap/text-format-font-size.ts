import type { EditorView } from "@tiptap/pm/view";
import type { Mark } from "@tiptap/pm/model";

import { pxToPt } from "@/features/document/overlay-text-font";

export interface SelectionFontSize {
  /** The first effective size; mixed selections retain a numeric stepping origin. */
  fontSize: number | null;
  fontSizeMixed: boolean;
}

/** Read the rendered inheritance without writing explicit sizes into SigmaDoc. */
export function readSelectionFontSize(
  view: EditorView,
  range: { from: number; to: number } = view.state.selection,
): SelectionFontSize {
  const { state } = view;
  const styleCache = new Map<Element, number | null>();
  const readSize = (pos: number, marks: readonly Mark[], caret = false): number | null => {
    const size = marks.find((mark) => mark.type.name === "styledText")?.attrs.fontSize;
    if (typeof size === "number" && Number.isFinite(size) && size > 0) return size;

    // nodeDOM gives the run wrapper (including MathLive's outer node), not KaTeX's
    // internally scaled glyphs. At a caret, domAtPos also handles empty paragraphs.
    const at = view.domAtPos(pos, 1);
    const node = caret
      ? (at.node.nodeType === 3 ? at.node : at.node.childNodes[at.offset] ?? at.node)
      : view.nodeDOM(pos) ?? at.node;
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    if (!element) return null;
    if (!styleCache.has(element)) {
      const px = Number.parseFloat(view.dom.ownerDocument.defaultView!.getComputedStyle(element).fontSize);
      styleCache.set(element, Number.isFinite(px) && px > 0 ? pxToPt(px) : null);
    }
    return styleCache.get(element) ?? null;
  };

  if (range.from === range.to) {
    const $pos = state.doc.resolve(range.from);
    return {
      fontSize: readSize(range.from, state.storedMarks ?? $pos.marks(), true),
      fontSizeMixed: false,
    };
  }

  let fontSize: number | null = null;
  let fontSizeMixed = false;
  state.doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (fontSizeMixed) return false;
    if (!node.isInline && !(node.isTextblock && node.childCount === 0)) return true;
    const current = readSize(pos, node.marks);
    if (current !== null) {
      if (fontSize === null) fontSize = current;
      else if (Math.abs(fontSize - current) > 0.001) fontSizeMixed = true;
    }
    return false;
  });
  return { fontSize, fontSizeMixed };
}
