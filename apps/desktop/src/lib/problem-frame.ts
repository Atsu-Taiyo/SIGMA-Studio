import type { SigmaBlock, ProblemNode, RichBlock } from "@/features/document";

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

export type ProblemFrameStyleId = (typeof PROBLEM_FRAME_STYLE_OPTIONS)[number]["id"];
export type ProblemFrameFragmentRole = "single" | "first" | "middle" | "last";

const PROBLEM_FRAME_STYLE_ID_SET = new Set<string>(
  PROBLEM_FRAME_STYLE_OPTIONS.map((option) => option.id),
);

export function normalizeProblemFrameStyleId(styleId: string | undefined): ProblemFrameStyleId {
  return PROBLEM_FRAME_STYLE_ID_SET.has(styleId ?? "")
    ? styleId as ProblemFrameStyleId
    : DEFAULT_PROBLEM_FRAME_STYLE_ID;
}

export function getProblemFrameStyleId(problem: Pick<ProblemNode, "frame">): ProblemFrameStyleId {
  return normalizeProblemFrameStyleId(problem.frame?.styleId);
}

export function problemFrameClassName(baseClass: string, styleId: string | undefined): string {
  const normalizedStyleId = normalizeProblemFrameStyleId(styleId);
  return [
    baseClass,
    "box-frame",
    normalizedStyleId === "doublebox" ? "box-frame--double-rule" : "",
    normalizedStyleId === "cornerbox" ? "box-frame--corner corner-frame" : "",
  ].filter(Boolean).join(" ");
}

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
): { x: number; y: number } {
  const normalizedStyleId = normalizeProblemFrameStyleId(styleId);
  if (normalizedStyleId === "doublebox") {
    return { x: 12, y: 10 };
  }
  if (normalizedStyleId === "cornerbox") {
    return { x: 30, y: 24 };
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
): { x: number; y: number } {
  const normalizedStyleId = normalizeProblemFrameStyleId(styleId);
  if (normalizedStyleId === "doublebox") {
    return { x: 3.4, y: 3 };
  }
  if (normalizedStyleId === "cornerbox") {
    return { x: 8, y: 6.4 };
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
): number {
  const normalizedStyleId = normalizeProblemFrameStyleId(styleId);
  const paddingY = getPrintProblemFrameChromePaddingMm(normalizedStyleId).y;
  const borderWidth = normalizedStyleId === "doublebox"
    ? 0.8
    : normalizedStyleId === "cornerbox"
      ? 0
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
