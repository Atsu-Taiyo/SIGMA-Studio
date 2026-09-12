import type { Graph2DSpec, InlineNode, ListItemContinuationNode } from "./model";
import type {
  OverlayGraphAxisLabelKey,
  OverlayGraphShape,
  OverlayShape,
  OverlayShapeId,
  OverlayTextBlock,
} from "./overlay-model";

export const GRAPH_AXIS_LABEL_KEYS = [
  "x",
  "y",
  "origin",
] as const satisfies readonly OverlayGraphAxisLabelKey[];

export function getGraphAxisLabelTextsByKey(
  shape: OverlayGraphShape,
  shapes: OverlayShape[],
): Partial<Record<OverlayGraphAxisLabelKey, string>> {
  const textShapesById = new Map(
    shapes
      .filter((item): item is Extract<OverlayShape, { type: "text" }> => (
        item.type === "text"
      ))
      .map((item) => [item.id, item]),
  );
  const labelIdsByKey = getExistingGraphAxisLabelTextShapeIdsByKey(shape, shapes);
  const textsByKey: Partial<Record<OverlayGraphAxisLabelKey, string>> = {};

  for (const key of GRAPH_AXIS_LABEL_KEYS) {
    const labelId = labelIdsByKey[key];
    const labelShape = labelId ? textShapesById.get(labelId) : null;
    const labelText = labelShape
      ? getOverlayTextBlocksLabelText(labelShape.props.blocks)
      : getGraphAxisLabelSpecText(shape.props.spec, key);
    if (labelText !== undefined) {
      textsByKey[key] = labelText;
    }
  }

  return textsByKey;
}

/**
 * Build a transient graph spec for commands that still accept labels inline.
 *
 * Persisted graphs keep materialized label text in owned text shapes only.
 * Command adapters may hydrate those values into a temporary spec, but must
 * clear them again after materializing the resulting label shapes.
 */
export function hydrateGraphSpecWithOwnedLabelTexts(
  shape: OverlayGraphShape,
  shapes: OverlayShape[],
): Graph2DSpec {
  const textShapesById = new Map(
    shapes
      .filter((item): item is Extract<OverlayShape, { type: "text" }> => item.type === "text")
      .map((item) => [item.id, item]),
  );
  const readOwnedText = (shapeId: OverlayShapeId | undefined): string | undefined => {
    const textShape = shapeId ? textShapesById.get(shapeId) : undefined;
    return textShape ? getOverlayTextBlocksLabelText(textShape.props.blocks) : undefined;
  };
  const axisLabels = getGraphAxisLabelTextsByKey(shape, shapes);
  const curveLabelIdsByCurveId = { ...(shape.props.labelTextShapeIdsByCurveId ?? {}) };
  const usedCurveLabelIds = new Set(Object.values(curveLabelIdsByCurveId));
  const unkeyedCurveLabelIds = (shape.props.labelTextShapeIds ?? [])
    .filter((id) => !usedCurveLabelIds.has(id));
  let unkeyedCurveLabelIndex = 0;
  for (const curve of shape.props.spec.curves) {
    if (curveLabelIdsByCurveId[curve.id]) {
      continue;
    }
    const labelId = unkeyedCurveLabelIds[unkeyedCurveLabelIndex];
    if (!labelId) {
      break;
    }
    curveLabelIdsByCurveId[curve.id] = labelId;
    unkeyedCurveLabelIndex += 1;
  }

  return {
    ...shape.props.spec,
    axes: {
      ...shape.props.spec.axes,
      ...(axisLabels.x === undefined ? {} : { xLabel: axisLabels.x }),
      ...(axisLabels.y === undefined ? {} : { yLabel: axisLabels.y }),
      ...(axisLabels.origin === undefined ? {} : { originLabel: axisLabels.origin }),
    },
    points: shape.props.spec.points?.map((point) => {
      const text = readOwnedText(shape.props.pointLabelTextShapeIdsByPointId?.[point.id]);
      return text === undefined ? point : { ...point, label: text };
    }),
    annotations: shape.props.spec.annotations?.map((annotation) => {
      const text = readOwnedText(shape.props.annotationTextShapeIdsByAnnotationId?.[annotation.id]);
      return text === undefined ? annotation : { ...annotation, text };
    }),
    curves: shape.props.spec.curves.map((curve) => {
      const text = readOwnedText(curveLabelIdsByCurveId[curve.id]);
      return text === undefined ? curve : { ...curve, label: text };
    }),
  };
}

/**
 * Remove duplicate label text from a graph spec once an owned text shape exists.
 */
export function clearMaterializedGraphLabelTexts(
  shape: OverlayGraphShape,
): OverlayGraphShape {
  const axisLabelIds = shape.props.axisLabelTextShapeIds ?? {};
  const pointLabelIds = shape.props.pointLabelTextShapeIdsByPointId ?? {};
  const annotationLabelIds = shape.props.annotationTextShapeIdsByAnnotationId ?? {};
  const curveLabelIds = shape.props.labelTextShapeIdsByCurveId ?? {};
  const clearsXAxis = Boolean(axisLabelIds.x && shape.props.spec.axes.xLabel);
  const clearsYAxis = Boolean(axisLabelIds.y && shape.props.spec.axes.yLabel);
  const clearsOrigin = Boolean(axisLabelIds.origin && shape.props.spec.axes.originLabel);
  const clearsPoint = shape.props.spec.points?.some((point) => (
    Boolean(pointLabelIds[point.id])
    && Object.prototype.hasOwnProperty.call(point, "label")
  )) ?? false;
  const clearsAnnotation = shape.props.spec.annotations?.some((annotation) => (
    Boolean(annotationLabelIds[annotation.id]) && annotation.text !== ""
  )) ?? false;
  const clearsCurve = shape.props.spec.curves.some((curve) => (
    Boolean(curveLabelIds[curve.id])
    && Object.prototype.hasOwnProperty.call(curve, "label")
  ));
  if (
    !clearsXAxis &&
    !clearsYAxis &&
    !clearsOrigin &&
    !clearsPoint &&
    !clearsAnnotation &&
    !clearsCurve
  ) {
    return shape;
  }
  const omitLabel = <T extends { label?: string }>(value: T): T => {
    const next = { ...value };
    delete next.label;
    return next;
  };

  return {
    ...shape,
    props: {
      ...shape.props,
      spec: {
        ...shape.props.spec,
        axes: {
          ...shape.props.spec.axes,
          ...(clearsXAxis ? { xLabel: "" } : {}),
          ...(clearsYAxis ? { yLabel: "" } : {}),
          ...(clearsOrigin ? { originLabel: "" } : {}),
        },
        points: shape.props.spec.points?.map((point) => (
          pointLabelIds[point.id] ? omitLabel(point) : point
        )),
        annotations: shape.props.spec.annotations?.map((annotation) => (
          annotationLabelIds[annotation.id] ? { ...annotation, text: "" } : annotation
        )),
        curves: shape.props.spec.curves.map((curve) => (
          curveLabelIds[curve.id] ? omitLabel(curve) : curve
        )),
      },
    },
  };
}

export function getGraphAxisLabelSpecText(
  spec: Graph2DSpec,
  key: OverlayGraphAxisLabelKey,
): string | undefined {
  if (key === "x") {
    return spec.axes.xLabel?.trim() || undefined;
  }
  if (key === "y") {
    return spec.axes.yLabel?.trim() || undefined;
  }
  return spec.axes.originLabel?.trim() || undefined;
}

/**
 * Flat text of a label shape. Every block that holds prose contributes — including list items and
 * the blocks that continue them — so a label the user turned into a list still reads back as its
 * own text instead of an empty string.
 */
export function getOverlayTextBlocksLabelText(
  blocks: readonly OverlayTextBlock[],
): string {
  return blocks.map(getBlockLabelText).join("");
}

function getBlockLabelText(
  block: OverlayTextBlock | ListItemContinuationNode | undefined,
): string {
  if (!block || block.type === "divider") {
    return "";
  }
  if (block.type === "list") {
    return (block.items ?? []).map((item) => (
      item.children.map(getOverlayRichTextInlineLabelText).join("") +
      (item.continuations ?? []).map(getBlockLabelText).join("") +
      (item.nested ?? []).map(getBlockLabelText).join("")
    )).join("");
  }
  if (block.type === "quote") {
    return block.blocks.map(getBlockLabelText).join("");
  }
  return block.children.map(getOverlayRichTextInlineLabelText).join("");
}

/** Compatibility name for callers that predate the canonical overlay model. */
export const getTiptapLabelText = getOverlayTextBlocksLabelText;

export function getExistingGraphAxisLabelTextShapeIdsByKey(
  shape: OverlayGraphShape,
  shapes: OverlayShape[],
): Partial<Record<OverlayGraphAxisLabelKey, OverlayShapeId>> {
  const textShapeIds = new Set(
    shapes
      .filter((item) => item.type === "text")
      .map((item) => item.id),
  );
  const labelIdsByKey: Partial<Record<OverlayGraphAxisLabelKey, OverlayShapeId>> = {};

  for (const [key, labelId] of Object.entries(
    shape.props.axisLabelTextShapeIds ?? {},
  )) {
    if (!isOverlayGraphAxisLabelKey(key) || !textShapeIds.has(labelId)) {
      continue;
    }
    labelIdsByKey[key] = labelId;
  }

  return labelIdsByKey;
}

export function isOverlayGraphAxisLabelKey(
  value: string,
): value is OverlayGraphAxisLabelKey {
  return value === "x" || value === "y" || value === "origin";
}

function getOverlayRichTextInlineLabelText(
  inline: InlineNode,
): string {
  if (inline.type === "mathInline") {
    return inline.tex;
  }
  if (inline.type === "text") {
    return inline.text;
  }
  return "";
}
