import { normalizeFillOpacity } from "@/lib/fill-opacity";

import { applyShapeOpacity } from "./render-attrs";
import type { OverlayArrowhead, OverlayShape } from "./types";
import { isClosedPolyline } from "./shapes/line";
import type { OverlaySelectionStylePatch } from "../page-overlay-types";

export function canShapeStyleStroke(shape: OverlayShape): boolean {
  return shape.type === "geo" || shape.type === "arrow" || shape.type === "line" || shape.type === "arc";
}

export function canShapeStyleFill(shape: OverlayShape): boolean {
  return shape.type === "geo" ||
    (shape.type === "arc" && shape.props.kind === "sector") ||
    (shape.type === "line" && isClosedPolyline(shape.props.kind, shape.props.points, shape.props.closed));
}

export function canShapeStyleLine(shape: OverlayShape): boolean {
  return shape.type === "geo" || shape.type === "arrow" || shape.type === "line" || shape.type === "arc" || shape.type === "callout";
}

export function canShapeStyleLineEndpoints(shape: OverlayShape): boolean {
  if (shape.type === "line") {
    return !isClosedPolyline(shape.props.kind, shape.props.points, shape.props.closed);
  }

  return shape.type === "arrow" || isOpenArcShape(shape);
}

export function isOpenStrokeShape(shape: OverlayShape): boolean {
  return shape.type === "arrow" || shape.type === "line" || shape.type === "arc";
}

export function sharedArrowhead(shapes: OverlayShape[], endpoint: "start" | "end"): OverlayArrowhead | null {
  let result: OverlayArrowhead | null = null;
  for (const shape of shapes) {
    if (shape.type !== "arrow" && shape.type !== "line" && !isOpenArcShape(shape)) {
      continue;
    }
    if (shape.type === "line" && isClosedPolyline(shape.props.kind, shape.props.points, shape.props.closed)) {
      continue;
    }
    const value = endpoint === "start"
      ? shape.props.arrowheadStart ?? "none"
      : shape.props.arrowheadEnd ?? "none";
    if (result === null) {
      result = value;
    } else if (result !== value) {
      return null;
    }
  }
  return result;
}

/**
 * What the selection's fill currently is, so the toolbar can show the document's value rather than
 * whatever was applied last.
 *
 * Shaped like `sharedArrowhead`: shapes that cannot take a fill are skipped entirely, and a
 * disagreement collapses to `mixed` instead of picking one shape's value to display.
 */
export type SharedFillState =
  | { kind: "none" }
  | { kind: "solid"; fillColor: string; fillOpacity: number }
  | { kind: "mixed" }
  | { kind: "unavailable" };

export function sharedFill(shapes: OverlayShape[]): SharedFillState {
  let result: SharedFillState | null = null;
  for (const shape of shapes) {
    if (!canShapeStyleFill(shape)) {
      continue;
    }
    const props = shape.props as { fill?: "none" | "solid"; fillColor?: string; color: string; fillOpacity?: number };
    const current: SharedFillState = props.fill === "solid"
      ? {
        kind: "solid",
        // The renderers fall back to the stroke colour when no fill colour was stored, so the
        // toolbar has to read the same fallback or it shows an empty swatch for a filled shape.
        fillColor: props.fillColor ?? props.color,
        fillOpacity: normalizeFillOpacity(props.fillOpacity),
      }
      : { kind: "none" };
    if (result === null) {
      result = current;
    } else if (!isSameFillState(result, current)) {
      return { kind: "mixed" };
    }
  }
  return result ?? { kind: "unavailable" };
}

function isSameFillState(a: SharedFillState, b: SharedFillState): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "solid" && b.kind === "solid") {
    return a.fillColor === b.fillColor && a.fillOpacity === b.fillOpacity;
  }
  return true;
}

export function applyStylePatchToShape(shape: OverlayShape, style: OverlaySelectionStylePatch): OverlayShape {
  if (shape.type === "geo") {
    const base = applyShapeOpacity(shape, style.opacity);
    return {
      ...base,
      props: {
        ...shape.props,
        color: style.color ?? shape.props.color,
        fillColor: style.fillColor ?? shape.props.fillColor,
        strokeOpacity: style.strokeOpacity ?? shape.props.strokeOpacity,
        fillOpacity: style.fillOpacity ?? shape.props.fillOpacity,
        labelColor: style.color ?? shape.props.labelColor,
        fill: style.fill ?? shape.props.fill,
        dash: style.dash ?? shape.props.dash,
        size: style.size ?? shape.props.size,
      },
    };
  }

  if (shape.type === "arrow") {
    const base = applyShapeOpacity(shape, style.opacity);
    return {
      ...base,
      props: {
        ...shape.props,
        color: style.color ?? shape.props.color,
        strokeOpacity: style.strokeOpacity ?? shape.props.strokeOpacity,
        labelColor: style.color ?? shape.props.labelColor,
        dash: style.dash ?? shape.props.dash,
        size: style.size ?? shape.props.size,
        arrowheadStart: style.arrowheadStart ?? shape.props.arrowheadStart,
        arrowheadEnd: style.arrowheadEnd ?? shape.props.arrowheadEnd,
      },
    };
  }

  if (shape.type === "line") {
    const base = applyShapeOpacity(shape, style.opacity);
    const closed = isClosedPolyline(shape.props.kind, shape.props.points, shape.props.closed);
    return {
      ...base,
      props: {
        ...shape.props,
        color: style.color ?? shape.props.color,
        fillColor: closed ? style.fillColor ?? shape.props.fillColor : shape.props.fillColor,
        strokeOpacity: style.strokeOpacity ?? shape.props.strokeOpacity,
        fillOpacity: closed ? style.fillOpacity ?? shape.props.fillOpacity : shape.props.fillOpacity,
        fill: closed ? style.fill ?? shape.props.fill : shape.props.fill,
        labelColor: style.color ?? shape.props.labelColor,
        dash: style.dash ?? shape.props.dash,
        size: style.size ?? shape.props.size,
        arrowheadStart: closed ? shape.props.arrowheadStart : style.arrowheadStart ?? shape.props.arrowheadStart,
        arrowheadEnd: closed ? shape.props.arrowheadEnd : style.arrowheadEnd ?? shape.props.arrowheadEnd,
      },
    };
  }

  if (shape.type === "arc") {
    const base = applyShapeOpacity(shape, style.opacity);
    const isSector = shape.props.kind === "sector";
    return {
      ...base,
      props: {
        ...shape.props,
        color: style.color ?? shape.props.color,
        fillColor: isSector ? style.fillColor ?? shape.props.fillColor : shape.props.fillColor,
        fillOpacity: isSector ? style.fillOpacity ?? shape.props.fillOpacity : shape.props.fillOpacity,
        fill: isSector ? style.fill ?? shape.props.fill : shape.props.fill,
        strokeOpacity: style.strokeOpacity ?? shape.props.strokeOpacity,
        dash: style.dash ?? shape.props.dash,
        size: style.size ?? shape.props.size,
        arrowheadStart: isSector ? shape.props.arrowheadStart : style.arrowheadStart ?? shape.props.arrowheadStart,
        arrowheadEnd: isSector ? shape.props.arrowheadEnd : style.arrowheadEnd ?? shape.props.arrowheadEnd,
      },
    };
  }

  if (shape.type === "text") {
    const base = applyShapeOpacity(shape, style.opacity);
    return {
      ...base,
      props: {
        ...shape.props,
        color: style.color ?? shape.props.color,
        size: style.size ?? shape.props.size,
      },
    };
  }

  if (shape.type === "callout") {
    const base = applyShapeOpacity(shape, style.opacity);
    return {
      ...base,
      props: {
        ...shape.props,
        dash: style.dash ?? shape.props.dash,
        strokeWidth: style.size ?? shape.props.strokeWidth,
      },
    };
  }

  return applyShapeOpacity(shape, style.opacity);
}

export function isOpenArcShape(shape: OverlayShape): shape is Extract<OverlayShape, { type: "arc" }> {
  return shape.type === "arc" && shape.props.kind !== "sector";
}
