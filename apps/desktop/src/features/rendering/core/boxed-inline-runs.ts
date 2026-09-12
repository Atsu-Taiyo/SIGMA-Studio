import type { InlineNode } from "@/features/document";

const ZERO_WIDTH_TEXT = /[\u200B-\u200D\uFEFF]/g;
const LINE_OVERLAP_TOLERANCE_PX = 1;

export function scaleBoxedRunRects<T extends BoxedRunRect>(rects: T[], zoom: number): T[] {
  if (!Number.isFinite(zoom) || zoom === 1 || zoom <= 0) {
    return rects;
  }
  return rects.map((rect) => ({ ...rect, top: rect.top / zoom, bottom: rect.bottom / zoom, height: rect.height / zoom }));
}

export interface BoxedInlineStyleSource {
  boxedPaddingY?: unknown;
  boxedTone?: unknown;
  boxedVariant?: unknown;
  paddingY?: unknown;
  tone?: unknown;
  variant?: unknown;
}

export interface NormalizedBoxedInlineStyle {
  paddingY?: number;
  tone?: string;
  variant?: string;
}

export interface BoxedInlineRunSegment {
  connectLeft: boolean;
  connectRight: boolean;
  runId: string;
  segmentCount: number;
  segmentId: string;
  segmentIndex: number;
  styleKey: string;
}

export interface AnnotatedInlineNode {
  boxedRun?: BoxedInlineRunSegment;
  index: number;
  node: InlineNode;
}

export interface AnnotatedBoxedRunItem<TItem> {
  boxedRun?: BoxedInlineRunSegment;
  index: number;
  item: TItem;
}

export interface BoxedRunRect {
  top: number;
  bottom: number;
  height: number;
}

export interface BoxedRunMeasurement<TTarget> extends BoxedRunRect {
  boxedTarget?: TTarget;
}

export interface BoxedRunLineTarget {
  extraPaddingBottom: number;
  extraPaddingTop: number;
  targetHeight: number;
  ownHeight: number;
}

export interface BoxedRunLineConnection {
  connectLeft: boolean;
  connectRight: boolean;
}

export function annotateBoxedInlineRuns(
  children: readonly InlineNode[],
  options: { runIdPrefix?: string } = {},
): AnnotatedInlineNode[] {
  return annotateBoxedRunItems(children, getBoxedInlineCandidate, options).map((entry) => ({
    boxedRun: entry.boxedRun,
    index: entry.index,
    node: entry.item,
  }));
}

export function annotateBoxedRunItems<TItem>(
  items: readonly TItem[],
  getCandidate: (item: TItem) => { kind: "boxed"; styleKey: string } | { kind: "break" } | { kind: "ignored" },
  options: { runIdPrefix?: string } = {},
): Array<AnnotatedBoxedRunItem<TItem>> {
  const annotated: Array<AnnotatedBoxedRunItem<TItem>> = items.map((item, index) => ({ index, item }));
  const runIdPrefix = options.runIdPrefix ? `${sanitizeRunIdPart(options.runIdPrefix)}-` : "";
  let runCount = 0;
  let pendingRun: Array<{ index: number; styleKey: string }> = [];

  const flushRun = () => {
    if (pendingRun.length === 0) {
      return;
    }

    const runId = `${runIdPrefix}boxed-run-${runCount}`;
    const segmentCount = pendingRun.length;
    pendingRun.forEach((segment, segmentIndex) => {
      annotated[segment.index].boxedRun = {
        connectLeft: segmentIndex > 0,
        connectRight: segmentIndex < segmentCount - 1,
        runId,
        segmentCount,
        segmentId: `${runId}-segment-${segmentIndex}-${segment.index}`,
        segmentIndex,
        styleKey: segment.styleKey,
      };
    });
    pendingRun = [];
    runCount += 1;
  };

  items.forEach((item, index) => {
    const candidate = getCandidate(item);
    if (candidate.kind === "ignored") {
      return;
    }
    if (candidate.kind === "break") {
      flushRun();
      return;
    }
    if (pendingRun.length > 0 && pendingRun[0].styleKey !== candidate.styleKey) {
      flushRun();
    }
    pendingRun.push({ index, styleKey: candidate.styleKey });
  });
  flushRun();

  return annotated;
}

export function boxedInlineRunSignature(children: readonly InlineNode[]): string {
  return children.map((child) => {
    if (child.type === "text") {
      return [
        "text",
        child.text,
        child.marks?.join(",") ?? "",
        child.boxedPaddingY ?? "",
        child.boxedVariant ?? "",
        child.boxedTone ?? "",
        child.color ?? "",
        child.backgroundColor ?? "",
        child.fontFamily ?? "",
        child.fontSize ?? "",
      ].join(":");
    }
    return [
      "math",
      child.id,
      child.tex,
      child.marks?.join(",") ?? "",
      child.boxedPaddingY ?? "",
      child.boxedVariant ?? "",
      child.boxedTone ?? "",
    ].join(":");
  }).join("|");
}

export function getBoxedInlineStyleKey(source: BoxedInlineStyleSource): string {
  const normalized = normalizeBoxedInlineStyle(source);
  const paddingY = normalized.paddingY ?? 0;
  const variant = normalized.variant ?? "frame";
  const tone = normalized.tone ?? "";
  return `${paddingY}|${variant}|${tone}`;
}

export function normalizeBoxedInlineStyle(source: BoxedInlineStyleSource): NormalizedBoxedInlineStyle {
  return {
    paddingY: firstFiniteNumber(source.boxedPaddingY, source.paddingY),
    variant: firstNonEmptyString(source.boxedVariant, source.variant),
    tone: firstNonEmptyString(source.boxedTone, source.tone),
  };
}

export function hasVisibleInlineText(text: string): boolean {
  return text.replace(ZERO_WIDTH_TEXT, "").length > 0;
}

export function splitBoxedRunRectsIntoLines<T extends BoxedRunRect>(rects: T[]): T[][] {
  const lines: Array<{ top: number; bottom: number; rects: T[] }> = [];

  for (const rect of rects) {
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || rect.height <= 0) {
      continue;
    }

    const currentLine = lines[lines.length - 1];
    if (
      !currentLine ||
      rect.top > currentLine.bottom - LINE_OVERLAP_TOLERANCE_PX ||
      rect.bottom < currentLine.top + LINE_OVERLAP_TOLERANCE_PX
    ) {
      lines.push({ top: rect.top, bottom: rect.bottom, rects: [rect] });
      continue;
    }

    currentLine.top = Math.min(currentLine.top, rect.top);
    currentLine.bottom = Math.max(currentLine.bottom, rect.bottom);
    currentLine.rects.push(rect);
  }

  return lines.map((line) => line.rects);
}

export function boxedRunExtraPaddingTop(ownTop: number, targetTop: number): number {
  return Math.max(0, ownTop - targetTop);
}

export function boxedRunExtraPaddingBottom(ownBottom: number, targetBottom: number): number {
  return Math.max(0, targetBottom - ownBottom);
}

export function computeBoxedRunLineTargets<TTarget>(
  measurements: Array<BoxedRunMeasurement<TTarget>>,
): Map<TTarget, BoxedRunLineTarget> {
  const targets = new Map<TTarget, BoxedRunLineTarget>();

  for (const line of splitBoxedRunRectsIntoLines(measurements)) {
    const targetTop = Math.min(...line.map((rect) => rect.top));
    const targetBottom = Math.max(...line.map((rect) => rect.bottom));
    const targetHeight = targetBottom - targetTop;
    if (!Number.isFinite(targetHeight) || targetHeight <= 0) {
      continue;
    }

    for (const rect of line) {
      if (rect.boxedTarget === undefined) {
        continue;
      }
      const previous = targets.get(rect.boxedTarget);
      targets.set(rect.boxedTarget, {
        targetHeight: Math.max(previous?.targetHeight ?? 0, targetHeight),
        ownHeight: Math.max(previous?.ownHeight ?? 0, rect.height),
        extraPaddingTop: Math.max(previous?.extraPaddingTop ?? 0, boxedRunExtraPaddingTop(rect.top, targetTop)),
        extraPaddingBottom: Math.max(previous?.extraPaddingBottom ?? 0, boxedRunExtraPaddingBottom(rect.bottom, targetBottom)),
      });
    }
  }

  return targets;
}

export function computeBoxedRunLineConnections<TTarget extends { from?: number; styleKey?: string; to?: number }>(
  measurements: Array<BoxedRunMeasurement<TTarget>>,
): Map<TTarget, BoxedRunLineConnection> {
  const connections = new Map<TTarget, BoxedRunLineConnection>();

  for (const line of splitBoxedRunRectsIntoLines(measurements)) {
    const boxedTargets = line
      .map((rect) => rect.boxedTarget)
      .filter((target): target is TTarget => (
        target !== undefined &&
        typeof target.from === "number" &&
        typeof target.to === "number" &&
        target.to > target.from
      ))
      .filter((target, index, targets) => targets.indexOf(target) === index)
      .sort((a, b) => (a.from ?? 0) - (b.from ?? 0));

    for (let index = 1; index < boxedTargets.length; index += 1) {
      const previous = boxedTargets[index - 1];
      const current = boxedTargets[index];
      if (previous === current || !areBoxedRunTargetsConnectable(previous, current)) {
        continue;
      }

      const previousConnection = connections.get(previous) ?? { connectLeft: false, connectRight: false };
      connections.set(previous, { ...previousConnection, connectRight: true });

      const currentConnection = connections.get(current) ?? { connectLeft: false, connectRight: false };
      connections.set(current, { ...currentConnection, connectLeft: true });
    }
  }

  return connections;
}

export function areBoxedRunTargetsConnectable(
  previous: { from?: number; styleKey?: string; to?: number },
  current: { from?: number; styleKey?: string; to?: number },
): boolean {
  return (
    typeof previous.to === "number" &&
    typeof current.from === "number" &&
    previous.to === current.from &&
    (previous.styleKey === undefined || current.styleKey === undefined || previous.styleKey === current.styleKey)
  );
}

function getBoxedInlineCandidate(
  child: InlineNode,
): { kind: "boxed"; styleKey: string } | { kind: "break" } | { kind: "ignored" } {
  if (child.type === "text" && !hasVisibleInlineText(child.text)) {
    return { kind: "ignored" };
  }
  if (!child.marks?.includes("boxed")) {
    return { kind: "break" };
  }
  return { kind: "boxed", styleKey: getBoxedInlineStyleKey(child) };
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function sanitizeRunIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "inline";
}
