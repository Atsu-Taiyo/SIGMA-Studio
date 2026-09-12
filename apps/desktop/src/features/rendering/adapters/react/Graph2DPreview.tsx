import { resolveGraph2DParameters } from "@/features/rendering/core";
import { useGraphParameterPreview } from "./use-graph-parameter-preview";
import { axisX, axisY, intersectGraphRanges } from "@/features/drawing/graph-coordinate-label";
import katex from "katex";

import { useT } from "@/lib/i18n/react";
import { mathRenderEnvironmentCacheKey, type MathRenderEnvironment } from "@/lib/math-environment";
import { trustSigmaKatexMacro } from "@/lib/math-macros";
// `memo` は本セッションの追加 (グラフは打鍵で変わらないので再描画を止める)。
import  {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Graph2DSpec, GraphFillPattern } from "@/features/document";
import { isSafeCssColor } from "@/features/document/css-safety";
import { ptToPx } from "@/lib/font-size-units";
import  {
  DEFAULT_GRAPH_FILL_COLOR,
  getGraphFillPath,
  normalizeGraphFillOpacity,
  normalizeGraphFillPattern,
} from "@/lib/graph-fill";
import  {
  buildFunctionPath,
  cropGraphSpecToSvgBox,
  describeGraphSpec,
  formatGraphWarning,
  formatTickLabelTex,
  generateTicks,
  getGraphDisplayClipBox,
  getGraphDisplayRange,
  getGraphNumericRange,
  getGraphPlotBox,
  getGraphVisibilityWarnings,
  graphCurveStrokeDasharray,
  mapGraphPoint,
  normalizeGraphColor,
  normalizeGraphCurveStrokeWidth,
  parseGraphPoint,
  type GraphPlotBox,
  type GraphSpecChangeMeta,
  type GraphSvgCropBox,
} from "@/lib/graph2d";
import { countPerformanceEvent, measurePerformance } from "@/lib/performance";

import { applyMathTypesetStyle } from "@/features/rendering/core";

import { sanitizeMathMarkup } from "../math-markup";
import { measureTexBoxEm } from "../math-metrics";
import { escapeHtml } from "../rich-text-html";
import { useMathEnvironment } from "./MathEnvironment";

interface Graph2DPreviewProps {
  spec: Graph2DSpec;
  className?: string;
  idSeed?: string;
  /** Editor instance receiving parameter playback previews. */
  shapeId?: string;
  staticMode?: boolean;
  onSpecChange?: (nextSpec: Graph2DSpec, meta?: GraphSpecChangeMeta) => void;
  /** When true, immediately enter crop mode (used by overlay editing state). */
  autoStartCrop?: boolean;
  /** When true, user gestures cannot enter or toggle crop mode. */
  disableCropInteraction?: boolean;
  /** Called when crop mode ends (confirm or cancel). */
  onCropEnd?: () => void;
}

type TexAlign = "start" | "middle" | "end";
const GRAPH_CACHE_LIMIT = 300;
const DEFAULT_GRAPH_TICK_FONT_SIZE_PT = 9;
const graphCurvePathCache = new Map<string, string>();
const graphFillPathCache = new Map<string, string>();
const graphTicksCache = new Map<string, number[]>();

interface TexLabelProps {
  cx: number;
  cy: number;
  width: number;
  height: number;
  align: TexAlign;
  vAlign: TexAlign;
  tex: string;
  className?: string;
  fontSize?: number;
  staticMode?: boolean;
}

// グラフのラベルは軸目盛りの数だけ描き直されるので、TeX ごとに 1 回だけ変換して使い回す。
const graphTexMarkupCache = new Map<string, string>();
const GRAPH_TEX_MARKUP_CACHE_LIMIT = 2000;

/**
 * `renderMathHtml` を通らないもう 1 つの数式 markup 生成口。KaTeX は `trust:false` の既定で
 * 既に安全だが、`<foreignObject>` へ `dangerouslySetInnerHTML` する出口を 1 種類に保つため
 * 同じサニタイザを通す。tex はグラフ仕様、つまり文書データ由来である。
 */
function renderTex(tex: string, environment: MathRenderEnvironment): string {
  const cacheKey = mathRenderEnvironmentCacheKey(environment, tex);
  const cached = graphTexMarkupCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let html: string;
  try {
    const markup = katex.renderToString(applyMathTypesetStyle(tex || "\\square", environment.typesetStyle), {
      macros: environment.macroSet.katexMacros,
      throwOnError: false,
      strict: "ignore",
      output: "html",
      trust: trustSigmaKatexMacro,
    });
    const sanitized = sanitizeMathMarkup(markup);
    html = sanitized.safe ? sanitized.html : `<span data-math-unrendered="true">${escapeHtml(tex)}</span>`;
  } catch {
    html = `<span data-math-unrendered="true">${escapeHtml(tex)}</span>`;
  }

  if (graphTexMarkupCache.size >= GRAPH_TEX_MARKUP_CACHE_LIMIT) {
    const oldest = graphTexMarkupCache.keys().next().value;
    if (oldest !== undefined) {
      graphTexMarkupCache.delete(oldest);
    }
  }
  graphTexMarkupCache.set(cacheKey, html);
  return html;
}

const TEX_SYMBOL_MAP: Record<string, string> = {
  "\\pi": "π",
  "\\theta": "θ",
  "\\alpha": "α",
  "\\beta": "β",
  "\\gamma": "γ",
  "\\delta": "δ",
  "\\epsilon": "ε",
  "\\varepsilon": "ε",
  "\\lambda": "λ",
  "\\mu": "μ",
  "\\sigma": "σ",
  "\\phi": "φ",
  "\\varphi": "φ",
  "\\omega": "ω",
  "\\sin": "sin",
  "\\cos": "cos",
  "\\tan": "tan",
  "\\log": "log",
  "\\ln": "ln",
  "\\exp": "exp",
  "\\sqrt": "√",
  "\\cdot": "·",
  "\\times": "×",
  "\\div": "÷",
  "\\pm": "±",
  "\\mp": "∓",
  "\\infty": "∞",
  "\\leq": "≤",
  "\\leqq": "≤",
  "\\geq": "≥",
  "\\geqq": "≥",
  "\\neq": "≠",
  "\\approx": "≈",
  "\\to": "→",
};

function texToPlain(tex: string): string {
  if (!tex) return "";
  let out = tex;
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2");
    if (next === out) break;
    out = next;
  }
  for (const [token, replacement] of Object.entries(TEX_SYMBOL_MAP)) {
    if (out.includes(token)) {
      out = out.split(token).join(replacement);
    }
  }
  out = out.replace(/\\([a-zA-Z]+)/g, "$1");
  out = out.replace(/[{}]/g, "");
  // Replace standard hyphens with proper Unicode mathematical minus signs for display
  out = out.replace(/-/g, "\u2212");
  return out;
}

function offsetForAlign(size: number, align: TexAlign): number {
  if (align === "start") return 0;
  if (align === "end") return size;
  return size / 2;
}

function flexJustify(align: TexAlign): "flex-start" | "center" | "flex-end" {
  if (align === "start") return "flex-start";
  if (align === "end") return "flex-end";
  return "center";
}

function svgTextAnchor(align: TexAlign): "start" | "middle" | "end" {
  if (align === "start") return "start";
  if (align === "end") return "end";
  return "middle";
}

function svgDominantBaseline(align: TexAlign): "hanging" | "alphabetic" | "middle" {
  if (align === "start") return "hanging";
  if (align === "end") return "alphabetic";
  return "middle";
}

// Ticks used to render into a fixed 64x26 (x-axis) / 46x26 (y-axis) foreignObject box regardless
// of the actual font size, so raising `axes.tickFontSize` (up to 48pt via graph settings) clipped
// the label -- the exact bug this feature exists to fix. We size the box from the real KaTeX/
// MathLive box metrics instead, so it grows only as much as the rendered glyphs need.
const TICK_LABEL_MIN_WIDTH_PX = 12;
const TICK_LABEL_MIN_HEIGHT_PX = 12;

/** `isGraph2DSpec` does not check these numeric fields, and they are interpolated into CSS. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function measureTickLabelBoxPx(
  tex: string,
  fontSizePt: number,
  environment: MathRenderEnvironment,
): { width: number; height: number } {
  const metrics = measureTexBoxEm(tex || "\\square", environment);
  const fontSizePx = ptToPx(fontSizePt);
  return {
    width: Math.max(TICK_LABEL_MIN_WIDTH_PX, Math.ceil(metrics.widthEm * fontSizePx)),
    height: Math.max(TICK_LABEL_MIN_HEIGHT_PX, Math.ceil((metrics.ascentEm + metrics.descentEm) * fontSizePx)),
  };
}

function TexLabel({
  cx,
  cy,
  width,
  height,
  align,
  vAlign,
  tex,
  className,
  fontSize,
  staticMode,
}: TexLabelProps) {
  const mathEnvironment = useMathEnvironment();
  if (staticMode) {
    return (
      <text
        x={cx}
        y={cy}
        textAnchor={svgTextAnchor(align)}
        dominantBaseline={svgDominantBaseline(vAlign)}
        className={className}
        style={fontSize !== undefined ? { fontSize: `${fontSize}pt` } : undefined}
      >
        {texToPlain(tex)}
      </text>
    );
  }

  const x = cx - offsetForAlign(width, align);
  const y = cy - offsetForAlign(height, vAlign);
  return (
    <foreignObject x={x} y={y} width={width} height={height} className={className}>
      <div
        {...({ xmlns: "http://www.w3.org/1999/xhtml" } as React.HTMLAttributes<HTMLDivElement>)}
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          justifyContent: flexJustify(align),
          alignItems: flexJustify(vAlign),
          fontSize: fontSize !== undefined ? `${fontSize}pt` : undefined,
          lineHeight: 1,
          pointerEvents: "none",
          overflow: "visible",
        }}
        dangerouslySetInnerHTML={{ __html: renderTex(tex, mathEnvironment) }}
      />
    </foreignObject>
  );
}

function Graph2DPreviewComponent({
  spec: propSpec,
  className = "",
  idSeed,
  shapeId,
  staticMode,
  onSpecChange,
  autoStartCrop,
  disableCropInteraction,
  onCropEnd,
}: Graph2DPreviewProps) {
  countPerformanceEvent("Graph2DPreview.render");
  const mathEnvironment = useMathEnvironment();
  // State for interactive cropping
  const [isCropping, setIsCropping] = useState(false);
  const [cropBox, setCropBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // Snapshot of the spec when crop mode begins. While cropping, rendering uses this
  // snapshot so the crop box stays meaningful even as we live-update the parent spec.
  const [originalSpec, setOriginalSpec] = useState<Graph2DSpec | null>(null);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    box: GraphSvgCropBox;
    handle: string;
  } | null>(null);
  const cropBoxRef = useRef<GraphSvgCropBox | null>(null);
  const originalSpecRef = useRef<Graph2DSpec | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cropCommittedRef = useRef(false);
  const generatedGraphInstanceId = safeId(useId());
  const graphInstanceId = idSeed ? safeId(idSeed) : generatedGraphInstanceId;

  const animatedSpec = useGraphParameterPreview(propSpec, shapeId, Boolean(staticMode || isCropping));
  const spec = useMemo(() => resolveGraph2DParameters(isCropping && originalSpec ? originalSpec : animatedSpec), [isCropping, originalSpec, animatedSpec]);
  // 下の memo は `spec` そのものではなく、読んでいるフィールドを deps にしている。
  // 元々は `getGraphDisplaySpec` が毎回新しい spec を返していたため、`spec` を deps に
  // すると memo が一切効かなかったから。今は shape をキーに spec の identity を保つので
  // (`graph-layout.ts`)、`spec` を deps にしても成立する — フィールド単位のままなのは、
  // クロップ中だけ差し替わる `originalSpec` を含めて「中身が変わった時だけ」を保つため。
  // 元の回避策と違い、ここを `spec` に戻しても壊れはしない。
  /* eslint-disable react-hooks/exhaustive-deps */
  const plotBox = useMemo(() => getGraphPlotBox(spec), [spec.kind]);
  // Hooks must run before the !range/!graphRange early return below.
  const graphSvgId = useMemo(() => safeId([
    graphInstanceId,
    spec.title,
    spec.kind,
    spec.width,
    spec.height,
    spec.viewBox.xMin,
    spec.viewBox.xMax,
    spec.viewBox.yMin,
    spec.viewBox.yMax,
    spec.graphViewBox?.xMin ?? "",
    spec.graphViewBox?.xMax ?? "",
    spec.graphViewBox?.yMin ?? "",
    spec.graphViewBox?.yMax ?? "",
  ].join("-")), [
    graphInstanceId,
    spec.title,
    spec.kind,
    spec.width,
    spec.height,
    spec.viewBox,
    spec.graphViewBox,
  ]);
  const curvePaths = useMemo(() => measurePerformance("Graph2DPreview.curvePaths", () => spec.curves.map((curve) => ({
    curve,
    path: getCachedGraphCurvePath(curve, spec, plotBox),
  }))), [spec.curves, spec.viewBox, spec.graphViewBox, spec.width, spec.height, plotBox]);
  const fillPaths = useMemo(() => measurePerformance("Graph2DPreview.fillPaths", () => (spec.fills ?? []).map((fill) => ({
    fill,
    path: getCachedGraphFillPath(spec, fill, plotBox),
    color: normalizeGraphColor(fill.color, DEFAULT_GRAPH_FILL_COLOR),
    opacity: normalizeGraphFillOpacity(fill.opacity),
    pattern: normalizeGraphFillPattern(fill.pattern),
    patternId: `graph2d-fill-pattern-${graphSvgId}-${safeId(fill.id)}`,
  })).filter((fillPath) => fillPath.path)), [
    spec.fills,
    spec.curves,
    spec.viewBox,
    spec.graphViewBox,
    spec.width,
    spec.height,
    spec.kind,
    plotBox,
    graphSvgId,
  ]);
  /* eslint-enable react-hooks/exhaustive-deps */
  const tShape = useT("shape");
  const visibilityWarnings = useMemo(() => getGraphVisibilityWarnings(spec), [spec]);
  const range = safeRange(spec);
  const graphRange = safeDisplayRange(spec);
  const description = describeGraphSpec(propSpec) || tShape("graphPreview.defaultAria");

  const getCropBoxForSpec = (source: Graph2DSpec) => {
    const sourcePlotBox = getGraphPlotBox(source);
    try {
      const clipBox = getGraphDisplayClipBox(source, sourcePlotBox);
      if (clipBox.width > 0 && clipBox.height > 0) {
        return {
          left: clipBox.x,
          top: clipBox.y,
          width: clipBox.width,
          height: clipBox.height,
        };
      }
    } catch {
      // Fall back to the whole plot when the saved graph range is malformed.
    }

    return {
      left: sourcePlotBox.left,
      top: sourcePlotBox.top,
      width: source.width - sourcePlotBox.left - sourcePlotBox.right,
      height: source.height - sourcePlotBox.top - sourcePlotBox.bottom,
    };
  };

  const enterCropMode = (source: Graph2DSpec) => {
    const nextCropBox = getCropBoxForSpec(source);
    cropCommittedRef.current = false;
    cropBoxRef.current = nextCropBox;
    originalSpecRef.current = source;
    setCropBox(nextCropBox);
    setOriginalSpec(source);
    setIsCropping(true);
  };

  const exitCropMode = () => {
    const finalCropBox = cropBoxRef.current ?? cropBox;
    if (finalCropBox) {
      commitFinalCropBox(finalCropBox);
    }
    cropBoxRef.current = null;
    originalSpecRef.current = null;
    setIsCropping(false);
    setCropBox(null);
    setOriginalSpec(null);
    onCropEnd?.();
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (staticMode || disableCropInteraction || !onSpecChange) return;
    e.preventDefault();
    e.stopPropagation();

    if (!isCropping) {
      enterCropMode(propSpec);
    } else {
      exitCropMode();
    }
  };

  const commitCropBoxToSpec = (
    box: GraphSvgCropBox,
    options: { resizeToCrop?: boolean } = {},
  ) => {
    const sourceSpec = originalSpecRef.current ?? originalSpec;
    if (!onSpecChange || !sourceSpec) return;
    const nextSpec = cropGraphSpecToSvgBox(sourceSpec, box, options);
    if (!nextSpec) return;

    onSpecChange(nextSpec, {
      source: "crop",
      cropBox: box,
      resizeToCrop: options.resizeToCrop === true,
    });
  };

  const commitFinalCropBox = (box: GraphSvgCropBox) => {
    if (cropCommittedRef.current) return;
    cropCommittedRef.current = true;
    commitCropBoxToSpec(box, { resizeToCrop: true });
  };

  // Auto-start crop mode when triggered externally (e.g. overlay editing state).
  // Syncing an external trigger into local state is one of the cases where setState
  // in an effect is the simplest correct pattern.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    if (autoStartCrop && !isCropping && onSpecChange && !staticMode) {
      const nextCropBox = getCropBoxForSpec(propSpec);
      cropCommittedRef.current = false;
      cropBoxRef.current = nextCropBox;
      originalSpecRef.current = propSpec;
      setCropBox(nextCropBox);
      setOriginalSpec(propSpec);
      setIsCropping(true);
    } else if (!autoStartCrop && isCropping) {
      const finalCropBox = cropBoxRef.current ?? cropBox;
      if (finalCropBox) {
        commitFinalCropBox(finalCropBox);
      }
      cropBoxRef.current = null;
      originalSpecRef.current = null;
      setIsCropping(false);
      setCropBox(null);
      setOriginalSpec(null);
    }
  }, [autoStartCrop]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const handlePointerDown = (e: React.PointerEvent, handle: string) => {
    if (!isCropping || !cropBox) return;
    e.preventDefault();
    e.stopPropagation();

    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      box: { ...cropBox },
      handle,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isCropping || !cropBox || !dragStartRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const start = dragStartRef.current;

    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const scaleX = spec.width / rect.width;
    const scaleY = spec.height / rect.height;

    const dx = (e.clientX - start.x) * scaleX;
    const dy = (e.clientY - start.y) * scaleY;

    const plotLeft = plotBox.left;
    const plotRight = spec.width - plotBox.right;
    const plotTop = plotBox.top;
    const plotBottom = spec.height - plotBox.bottom;

    const newBox = { ...start.box };
    const MIN_SIZE = 30;

    if (start.handle === "center") {
      newBox.left = Math.max(plotLeft, Math.min(plotRight - newBox.width, start.box.left + dx));
      newBox.top = Math.max(plotTop, Math.min(plotBottom - newBox.height, start.box.top + dy));
    } else {
      if (start.handle.includes("l")) {
        const potentialLeft = start.box.left + dx;
        const boundedLeft = Math.max(plotLeft, Math.min(start.box.left + start.box.width - MIN_SIZE, potentialLeft));
        newBox.width = start.box.left + start.box.width - boundedLeft;
        newBox.left = boundedLeft;
      }
      if (start.handle.includes("r")) {
        const potentialWidth = start.box.width + dx;
        newBox.width = Math.max(MIN_SIZE, Math.min(plotRight - start.box.left, potentialWidth));
      }
      if (start.handle.includes("t")) {
        const potentialTop = start.box.top + dy;
        const boundedTop = Math.max(plotTop, Math.min(start.box.top + start.box.height - MIN_SIZE, potentialTop));
        newBox.height = start.box.top + start.box.height - boundedTop;
        newBox.top = boundedTop;
      }
      if (start.handle.includes("b")) {
        const potentialHeight = start.box.height + dy;
        newBox.height = Math.max(MIN_SIZE, Math.min(plotBottom - start.box.top, potentialHeight));
      }
    }

    cropBoxRef.current = newBox;
    setCropBox(newBox);
    commitCropBoxToSpec(newBox);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isCropping || !dragStartRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragStartRef.current = null;
  };

  if (!range || !graphRange) {
    return (
      <div className={`graph2d-container ${className}`} style={{ position: "relative" }}>
        <svg
          className="graph2d-svg"
          data-testid="graph2d-svg"
          role="img"
          aria-label={tShape("graphPreview.rangeErrorAria", { description })}
          viewBox={`0 0 ${spec.width} ${spec.height}`}
        >
          <rect width={spec.width} height={spec.height} rx="6" className="graph2d-error-bg" />
          <text x={spec.width / 2} y={spec.height / 2} textAnchor="middle" className="graph2d-error-text">
            {tShape("graphPreview.cannotDraw")}
          </text>
        </svg>
      </div>
    );
  }

  const visibleRange = intersectGraphRanges(range, graphRange);
  const xTicks = visibleRange
    ? getCachedGraphTicks(visibleRange.xMin, visibleRange.xMax, spec.axes.xTickStep, spec.kind === "numberLine" ? 8 : 12)
    : [];
  const yTicks = visibleRange && spec.kind !== "numberLine"
    ? getCachedGraphTicks(visibleRange.yMin, visibleRange.yMax, spec.axes.yTickStep, 9)
    : [];
  const showX = spec.axes.showX !== false;
  const showY = spec.kind === "cartesian" && spec.axes.showY !== false;
  const showTicks = spec.axes.showTicks !== false;
  const xAxisWithinRange = visibleRange !== null && visibleRange.yMin <= 0 && visibleRange.yMax >= 0;
  const yAxisWithinRange = visibleRange !== null && visibleRange.xMin <= 0 && visibleRange.xMax >= 0;
  const showXAxis = showX && xAxisWithinRange;
  const showYAxis = showY && yAxisWithinRange;
  const xAxisY = axisY(range, spec, plotBox);
  const yAxisX = showY ? axisX(range, spec, plotBox) : null;
  const axisArrowId = `axis-arrow-${graphSvgId}`;
  // The axis is the one part of a graph whose style reaches a React style object rather than an SVG
  // attribute, and `isGraph2DSpec` checks the type of none of these three fields — so a `;` inside
  // any of them becomes a real extra declaration once this component is serialized with
  // `renderToStaticMarkup` for the SVG export. Each stored value is checked *before* the preset
  // default is applied, so rejecting one falls back to the preset instead of losing the axis style.
  const storedAxisColor = isSafeCssColor(spec.axes.axisColor) ? spec.axes.axisColor : undefined;
  const axisColor = storedAxisColor;
  const storedAxisStrokeWidth = isFiniteNumber(spec.axes.axisStrokeWidth) ? spec.axes.axisStrokeWidth : undefined;
  const axisStrokeWidth = storedAxisStrokeWidth;
  const axisStrokeDasharray = axisDasharray(spec.axes.axisDash);
  const axisStyle = axisColor || axisStrokeWidth !== undefined || axisStrokeDasharray
    ? {
        ...(axisColor ? { stroke: axisColor } : {}),
        ...(axisStrokeWidth !== undefined ? { strokeWidth: axisStrokeWidth } : {}),
        ...(axisStrokeDasharray ? { strokeDasharray: axisStrokeDasharray } : {}),
      }
    : undefined;
  const plotClipId = `graph2d-plot-clip-${graphSvgId}`;
  const graphClipId = `graph2d-graph-clip-${graphSvgId}`;
  const plotWidth = Math.max(0, spec.width - plotBox.left - plotBox.right);
  const plotHeight = Math.max(0, spec.height - plotBox.top - plotBox.bottom);
  const graphClipBox = getGraphDisplayClipBox(spec, plotBox);
  const hasDrawableCurve = curvePaths.some((curvePath) => curvePath.path);

  const handleDefs = cropBox ? [
    { name: "tl", x: cropBox.left, y: cropBox.top, cursor: "nwse-resize" },
    { name: "tr", x: cropBox.left + cropBox.width, y: cropBox.top, cursor: "nesw-resize" },
    { name: "bl", x: cropBox.left, y: cropBox.top + cropBox.height, cursor: "nesw-resize" },
    { name: "br", x: cropBox.left + cropBox.width, y: cropBox.top + cropBox.height, cursor: "nwse-resize" },
    { name: "t", x: cropBox.left + cropBox.width / 2, y: cropBox.top, cursor: "ns-resize" },
    { name: "b", x: cropBox.left + cropBox.width / 2, y: cropBox.top + cropBox.height, cursor: "ns-resize" },
    { name: "l", x: cropBox.left, y: cropBox.top + cropBox.height / 2, cursor: "ew-resize" },
    { name: "r", x: cropBox.left + cropBox.width, y: cropBox.top + cropBox.height / 2, cursor: "ew-resize" },
  ] : [];

  return (
    <div
      ref={containerRef}
      className={`graph2d-container ${className} ${isCropping ? "cropping" : ""}`}
      style={{ position: "relative", width: "100%", height: "100%" }}
      onDoubleClick={handleDoubleClick}
      onPointerDown={(e) => {
        if (isCropping) {
          // Crop box and handles call stopPropagation in their own onPointerDown,
          // so reaching here means the user tapped outside the crop region — exit.
          e.stopPropagation();
          exitCropMode();
        }
      }}
    >
      <svg
        ref={svgRef}
        className="graph2d-svg"
        data-testid="graph2d-svg"
        role="img"
        aria-label={description}
        viewBox={`0 0 ${spec.width} ${spec.height}`}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{ touchAction: isCropping ? "none" : "auto" }}
      >
        <title>{description}</title>
        <defs>
          <marker
            id={axisArrowId}
            markerWidth="8"
            markerHeight="8"
            refX="6"
            refY="4"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path
              d="M0 0 L7 4 L0 8 Z"
              className="graph2d-axis-arrow"
              style={axisColor ? { fill: axisColor } : undefined}
            />
          </marker>
          <clipPath id={plotClipId}>
            <rect
              x={plotBox.left}
              y={plotBox.top}
              width={plotWidth}
              height={plotHeight}
            />
          </clipPath>
          <clipPath id={graphClipId}>
            <rect
              x={graphClipBox.x}
              y={graphClipBox.y}
              width={graphClipBox.width}
              height={graphClipBox.height}
            />
          </clipPath>
          {fillPaths.map(({ pattern, patternId, color, opacity }) =>
            pattern === "solid" ? null : (
              <GraphFillPatternDef
                key={patternId}
                id={patternId}
                pattern={pattern}
                color={color}
                opacity={opacity}
              />
            ),
          )}
        </defs>

        <rect
          x={plotBox.left}
          y={plotBox.top}
          width={plotWidth}
          height={plotHeight}
          rx="4"
          className="graph2d-plot-bg"
        />

        {fillPaths.length > 0 && (
          <g className="graph2d-fills" clipPath={`url(#${graphClipId})`}>
            {fillPaths.map(({ fill, path, color, opacity, pattern, patternId }) => (
              <path
                key={fill.id}
                className="graph2d-fill-region"
                data-testid="graph2d-fill-region"
                d={path}
                fill={pattern === "solid" ? color : `url(#${patternId})`}
                fillOpacity={pattern === "solid" ? opacity : undefined}
                fillRule="evenodd"
              />
            ))}
          </g>
        )}

        {spec.axes.grid && spec.kind === "cartesian" && (
          <g className="graph2d-grid">
            {xTicks.map((tick) => {
              const point = mapGraphPoint(tick, 0, range, spec, plotBox);
              return (
                <line
                  key={`x-grid-${tick}`}
                  x1={point.x}
                  x2={point.x}
                  y1={graphClipBox.y}
                  y2={graphClipBox.y + graphClipBox.height}
                />
              );
            })}
            {yTicks.map((tick) => {
              const point = mapGraphPoint(0, tick, range, spec, plotBox);
              return (
                <line
                  key={`y-grid-${tick}`}
                  x1={graphClipBox.x}
                  x2={graphClipBox.x + graphClipBox.width}
                  y1={point.y}
                  y2={point.y}
                />
              );
            })}
          </g>
        )}

        <g className="graph2d-axes">
          {showXAxis && (
            <line
              x1={graphClipBox.x}
              x2={graphClipBox.x + graphClipBox.width}
              y1={xAxisY}
              y2={xAxisY}
              markerEnd={`url(#${axisArrowId})`}
              style={axisStyle}
            />
          )}
          {showYAxis && yAxisX !== null && (
            <line
              x1={yAxisX}
              x2={yAxisX}
              y1={graphClipBox.y + graphClipBox.height}
              y2={graphClipBox.y}
              markerEnd={`url(#${axisArrowId})`}
              style={axisStyle}
            />
          )}
        </g>

        {showTicks && (
          <g className="graph2d-ticks">
            {showXAxis &&
              xTicks.map((tick) => {
                const point = mapGraphPoint(tick, 0, range, spec, plotBox);
                const tickTex = formatTickLabelTex(tick, spec.axes.xTickMode, spec.axes.xTickStep);
                const tickFontSize = isFiniteNumber(spec.axes.tickFontSize)
                  ? spec.axes.tickFontSize
                  : DEFAULT_GRAPH_TICK_FONT_SIZE_PT;
                const tickBox = measureTickLabelBoxPx(tickTex, tickFontSize, mathEnvironment);
                return (
                  <TexLabel
                    key={`x-tick-${tick}`}
                    cx={point.x}
                    cy={xAxisY + 18}
                    width={tickBox.width}
                    height={tickBox.height}
                    align="middle"
                    vAlign="middle"
                    tex={tickTex}
                    className="graph2d-tex-label"
                    fontSize={tickFontSize}
                    staticMode={staticMode}
                  />
                );
              })}
            {showYAxis &&
              yTicks.map((tick) => {
                const point = mapGraphPoint(0, tick, range, spec, plotBox);
                const tickTex = formatTickLabelTex(tick, spec.axes.yTickMode, spec.axes.yTickStep);
                const tickFontSize = isFiniteNumber(spec.axes.tickFontSize)
                  ? spec.axes.tickFontSize
                  : DEFAULT_GRAPH_TICK_FONT_SIZE_PT;
                const tickBox = measureTickLabelBoxPx(tickTex, tickFontSize, mathEnvironment);
                return (
                  <TexLabel
                    key={`y-tick-${tick}`}
                    cx={plotBox.left - 8}
                    cy={point.y}
                    width={tickBox.width}
                    height={tickBox.height}
                    align="end"
                    vAlign="middle"
                    tex={tickTex}
                    className="graph2d-tex-label"
                    fontSize={tickFontSize}
                    staticMode={staticMode}
                  />
                );
              })}
          </g>
        )}

        <g className="graph2d-curves" clipPath={`url(#${graphClipId})`}>
          {curvePaths.map(({ curve, path }) =>
            path ? (
              <path
                key={curve.id}
                data-testid="graph2d-curve"
                d={path}
                fill="none"
                stroke={normalizeGraphColor(curve.color)}
                strokeWidth={normalizeGraphCurveStrokeWidth(curve.strokeWidth)}
                strokeDasharray={graphCurveStrokeDasharray(curve)}
                strokeLinecap="butt"
                vectorEffect="non-scaling-stroke"
              />
            ) : null,
          )}
        </g>

        <g className="graph2d-point-guides" clipPath={`url(#${graphClipId})`}>
          {(spec.points ?? []).map((point) => {
            const parsed = parseGraphPoint(point);
            if (!parsed) {
              return null;
            }

            const mapped = mapGraphPoint(parsed.x, parsed.y, range, spec, plotBox);
            const color = normalizeGraphColor(point.color, "#dc2626");
            return (
              <g key={`point-guides-${point.id}`}>
                {point.showXProjection && showXAxis && (
                  <line
                    data-testid="graph2d-point-guide-x"
                    x1={mapped.x}
                    x2={mapped.x}
                    y1={mapped.y}
                    y2={xAxisY}
                    stroke={color}
                    strokeOpacity={0.65}
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {point.showYProjection && showYAxis && yAxisX !== null && (
                  <line
                    data-testid="graph2d-point-guide-y"
                    x1={mapped.x}
                    x2={yAxisX}
                    y1={mapped.y}
                    y2={mapped.y}
                    stroke={color}
                    strokeOpacity={0.65}
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </g>
            );
          })}
        </g>

        <g className="graph2d-points" clipPath={`url(#${graphClipId})`}>
          {(spec.points ?? []).map((point) => {
            const parsed = parseGraphPoint(point);
            if (!parsed) {
              return null;
            }
            const mapped = mapGraphPoint(parsed.x, parsed.y, range, spec, plotBox);
            const color = normalizeGraphColor(point.color, "#dc2626");
            const radius = normalizeGraphPointRadius(point.radius);
            const open = point.fill === "none";
            return (
              <g key={point.id}>
                {open && (
                  <circle
                    className="graph2d-point-open-halo"
                    cx={mapped.x}
                    cy={mapped.y}
                    r={radius + 1.4}
                    fill="#ffffff"
                    stroke="none"
                  />
                )}
                <circle
                  className="graph2d-point"
                  cx={mapped.x}
                  cy={mapped.y}
                  r={radius}
                  fill={open ? "#ffffff" : color}
                  stroke={color}
                  strokeWidth={open ? 2.4 : 0}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
        </g>

        {visibilityWarnings.length > 0 && (
          <text x={spec.width / 2} y={spec.height / 2} textAnchor="middle" className="graph2d-error-text">
            {formatGraphWarning(visibilityWarnings[0], tShape)}
          </text>
        )}

        {!hasDrawableCurve && visibilityWarnings.length === 0 && spec.curves.length > 0 && (
          <text x={spec.width / 2} y={spec.height / 2} textAnchor="middle" className="graph2d-error-text">
            {tShape("graphPreview.cannotEvaluate")}
          </text>
        )}

        {/* Cropping UI inside SVG */}
        {isCropping && cropBox && (
          <>
            {/* Shadows overlay outside crop boundaries */}
            <rect
              x={plotBox.left}
              y={plotBox.top}
              width={Math.max(0, cropBox.left - plotBox.left)}
              height={spec.height - plotBox.top - plotBox.bottom}
              fill="#0f172a80"
              style={{ pointerEvents: "none" }}
            />
            <rect
              x={cropBox.left + cropBox.width}
              y={plotBox.top}
              width={Math.max(0, spec.width - plotBox.right - (cropBox.left + cropBox.width))}
              height={spec.height - plotBox.top - plotBox.bottom}
              fill="#0f172a80"
              style={{ pointerEvents: "none" }}
            />
            <rect
              x={cropBox.left}
              y={plotBox.top}
              width={cropBox.width}
              height={Math.max(0, cropBox.top - plotBox.top)}
              fill="#0f172a80"
              style={{ pointerEvents: "none" }}
            />
            <rect
              x={cropBox.left}
              y={cropBox.top + cropBox.height}
              width={cropBox.width}
              height={Math.max(0, spec.height - plotBox.bottom - (cropBox.top + cropBox.height))}
              fill="#0f172a80"
              style={{ pointerEvents: "none" }}
            />

            {/* Crop box border */}
            <rect
              x={cropBox.left}
              y={cropBox.top}
              width={cropBox.width}
              height={cropBox.height}
              fill="none"
              stroke="#2563eb"
              strokeWidth="2"
              strokeDasharray="4 3"
              style={{ cursor: "move", pointerEvents: "all" }}
              onPointerDown={(e) => handlePointerDown(e, "center")}
            />

            {/* Drag Handles */}
            {handleDefs.map((h) => (
              <g key={h.name}>
                <circle
                  cx={h.x}
                  cy={h.y}
                  r={5}
                  fill="#2563eb"
                  stroke="#ffffff"
                  strokeWidth="1.5"
                  style={{ pointerEvents: "none" }}
                />
                <circle
                  cx={h.x}
                  cy={h.y}
                  r={14}
                  fill="transparent"
                  style={{ cursor: h.cursor, pointerEvents: "all" }}
                  onPointerDown={(e) => handlePointerDown(e, h.name)}
                />
              </g>
            ))}
          </>
        )}
      </svg>
    </div>
  );
}

function safeRange(spec: Graph2DSpec) {
  try {
    return getGraphNumericRange(spec);
  } catch {
    return null;
  }
}

function getCachedGraphCurvePath(
  curve: Graph2DSpec["curves"][number],
  spec: Graph2DSpec,
  plotBox: GraphPlotBox,
): string {
  const key = stableGraphCacheKey({
    curve,
    graphViewBox: spec.graphViewBox,
    height: spec.height,
    kind: spec.kind,
    plotBox,
    viewBox: spec.viewBox,
    width: spec.width,
  });
  return getCachedValue(graphCurvePathCache, key, () => buildFunctionPath(curve, spec, plotBox));
}

function getCachedGraphFillPath(
  spec: Graph2DSpec,
  fill: NonNullable<Graph2DSpec["fills"]>[number],
  plotBox: GraphPlotBox,
): string {
  const key = stableGraphCacheKey({
    // 軸は塗りつぶし領域の境界そのもの (resolveGraphFillRegion が showX / showY で分岐する)。
    // キーに含めないと軸の表示を切り替えたときに古い塗りが残る。
    axes: spec.axes,
    curves: spec.curves,
    fill,
    graphViewBox: spec.graphViewBox,
    height: spec.height,
    kind: spec.kind,
    plotBox,
    viewBox: spec.viewBox,
    width: spec.width,
  });
  return getCachedValue(graphFillPathCache, key, () => getGraphFillPath(spec, fill, plotBox) ?? "");
}

function getCachedGraphTicks(min: number, max: number, requestedStep: string | undefined, maxTicks: number): number[] {
  const key = `${min}:${max}:${requestedStep ?? ""}:${maxTicks}`;
  return getCachedValue(graphTicksCache, key, () => generateTicks(min, max, requestedStep, maxTicks));
}

function axisDasharray(dash: Graph2DSpec["axes"]["axisDash"]): string | undefined {
  if (dash === "dashed") {
    return "3 3";
  }
  if (dash === "dotted") {
    return "1.2 3";
  }
  return undefined;
}

function getCachedValue<T>(cache: Map<string, T>, key: string, createValue: () => T): T {
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const value = createValue();
  cache.set(key, value);
  if (cache.size > GRAPH_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  return value;
}

function stableGraphCacheKey(value: unknown): string {
  return JSON.stringify(value);
}

function safeDisplayRange(spec: Graph2DSpec) {
  try {
    return getGraphDisplayRange(spec);
  } catch {
    return null;
  }
}


function normalizeGraphPointRadius(radius: number | undefined): number {
  return Number.isFinite(radius) && radius !== undefined
    ? Math.min(12, Math.max(1.5, radius))
    : 4.3;
}

function safeId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "");
  return normalized || "graph";
}

function GraphFillPatternDef({
  id,
  pattern,
  color,
  opacity,
}: {
  id: string;
  pattern: Exclude<GraphFillPattern, "solid">;
  color: string;
  opacity: number;
}) {
  const backgroundOpacity = Math.min(0.22, opacity * 0.45);
  const markOpacity = Math.min(0.95, Math.max(0.36, opacity + 0.28));
  const lineProps = {
    stroke: color,
    strokeWidth: pattern === "cross" ? 1 : 1.25,
    strokeOpacity: markOpacity,
    strokeLinecap: "butt" as const,
  };

  if (pattern === "dots") {
    return (
      <pattern id={id} width="12" height="12" patternUnits="userSpaceOnUse">
        <rect width="12" height="12" fill={color} opacity={backgroundOpacity} />
        <circle cx="3" cy="3" r="1.15" fill={color} opacity={markOpacity} />
        <circle cx="9" cy="9" r="1.15" fill={color} opacity={markOpacity} />
      </pattern>
    );
  }

  const path = graphFillPatternPath(pattern);
  return (
    <pattern id={id} width="10" height="10" patternUnits="userSpaceOnUse">
      <rect width="10" height="10" fill={color} opacity={backgroundOpacity} />
      <path d={path} {...lineProps} />
    </pattern>
  );
}

function graphFillPatternPath(pattern: Exclude<GraphFillPattern, "solid">): string {
  switch (pattern) {
    case "diagonal":
      return "M -5 10 L 10 -5 M 0 10 L 10 0 M 5 10 L 10 5";
    case "diagonalBack":
      return "M 0 5 L 5 10 M 0 0 L 10 10 M 5 0 L 10 5";
    case "cross":
      return [
        "M -5 10 L 10 -5",
        "M 0 10 L 10 0",
        "M 5 10 L 10 5",
        "M 0 5 L 5 10",
        "M 0 0 L 10 10",
        "M 5 0 L 10 5",
      ].join(" ");
    case "horizontal":
      return "M 0 3.2 H 10 M 0 8.2 H 10";
    case "vertical":
      return "M 3.2 0 V 10 M 8.2 0 V 10";
    case "dots":
      return "";
  }
}

/**
 * グラフは本文の打鍵では変わらないので memo を掛ける。`getGraphDisplaySpec` が shape ごとに
 * spec の identity を保つようになったのが前提 (`graph-layout.ts`) — spec を毎回作り直して
 * いた状態では memo を掛けても素通りする。
 *
 * ただし編集面の呼び出し元 (`overlay-canvas/shape-renderer.tsx` の `onSpecChange`) は
 * レンダーごとに新しいクロージャを渡すので、**その経路では今のところ memo は効かない**
 * (親の `OverlayShapeView` 自体が memo 済みなので実害は出ていない)。効かせるには
 * ハンドラを shape.id で安定化させる必要がある。静的描画・印刷側の呼び出しには効く。
 */
export const Graph2DPreview = memo(Graph2DPreviewComponent);

Graph2DPreview.displayName = "Graph2DPreview";
