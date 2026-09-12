import { resolveDocumentFontFamily, type InlineNode } from "@/features/document";

import {
  annotateBoxedInlineRuns,
  type AnnotatedInlineNode,
  type BoxedInlineRunSegment,
} from "./boxed-inline-runs";

/**
 * Framework- and output-format-neutral rich-text model.
 *
 * Canonical SigmaDoc inline content is converted here. Format adapters own
 * Tiptap conversion, HTML escaping, element names, and math markup.
 */

export interface RichTextRenderStyle {
  backgroundColor?: string;
  color?: string;
  fontFamily?: string;
  fontSizePt?: number;
  fontStyle?: string;
  fontWeight?: string;
  textDecoration?: string;
}

export interface RichTextBoxDecoration {
  connectLeft?: boolean;
  connectRight?: boolean;
  math?: boolean;
  paddingY?: number;
  run?: BoxedInlineRunSegment;
  tone?: string;
  type: "box";
  variant?: string;
}

export type RichTextRenderDecoration =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "underline" }
  | { style: RichTextRenderStyle; type: "style" }
  | RichTextBoxDecoration;

export type RichTextInlineRenderNode =
  | {
      decorations: RichTextRenderDecoration[];
      kind: "text";
      sourceIndex?: number;
      text: string;
    }
  | {
      decorations: RichTextRenderDecoration[];
      id: string;
      kind: "math";
      sourceIndex?: number;
      tex: string;
    };

export interface RichTextRenderFragment {
  children: RichTextRenderNode[];
  kind: "fragment";
}

export interface RichTextInlineRenderFragment {
  children: RichTextInlineRenderNode[];
  kind: "fragment";
}

export type RichTextRenderNode =
  | RichTextRenderFragment
  | {
      blockType: "heading" | "paragraph";
      children: RichTextRenderNode[];
      headingLevel?: 1 | 2 | 3;
      /**
       * The block draws no glyph, so a static renderer has to emit an explicit line-box
       * placeholder for it. Both renderers read this instead of guessing from their own output —
       * "serialized to an empty string" and "every child is empty text" disagree for a block that
       * only holds an empty styled run.
       */
      isBlank?: boolean;
      kind: "block";
      lineHeight?: string;
      textAlign?: "center" | "justify" | "left" | "right";
    }
  | RichTextInlineRenderNode
  | {
      kind: "lineBreak";
    };

export interface InlineNodesRenderModelOptions {
  annotateBoxedRuns?: boolean;
  runIdPrefix?: string;
}

/** Converts canonical SigmaDoc inline nodes into the shared render model. */
export function createInlineNodesRenderModel(
  children: readonly InlineNode[],
  options: InlineNodesRenderModelOptions = {},
): RichTextInlineRenderFragment {
  const entries: AnnotatedInlineNode[] = options.annotateBoxedRuns
    ? annotateBoxedInlineRuns(children, { runIdPrefix: options.runIdPrefix })
    : children.map((node, index) => ({ index, node }));
  return {
    kind: "fragment",
    children: entries.map(({ boxedRun, index, node }) => createInlineNodeRenderModel(node, index, boxedRun)),
  };
}

export function createRichTextBoxDecoration(
  paddingYValue: unknown,
  math: boolean,
  boxedRun?: BoxedInlineRunSegment,
  variantValue?: unknown,
  toneValue?: unknown,
): RichTextBoxDecoration {
  const paddingY = normalizeNonnegativeNumber(paddingYValue);
  return {
    type: "box",
    ...(paddingY !== undefined ? { paddingY } : {}),
    math,
    connectLeft: boxedRun?.connectLeft,
    connectRight: boxedRun?.connectRight,
    run: boxedRun,
    variant: typeof variantValue === "string" ? variantValue : undefined,
    tone: typeof toneValue === "string" ? toneValue : undefined,
  };
}

function createInlineNodeRenderModel(
  child: InlineNode,
  sourceIndex: number,
  boxedRun?: BoxedInlineRunSegment,
): RichTextInlineRenderNode {
  const style = inlineNodeStyle(child);

  if (child.type === "mathInline") {
    const decorations: RichTextRenderDecoration[] = [];
    if (style) {
      decorations.push({ type: "style", style });
    }
    if (child.marks?.includes("underline")) {
      decorations.push({ type: "underline" });
    }
    if (child.marks?.includes("boxed")) {
      decorations.push(createRichTextBoxDecoration(
        child.boxedPaddingY,
        true,
        boxedRun,
        child.boxedVariant,
        child.boxedTone,
      ));
    }
    return {
      kind: "math",
      id: child.id,
      tex: child.tex,
      decorations,
      sourceIndex,
    };
  }

  const decorations: RichTextRenderDecoration[] = (child.marks ?? []).flatMap((mark): RichTextRenderDecoration[] => {
    if (mark === "bold" || mark === "italic" || mark === "underline") {
      return [{ type: mark }];
    }
    if (mark === "boxed") {
      return [createRichTextBoxDecoration(
        child.boxedPaddingY,
        false,
        boxedRun,
        child.boxedVariant,
        child.boxedTone,
      )];
    }
    return [];
  });
  if (style) {
    decorations.push({ type: "style", style });
  }
  return {
    kind: "text",
    text: child.text,
    decorations,
    sourceIndex,
  };
}

function inlineNodeStyle(child: InlineNode): RichTextRenderStyle | undefined {
  const fontSizePt = typeof child.fontSize === "number" && Number.isFinite(child.fontSize)
    ? child.fontSize
    : undefined;
  const style = {
    backgroundColor: child.backgroundColor,
    color: child.color,
    fontFamily: resolveDocumentFontFamily(child.fontFamily),
    fontSizePt,
  };
  return Object.values(style).some((value) => value !== undefined) ? style : undefined;
}

function normalizeNonnegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
