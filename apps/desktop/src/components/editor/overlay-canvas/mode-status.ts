import {
  type OverlayModeStatus
} from "../page-overlay-types";
import {
  type OverlayInteractionMode
} from "./interaction-mode";

export function getModeStatus(mode: OverlayInteractionMode, selectedCount: number): OverlayModeStatus {
  if (mode.id === "overlay.move") {
    return { id: "overlay.move", labelId: "moving" };
  }

  if (mode.id === "overlay.resize") {
    return { id: "overlay.resize", labelId: "resizing" };
  }

  if (mode.id === "overlay.rotate") {
    return { id: "overlay.rotate", labelId: "rotating" };
  }

  if (mode.id === "overlay.anchor") {
    return { id: "overlay.anchor", labelId: "anchoring" };
  }

  if (mode.id === "overlay.marquee") {
    return { id: "overlay.marquee", labelId: "marquee" };
  }

  if (mode.id === "overlay.textEditing") {
    return { id: "overlay.textEditing", labelId: "textEditing" };
  }

  if (mode.id === "overlay.imageCropping" || mode.id === "overlay.imageCropResize" || mode.id === "overlay.imageCropPan") {
    return { id: "overlay.imageCropping", labelId: "imageCropping" };
  }

  if (mode.id === "overlay.graphEditing") {
    return { id: "overlay.graphEditing", labelId: "graphEditing" };
  }

  if (mode.id === "overlay.graph3dEditing") {
    return { id: "overlay.graph3dEditing", labelId: "graph3dEditing" };
  }

  if (mode.id === "overlay.tableEditing") {
    return { id: "overlay.tableEditing", labelId: "tableEditing" };
  }

  if (mode.id === "overlay.originPicking") {
    return { id: "overlay.originPicking", labelId: "originPicking" };
  }

  if (mode.id === "overlay.graphFillPicking") {
    return { id: "overlay.graphFillPicking", labelId: "fillPicking" };
  }

  if (mode.id === "overlay.curveDrawing") {
    if (mode.tool.command === "threePointArc") {
      return { id: "overlay.curveDrawing", labelId: "threePointArc" };
    }
    return { id: "overlay.curveDrawing", labelId: mode.tool.command === "polyline" ? "polyline" : "curve" };
  }

  if (mode.id === "overlay.insertDrag") {
    return {
      id: "overlay.insertDrag",
      labelId: mode.tool.command === "graph" || mode.tool.command === "graph3d" ? "pickViewport" : "placeShape",
    };
  }

  if (mode.tool.kind === "insert") {
    return { id: "overlay.select", labelId: "insert" };
  }

  return { id: "overlay.select", labelId: selectedCount > 0 ? "select" : "shape" };
}