import type { OverlayArcShape } from "@/features/document";
import {
  getArcRadii,
  normalizePositiveAngle,
} from "@/features/drawing";

function formatArcRadiusReadout(rx: number, ry: number): string {
  const rxRounded = Math.round(rx);
  const ryRounded = Math.round(ry);
  return rxRounded === ryRounded
    ? `r=${rxRounded}`
    : `${rxRounded}×${ryRounded}`;
}

function formatArcSweepReadout(
  startAngle: number,
  endAngle: number,
): string {
  const sweepDegrees = Math.round(
    (normalizePositiveAngle(endAngle - startAngle) * 180) / Math.PI,
  );
  return `${sweepDegrees}°`;
}

export type ArcDragReadoutFocus = "angle" | "radius" | "both";

/** ドラッグ中のライブ数値表示テキスト(半径・中心角)を組み立てる。 */
export function getArcDragReadoutText(
  shape: OverlayArcShape,
  focus: ArcDragReadoutFocus,
): string {
  const { rx, ry } = getArcRadii(shape);
  const radiusText = formatArcRadiusReadout(rx, ry);
  const sweepText = formatArcSweepReadout(
    shape.props.startAngle,
    shape.props.endAngle,
  );
  if (focus === "angle") {
    return sweepText;
  }
  if (focus === "radius") {
    return radiusText;
  }
  return `${radiusText}  ${sweepText}`;
}
