import {
  getShapeDimensionBounds,
  getShapeRotation,
  resizeBoxShape,
  type OverlayInsertCommand,
} from "@/features/drawing";

import type { OverlayShape } from "./types";
import type { OverlaySelectionStylePatch } from "../page-overlay-types";
import { applyStylePatchToShape } from "./style-patch";
import { buildInsertShape } from "./shapes/create-shape";

export type ShapeTypeChangeCommand = Exclude<
  OverlayInsertCommand,
  "threePointArc" | "highlight" | "text" | "graph" | "graph3d" | "table" | "chart"
>;

export function canChangeOverlayShapeType(shape: OverlayShape): boolean {
  return shape.type === "geo" ||
    shape.type === "arc" ||
    shape.type === "arrow" ||
    shape.type === "line" ||
    shape.type === "callout";
}

export function isShapeTypeChangeCommand(command: string): command is ShapeTypeChangeCommand {
  return command !== "select" &&
    command !== "threePointArc" &&
    command !== "highlight" &&
    command !== "text" &&
    command !== "graph" &&
    command !== "graph3d" &&
    command !== "table" &&
    command !== "chart";
}

export function changeOverlayShapeType(source: OverlayShape, command: ShapeTypeChangeCommand): OverlayShape | null {
  if (!canChangeOverlayShapeType(source)) {
    return null;
  }

  const bounds = getShapeDimensionBounds(source);
  const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
  const start = command === "circle" || command === "ellipse" || command === "arc" || command === "sector"
    ? center
    : { x: bounds.x, y: bounds.y };
  const end = { x: bounds.x + bounds.w, y: bounds.y + bounds.h };
  const built = buildInsertShape({ kind: "insert", command }, start, end, source.id);
  if (!built) {
    return null;
  }

  const sized = built.type === "geo" || built.type === "arc" || built.type === "callout"
    ? resizeBoxShape(built, bounds)
    : built;
  const styled = applyStylePatchToShape(sized, getSourceStyle(source));
  const label = getShapeLabel(source);
  const labelColor = getShapeLabelColor(source);
  const withLabel = label !== undefined || labelColor !== undefined
    ? applyShapeLabel(styled, label, labelColor)
    : styled;

  return {
    ...withLabel,
    id: source.id,
    rotation: getShapeRotation(source),
    ...(source.flipX ? { flipX: true } : {}),
    ...(source.flipY ? { flipY: true } : {}),
    ...(source.parentId ? { parentId: source.parentId } : {}),
    ...(source.groupId ? { groupId: source.groupId } : {}),
    ...(source.stackLayer ? { stackLayer: source.stackLayer } : {}),
    ...(source.locked ? { locked: true } : {}),
    ...(source.hidden ? { hidden: true } : {}),
    ...(source.opacity !== undefined ? { opacity: source.opacity } : {}),
    ...(source.anchor ? { anchor: source.anchor } : {}),
  } as OverlayShape;
}

function getSourceStyle(source: OverlayShape): OverlaySelectionStylePatch {
  if (source.type === "geo" || source.type === "arc" || source.type === "arrow" || source.type === "line") {
    const style: OverlaySelectionStylePatch = {
      color: source.props.color,
      strokeOpacity: source.props.strokeOpacity,
      fill: source.props.fill,
      dash: source.props.dash,
      size: source.props.size,
    };
    if (source.type === "geo" || source.type === "arc" || source.type === "line") {
      style.fillColor = source.props.fillColor;
      style.fillOpacity = source.props.fillOpacity;
    }
    if (source.type === "arc" || source.type === "arrow" || source.type === "line") {
      style.arrowheadStart = source.props.arrowheadStart;
      style.arrowheadEnd = source.props.arrowheadEnd;
    }
    return style;
  }
  return {};
}

function getShapeLabel(source: OverlayShape): string | undefined {
  if (source.type === "geo" || source.type === "arrow" || source.type === "line") {
    return source.props.label;
  }
  return undefined;
}

function getShapeLabelColor(source: OverlayShape): string | undefined {
  if (source.type === "geo" || source.type === "arrow" || source.type === "line") {
    return source.props.labelColor;
  }
  return undefined;
}

function applyShapeLabel(shape: OverlayShape, label?: string, labelColor?: string): OverlayShape {
  if (shape.type === "geo" || shape.type === "arrow" || shape.type === "line") {
    return {
      ...shape,
      props: {
        ...shape.props,
        ...(label !== undefined ? { label } : {}),
        ...(labelColor !== undefined ? { labelColor } : {}),
      },
    } as OverlayShape;
  }
  return shape;
}
