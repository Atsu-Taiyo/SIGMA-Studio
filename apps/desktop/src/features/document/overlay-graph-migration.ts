import type {
  OverlayGraphShape,
} from "./overlay-model";
import type { Graph2DSpec } from "./model";

const GRAPH_BOUNDS_MODE = "plot" as const;

type GraphPlotBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function getLegacyGraphPlotBox(spec: Graph2DSpec): GraphPlotBox {
  if (spec.kind === "numberLine") {
    return {
      left: 34,
      top: 20,
      right: 28,
      bottom: 30,
    };
  }

  return {
    left: 46,
    top: 18,
    right: 18,
    bottom: 34,
  };
}

/**
 * Migrates the short-lived graph contract whose stored bounds represented the
 * padded SVG viewport. Canonical SigmaDoc stores the visible plot rectangle.
 */
export function migrateLegacyGraphShapeToPlotBounds(
  shape: OverlayGraphShape,
): OverlayGraphShape {
  if (shape.props.boundsMode === GRAPH_BOUNDS_MODE) {
    return shape;
  }

  const spec = shape.props.preserveSpecSize === true
    ? shape.props.spec
    : {
        ...shape.props.spec,
        width: shape.props.w,
        height: shape.props.h,
      };
  const plotBox = getLegacyGraphPlotBox(spec);
  const scaleX = shape.props.w / Math.max(1, spec.width);
  const scaleY = shape.props.h / Math.max(1, spec.height);
  const left = plotBox.left * scaleX;
  const top = plotBox.top * scaleY;
  const right = plotBox.right * scaleX;
  const bottom = plotBox.bottom * scaleY;
  const anchor = shape.anchor?.type === "block"
    ? {
        ...shape.anchor,
        dy: shape.anchor.dy + top,
        ...(shape.anchor.dx === undefined ? {} : { dx: shape.anchor.dx + left }),
        ...(shape.anchor.line
          ? { line: { ...shape.anchor.line, dy: shape.anchor.line.dy + top } }
          : {}),
      }
    : shape.anchor;

  return {
    ...shape,
    x: shape.x + left,
    y: shape.y + top,
    ...(anchor ? { anchor } : {}),
    props: {
      ...shape.props,
      boundsMode: GRAPH_BOUNDS_MODE,
      w: Math.max(1, shape.props.w - left - right),
      h: Math.max(1, shape.props.h - top - bottom),
      spec: shape.props.preserveSpecSize === true ? shape.props.spec : spec,
    },
  };
}
