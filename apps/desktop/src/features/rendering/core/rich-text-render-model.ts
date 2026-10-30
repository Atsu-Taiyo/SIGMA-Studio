import { resolveDocumentFontFamily, type InlineNode, type DocumentReference, type UnderlineStyle } from "@/features/document";

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
  letterSpacingPx?: number;
  fontKerning?: "auto" | "normal" | "none";
  /** CSS pixels; positive values raise the text baseline. */
  baselineShiftPx?: number;
  fontStyle?: string;
  fontWeight?: string;
  textDecoration?: string;
}

export interface RichTextBoxDecoration {
  connectLeft?: boolean;
  connectRight?: boolean;
  math?: boolean;
  paddingY?: number;
  /** Roundness of an `oval` box in percent; absent means the variant's full rounding. */
  roundness?: number;
  run?: BoxedInlineRunSegment;
  tone?: string;
  type: "box";
  variant?: string;
}

export type RichTextRenderDecoration =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "underline"; style?: UnderlineStyle }
  | { style: RichTextRenderStyle; type: "style" }
  | RichTextBoxDecoration;

export type RichTextInlineRenderNode =
  | {
      decorations: RichTextRenderDecoration[];
      kind: "text";
      reference?: DocumentReference;
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
  roundnessValue?: unknown,
): RichTextBoxDecoration {
  const paddingY = normalizeNonnegativeNumber(paddingYValue);
  const roundness = typeof roundnessValue === "number" ? roundnessValue : undefined;
  return {
    type: "box",
    ...(paddingY !== undefined ? { paddingY } : {}),
    math,
    connectLeft: boxedRun?.connectLeft,
    connectRight: boxedRun?.connectRight,
    run: boxedRun,
    variant: typeof variantValue === "string" ? variantValue : undefined,
    tone: typeof toneValue === "string" ? toneValue : undefined,
    ...(roundness !== undefined ? { roundness } : {}),
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
      decorations.push({ type: "underline", ...(child.underlineStyle ? { style: child.underlineStyle } : {}) });
    }
    if (child.marks?.includes("boxed")) {
      decorations.push(createRichTextBoxDecoration(
        child.boxedPaddingY,
        true,
        boxedRun,
        child.boxedVariant,
        child.boxedTone,
        child.boxedRoundness,
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
    if (mark === "underline") {
      return [{ type: mark, ...(child.underlineStyle ? { style: child.underlineStyle } : {}) }];
    }
    if (mark === "bold" || mark === "italic") {
      return [{ type: mark }];
    }
    if (mark === "boxed") {
      return [createRichTextBoxDecoration(
        child.boxedPaddingY,
        false,
        boxedRun,
        child.boxedVariant,
        child.boxedTone,
        child.boxedRoundness,
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
    ...(child.reference ? { reference: child.reference } : {}),
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
    baselineShiftPx: child.type === "text" ? child.baselineShiftPx : undefined,
    letterSpacingPx: child.type === "text" ? child.letterSpacingPx : undefined,
      fontKerning: child.type === "text" ? child.fontKerning : undefined,
  };
  return Object.values(style).some((value) => value !== undefined) ? style : undefined;
}

function normalizeNonnegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
