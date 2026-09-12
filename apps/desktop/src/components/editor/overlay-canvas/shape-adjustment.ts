import type { PointHandle } from "./interaction-mode";
import { getArcDragReadoutText } from "./shapes/arc-readout";
import {
  normalizeBlockArrowHeadLengthRatio,
  normalizeBlockArrowShaftRatio,
} from "./shapes/block-arrow";
import { getCalloutCornerRadius } from "./shapes/callout";
import type { OverlayShape } from "./types";

export function isShapeAdjustmentHandle(handle: PointHandle): boolean {
  return handle.type === "arc" ||
    handle.type === "arcRadius" ||
    handle.type === "triangleApex" ||
    handle.type === "blockArrowHead" ||
    handle.type === "blockArrowShaft" ||
    handle.type === "calloutCornerRadius";
}

/**
 * ドラッグ中に出す数値の読み上げ。**文言ではなく記述子を返す** —
 * この層は表示言語を知らないので、`OverlayCanvasEditorClient` が `t` で組み立てる。
 */
export type ShapeAdjustmentReadout =
  | { id: "apex"; values: { value: string } }
  | { id: "arrowHead"; values: { value: string } }
  | { id: "arrowShaft"; values: { value: string } }
  | { id: "cornerRadius"; values: { value: number } }
  | { id: "raw"; values: { value: string } };

export function getShapeAdjustmentReadout(shape: OverlayShape, handle: PointHandle): ShapeAdjustmentReadout | null {
  if (shape.type === "arc" && (handle.type === "arc" || handle.type === "arcRadius")) {
    const text = getArcDragReadoutText(shape, handle.type === "arc" ? "angle" : "radius");
    return text === null ? null : { id: "raw", values: { value: text } };
  }

  if (shape.type === "geo" && shape.props.geo === "triangle" && handle.type === "triangleApex") {
    const ratio = (shape.props.apexX ?? shape.props.w / 2) / Math.max(1, shape.props.w);
    return { id: "apex", values: { value: formatPercent(ratio) } };
  }

  if (shape.type === "geo" && shape.props.geo === "blockArrow") {
    if (handle.type === "blockArrowHead") {
      return { id: "arrowHead", values: { value: formatPercent(normalizeBlockArrowHeadLengthRatio(shape.props.headLengthRatio)) } };
    }
    if (handle.type === "blockArrowShaft") {
      return { id: "arrowShaft", values: { value: formatPercent(normalizeBlockArrowShaftRatio(shape.props.shaftRatio)) } };
    }
  }

  if (shape.type === "callout" && handle.type === "calloutCornerRadius") {
    return { id: "cornerRadius", values: { value: Math.round(getCalloutCornerRadius(shape)) } };
  }

  return null;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
