import {
  type BoxedTone,
  type BoxedVariant,
  type HeadingNode,
  type InlineNode,
  type LineHeight,
  type OverlayTextBlock,
  type ParagraphNode,
  type TextAlign,
  type TextMark,
  normalizeLineHeight,
  resolveDocumentFontFamily,
} from "@/features/document";
import { parseCssFontSizeToPt } from "@/lib/font-size-units";
import { createId } from "@/lib/id";

export {
  inlineNodesToPlainText,
  overlayTextBlocksToInlineNodes,
  overlayRichTextInlinesToInlineNodes,
} from "@/features/document";

export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  content?: TiptapNode[];
  marks?: TiptapNode[];
}

export interface TiptapDoc extends TiptapNode {
  type: "doc";
  content: TiptapNode[];
}

export function toTiptap(block: ParagraphNode | HeadingNode): TiptapDoc {
  const nodeType = block.type === "heading" ? "heading" : "paragraph";
  const attrs = {
    ...(block.type === "heading" ? { level: block.level } : {}),
    ...(block.align ? { textAlign: block.align } : {}),
    ...(block.lineHeight ? { lineHeight: block.lineHeight } : {}),
  };

  return {
    type: "doc",
    content: [
      {
        type: nodeType,
        attrs: Object.keys(attrs).length ? attrs : undefined,
        content: inlineNodesToTiptapNodes(block.children),
      },
    ],
  };
}

export function fromTiptap(
  doc: TiptapDoc,
  previous: ParagraphNode | HeadingNode,
): ParagraphNode | HeadingNode {
  const firstBlock = doc.content?.[0];
  const children = tiptapNodesToInlineNodes(firstBlock?.content ?? []);

  if (previous.type === "heading") {
    const level = Number(firstBlock?.attrs?.level ?? previous.level);
    return {
      ...previous,
      level: level === 1 || level === 2 || level === 3 ? level : previous.level,
      align: normalizeTextAlign(firstBlock?.attrs?.textAlign) ?? previous.align,
      lineHeight: normalizeLineHeight(firstBlock?.attrs?.lineHeight) ?? previous.lineHeight,
      children,
    };
  }

  return {
    ...previous,
    align: normalizeTextAlign(firstBlock?.attrs?.textAlign) ?? previous.align,
    lineHeight: normalizeLineHeight(firstBlock?.attrs?.lineHeight) ?? previous.lineHeight,
    children,
  };
}

export function inlineNodesToTiptapDoc(
  children: InlineNode[],
  align?: TextAlign,
  lineHeight?: LineHeight,
): TiptapDoc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: {
          ...(align ? { textAlign: align } : {}),
          ...(lineHeight ? { lineHeight } : {}),
        },
        content: inlineNodesToTiptapNodes(children),
      },
    ],
  };
}

export function inlineNodesToOverlayTextBlocks(
  children: InlineNode[],
  align?: TextAlign,
  lineHeight?: LineHeight,
): OverlayTextBlock[] {
  return [{
    type: "paragraph",
    id: createId("p"),
    children,
    ...(align ? { align } : {}),
    ...(lineHeight ? { lineHeight } : {}),
  }];
}

function normalizeTextAlign(value: unknown): TextAlign | undefined {
  return value === "left" || value === "center" || value === "right" || value === "justify" ? value : undefined;
}

export function tiptapDocToInlineNodes(doc: TiptapDoc): InlineNode[] {
  return tiptapNodesToInlineNodes(doc.content?.[0]?.content ?? []);
}

export function inlineNodesToTiptapNodes(children: InlineNode[]): TiptapNode[] {
  return children.flatMap((child) => {
    if (child.type === "mathInline") {
      const marks = inlineMathMarksToTiptapMarks(child);
      return {
        type: "mathInline",
        attrs: {
          id: child.id,
          tex: child.tex,
        },
        ...(marks ? { marks } : {}),
      };
    }

    const marks: TiptapNode[] = child.marks?.map((mark) => {
      if (mark !== "boxed") {
        return { type: mark };
      }
      const attrs = boxedMarkAttrs(child);
      return Object.keys(attrs).length ? { type: mark, attrs } : { type: mark };
    }) ?? [];
    const fontSize = normalizeFontSize(child.fontSize);
    const fontFamily = resolveDocumentFontFamily(child.fontFamily);
    if (child.color || child.backgroundColor || fontFamily || fontSize) {
      marks.push({
        type: "styledText",
        attrs: {
          color: child.color,
          backgroundColor: child.backgroundColor,
          fontFamily,
          fontSize,
        },
      });
    }

    return textWithHardBreaksToTiptapNodes(child.text, marks);
  });
}

export function tiptapNodesToInlineNodes(nodes: TiptapNode[]): InlineNode[] {
  const result: InlineNode[] = [];

  for (const node of nodes) {
    if (node.type === "text" && node.text) {
      pushText(
        result,
        node.text,
        node.marks
          ?.map((mark) => mark.type)
          .filter((mark): mark is TextMark => mark === "bold" || mark === "italic" || mark === "underline" || mark === "boxed"),
        getStyledTextAttr(node, "color"),
        getStyledTextAttr(node, "backgroundColor"),
        getStyledTextAttr(node, "fontFamily"),
        getStyledTextFontSize(node),
        getBoxedTextPaddingY(node),
        getBoxedTextVariant(node),
        getBoxedTextTone(node),
      );
      continue;
    }

    if (node.type === "hardBreak") {
      const previous = result[result.length - 1];
      pushText(
        result,
        "\n",
        previous?.type === "text" ? previous.marks : undefined,
        previous?.type === "text" ? previous.color : undefined,
        previous?.type === "text" ? previous.backgroundColor : undefined,
        previous?.type === "text" ? previous.fontFamily : undefined,
        previous?.type === "text" ? previous.fontSize : undefined,
        previous?.type === "text" ? previous.boxedPaddingY : undefined,
        previous?.type === "text" ? previous.boxedVariant : undefined,
        previous?.type === "text" ? previous.boxedTone : undefined,
      );
      continue;
    }

    if (node.type === "mathInline") {
      const marks = getInlineMathMarks(node);
      const isBoxed = marks?.includes("boxed");
      const boxedPaddingY = isBoxed ? getBoxedTextPaddingY(node) : undefined;
      const boxedVariant = isBoxed ? getBoxedTextVariant(node) : undefined;
      const boxedTone = isBoxed ? getBoxedTextTone(node) : undefined;
      result.push({
        type: "mathInline",
        id: String(node.attrs?.id ?? `m_inline_${result.length}`),
        tex: String(node.attrs?.tex ?? ""),
        display: "inline",
        ...(marks ? { marks } : {}),
        ...(getStyledTextAttr(node, "color") ? { color: getStyledTextAttr(node, "color") } : {}),
        ...(getStyledTextAttr(node, "backgroundColor") ? { backgroundColor: getStyledTextAttr(node, "backgroundColor") } : {}),
        ...(getStyledTextAttr(node, "fontFamily") ? { fontFamily: getStyledTextAttr(node, "fontFamily") } : {}),
        ...(getStyledTextFontSize(node) ? { fontSize: getStyledTextFontSize(node) } : {}),
        ...(boxedPaddingY !== undefined ? { boxedPaddingY } : {}),
        ...(boxedVariant ? { boxedVariant } : {}),
        ...(boxedTone ? { boxedTone } : {}),
        semanticRole: "expression",
      });
      continue;
    }

    if (node.content?.length) {
      for (const child of tiptapNodesToInlineNodes(node.content)) {
        if (child.type === "text") {
          pushText(
            result,
            child.text,
            child.marks,
            child.color,
            child.backgroundColor,
            child.fontFamily,
            child.fontSize,
            child.boxedPaddingY,
            child.boxedVariant,
            child.boxedTone,
          );
        } else {
          result.push(child);
        }
      }
    }
  }

  return result;
}

function textWithHardBreaksToTiptapNodes(text: string, marks: TiptapNode[]): TiptapNode[] {
  const segments = text.split("\n");
  const result: TiptapNode[] = [];
  const renderedMarks = marks.length ? marks : undefined;

  segments.forEach((segment, index) => {
    if (index > 0) {
      result.push({ type: "hardBreak" });
    }
    if (segment.length > 0) {
      result.push({
        type: "text",
        text: segment,
        marks: renderedMarks,
      });
    }
  });

  return result;
}

function pushText(
  nodes: InlineNode[],
  text: string,
  marks?: TextMark[],
  color?: string,
  backgroundColor?: string,
  fontFamily?: string,
  fontSize?: number,
  boxedPaddingY?: number,
  boxedVariant?: BoxedVariant,
  boxedTone?: BoxedTone,
): void {
  const previous = nodes[nodes.length - 1];
  const normalizedMarks = marks?.length ? marks : undefined;
  const normalizedFontSize = normalizeFontSize(fontSize);
  const isBoxed = normalizedMarks?.includes("boxed");
  const normalizedBoxedPaddingY = isBoxed ? normalizeBoxedPaddingY(boxedPaddingY) : undefined;
  const normalizedBoxedVariant = isBoxed ? normalizeBoxedVariant(boxedVariant) : undefined;
  const normalizedBoxedTone = isBoxed ? normalizeBoxedTone(boxedTone) : undefined;
  if (
    previous?.type === "text" &&
    sameMarks(previous.marks, normalizedMarks) &&
    previous.color === color &&
    previous.backgroundColor === backgroundColor &&
    previous.fontFamily === fontFamily &&
    previous.fontSize === normalizedFontSize &&
    previous.boxedPaddingY === normalizedBoxedPaddingY &&
    previous.boxedVariant === normalizedBoxedVariant &&
    previous.boxedTone === normalizedBoxedTone
  ) {
    previous.text += text;
    return;
  }

  nodes.push({
    type: "text",
    text,
    ...(normalizedMarks ? { marks: normalizedMarks } : {}),
    ...(color ? { color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(fontFamily ? { fontFamily } : {}),
    ...(normalizedFontSize ? { fontSize: normalizedFontSize } : {}),
    ...(normalizedBoxedPaddingY !== undefined ? { boxedPaddingY: normalizedBoxedPaddingY } : {}),
    ...(normalizedBoxedVariant ? { boxedVariant: normalizedBoxedVariant } : {}),
    ...(normalizedBoxedTone ? { boxedTone: normalizedBoxedTone } : {}),
  });
}

function sameMarks(a?: TextMark[], b?: TextMark[]): boolean {
  return (a ?? []).join("|") === (b ?? []).join("|");
}

function getStyledTextAttr(node: TiptapNode, attr: "color" | "backgroundColor" | "fontFamily"): string | undefined {
  const mark = node.marks?.find((item) => item.type === "styledText");
  const value = mark?.attrs?.[attr];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getStyledTextFontSize(node: TiptapNode): number | undefined {
  const mark = node.marks?.find((item) => item.type === "styledText");
  return normalizeFontSize(mark?.attrs?.fontSize);
}

function getBoxedTextPaddingY(node: TiptapNode): number | undefined {
  const mark = node.marks?.find((item) => item.type === "boxed");
  return normalizeBoxedPaddingY(mark?.attrs?.paddingY);
}

function getBoxedTextVariant(node: TiptapNode): BoxedVariant | undefined {
  const mark = node.marks?.find((item) => item.type === "boxed");
  return normalizeBoxedVariant(mark?.attrs?.variant);
}

function getBoxedTextTone(node: TiptapNode): BoxedTone | undefined {
  const mark = node.marks?.find((item) => item.type === "boxed");
  return normalizeBoxedTone(mark?.attrs?.tone);
}

function getInlineMathMarks(node: TiptapNode): Array<Extract<TextMark, "underline" | "boxed">> | undefined {
  const marks = node.marks
    ?.map((mark) => mark.type)
    .filter((mark): mark is Extract<TextMark, "underline" | "boxed"> => mark === "underline" || mark === "boxed");
  return marks?.length ? marks : undefined;
}

function boxedMarkAttrs(node: {
  boxedPaddingY?: number;
  boxedVariant?: BoxedVariant;
  boxedTone?: BoxedTone;
}): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const paddingY = normalizeBoxedPaddingY(node.boxedPaddingY);
  if (paddingY !== undefined) {
    attrs.paddingY = paddingY;
  }
  const variant = normalizeBoxedVariant(node.boxedVariant);
  if (variant) {
    attrs.variant = variant;
  }
  const tone = normalizeBoxedTone(node.boxedTone);
  if (tone) {
    attrs.tone = tone;
  }
  return attrs;
}

function inlineMathMarksToTiptapMarks(node: Extract<InlineNode, { type: "mathInline" }>): TiptapNode[] | undefined {
  const marks: TiptapNode[] = [];
  const fontSize = normalizeFontSize(node.fontSize);
  const fontFamily = resolveDocumentFontFamily(node.fontFamily);
  if (node.color || node.backgroundColor || fontFamily || fontSize) {
    marks.push({
      type: "styledText",
      attrs: {
        color: node.color,
        backgroundColor: node.backgroundColor,
        fontFamily,
        fontSize,
      },
    });
  }
  if (node.marks?.includes("underline")) {
    marks.push({ type: "underline" });
  }
  if (node.marks?.includes("boxed")) {
    marks.push({
      type: "boxed",
      attrs: {
        ...boxedMarkAttrs(node),
        math: true,
      },
    });
  }
  return marks.length > 0 ? marks : undefined;
}

function normalizeFontSize(value: unknown): number | undefined {
  return parseCssFontSizeToPt(value);
}

function normalizeBoxedPaddingY(value: unknown): number | undefined {
  const paddingY = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(paddingY) && paddingY >= 0 ? Math.min(12, Math.round(paddingY * 10) / 10) : undefined;
}

function normalizeBoxedVariant(value: unknown): BoxedVariant | undefined {
  return value === "frame" || value === "thick" || value === "double" || value === "oval" || value === "shade"
    ? value
    : undefined;
}

function normalizeBoxedTone(value: unknown): BoxedTone | undefined {
  return value === "gray" || value === "blue" || value === "green" || value === "red" || value === "yellow"
    ? value
    : undefined;
}
