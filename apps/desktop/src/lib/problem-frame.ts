import {
  CUSTOM_FRAME_STYLE_ID,
  resolveCustomFrameMetrics,
  type CustomFrame,
  type ProblemFrame,
  type ProblemNode,
  type RichBlock,
  type SigmaBlock,
  type TikzImageSource,
} from "@/features/document";
import { applyCustomFrameDrawing, normalizeCustomFrameInput, type CustomFrameDrawing } from "@/lib/custom-frame";

export const DEFAULT_PROBLEM_FRAME_STYLE_ID = "fancybox";

export const PROBLEM_FRAME_STYLE_OPTIONS = [
  {
    id: "fancybox",
    commandName: "fancybox",
    labelKey: "problem.frameStyle.fancybox.label",
    descriptionKey: "problem.frameStyle.fancybox.description",
  },
  {
    id: "doublebox",
    commandName: "doublebox",
    labelKey: "problem.frameStyle.doublebox.label",
    descriptionKey: "problem.frameStyle.doublebox.description",
  },
  {
    id: "cornerbox",
    commandName: "cornerbox",
    labelKey: "problem.frameStyle.cornerbox.label",
    descriptionKey: "problem.frameStyle.cornerbox.description",
  },
] as const;

export type BuiltInProblemFrameStyleId = (typeof PROBLEM_FRAME_STYLE_OPTIONS)[number]["id"];
export type ProblemFrameStyleId = BuiltInProblemFrameStyleId | typeof CUSTOM_FRAME_STYLE_ID;
export { CUSTOM_FRAME_STYLE_ID };
export type ProblemFrameFragmentRole = "single" | "first" | "middle" | "last";

const PROBLEM_FRAME_STYLE_ID_SET = new Set<string>(
  PROBLEM_FRAME_STYLE_OPTIONS.map((option) => option.id),
);

export function normalizeProblemFrameStyleId(styleId: string | undefined): BuiltInProblemFrameStyleId {
  return PROBLEM_FRAME_STYLE_ID_SET.has(styleId ?? "")
    ? styleId as BuiltInProblemFrameStyleId
    : DEFAULT_PROBLEM_FRAME_STYLE_ID;
}

/**
 * `"custom"` only counts when the drawing is actually there; a frame that lost its artwork
 * (an older app, a hand-edited file) falls back to the default instead of drawing nothing.
 */
export function getProblemFrameStyleId(problem: Pick<ProblemNode, "frame">): ProblemFrameStyleId {
  return problem.frame?.styleId === CUSTOM_FRAME_STYLE_ID && problem.frame.custom
    ? CUSTOM_FRAME_STYLE_ID
    : normalizeProblemFrameStyleId(problem.frame?.styleId);
}

export function getProblemCustomFrame(problem: Pick<ProblemNode, "frame">): CustomFrame | undefined {
  return getProblemFrameStyleId(problem) === CUSTOM_FRAME_STYLE_ID ? problem.frame?.custom : undefined;
}

export function problemFrameClassName(baseClass: string, styleId: string | undefined): string {
  if (styleId === CUSTOM_FRAME_STYLE_ID) {
    return [baseClass, "problem-frame--custom"].join(" ");
  }
  const normalizedStyleId = normalizeProblemFrameStyleId(styleId);
  return [
    baseClass,
    "box-frame",
    normalizedStyleId === "doublebox" ? "box-frame--double-rule" : "",
    normalizedStyleId === "cornerbox" ? "problem-frame--bracket" : "",
  ].filter(Boolean).join(" ");
}

const PX_TO_MM = 25.4 / 96;

/**
 * A framed area normally gets its border/padding from CSS (`.with-frame` in
 * globals.css) laid out around the real content box. But when the area is split
 * by a manual break, its blocks are placed individually at bare (unpadded)
 * coordinates (see `column-block-flowed` in globals.css), and the border is drawn
 * as decorative overlay pieces instead — those pieces have no content of their
 * own, so they need this padding applied manually to reproduce the same visual
 * inset. Values mirror the `padding` declared for each `.with-frame` variant in
 * globals.css; keep them in sync if that CSS changes.
 */
export function getProblemFrameChromePaddingPx(
  styleId: string | undefined,
  custom?: CustomFrame,
): { x: number; y: number } {
  if (styleId === CUSTOM_FRAME_STYLE_ID && custom) {
    // The artwork sits in the border, which the overlay piece has to enclose as well.
    const { borderPx, paddingPx } = resolveCustomFrameMetrics(custom);
    return { x: borderPx + paddingPx, y: borderPx + paddingPx };
  }
  const normalizedStyleId = normalizeProblemFrameStyleId(styleId);
  if (normalizedStyleId === "doublebox") {
    return { x: 12, y: 10 };
  }
  if (normalizedStyleId === "cornerbox") {
    return { x: 16, y: 12 };
  }
  return { x: 10, y: 8 };
}

/**
 * The print stylesheet declares its own frame padding in mm (`.print-problem-area.with-frame`
 * in globals.css) rather than reusing the editor's px values, so pagination cannot reuse
 * `getProblemFrameChromePaddingPx`. Print needs this to reserve a framed fragment's chrome
 * height before deciding whether the fragment fits the rest of a column — the same thing
 * `estimatePrintBoxFragmentChromeHeight` does for boxes. Values mirror that CSS; keep them
 * in sync if it changes.
 */
export function getPrintProblemFrameChromePaddingMm(
  styleId: string | undefined,
  custom?: CustomFrame,
): { x: number; y: number } {
  if (styleId === CUSTOM_FRAME_STYLE_ID && custom) {
    const padding = resolveCustomFrameMetrics(custom).paddingPx * PX_TO_MM;
    return { x: padding, y: padding };
  }
  const normalizedStyleId = normalizeProblemFrameStyleId(styleId);
  if (normalizedStyleId === "doublebox") {
    return { x: 3.4, y: 3 };
  }
  if (normalizedStyleId === "cornerbox") {
    return { x: 4.2, y: 3.2 };
  }
  return { x: 3, y: 2.5 };
}

/**
 * Returns only the vertical chrome that a print problem-area fragment actually
 * paints. Continuations have no top padding, while the first/last outer edges
 * also reserve their style-specific border width. These values mirror
 * document-surface.css and are kept separate from the editor's overlay-piece
 * geometry, whose padding contract is intentionally different.
 */
export function getPrintProblemFrameFragmentChromeHeightMm(
  styleId: string | undefined,
  role: ProblemFrameFragmentRole,
  custom?: CustomFrame,
): number {
  const isCustom = styleId === CUSTOM_FRAME_STYLE_ID && custom !== undefined;
  const paddingY = getPrintProblemFrameChromePaddingMm(styleId, custom).y;
  const borderWidth = isCustom
    ? resolveCustomFrameMetrics(custom).borderPx * PX_TO_MM
    : normalizeProblemFrameStyleId(styleId) === "doublebox"
      ? 0.8
      : 0.3;
  const hasTop = role === "single" || role === "first";
  const hasBottom = role === "single" || role === "last";
  return paddingY + (hasTop ? paddingY + borderWidth : 0) + (hasBottom ? borderWidth : 0);
}

export function setProblemFrameEnabled<T extends SigmaBlock | RichBlock>(block: T, enabled: boolean): T {
  if (block.type !== "problem") {
    return block;
  }

  if (enabled) {
    return {
      ...block,
      frame: {
        ...(block.frame ?? {}),
        enabled: true,
        styleId: getProblemFrameStyleId(block),
      },
    } as T;
  }

  const frame = { ...(block.frame ?? {}) };
  delete frame.enabled;
  return {
    ...block,
    frame: Object.keys(frame).length > 0 ? frame : undefined,
  } as T;
}

export function setProblemFrameStyle<T extends SigmaBlock | RichBlock>(block: T, styleId: string): T {
  if (block.type !== "problem") {
    return block;
  }

  return {
    ...block,
    frame: {
      ...(block.frame ?? {}),
      enabled: true,
      styleId: normalizeProblemFrameStyleId(styleId),
    },
  } as T;
}

/**
 * Selecting the user's own drawing keeps every other frame field, and a built-in style chosen
 * later keeps the drawing too, so switching back and forth never loses artwork.
 */
export function setProblemCustomFrame<T extends SigmaBlock | RichBlock>(block: T, custom: CustomFrame): T {
  if (block.type !== "problem") {
    return block;
  }

  return {
    ...block,
    frame: {
      ...(block.frame ?? {}),
      enabled: true,
      styleId: CUSTOM_FRAME_STYLE_ID,
      custom,
    },
  } as T;
}

/**
 * A finished drawing becomes the problem's frame. The previous frame is read from the block being
 * updated (not from props), so two quick edits never overwrite each other, and the thickness and
 * padding the user already chose survive a new drawing (see `applyCustomFrameDrawing`).
 */
export function applyProblemFrameDrawing<T extends SigmaBlock | RichBlock>(
  block: T,
  drawing: CustomFrameDrawing,
  options: { slice?: number; tikz?: TikzImageSource } = {},
): T {
  if (block.type !== "problem") {
    return block;
  }
  return setProblemCustomFrame(block, applyCustomFrameDrawing(block.frame?.custom, drawing, options));
}

/**
 * Builds a saveable `ProblemFrame` from loosely typed input (an AI tool call, a pasted snippet).
 * The drawing is normalized like the settings dialog does (`normalizeCustomFrameInput`), so a frame
 * that arrives this way is stored in the one canonical form the document schema accepts; a drawing
 * that cannot be used throws, instead of saving something the file would later refuse to open.
 */
export function normalizeProblemFrameInput(input: Record<string, unknown>): ProblemFrame {
  const { custom: rawCustom, ...rest } = input;
  const frame = { ...rest } as ProblemFrame;
  const custom = normalizeCustomFrameInput(rawCustom, "frame.custom");
  if (!custom) {
    delete frame.custom;
    return frame;
  }
  return {
    ...frame,
    enabled: frame.enabled ?? true,
    styleId: CUSTOM_FRAME_STYLE_ID,
    custom,
  };
}
