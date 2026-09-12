import type { Graph2DSpec, GraphCurve, GraphParameter } from "@/features/document";

const resolvedSpecs = new WeakMap<Graph2DSpec, Graph2DSpec>();

/** Derived numeric expressions for geometry/rendering only. Never adopt this as the document. */
export function resolveGraphParameterExpression(expression: string, parameters: readonly GraphParameter[]): string {
  if (parameters.length === 0) return expression;
  const values = new Map(parameters.map((parameter) => [parameter.name.toLowerCase(), parameter.value]));
  // Scan numbers before identifiers so scientific notation (1e-3) stays intact. Match whole
  // identifiers so s never changes sin or s2, and leave functions and independent variables alone.
  return expression.replace(/(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[a-z_][a-z_0-9]*/giu, (token, offset: number) => {
    if (/^[\d.]/u.test(token) || /^[xyt]$/iu.test(token) || /^\s*\(/u.test(expression.slice(offset + token.length))) return token;
    const value = values.get(token.toLowerCase());
    return value === undefined || !Number.isFinite(value) ? token : `(${value})`;
  });
}

export function resolveGraphParameterCurve(curve: GraphCurve, parameters: readonly GraphParameter[] = []): GraphCurve {
  if (parameters.length === 0) return curve;
  const resolve = (value: string) => resolveGraphParameterExpression(value, parameters);
  return { ...curve, expr: resolve(curve.expr),
    ...(curve.yExpr === undefined ? {} : { yExpr: resolve(curve.yExpr) }),
    ...(curve.domain ? { domain: {
      ...(curve.domain.min === undefined ? {} : { min: resolve(curve.domain.min) }),
      ...(curve.domain.max === undefined ? {} : { max: resolve(curve.domain.max) }),
    } } : {}),
  };
}

export function resolveGraph2DParameters(spec: Graph2DSpec): Graph2DSpec {
  if (!spec.parameters?.length) return spec;
  const cached = resolvedSpecs.get(spec);
  if (cached) return cached;
  const parameters = spec.parameters;
  const resolve = (value: string) => resolveGraphParameterExpression(value, parameters);
  const point = <T extends { x: string; y: string }>(item: T): T => ({ ...item, x: resolve(item.x), y: resolve(item.y) });
  const range = (value: Graph2DSpec["viewBox"]) => ({ xMin: resolve(value.xMin), xMax: resolve(value.xMax), yMin: resolve(value.yMin), yMax: resolve(value.yMax) });
  const result: Graph2DSpec = { ...spec,
    parameters: [],
    curves: spec.curves.map((curve) => resolveGraphParameterCurve(curve, parameters)),
    viewBox: range(spec.viewBox),
    ...(spec.graphViewBox ? { graphViewBox: range(spec.graphViewBox) } : {}),
    axes: { ...spec.axes,
      ...(spec.axes.xTickStep === undefined ? {} : { xTickStep: resolve(spec.axes.xTickStep) }),
      ...(spec.axes.yTickStep === undefined ? {} : { yTickStep: resolve(spec.axes.yTickStep) }),
    },
    ...(spec.points ? { points: spec.points.map(point) } : {}),
    ...(spec.fills ? { fills: spec.fills.map(point) } : {}),
    ...(spec.annotations ? { annotations: spec.annotations.map(point) } : {}),
  };
  resolvedSpecs.set(spec, result);
  return result;
}
