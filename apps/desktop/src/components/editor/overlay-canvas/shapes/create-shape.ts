import { createOverlayTextBlocks } from "../ids";
import type { InsertTool } from "../interaction-mode";
import { getCenterDragBounds } from "../math";
import type { OverlayPoint, OverlayShape, OverlayShapeId, SigmaTableSpec } from "../types";
import {
  createArcShapeFromCenterDrag,
  createArcShapeFromThreePoints,
  createGraph3DSpecPreset,
  DEFAULT_CALLOUT_CORNER_RADIUS,
  DEFAULT_TEXT_SHAPE_WIDTH,
  getTextShapeLineHeightPx,
  MIN_TEXT_SHAPE_WIDTH,
  normalizeCalloutCornerRadius,
  type OverlayShapeStyleDefaults,
} from "@/features/drawing";
import { createGraphShapeFromPlotBounds } from "./graph";
import {
  getDefaultCurvePoints,
  normalizeCurvePoints,
  normalizeFreehandPoints,
} from "./line";
import { regularPolygonSidesFromCommand } from "./regular-polygon";
import { TABLE_SHAPE_TYPE, createTableShapeProps } from "./table";
import { buildGraph3DPresetNames } from "@/lib/graph3d-preset-names";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { CHART_SHAPE_TYPE, MIN_CHART_HEIGHT, MIN_CHART_WIDTH } from "./chart";

const EQUILATERAL_TRIANGLE_HEIGHT_RATIO = Math.sqrt(3) / 2;
const tShape = createCurrentLocaleTranslator("shape");


export { getRegularResizeAspect } from "@/features/drawing";

export function isArrowKey(key: string): boolean {
  return key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight";
}

export function arrowKeyDelta(key: string, distance: number): OverlayPoint {
  if (key === "ArrowLeft") {
    return { x: -distance, y: 0 };
  }
  if (key === "ArrowRight") {
    return { x: distance, y: 0 };
  }
  if (key === "ArrowUp") {
    return { x: 0, y: -distance };
  }
  return { x: 0, y: distance };
}

export function isClickPointDrawingTool(tool: InsertTool): boolean {
  return tool.command === "curve" || tool.command === "polyline" || tool.command === "threePointArc";
}

export function isPointSnappedClickDrawingTool(tool: InsertTool): boolean {
  return tool.command === "curve" || tool.command === "polyline";
}

export function isPointSnappedInsertDragTool(tool: InsertTool): boolean {
  return tool.command === "line" || tool.command === "arrow";
}

export function isAngleSnappedInsertTool(tool: InsertTool): boolean {
  return tool.command === "line" || tool.command === "arrow" || tool.command === "blockArrow";
}

/** arc/sector の中心ドラッグ挿入(Shift中だけ方向を15°スナップ)。 */
export function isArcInsertTool(tool: InsertTool): boolean {
  return tool.command === "arc" || tool.command === "sector";
}

export function isSnapDisableKey(key: string): boolean {
  return key === " " || key === "Space" || key === "Spacebar";
}

export function isConstraintModifierKey(key: string): boolean {
  return key === "Shift" || key === "Control";
}

export function getRegularInsertAspect(tool: InsertTool): number | null {
  if (regularPolygonSidesFromCommand(tool.command) !== null) {
    return 1;
  }

  if (
    tool.command === "rectangle" ||
    tool.command === "circle" ||
    tool.command === "ellipse" ||
    tool.command === "diamond"
  ) {
    return 1;
  }

  if (tool.command === "triangle") {
    return EQUILATERAL_TRIANGLE_HEIGHT_RATIO;
  }

  return null;
}

function cloneTableSpec(table: SigmaTableSpec): SigmaTableSpec {
  return structuredClone(table) as SigmaTableSpec;
}

export function buildInsertShape(
  tool: InsertTool,
  start: OverlayPoint,
  end: OverlayPoint,
  id: OverlayShapeId,
  points?: OverlayPoint[],
  closed = false,
  /**
   * The style the author last used, already filtered to the axes this command may take
   * (`pickStyleDefaultsForInsert`). Absent means "start from the built-in look", which is what the
   * shape-type-change path and the tests without a remembered style rely on.
   */
  styleDefaults: Partial<OverlayShapeStyleDefaults> = {},
): OverlayShape | null {
  const command = tool.command;
  /** Short name for the many `style.x ?? builtIn` reads below. */
  const style = styleDefaults;
  const polygonSides = regularPolygonSidesFromCommand(command);
  const minX = Math.min(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const w = Math.max(2, Math.abs(end.x - start.x));
  const h = Math.max(2, Math.abs(end.y - start.y));

  if (
    command === "circle" ||
    command === "ellipse"
  ) {
    const bounds = getCenterDragBounds(start, end, false);
    return {
      id,
      type: "geo",
      x: bounds.x,
      y: bounds.y,
      rotation: 0,
      props: {
        w: bounds.w,
        h: bounds.h,
        geo: "ellipse",
        fill: style.fill ?? "none",
        color: style.color ?? "black",
        strokeOpacity: style.strokeOpacity,
        fillColor: style.fillColor ?? "#ffffff",
        fillOpacity: style.fillOpacity,
        labelColor: style.color ?? "black",
        dash: style.dash ?? "solid",
        size: style.size ?? "m",
      },
    };
  }

  if (command === "blockArrow") {
    const dx = end.x - start.x;
    const length = Math.max(48, Math.abs(dx));
    const thickness = Math.max(28, Math.min(96, Math.abs(end.y - start.y)));
    const pointsLeft = dx < 0;
    return {
      id,
      type: "geo",
      x: Math.min(start.x, end.x),
      y: (start.y + end.y) / 2 - thickness / 2,
      rotation: pointsLeft ? Math.PI : 0,
      props: {
        w: length,
        h: thickness,
        geo: "blockArrow",
        fill: style.fill ?? "solid",
        color: style.color ?? "black",
        strokeOpacity: style.strokeOpacity,
        fillColor: style.fillColor ?? "#bfdbfe",
        fillOpacity: style.fillOpacity ?? 0.85,
        labelColor: style.color ?? "black",
        dash: style.dash ?? "solid",
        size: style.size ?? "m",
      },
    };
  }

  if (
    command === "rectangle" ||
    command === "triangle" ||
    command === "diamond" ||
    polygonSides !== null ||
    command === "highlight"
  ) {
    const geo: Extract<OverlayShape, { type: "geo" }>["props"]["geo"] = command === "highlight"
      ? "rectangle"
      : polygonSides !== null
        ? "regularPolygon"
        : command as "rectangle" | "triangle" | "diamond";
    return {
      id,
      type: "geo",
      x: minX,
      y: minY,
      rotation: 0,
      opacity: command === "highlight" ? 0.45 : undefined,
      // `styleDefaults` is empty for `highlight` (`pickStyleDefaultsForInsert` excludes it), so the
      // marker keeps its fixed yellow whatever the author last drew.
      props: {
        w,
        h,
        geo,
        fill: command === "highlight" ? "solid" : style.fill ?? "none",
        color: command === "highlight" ? "#facc15" : style.color ?? "black",
        strokeOpacity: command === "highlight" ? undefined : style.strokeOpacity,
        fillColor: command === "highlight" ? "#facc15" : style.fillColor ?? "#ffffff",
        fillOpacity: command === "highlight" ? 1 : style.fillOpacity,
        labelColor: command === "highlight" ? "black" : style.color ?? "black",
        dash: command === "highlight" ? "solid" : style.dash ?? "solid",
        size: command === "highlight" ? "m" : style.size ?? "m",
        apexX: command === "triangle" ? w / 2 : undefined,
        polygonSides: polygonSides ?? undefined,
      },
    };
  }

  if (command === "arc" || command === "sector") {
    return createArcShapeFromCenterDrag(id, start, end, command, {
      ...style,
      arrowheadStart: command === "arc" ? style.arrowheadStart ?? "none" : undefined,
      arrowheadEnd: command === "arc" ? style.arrowheadEnd ?? "none" : undefined,
    });
  }

  if (command === "threePointArc") {
    const arcPoints = points && points.length > 0 ? points : [start, end];
    if (arcPoints.length >= 3) {
      return createArcShapeFromThreePoints(id, arcPoints[0], arcPoints[1], arcPoints[2], {
        ...style,
        arrowheadStart: style.arrowheadStart ?? "none",
        arrowheadEnd: style.arrowheadEnd ?? "none",
      });
    }

    const previewStart = arcPoints[0] ?? start;
    const previewEnd = arcPoints[1] ?? end;
    return {
      id,
      type: "line",
      x: previewStart.x,
      y: previewStart.y,
      rotation: 0,
      props: {
        kind: "polyline",
        points: [
          { x: 0, y: 0 },
          { x: previewEnd.x - previewStart.x, y: previewEnd.y - previewStart.y },
        ],
        closed: false,
        arrowheadStart: style.arrowheadStart ?? "none",
        arrowheadEnd: style.arrowheadEnd ?? "none",
        fill: "none",
        fillColor: "#ffffff",
        color: style.color ?? "black",
        strokeOpacity: style.strokeOpacity,
        labelColor: style.color ?? "black",
        dash: style.dash ?? "solid",
        size: style.size ?? "m",
      },
    };
  }

  if (command === "arrow") {
    return {
      id,
      type: "arrow",
      x: start.x,
      y: start.y,
      rotation: 0,
      props: {
        start: { x: 0, y: 0 },
        end: { x: end.x - start.x, y: end.y - start.y },
        arrowheadStart: style.arrowheadStart ?? "none",
        // An arrow that arrives without a head is not an arrow, so this one axis keeps a floor.
        arrowheadEnd: style.arrowheadEnd === undefined || style.arrowheadEnd === "none"
          ? "arrow"
          : style.arrowheadEnd,
        fill: "none",
        color: style.color ?? "black",
        strokeOpacity: style.strokeOpacity,
        labelColor: style.color ?? "black",
        dash: style.dash ?? "solid",
        size: style.size ?? "m",
      },
    };
  }

  if (command === "line" || command === "polyline" || command === "curve" || command === "freehand") {
    const kind = command === "line" || command === "polyline" ? "polyline" : command;
    const linePoints = command === "curve" || command === "polyline"
      ? points && points.length >= 2
        ? normalizeCurvePoints(points, start, end)
        : command === "curve"
          ? getDefaultCurvePoints(start, end)
          : [
              { x: 0, y: 0 },
              { x: end.x - start.x, y: end.y - start.y },
            ]
      : command === "freehand"
        ? normalizeFreehandPoints(points ?? [start, end], start, end)
        : [
            { x: 0, y: 0 },
            { x: end.x - start.x, y: end.y - start.y },
          ];
    return {
      id,
      type: "line",
      x: start.x,
      y: start.y,
      rotation: 0,
      props: {
        kind,
        points: linePoints,
        closed: command === "polyline" && closed && linePoints.length >= 3,
        arrowheadStart: style.arrowheadStart ?? "none",
        arrowheadEnd: style.arrowheadEnd ?? "none",
        fill: "none",
        fillColor: "#ffffff",
        color: style.color ?? "black",
        strokeOpacity: style.strokeOpacity,
        labelColor: style.color ?? "black",
        dash: style.dash ?? "solid",
        size: style.size ?? "m",
      },
    };
  }

  if (command === "text") {
    return {
      id,
      type: "text",
      x: minX,
      y: minY,
      rotation: 0,
      props: {
        // The width is the user's from the first moment: a drag sets it, a click takes the
        // default. Height is one line — the box is empty, and the DOM measurement grows it as
        // soon as there is something to draw.
        w: end.x === start.x ? DEFAULT_TEXT_SHAPE_WIDTH : Math.max(MIN_TEXT_SHAPE_WIDTH, w),
        h: getTextShapeLineHeightPx("m"),
        blocks: createOverlayTextBlocks(""),
        color: "black",
        size: "m",
      },
    };
  }

  if (command === "callout") {
    const tailDepth = Math.min(36, Math.max(18, h * 0.28));
    const bodyHeight = Math.max(24, h - tailDepth);
    return {
      id,
      type: "callout",
      x: minX,
      y: minY,
      rotation: 0,
      props: {
        w,
        h: bodyHeight,
        radius: normalizeCalloutCornerRadius(tool.calloutRadius ?? DEFAULT_CALLOUT_CORNER_RADIUS, w, bodyHeight),
        tail: {
          baseStart: { x: w * 0.22, y: bodyHeight },
          baseEnd: { x: w * 0.42, y: bodyHeight },
          tip: { x: w * 0.14, y: h },
        },
        blocks: createOverlayTextBlocks(""),
        color: "black",
        size: "m",
        dash: "solid",
        strokeWidth: "m",
      },
    };
  }

  if (command === "graph") {
    return createGraphShapeFromPlotBounds(id, { x: minX, y: minY, w, h }, tool.graphPreset ?? "blank");
  }

  if (command === "graph3d") {
    return {
      id,
      type: "graph3dShape",
      x: minX,
      y: minY,
      rotation: 0,
      props: {
        w,
        h,
        spec: createGraph3DSpecPreset(tool.graph3dPreset ?? "revolution", buildGraph3DPresetNames(tShape)),
      },
    };
  }

  if (command === "table") {
    const tableW = Math.max(120, w, tool.tableSize?.w ?? 0);
    const tableH = Math.max(72, h, tool.tableSize?.h ?? 0);
    return {
      id,
      type: TABLE_SHAPE_TYPE,
      x: minX,
      y: minY,
      rotation: 0,
      props: tool.table
        ? {
            w: tableW,
            h: tableH,
            table: cloneTableSpec(tool.table),
          }
        : createTableShapeProps("plain", tableW, tableH),
    };
  }

  if (command === "chart") {
    if (!tool.chart) {
      return null;
    }
    return {
      id,
      type: CHART_SHAPE_TYPE,
      x: minX,
      y: minY,
      rotation: 0,
      props: {
        // `w`/`h` come from the corner drag, matching `x`/`y` above. `getCenterDragBounds` reads
        // `start` as a centre and so returns twice the span — pairing it with a corner origin
        // produced a chart of double the requested size, anchored where the smaller one was
        // clamped to fit.
        w: Math.max(MIN_CHART_WIDTH, w),
        h: Math.max(MIN_CHART_HEIGHT, h),
        // Deep-cloned for the same reason the table spec is: the seed belongs to the caller, and a
        // shared reference would let a later edit to the shape mutate whatever produced it.
        spec: structuredClone(tool.chart.spec),
        ...(tool.chart.sourceTableShapeId ? { sourceTableShapeId: tool.chart.sourceTableShapeId } : {}),
        dataSnapshot: structuredClone(tool.chart.dataSnapshot),
      },
    };
  }

  return null;
}
