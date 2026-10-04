import type { OverlaySnapGeometry } from "@/features/drawing";
import type { Dispatch, PointerEvent as ReactPointerEvent, RefObject, SetStateAction } from "react";
import type { OverlayChangeHistory, OverlaySolidEdgeSelection } from "../page-overlay-types";
import type { InsertTool, OverlayInteractionMode } from "./interaction-mode";
import type { AnchorMeasurements } from "./selection-handles";
import type { OverlayAsset, OverlayPoint, OverlayShape, OverlayShapeId, OverlayShapePatch } from "./types";

export interface OverlayPointerEditingPort {
  shapesRef: RefObject<OverlayShape[]>;
  updateShape: (patch: OverlayShapePatch, options?: { commit?: boolean; history?: OverlayChangeHistory; }) => void;
  editPolicyLockedShapeIdsRef: RefObject<ReadonlySet<string>>;
  /** 選べない図形 (`OverlayEditPolicy.unselectableShapeIds`)。囲み選択から外す。 */
  editPolicyUnselectableShapeIdsRef?: RefObject<ReadonlySet<string> | undefined>;
  notifyEditPolicyBlocked: () => void;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  assetsRef: RefObject<Record<string, OverlayAsset>>;
  replaceShape: (shape: OverlayShape) => void;
}

export interface OverlayPointerSelectionPort {
  selectedIdsRef: RefObject<string[]>;
  focusedGroupIdRef: RefObject<string | null>;
  setFocusedGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedShapeIds: (ids: OverlayShapeId[]) => void;
  selectShape: (id: OverlayShapeId) => void;
  toggleShapeSelection: (ids: OverlayShapeId[]) => void;
  setSolidEdge: (next: OverlaySolidEdgeSelection | null) => void;
  duplicateSelectedShapes: (offset?: OverlayPoint) => OverlayShape[];
}

export interface OverlayPointerGeometryPort {
  pagePointFromClient: (clientX: number, clientY: number, cachedRect?: { left: number; top: number; width: number; height: number; } | null) => OverlayPoint;
  getOverlaySnapThreshold: () => number;
  getShapeAtPoint: (point: OverlayPoint, margin?: number) => OverlayShape | undefined;
  getOpenStrokeShapeAtPoint: (point: OverlayPoint) => OverlayShape | undefined;
  clientPointFromPage: (point: OverlayPoint) => { x: number; y: number; };
  refreshAnchorMeasurements: () => AnchorMeasurements;
  createSnapGeometry: (excludedShapeIds?: Iterable<OverlayShapeId>) => OverlaySnapGeometry;
  anchorMeasurementsRef: RefObject<AnchorMeasurements>;
}

export interface OverlayPointerDrawingPort {
  getSnappedDrawingPoint: (rawPoint: OverlayPoint, options?: { previousPoint?: OverlayPoint; shiftKey?: boolean; enabled?: boolean; }) => OverlayPoint;
  finishCurveDrawing: (tool: InsertTool, points: OverlayPoint[], closed?: boolean) => boolean;
  getSnappedInsertDragPoint: (tool: InsertTool, start: OverlayPoint, point: OverlayPoint, modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "ctrlKey" | "shiftKey">) => OverlayPoint;
  createShapeFromInsertDrag: (tool: InsertTool, start: OverlayPoint, end: OverlayPoint, points?: OverlayPoint[], closed?: boolean) => OverlayShapeId | null;
}

export interface OverlayPointerTransformsPort {
  applyMoveInteractionAtPoint: (interaction: Extract<OverlayInteractionMode, { id: "overlay.move"; }>, point: OverlayPoint) => void;
  applyResizeInteractionAtPoint: (interaction: Extract<OverlayInteractionMode, { id: "overlay.resize"; }>, point: OverlayPoint, modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "ctrlKey" | "shiftKey">) => void;
  applyPointInteractionAtPoint: (interaction: Extract<OverlayInteractionMode, { id: "overlay.point"; }>, point: OverlayPoint, modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "shiftKey">) => void;
  applyImageCropInteractionAtPoint: (interaction: Extract<OverlayInteractionMode, { id: "overlay.imageCropResize" | "overlay.imageCropPan"; }>, point: OverlayPoint) => void;
}
