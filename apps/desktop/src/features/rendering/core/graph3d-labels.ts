import type {
  Graph3DAxisColors,
  Graph3DCamera,
  Graph3DSpec,
} from "@/features/document";

import { createGraph3DProjector } from "./graph3d-projection";

const AXIS_LABEL_DISTANCE = 3.3;

export interface Graph3DDisplayAnnotation {
  id: string;
  position: { x: number; y: number; z: number };
  labelTex: string;
  color?: string;
}

export type ResolvedGraph3DAnnotation =
  | {
      id: string;
      kind: "label";
      position: { x: number; y: number; z: number };
      labelTex: string;
      color?: string;
    }
  | {
      id: string;
      kind: "dimension";
      from: { x: number; y: number; z: number };
      to: { x: number; y: number; z: number };
      labelTex: string;
      color?: string;
    };

/** Builds the common live/static/print label layer from resolved scene annotations. */
export function createGraph3DDisplayAnnotations(
  spec: Pick<Graph3DSpec, "view">,
  annotations: readonly ResolvedGraph3DAnnotation[],
  axisColors: Graph3DAxisColors,
): Graph3DDisplayAnnotation[] {
  const authored = annotations.map((annotation) => ({
    id: annotation.id,
    position: annotation.kind === "label"
      ? annotation.position
      : {
          x: (annotation.from.x + annotation.to.x) / 2,
          y: (annotation.from.y + annotation.to.y) / 2,
          z: (annotation.from.z + annotation.to.z) / 2,
        },
    labelTex: annotation.labelTex,
    ...(annotation.color ? { color: annotation.color } : {}),
  }));
  if (!spec.view.showAxes || spec.view.showAxisLabels === false) return authored;
  return [
    ...authored,
    { id: "axis-x", position: { x: AXIS_LABEL_DISTANCE, y: 0, z: 0 }, labelTex: "x", color: axisColors.x },
    { id: "axis-y", position: { x: 0, y: AXIS_LABEL_DISTANCE, z: 0 }, labelTex: "y", color: axisColors.y },
    { id: "axis-z", position: { x: 0, y: 0, z: AXIS_LABEL_DISTANCE }, labelTex: "z", color: axisColors.z },
  ];
}

/**
 * Projects a mathematical z-up point into the authored 3D viewport.
 *
 * A thin wrapper over {@link createGraph3DProjector} — the label layer only needs the pixel, while
 * the headless renderer also needs the depth to sort by. Keeping one implementation is what stops
 * a label and the surface it names from drifting apart.
 */
export function projectGraph3DLabel(
  point: { x: number; y: number; z: number },
  camera: Graph3DCamera,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const projected = createGraph3DProjector(camera, width, height).project(point);
  return projected ? { x: projected.x, y: projected.y } : null;
}
