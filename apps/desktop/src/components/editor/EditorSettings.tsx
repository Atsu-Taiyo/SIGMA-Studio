"use client";

import {
  ChevronDown,
  Crop,
  Crosshair,
  PaintBucket,
  Tag,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";

import { GraphItemActionsMenu, GRAPH_SETTINGS_POPOVER_Z_INDEX } from "./GraphItemActionsMenu";
import { GraphSettingsSection, GraphCardGrid, GraphAddCard } from "./GraphSettingsControls";
import { GraphParameters } from "./GraphParameters";
import { Graph2DVideoExport } from "./Graph2DVideoExport";
import { dispatchGraphParameterPreview, dispatchGraphParametersOpen } from "@/lib/graph-parameter-preview";
import { ColorPalette } from "@/components/editor/ColorPalette";

import {
  OverlayLineDashMenuButton,
  OverlayLineWidthMenuButton,
  type OverlayLineDashOption,
  type OverlayLineWidthOption,
} from "@/components/editor/overlay-line-style-menus";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { MathExpressionInput } from "@/components/math/MathExpressionInput";
import { Button, IconButton } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Grid, Inline, Inset, Stack } from "@/components/ui/layout";
import { renderMathHtml } from "@/features/rendering/adapters";
import { MathPreview, useMathEnvironment } from "@/features/rendering/adapters/react";
import type { MathRenderEnvironment } from "@/lib/math-environment";
import { getTexIssues } from "@/lib/sigma-doc-schema";
import { useInlineMathInputMode } from "@/lib/inline-math-mode";
import {
  ORDERED_INLINE_MATH_TEMPLATE_GROUPS,
  type MathTemplateButton,
} from "@/lib/inline-math-templates";
import {
  graphExpressionToTex,
  parseGraphImplicitEquationTex,
  texToGraphExpression,
  texToGraphExpressionWithError,
  type GraphTexErrorCode,
  type GraphRangeTexParts,
} from "@/lib/graph-tex";
import { findGraphCurveIntersections } from "@/lib/graph-intersection";
import { insertEditableMathTemplateTex } from "@/lib/math-tex";
import {
  DEFAULT_GRAPH_FILL_COLOR,
  GRAPH_FILL_PATTERN_OPTIONS,
  normalizeGraphFillOpacity,
  normalizeGraphFillPattern,
} from "@/lib/graph-fill-style";
import {
  DEFAULT_GRAPH_ORIGIN_LABEL_TEX,
  DEFAULT_PARAMETRIC_DOMAIN,
  GRAPH_CURVE_MODE_OPTIONS,
  GRAPH_STROKE_WIDTH_OPTIONS,
  createDefaultGraphCurve,
  createDefaultGraphPoint,
  fitGraphViewBoxToCurves,
  formatRangeValue,
  formatGraphIssue,
  formatGraphWarning,
  getGraphIssues,
  getGraphVisibilityWarnings,
  makeGraphCurveLabel,
  normalizeGraphColor,
  normalizeGraphCurveDash,
  normalizeGraphCurveMode,
  normalizeGraphCurveStrokeWidth,
  type GraphExpressionVariableName,
} from "@/lib/graph2d";
import type {
  Graph2DSpec,
  GraphCurve,
  SigmaChartData,
  SigmaChartSpec,
  GraphCurveDash,
  GraphFillRegion,
  GraphPoint,
  GraphViewBox,
} from "@/features/document";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";

type GraphAxisLabelKey = "x" | "y" | "origin";

function renderMathTemplateButtonHtml(tex: string, environment: MathRenderEnvironment): string {
  let placeholderIndex = 0;
  const previewTex = tex.replace(/#\?/g, () => {
    placeholderIndex += 1;
    return `\\placeholder[${placeholderIndex}]{\\square}`;
  });
  return renderMathHtml(previewTex, environment);
}

function getMathTemplateButtonTitle(template: MathTemplateButton, tShape: Translate<"shape">): string {
  const placeholderCount = (template.tex.match(/#\?/g) ?? []).length;
  if (placeholderCount === 0) {
    return template.label;
  }

  return tShape("math.templateHint", { replace: { name: template.label, slots: placeholderCount } });
}

function clampInlineMathCursor(cursor: number, tex: string): number {
  if (!Number.isFinite(cursor)) {
    return tex.length;
  }

  return Math.min(Math.max(Math.round(cursor), 0), tex.length);
}

export const SELECT_OVERLAY_CHART_EVENT = "sigma-studio:select-overlay-chart";
export const OPEN_OVERLAY_CHART_SETTINGS_EVENT = "sigma-studio:open-overlay-chart-settings";

/**
 * What the shell needs to draw the chart panel.
 *
 * `sourceTable` is the resolved table (or `null` when the reference is broken) rather than a flag,
 * because the panel also lists the series it can colour, and those come from the live data.
 */
export interface SelectedOverlayChart {
  shapeId: string;
  spec: SigmaChartSpec;
  data: SigmaChartData;
  /** False when the chart is drawing from its snapshot because the table is gone. */
  linked: boolean;
  /**
   * Writes a new spec back to the canvas.
   *
   * Carried in the payload rather than sent as a second event, matching `SelectedOverlayGraph`.
   * `areSelectedOverlayChartsEqual` compares only the data fields, so a fresh closure per dispatch
   * does not defeat the shell's bail.
   */
  onSpecChange: (spec: SigmaChartSpec) => void;
}

export const SELECT_OVERLAY_GRAPH_EVENT = "sigma-studio:select-overlay-graph";
export const OPEN_OVERLAY_GRAPH_SETTINGS_EVENT = "sigma-studio:open-overlay-graph-settings";
/** 塗りつぶしのクリックが閉じた領域を解決できなかったときに、設定パネルへ理由を伝える。 */
export const GRAPH_FILL_UNRESOLVED_EVENT = "sigma-studio:graph-fill-unresolved";
export { GRAPH_SETTINGS_POPOVER_Z_INDEX, GraphItemActionsMenu } from "./GraphItemActionsMenu";

/**
 * 数式の検証エラーを利用者向けの一文にする。
 *
 * **`message` は `lib/sigma-doc-schema.ts` が組み立てた日本語**で、ここはそれを
 * 正規表現で読み直している (グラフ側で潰したのと同じ形が残っている面)。
 * schema 側は WI-12 の担当なので、あちらがコード化されたらここも合わせて畳むこと。
 */
export function formatTexIssueForClient(message: string, tShape: Translate<"shape">): string {
  const command = message.match(/未許可のTeXコマンド (.+) があります。$/)?.[1];
  return command
    ? tShape("tex.disallowedCommand", { replace: { command } })
    : tShape("tex.cannotRender");
}

export interface SelectedOverlayGraph {
  shapeId: string;
  spec: Graph2DSpec;
  axisLabelShapeIdsByKey: Partial<Record<GraphAxisLabelKey, string>>;
  axisLabelTextsByKey: Partial<Record<GraphAxisLabelKey, string>>;
  formulaLabelShapeIds: string[];
  formulaLabelShapeIdsByCurveId: Record<string, string>;
  pickingOrigin: boolean;
  pickingFill: boolean;
  onSpecChange: (nextSpec: Graph2DSpec) => void;
  onAxisLabelChange: (key: GraphAxisLabelKey, visible: boolean) => void;
  onAxisLabelTextChange: (key: GraphAxisLabelKey, text: string) => void;
  onFormulaLabelChange: (curveId: string, visible: boolean) => void;
  onStartCrop: () => void;
  onStartOriginPick: () => void;
  onStartFillPick: () => void;
  onClose: () => void;
}

export interface SelectedInlineMath {
  id: string;
  tex: string;
  cursor: number;
  blockId?: string;
  setCursor?: (cursor: number) => void;
  updateTex: (tex: string, cursor?: number) => void;
}

function MathInputModeControl() {
  const tShape = useT("shape");
  const [inputMode, setInputMode] = useInlineMathInputMode();

  return (
    <div className="inline-math-input-mode-row" role="group" aria-label={tShape("math.inputMode")}>
      <button
        type="button"
        className={inputMode === "tex" ? "selected" : ""}
        aria-pressed={inputMode === "tex"}
        onClick={() => setInputMode("tex")}
      >
        TeX
      </button>
      <button
        type="button"
        className={inputMode === "mathlive" ? "selected" : ""}
        aria-pressed={inputMode === "mathlive"}
        onClick={() => setInputMode("mathlive")}
      >
        {tShape("math.realtimeInput")}
      </button>
    </div>
  );
}

/**
 * 選択中のインライン数式に対する入力モードとテンプレート操作。
 * 上部ツールバーの数式ダイアログで編集内容を共有する。
 */
export function InlineMathDetails({
  onInsertTemplate,
  selectedInlineMath,
}: {
  onInsertTemplate?: (templateTex: string) => void;
  selectedInlineMath: SelectedInlineMath | null;
}) {
  const tShape = useT("shape");
  const mathEnvironment = useMathEnvironment();
  const cursor = selectedInlineMath
    ? clampInlineMathCursor(selectedInlineMath.cursor, selectedInlineMath.tex)
    : 0;

  const insertTemplate = (templateTex: string) => {
    if (!selectedInlineMath) {
      onInsertTemplate?.(templateTex);
      return;
    }
    const insertion = insertEditableMathTemplateTex(selectedInlineMath.tex, cursor, templateTex);
    selectedInlineMath.updateTex(insertion.tex, insertion.cursor);
  };

  return (
    <div className="editor-settings-section">
      <MathInputModeControl />
      {selectedInlineMath || onInsertTemplate ? (
        <div className="inline-math-template-palette" aria-label={tShape("math.templates")}>
          {ORDERED_INLINE_MATH_TEMPLATE_GROUPS.map((group) => (
            <section className="inline-math-template-group" key={group.id}>
              <h3>{tShape(`mathTemplateGroup.${group.id}`)}</h3>
              <div className="inline-math-template-row">
                {group.templates.map((template) => (
                  <button
                    type="button"
                    className="inline-math-template-button"
                    key={template.id}
                    title={getMathTemplateButtonTitle(template, tShape)}
                    aria-label={getMathTemplateButtonTitle(template, tShape)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertTemplate(template.tex)}
                    dangerouslySetInnerHTML={{ __html: renderMathTemplateButtonHtml(template.tex, mathEnvironment) }}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : null}

      {selectedInlineMath ? getTexIssues(selectedInlineMath.tex, selectedInlineMath.id).map((issue, index) => (
        <p className="inline-error" key={`${issue}-${index}`}>
          {formatTexIssueForClient(issue, tShape)}
        </p>
      )) : null}
    </div>
  );
}

// グラフは白黒印刷を基本とするため、推奨パレットは黒・グレー階調を先頭に置く。
const GRAPH_RECOMMENDED_COLORS: readonly string[] = [
  "#0d0d0d",
  "#374151",
  "#6b7280",
  "#9ca3af",
  "#d1d5db",
  "#dc2626",
  "#2563eb",
];

/**
 * 既定の線種・線幅。module 直下で文言を持たず、描画時に `t` で作る。
 *
 * 線種の語 (実線 / 破線 / 点線) は**ツールバーと同じ言葉**なので、辞書も
 * `chrome.format.lineDash.*` を唯一の出典にする (同じラベルの辞書を 2 つ持つと必ずドリフトする)。
 */
function buildGraphDashMenuOptions(t: Translate<"chrome">): OverlayLineDashOption<GraphCurveDash>[] {
  return [
    { value: "solid", label: t("format.lineDash.solid") },
    { value: "dashed", label: t("format.lineDash.dashed"), dasharray: "8 5" },
    { value: "dotted", label: t("format.lineDash.dotted"), dasharray: "1 5" },
  ];
}

function buildGraphLineWidthMenuOptions(t: Translate<"shape">): OverlayLineWidthOption<string>[] {
  return GRAPH_STROKE_WIDTH_OPTIONS.map((option) => ({
    value: String(option.value),
    label: t(`graphStrokeWidth.${option.id}` as never) as string,
    strokeWidth: option.value,
  }));
}

function graphCurveExprTex(curve: GraphCurve): string {
  return curve.exprTex?.trim() || graphExpressionToTex(curve.expr);
}

function graphCurveYExprTex(curve: GraphCurve): string {
  return curve.yExprTex?.trim() || (curve.yExpr ? graphExpressionToTex(curve.yExpr) : "");
}

function getNextPointLabel(points: readonly GraphPoint[]): string {
  const labels = new Set(points.map((point) => point.label).filter((label): label is string => Boolean(label)));
  if (!labels.has("P")) {
    return "P";
  }

  for (let index = 2; ; index += 1) {
    const label = `P_${index}`;
    if (!labels.has(label)) {
      return label;
    }
  }
}

/**
 * 選択中の graph2dShape を SigmaDoc の仕様へ書き戻す詳細 UI。
 * 描画は Graph2DPreview に委ね、ここでは入力、表示状態、編集モードだけを扱う。
 */
export function OverlayGraphSettings({ selectedOverlayGraph }: { selectedOverlayGraph: SelectedOverlayGraph }) {
  const {
    spec,
    axisLabelShapeIdsByKey,
    axisLabelTextsByKey,
    formulaLabelShapeIdsByCurveId,
    pickingOrigin,
    pickingFill,
    onSpecChange,
    onAxisLabelChange,
    onAxisLabelTextChange,
    onFormulaLabelChange,
    onStartCrop,
    onStartOriginPick,
    onStartFillPick,
  } = selectedOverlayGraph;
  const specRef = useRef(spec);
  useEffect(() => {
    specRef.current = spec;
  }, [spec]);
  const tShape = useT("shape");
  const issues = useMemo(
    () => getGraphIssues(spec, selectedOverlayGraph.shapeId),
    [selectedOverlayGraph.shapeId, spec],
  );
  const warnings = useMemo(() => getGraphVisibilityWarnings(spec), [spec]);
  const allMessages = [
    ...issues.map((issue) => formatGraphIssue(issue, tShape)),
    ...warnings.map((code) => formatGraphWarning(code, tShape)),
  ];
  const [openStyleMenu, setOpenStyleMenu] = useState<string | null>(null);
  // **理由はコードで持ち、描画時に辞書へ通す。** 文言を state に入れると、
  // 表示中に言語を切り替えたとき古い言語のまま残る (`GraphExpressionMathInput` と同じ規約)。
  const [intersectionReason, setIntersectionReason] = useState<"noIntersection" | null>(null);
  const intersectionMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fillUnresolved, setFillUnresolved] = useState(false);
  const fillUnresolvedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 塗りモードを出入りしたら古い警告は捨てる。パネルのボタンからでも右クリック
  // メニューからでも同じように効かせるため、クリックハンドラではなく
  // pickingFill の変化そのもので判定する (props 変化に合わせた state 調整)。
  const [fillPickingAtWarning, setFillPickingAtWarning] = useState(pickingFill);
  if (fillPickingAtWarning !== pickingFill) {
    setFillPickingAtWarning(pickingFill);
    setFillUnresolved(false);
  }
  useEffect(() => {
    dispatchGraphParametersOpen(selectedOverlayGraph.shapeId, true);
    return () => dispatchGraphParametersOpen(selectedOverlayGraph.shapeId, false);
  }, [selectedOverlayGraph.shapeId]);
  const tickFontSize = spec.axes.tickFontSize ?? 9;

  useEffect(() => () => {
    if (intersectionMessageTimerRef.current) {
      clearTimeout(intersectionMessageTimerRef.current);
    }
  }, []);

  // 塗りつぶしが閉じた領域を解決できなかったとき、クリックが無反応に見えないよう理由を出す。
  useEffect(() => {
    const handleFillUnresolved = (event: Event) => {
      const detail = event instanceof CustomEvent ? (event.detail as { shapeId?: unknown } | null) : null;
      if (detail?.shapeId !== selectedOverlayGraph.shapeId) {
        return;
      }

      setFillUnresolved(true);
      if (fillUnresolvedTimerRef.current) {
        clearTimeout(fillUnresolvedTimerRef.current);
      }
      fillUnresolvedTimerRef.current = setTimeout(() => setFillUnresolved(false), 5000);
    };

    window.addEventListener(GRAPH_FILL_UNRESOLVED_EVENT, handleFillUnresolved);
    return () => window.removeEventListener(GRAPH_FILL_UNRESOLVED_EVENT, handleFillUnresolved);
  }, [selectedOverlayGraph.shapeId]);

  useEffect(() => () => {
    if (fillUnresolvedTimerRef.current) {
      clearTimeout(fillUnresolvedTimerRef.current);
    }
  }, []);

  const activeFillUnresolvedMessage = pickingFill && fillUnresolved ? tShape("graph.fillUnresolved") : "";
  const modeStatusMessage = activeFillUnresolvedMessage
    || (pickingOrigin ? tShape("graph.pickOriginHint") : "")
    || (pickingFill ? tShape("graph.pickFillHint") : "");

  const updateSpec = (updater: (current: Graph2DSpec) => Graph2DSpec) => {
    const nextSpec = updater(specRef.current);
    specRef.current = nextSpec;
    onSpecChange(nextSpec);
  };

  const updateCurve = (curveId: string, patch: Partial<GraphCurve>) => {
    updateSpec((current) => ({
      ...current,
      curves: current.curves.map((curve) => (curve.id === curveId ? { ...curve, ...patch } : curve)),
    }));
  };

  const updateCurveDomain = (curveId: string, parts: GraphRangeTexParts | null) => {
    updateSpec((current) => ({
      ...current,
      curves: current.curves.map((curve) => {
        if (curve.id !== curveId) {
          return curve;
        }

        const nextCurve: GraphCurve = { ...curve };
        if (!parts || (parts.min === undefined && parts.max === undefined)) {
          delete nextCurve.domain;
          return nextCurve;
        }
        nextCurve.domain = {
          ...(parts.min !== undefined ? { min: parts.min } : {}),
          ...(parts.max !== undefined ? { max: parts.max } : {}),
        };
        return nextCurve;
      }),
    }));
  };

  const updateCurveMode = (curve: GraphCurve, mode: NonNullable<GraphCurve["mode"]>) => {
    const patch = createCurveModePatch(curve, mode);
    updateCurve(curve.id, patch);
  };

  const updateAxisRange = (axis: "x" | "y", parts: GraphRangeTexParts) => {
    updateSpec((current) => ({
      ...current,
      viewBox: {
        ...current.viewBox,
        ...(axis === "x"
          ? { xMin: parts.min ?? current.viewBox.xMin, xMax: parts.max ?? current.viewBox.xMax }
          : { yMin: parts.min ?? current.viewBox.yMin, yMax: parts.max ?? current.viewBox.yMax }),
      },
    }));
  };

  const updateDisplayRange = (axis: "x" | "y", parts: GraphRangeTexParts) => {
    updateSpec((current) => {
      const base = current.graphViewBox ?? current.viewBox;
      return {
        ...current,
        graphViewBox: {
          ...base,
          ...(axis === "x"
            ? { xMin: parts.min ?? base.xMin, xMax: parts.max ?? base.xMax }
            : { yMin: parts.min ?? base.yMin, yMax: parts.max ?? base.yMax }),
        },
      };
    });
  };

  const updateTickStep = (axis: "x" | "y", expression: string | null) => {
    updateSpec((current) => ({
      ...current,
      axes: {
        ...current.axes,
        ...(axis === "x" ? { xTickStep: expression ?? "" } : { yTickStep: expression ?? "" }),
      },
    }));
  };

  const setGraphViewBoxSameAsAxis = (sameAsAxis: boolean) => {
    updateSpec((current) => {
      if (sameAsAxis) {
        const next = { ...current };
        delete next.graphViewBox;
        return next;
      }

      return {
        ...current,
        graphViewBox: { ...current.viewBox },
      };
    });
  };

  const addCurve = () => {
    updateSpec((current) => ({
      ...current,
      curves: [...current.curves, createDefaultGraphCurve(current.curves.length)],
    }));
  };

  const removeCurve = (curveId: string) => {
    updateSpec((current) => ({
      ...current,
      curves: current.curves.filter((curve) => curve.id !== curveId),
    }));
  };

  const addPoint = () => {
    updateSpec((current) => ({
      ...current,
      points: [...(current.points ?? []), createDefaultGraphPoint(current.points?.length ?? 0)],
    }));
  };

  const findIntersections = () => {
    const currentSpec = specRef.current;
    const intersections = findGraphCurveIntersections(currentSpec);
    if (intersections.length === 0) {
      if (intersectionMessageTimerRef.current) {
        clearTimeout(intersectionMessageTimerRef.current);
      }
      setIntersectionReason("noIntersection");
      intersectionMessageTimerRef.current = setTimeout(() => {
        setIntersectionReason(null);
        intersectionMessageTimerRef.current = null;
      }, 2000);
      return;
    }

    if (intersectionMessageTimerRef.current) {
      clearTimeout(intersectionMessageTimerRef.current);
      intersectionMessageTimerRef.current = null;
    }
    setIntersectionReason(null);

    const labeledPoints = [...(currentSpec.points ?? [])];
    const newPoints = intersections.map((intersection) => {
      const x = formatRangeValue(intersection.x);
      const y = formatRangeValue(intersection.y);
      const point: GraphPoint = {
        ...createDefaultGraphPoint(labeledPoints.length),
        x,
        y,
        xTex: graphExpressionToTex(x),
        yTex: graphExpressionToTex(y),
        label: getNextPointLabel(labeledPoints),
      };
      labeledPoints.push(point);
      return point;
    });

    updateSpec((current) => ({
      ...current,
      points: [...(current.points ?? []), ...newPoints],
    }));
  };

  const updatePoint = (pointId: string, patch: Partial<GraphPoint>) => {
    updateSpec((current) => ({
      ...current,
      points: (current.points ?? []).map((point) => (point.id === pointId ? { ...point, ...patch } : point)),
    }));
  };

  const removePoint = (pointId: string) => {
    updateSpec((current) => {
      const points = (current.points ?? []).filter((point) => point.id !== pointId);
      if (points.length === 0) {
        const next = { ...current };
        delete next.points;
        return next;
      }

      return { ...current, points };
    });
  };

  const updateFill = (fillId: string, patch: Partial<GraphFillRegion>) => {
    updateSpec((current) => ({
      ...current,
      fills: (current.fills ?? []).map((fill) => (fill.id === fillId ? { ...fill, ...patch } : fill)),
    }));
  };

  const removeFill = (fillId: string) => {
    updateSpec((current) => {
      const fills = (current.fills ?? []).filter((fill) => fill.id !== fillId);
      if (fills.length === 0) {
        const next = { ...current };
        delete next.fills;
        return next;
      }

      return { ...current, fills };
    });
  };

  const isAxisLabelVisible = (key: GraphAxisLabelKey): boolean => {
    if (axisLabelShapeIdsByKey[key]) {
      return true;
    }
    if (key === "x") return Boolean(spec.axes.xLabel?.trim());
    if (key === "y") return Boolean(spec.axes.yLabel?.trim());
    return Boolean(spec.axes.originLabel?.trim());
  };

  const setAxisLabelVisible = (key: GraphAxisLabelKey, visible: boolean) => {
    onAxisLabelChange(key, visible);
  };

  const getAxisLabelText = (key: GraphAxisLabelKey): string => {
    const current = axisLabelTextsByKey[key];
    if (current !== undefined) {
      return current;
    }
    if (key === "x") return spec.axes.xLabel?.trim() || "x";
    if (key === "y") return spec.axes.yLabel?.trim() || "y";
    return spec.axes.originLabel?.trim() || DEFAULT_GRAPH_ORIGIN_LABEL_TEX;
  };

  const graphViewBox = spec.graphViewBox ?? spec.viewBox;
  const targetCurves = spec.curves.filter((curve) => {
    const mode = normalizeGraphCurveMode(curve.mode);
    return mode === "yOfX" || mode === "xOfY" || mode === "parametric";
  });
  const axisLabelControls = [
    { key: "x", label: "x", textLabel: "x", disabled: spec.axes.showX === false },
    { key: "y", label: "y", textLabel: "y", disabled: spec.kind !== "cartesian" || spec.axes.showY === false },
    { key: "origin", label: tShape("graph.origin"), textLabel: tShape("graph.origin"), disabled: spec.axes.showX === false || (spec.kind === "cartesian" && spec.axes.showY === false) },
  ] satisfies Array<{ key: GraphAxisLabelKey; label: string; textLabel: string; disabled: boolean }>;

  return (
    <Inset className="editor-settings-section overlay-graph-inspector" space="md">
      <Stack gap="none">
        <Inline className="graph-tool-row" gap="xs" role="group" aria-label={tShape("graph.toolsAria")}>
          <IconButton
            label={tShape("graph.pickOrigin")}
            tooltip={{ label: tShape("graph.pickOriginTooltip") }}
            tone="secondary"
            className={`graph-tool-button ${pickingOrigin ? "active" : ""}`}
            aria-pressed={pickingOrigin}
            onClick={onStartOriginPick}
            data-testid="overlay-graph-origin-button"
          >
            <Crosshair size={15} aria-hidden="true" />
          </IconButton>

          <IconButton
            label={tShape("graph.fillArea")}
            // 無効なボタンは hover/focus を発火しないので Tooltip が出ない。
            // 理由に到達できるようネイティブ title へ落とす。
            title={spec.kind === "cartesian" ? undefined : tShape("graph.fillCartesianOnlyTooltip")}
            tooltip={spec.kind === "cartesian" ? { label: tShape("graph.fillTooltip") } : undefined}
            tone="secondary"
            className={`graph-tool-button ${pickingFill ? "active" : ""}`}
            aria-pressed={pickingFill}
            disabled={spec.kind !== "cartesian"}
            onClick={onStartFillPick}
            data-testid="overlay-graph-fill-button"
          >
            <PaintBucket size={15} aria-hidden="true" />
          </IconButton>

          <IconButton
            label={tShape("graph.trim")}
            tooltip={{ label: tShape("graph.trimTooltip") }}
            tone="secondary"
            className="graph-tool-button"
            onClick={onStartCrop}
            data-testid="overlay-graph-crop-button"
          >
            <Crop size={15} aria-hidden="true" />
          </IconButton>
        </Inline>

        {/* live region は常にマウントしておく。表示と同時に挿入すると読み上げが不安定になるため、
            空のときは display:none にせず視覚的に潰すだけにする。 */}
        <div
          className="graph-mode-status"
          role="status"
          data-empty={modeStatusMessage ? undefined : "true"}
          data-tone={activeFillUnresolvedMessage ? "warning" : "info"}
          data-testid="overlay-graph-mode-status"
        >
          {modeStatusMessage}
        </div>

      <GraphSettingsSection title={tShape("graph3dUi.parametersSection")} count={spec.parameters?.length ?? 0}>
        <GraphParameters key={selectedOverlayGraph.shapeId} parameters={spec.parameters ?? []}
          onChange={(updater) => updateSpec((current) => ({ ...current, parameters: updater(current.parameters ?? []) }))}
          onPreview={(overrides, playing) => dispatchGraphParameterPreview({ shapeId: selectedOverlayGraph.shapeId, overrides, playing })} />
        <Graph2DVideoExport key={selectedOverlayGraph.shapeId} spec={spec} />
      </GraphSettingsSection>

      <GraphSettingsSection title={tShape("graph.curve")} count={spec.curves.length} defaultOpen>
        <GraphCardGrid className="graph-curve-list">
          {spec.curves.map((curve, index) => (
            <GraphCurveCard
              key={curve.id}
              curve={curve}
              index={index}
              graphViewBox={graphViewBox}
              formulaLabelVisible={Boolean(formulaLabelShapeIdsByCurveId[curve.id])}
              openStyleMenu={openStyleMenu}
              onOpenStyleMenuChange={setOpenStyleMenu}
              onFormulaLabelToggle={(visible) => onFormulaLabelChange(curve.id, visible)}
              onPatch={(patch) => updateCurve(curve.id, patch)}
              onModeChange={(mode) => updateCurveMode(curve, mode)}
              onDomainCommit={(parts) => updateCurveDomain(curve.id, parts)}
              onRemove={() => removeCurve(curve.id)}
            />
          ))}
          <GraphAddCard label={tShape("graph.addCurve")} onClick={addCurve} />
        </GraphCardGrid>
      </GraphSettingsSection>

      <GraphSettingsSection title={tShape("graph.point")} count={(spec.points ?? []).length} defaultOpen>
        <GraphCardGrid className="graph-curve-list">
          {(spec.points ?? []).map((point, index) => (
            <GraphPointCard
              key={point.id}
              point={point}
              index={index}
              cartesian={spec.kind === "cartesian"}
              openStyleMenu={openStyleMenu}
              onOpenStyleMenuChange={setOpenStyleMenu}
              onPatch={(patch) => updatePoint(point.id, patch)}
              onRemove={() => removePoint(point.id)}
            />
          ))}
          <GraphAddCard label={tShape("graph.addPoint")} onClick={addPoint} />
        </GraphCardGrid>
        {/* 曲線が2本未満では交点が定義できない。常時出して大半を死にボタンにせず、
            意味を持つときだけ控えめな補助操作として出す。 */}
        {targetCurves.length >= 2 && (
          <Button
            tone="ghost"
            size="sm"
            className="graph-find-intersections-button"
            onClick={findIntersections}
            aria-label={tShape("graph.addIntersection")}
          >
            {tShape("graph.addIntersection")}
          </Button>
        )}
        {intersectionReason && (
          <div className="intersection-message" role="status">
            {tShape(`graph.${intersectionReason}`)}
          </div>
        )}
      </GraphSettingsSection>

      {(spec.fills ?? []).length > 0 && (
        <GraphSettingsSection title={tShape("graph.fill")} count={(spec.fills ?? []).length} defaultOpen>
          <GraphCardGrid className="graph-curve-list">
            {(spec.fills ?? []).map((fill, index) => (
              <GraphFillCard
                key={fill.id}
                fill={fill}
                index={index}
                openStyleMenu={openStyleMenu}
                onOpenStyleMenuChange={setOpenStyleMenu}
                onPatch={(patch) => updateFill(fill.id, patch)}
                onRemove={() => removeFill(fill.id)}
              />
            ))}
          </GraphCardGrid>
        </GraphSettingsSection>
      )}

      <GraphSettingsSection title={tShape("graph.displayRange")} defaultOpen={false}>
        <label className="field-label">{tShape("graph.axisRangeLabel")}</label>
        <Stack className="graph-range-input-grid" gap="sm">
          <GraphRangeInput
            min={spec.viewBox.xMin}
            max={spec.viewBox.xMax}
            variableName="x"
            requireBoth
            ariaLabel={tShape("graph.xAxisRange")}
            dataTestId="overlay-graph-x-range"
            onCommitRange={(parts) => parts && updateAxisRange("x", parts)}
          />
          {spec.kind === "cartesian" && (
            <GraphRangeInput
              min={spec.viewBox.yMin}
              max={spec.viewBox.yMax}
              variableName="y"
              requireBoth
              ariaLabel={tShape("graph.yAxisRange")}
              dataTestId="overlay-graph-y-range"
              onCommitRange={(parts) => parts && updateAxisRange("y", parts)}
            />
          )}
        </Stack>

        <Inline className="graph-range-heading" gap="sm" justify="between">
          <label className="field-label">{tShape("graph.graphRangeLabel")}</label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={!spec.graphViewBox}
              onChange={(event) => setGraphViewBoxSameAsAxis(event.target.checked)}
            />
            <span>{tShape("graph.sameAsAxisRange")}</span>
          </label>
        </Inline>
        {spec.graphViewBox && (
          <Stack className="graph-range-input-grid" gap="sm">
            <GraphRangeInput
              min={graphViewBox.xMin}
              max={graphViewBox.xMax}
              variableName="x"
              requireBoth
              ariaLabel={tShape("graph.xDisplayRange")}
              dataTestId="overlay-graph-display-x-range"
              onCommitRange={(parts) => parts && updateDisplayRange("x", parts)}
            />
            {spec.kind === "cartesian" && (
              <GraphRangeInput
                min={graphViewBox.yMin}
                max={graphViewBox.yMax}
                variableName="y"
                requireBoth
                ariaLabel={tShape("graph.yDisplayRange")}
                dataTestId="overlay-graph-display-y-range"
                onCommitRange={(parts) => parts && updateDisplayRange("y", parts)}
              />
            )}
          </Stack>
        )}

        <label className="field-label">{tShape("graph.tickStepLabel")}</label>
        <Grid className="graph-range-input-grid halves" columns={2} gap="sm" responsive={false}>
          <Stack className="graph-style-field" gap="xs">
            <span>x</span>
            <GraphExpressionMathInput
              tex={spec.axes.xTickStep?.trim() ? graphExpressionToTex(spec.axes.xTickStep) : ""}
              ariaLabel={tShape("graph.xTickStep")}
              placeholderTex="1"
              allowEmpty
              dataTestId="overlay-graph-x-tick-step"
              onCommitExpression={(expression) => updateTickStep("x", expression)}
              onClear={() => updateTickStep("x", null)}
            />
          </Stack>
          <Stack className="graph-style-field" gap="xs">
            <span>y</span>
            <GraphExpressionMathInput
              tex={spec.axes.yTickStep?.trim() ? graphExpressionToTex(spec.axes.yTickStep) : ""}
              ariaLabel={tShape("graph.yTickStep")}
              placeholderTex="1"
              allowEmpty
              dataTestId="overlay-graph-y-tick-step"
              onCommitExpression={(expression) => updateTickStep("y", expression)}
              onClear={() => updateTickStep("y", null)}
            />
          </Stack>
        </Grid>

        <GraphTickFontSizeInput
          key={tickFontSize}
          value={tickFontSize}
          onCommit={(nextTickFontSize) => {
            updateSpec((current) => ({
              ...current,
              axes: { ...current.axes, tickFontSize: nextTickFontSize },
            }));
          }}
        />

        <label className="field-label">{tShape("graph.axisVisibility")}</label>
        <Grid className="graph-checkbox-grid" columns={2} gap="sm" responsive={false}>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={spec.axes.showX !== false}
              onChange={(event) => {
                const showX = event.target.checked;
                updateSpec((current) => ({ ...current, axes: { ...current.axes, showX } }));
              }}
            />
            <span>{tShape("graph.xAxis")}</span>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={spec.axes.showY !== false && spec.kind === "cartesian"}
              disabled={spec.kind !== "cartesian"}
              onChange={(event) => {
                const showY = event.target.checked;
                updateSpec((current) => ({ ...current, axes: { ...current.axes, showY } }));
              }}
            />
            <span>{tShape("graph.yAxis")}</span>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={spec.axes.showTicks !== false}
              onChange={(event) => {
                const showTicks = event.target.checked;
                updateSpec((current) => ({ ...current, axes: { ...current.axes, showTicks } }));
              }}
            />
            <span>{tShape("graph.ticks")}</span>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={spec.axes.grid}
              onChange={(event) => {
                const grid = event.target.checked;
                updateSpec((current) => ({ ...current, axes: { ...current.axes, grid } }));
              }}
            />
            <span>{tShape("graph.grid")}</span>
          </label>
        </Grid>
      </GraphSettingsSection>

      <GraphSettingsSection title={tShape("graph.axisName")} defaultOpen={false}>
        <Stack className="graph-axis-label-list" gap="sm">
          {axisLabelControls.map(({ key, label, textLabel, disabled }) => {
            const visible = isAxisLabelVisible(key);
            return (
              <Inline className="graph-axis-label-row" key={key} gap="sm" align="center">
                <label className="checkbox-field graph-axis-label-toggle">
                  <input
                    type="checkbox"
                    checked={visible}
                    disabled={disabled}
                    data-testid={`overlay-graph-axis-label-${key}`}
                    onChange={(event) => setAxisLabelVisible(key, event.target.checked)}
                  />
                  <span>{label}</span>
                </label>
                <MathExpressionInput
                  tex={getAxisLabelText(key)}
                  disabled={disabled || !visible}
                  ariaLabel={key === "origin"
                    ? tShape("graph.originLabelName")
                    : tShape("graph.axisNameOf", { replace: { axis: textLabel } })}
                  data-testid={`overlay-graph-axis-label-text-${key}`}
                  onCommit={(tex) => onAxisLabelTextChange(key, tex.trim())}
                />
              </Inline>
            );
          })}
        </Stack>
      </GraphSettingsSection>

        {allMessages.map((message, index) => (
          <p className="graph-settings-message" key={`${message}-${index}`}>
            {message}
          </p>
        ))}
        {warnings.length > 0 && (
          <Button
            tone="secondary"
            data-testid="overlay-graph-fit-view-box"
            onClick={() => updateSpec(fitGraphViewBoxToCurves)}
          >
            {tShape("graph.fitToCurves")}
          </Button>
        )}
      </Stack>
    </Inset>
  );
}

/** 関数式を主役に置き、線の見た目と定義域を段階的に編集するカード。 */
/**
 * 曲線1本の見た目（色・線種・太さ）を変える操作列。
 * 設定パネルの関数カードと、グラフ上の3点メニューの両方から使う共有部品。
 */
export function GraphCurveStyleControls({
  curve,
  label,
  menuKeyPrefix,
  openStyleMenu,
  onOpenStyleMenuChange,
  onPatch,
  popoverZIndex = GRAPH_SETTINGS_POPOVER_Z_INDEX,
  testIdPrefix,
}: {
  curve: GraphCurve;
  /** 「関数 1」など、各操作の aria-label の主語になる短い名前。 */
  label: string;
  /** 排他制御に使う開閉キーの接頭辞。呼び出し元ごとに別の値を渡すこと。 */
  menuKeyPrefix: string;
  openStyleMenu: string | null;
  onOpenStyleMenuChange: (key: string | null) => void;
  onPatch: (patch: Partial<GraphCurve>) => void;
  popoverZIndex?: CSSProperties["zIndex"];
  testIdPrefix?: string;
}) {
  const tShape = useT("shape");
  const tChrome = useT("chrome");
  const dashButtonRef = useRef<HTMLButtonElement | null>(null);
  const widthButtonRef = useRef<HTMLButtonElement | null>(null);
  const curveColor = normalizeGraphColor(curve.color);
  const curveDash = normalizeGraphCurveDash(curve.dash);
  const curveStrokeWidth = normalizeGraphCurveStrokeWidth(curve.strokeWidth);
  const colorMenuKey = `${menuKeyPrefix}-color`;
  const dashMenuKey = `${menuKeyPrefix}-dash`;
  const widthMenuKey = `${menuKeyPrefix}-width`;

  return (
    <>
      <GraphColorControl
        label={tShape("graphStyle.colorOf", { target: label })}
        value={curveColor}
        menuKey={colorMenuKey}
        openStyleMenu={openStyleMenu}
        onOpenStyleMenuChange={onOpenStyleMenuChange}
        onChange={(color) => onPatch({ color })}
        popoverZIndex={popoverZIndex}
        data-testid={testIdPrefix ? `${testIdPrefix}-color-select` : undefined}
      />
      <span className="graph-style-menu" data-testid={testIdPrefix ? `${testIdPrefix}-dash-select` : undefined}>
        <OverlayLineDashMenuButton
          buttonRef={dashButtonRef}
          options={buildGraphDashMenuOptions(tChrome)}
          currentValue={curveDash}
          open={openStyleMenu === dashMenuKey}
          onToggle={() => onOpenStyleMenuChange(openStyleMenu === dashMenuKey ? null : dashMenuKey)}
          onSelect={(dash) => {
            onPatch({ dash });
            onOpenStyleMenuChange(null);
          }}
          popoverZIndex={popoverZIndex}
        />
      </span>
      <span className="graph-style-menu" data-testid={testIdPrefix ? `${testIdPrefix}-stroke-width-select` : undefined}>
        <OverlayLineWidthMenuButton
          buttonRef={widthButtonRef}
          options={buildGraphLineWidthMenuOptions(tShape)}
          currentValue={String(curveStrokeWidth)}
          open={openStyleMenu === widthMenuKey}
          onToggle={() => onOpenStyleMenuChange(openStyleMenu === widthMenuKey ? null : widthMenuKey)}
          onSelect={(value) => {
            onPatch({ strokeWidth: Number(value) });
            onOpenStyleMenuChange(null);
          }}
          popoverZIndex={popoverZIndex}
        />
      </span>
    </>
  );
}

/**
 * 削除項目を押す直前に、フォーカスを生き残るパネル本体へ退避させる。
 *
 * 「関数を削除」「塗りつぶしを削除」は自分のアンカーごと unmount するので、
 * ToolbarPopover のフォーカス復帰先が消えてフォーカスが `body` へ落ちる。すると
 * キャンバスのキーボードハンドラの `[data-non-modal-surface]` 判定を抜けて、
 * 次の Delete が選択中のグラフごと消す。
 */
function focusGraphSettingsSurface() {
  if (typeof document === "undefined") {
    return;
  }

  document.querySelector<HTMLElement>("[data-graph-settings-panel]")?.focus({ preventScroll: true });
}

export function GraphCurveActionsMenuContent({
  curve,
  index,
  formulaLabelVisible,
  openStyleMenu,
  onOpenStyleMenuChange,
  onFormulaLabelToggle,
  onPatch,
  onRemove,
}: {
  curve: GraphCurve;
  index: number;
  formulaLabelVisible: boolean;
  openStyleMenu: string | null;
  onOpenStyleMenuChange: (key: string | null) => void;
  onFormulaLabelToggle: (visible: boolean) => void;
  onPatch: (patch: Partial<GraphCurve>) => void;
  onRemove: () => void;
}) {
  const tShape = useT("shape");
  return (
    <>
      <div className="graph-item-style-row" role="group" aria-label={tShape("graph.curveLineStyle", { index: index + 1 })}>
        <GraphCurveStyleControls
          curve={curve}
          label={tShape("graph.curveN", { index: index + 1 })}
          menuKeyPrefix={`curve-${curve.id}`}
          openStyleMenu={openStyleMenu}
          onOpenStyleMenuChange={onOpenStyleMenuChange}
          onPatch={onPatch}
          testIdPrefix={index === 0 ? "overlay-graph" : undefined}
        />
      </div>
      <div className="graph-item-actions-separator" role="separator" />
      <button
        type="button"
        aria-pressed={formulaLabelVisible}
        onClick={() => onFormulaLabelToggle(!formulaLabelVisible)}
      >
        <Tag size={13} aria-hidden="true" />
        <span>{tShape("graph.toggleFormula", { action: formulaLabelVisible ? tShape("graph.hide") : tShape("graph.show") })}</span>
      </button>
      <Button
        tone="danger"
        size="sm"
        aria-label={tShape("graph.curveDelete", { index: index + 1 })}
        onClick={() => {
          focusGraphSettingsSurface();
          onRemove();
        }}
      >
        <Trash2 size={14} aria-hidden="true" />
        <span>{tShape("graph.deleteCurve")}</span>
      </Button>
    </>
  );
}

function GraphCurveCard({
  curve,
  index,
  graphViewBox,
  formulaLabelVisible,
  openStyleMenu,
  onOpenStyleMenuChange,
  onFormulaLabelToggle,
  onPatch,
  onModeChange,
  onDomainCommit,
  onRemove,
}: {
  curve: GraphCurve;
  index: number;
  graphViewBox: GraphViewBox;
  formulaLabelVisible: boolean;
  openStyleMenu: string | null;
  onOpenStyleMenuChange: (key: string | null) => void;
  onFormulaLabelToggle: (visible: boolean) => void;
  onPatch: (patch: Partial<GraphCurve>) => void;
  onModeChange: (mode: NonNullable<GraphCurve["mode"]>) => void;
  onDomainCommit: (parts: GraphRangeTexParts | null) => void;
  onRemove: () => void;
}) {
  const tShape = useT("shape");
  const curveMode = normalizeGraphCurveMode(curve.mode);
  const variableName: GraphExpressionVariableName = curveMode === "parametric" ? "t" : curveMode === "xOfY" ? "y" : "x";
  const exprTexValue = graphCurveExprTex(curve);
  const yExprTexValue = graphCurveYExprTex(curve);
  const domainPlaceholderBounds = curveMode === "parametric"
    ? DEFAULT_PARAMETRIC_DOMAIN
    : {
      min: curveMode === "xOfY" ? graphViewBox.yMin : graphViewBox.xMin,
      max: curveMode === "xOfY" ? graphViewBox.yMax : graphViewBox.xMax,
    };
  const detailDefaultOpen =
    curveMode !== "yOfX" ||
    Boolean(curve.domain?.min?.trim()) ||
    Boolean(curve.domain?.max?.trim());

  const commitExpr = (expression: string, tex: string) => {
    onPatch({
      expr: expression,
      exprTex: tex,
      label: curveMode === "parametric"
        ? makeGraphCurveLabel("parametric", tex, yExprTexValue)
        : makeGraphCurveLabel(curveMode, tex),
    });
  };
  const commitYExpr = (expression: string, tex: string) => {
    onPatch({
      yExpr: expression,
      yExprTex: tex,
      label: makeGraphCurveLabel("parametric", exprTexValue, tex),
    });
  };

  return (
    <Inset className="graph-curve-editor" space="sm">
      <Stack gap="sm">
      <Inline className="graph-curve-header" gap="sm" justify="between">
        <Inline className="graph-curve-heading" gap="xs">
          <span
            className="graph-curve-style-summary"
            style={{
              borderTopColor: normalizeGraphColor(curve.color),
              borderTopStyle: normalizeGraphCurveDash(curve.dash) === "solid" ? "solid" : normalizeGraphCurveDash(curve.dash),
              borderTopWidth: Math.max(1, normalizeGraphCurveStrokeWidth(curve.strokeWidth)),
            }}
            aria-hidden="true"
          />
          <span className="graph-curve-title">{tShape("graph.curveN", { index: index + 1 })}</span>
        </Inline>
        <Inline className="graph-curve-header-actions" gap="xs">
          <GraphItemActionsMenu
            label={tShape("graph.curveActions", { index: index + 1 })}
            testId={index === 0 ? "overlay-graph-curve-actions" : undefined}
            onCloseNestedMenus={() => onOpenStyleMenuChange(null)}
          >
            <GraphCurveActionsMenuContent
              curve={curve}
              index={index}
              formulaLabelVisible={formulaLabelVisible}
              openStyleMenu={openStyleMenu}
              onOpenStyleMenuChange={onOpenStyleMenuChange}
              onFormulaLabelToggle={onFormulaLabelToggle}
              onPatch={onPatch}
              onRemove={onRemove}
            />
          </GraphItemActionsMenu>
        </Inline>
      </Inline>
      {curveMode === "parametric" ? (
        <Stack className="graph-function-rows" gap="sm">
          <Inline className="graph-function-row" gap="sm">
            <MathPreview tex="x=" className="graph-function-prefix" />
            <GraphExpressionMathInput
              tex={exprTexValue}
              ariaLabel={tShape("graph.curveXtExpr", { index: index + 1 })}
              dataTestId={index === 0 ? "overlay-graph-expr-input" : undefined}
              live
              onCommitExpression={commitExpr}
            />
          </Inline>
          <Inline className="graph-function-row" gap="sm">
            <MathPreview tex="y=" className="graph-function-prefix" />
            <GraphExpressionMathInput
              tex={yExprTexValue}
              ariaLabel={tShape("graph.curveYtExpr", { index: index + 1 })}
              dataTestId={index === 0 ? "overlay-graph-y-expr-input" : undefined}
              live
              onCommitExpression={commitYExpr}
            />
          </Inline>
        </Stack>
      ) : curveMode === "implicit" ? (
        <Inline className="graph-function-row" gap="sm">
          <GraphExpressionMathInput
            tex={exprTexValue}
            ariaLabel={tShape("graph.curveImplicitExpr", { index: index + 1 })}
            dataTestId={index === 0 ? "overlay-graph-expr-input" : undefined}
            allowImplicitEquation
            live
            onCommitExpression={commitExpr}
          />
        </Inline>
      ) : (
        <Inline className="graph-function-row" gap="sm">
          <MathPreview tex={curveMode === "xOfY" ? "x=" : "y="} className="graph-function-prefix" />
          <GraphExpressionMathInput
            tex={exprTexValue}
            ariaLabel={tShape("graph.curveExpr", { index: index + 1 })}
            dataTestId={index === 0 ? "overlay-graph-expr-input" : undefined}
            live
            onCommitExpression={commitExpr}
          />
        </Inline>
      )}
      <Disclosure label={tShape("graph.curveAdvanced", { index: index + 1 })} defaultOpen={detailDefaultOpen} className="graph-card-detail">
        <Grid className="graph-curve-select-grid" columns={2} gap="sm" responsive={false}>
          <Stack className="graph-style-field" gap="xs">
            <span>{tShape("graph.direction")}</span>
            <GraphCurveModeControl
              value={curveMode}
              menuKey={`curve-mode-${curve.id}`}
              openStyleMenu={openStyleMenu}
              onOpenStyleMenuChange={onOpenStyleMenuChange}
              data-testid={index === 0 ? "overlay-graph-mode-select" : undefined}
              onChange={onModeChange}
            />
          </Stack>
          <Stack className="graph-style-field" gap="xs">
            <span>{curveMode === "parametric" ? tShape("graph.tRange") : curveMode === "implicit" ? tShape("graph.xRange") : tShape("graph.domain")}</span>
            <GraphRangeInput
              min={curve.domain?.min}
              max={curve.domain?.max}
              variableName={variableName}
              allowEmpty
              ariaLabel={tShape("graph.curveDomain", { index: index + 1 })}
              minPlaceholderTex={graphExpressionToTex(domainPlaceholderBounds.min)}
              maxPlaceholderTex={graphExpressionToTex(domainPlaceholderBounds.max)}
              dataTestId={index === 0 ? "overlay-graph-domain-input" : undefined}
              onCommitRange={onDomainCommit}
            />
          </Stack>
        </Grid>
      </Disclosure>
      </Stack>
    </Inset>
  );
}

/** 関数の向きを数式表示の共通ポップオーバーから選ぶコントロール。 */
function GraphCurveModeControl({
  value,
  menuKey,
  openStyleMenu,
  onOpenStyleMenuChange,
  onChange,
  "data-testid": dataTestId,
}: {
  value: NonNullable<GraphCurve["mode"]>;
  menuKey: string;
  openStyleMenu: string | null;
  onOpenStyleMenuChange: (key: string | null) => void;
  onChange: (mode: NonNullable<GraphCurve["mode"]>) => void;
  "data-testid"?: string;
}) {
  const tShape = useT("shape");
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const open = openStyleMenu === menuKey;
  const currentOption = GRAPH_CURVE_MODE_OPTIONS.find((option) => option.value === value) ?? { label: "y=f(x)", value: "yOfX" };

  return (
    <div className="graph-mode-control">
      <button
        ref={buttonRef}
        type="button"
        className={`graph-mode-button ${open ? "active" : ""}`}
        aria-label={tShape("graph.curveModeCurrent", { mode: currentOption.label })}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={dataTestId}
        onClick={() => onOpenStyleMenuChange(open ? null : menuKey)}
      >
        <MathPreview tex={graphCurveModeOptionTex(value)} className="graph-mode-preview" />
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={() => onOpenStyleMenuChange(null)}
        className="shape-menu graph-mode-menu"
        ariaLabel={tShape("graph.curveModeAria")}
        zIndex={GRAPH_SETTINGS_POPOVER_Z_INDEX}
      >
        {GRAPH_CURVE_MODE_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            className={option.value === value ? "active" : ""}
            aria-label={option.label}
            onClick={() => {
              onChange(option.value);
              onOpenStyleMenuChange(null);
            }}
          >
            <MathPreview tex={graphCurveModeOptionTex(option.value)} className="graph-mode-preview" />
          </button>
        ))}
      </ToolbarPopover>
    </div>
  );
}

function graphCurveModeOptionTex(mode: NonNullable<GraphCurve["mode"]>): string {
  if (mode === "xOfY") {
    return "x=f(y)";
  }
  if (mode === "parametric") {
    return "x=f(t),\\ y=g(t)";
  }
  if (mode === "implicit") {
    return "F(x,y)=c";
  }
  return "y=f(x)";
}

/** 点の見た目と補助線を、関数と同じ hover / focus 操作メニューへまとめる。 */
export function GraphPointActionsMenuContent({
  point,
  index,
  cartesian,
  openStyleMenu,
  onOpenStyleMenuChange,
  onPatch,
  onRemove,
}: {
  point: GraphPoint;
  index: number;
  cartesian: boolean;
  openStyleMenu: string | null;
  onOpenStyleMenuChange: (key: string | null) => void;
  onPatch: (patch: Partial<GraphPoint>) => void;
  onRemove: () => void;
}) {
  const tShape = useT("shape");
  const pointFill = point.fill === "none" ? "none" : "solid";
  const pointColor = normalizeGraphColor(point.color);

  return (
    <>
      <div className="graph-fill-action-grid">
        <div className="graph-item-action-field">
          <span>{tShape("graph.color")}</span>
          <GraphColorControl
            label={tShape("graph.pointColor", { index: index + 1 })}
            value={pointColor}
            menuKey={`point-color-${point.id}`}
            openStyleMenu={openStyleMenu}
            onOpenStyleMenuChange={onOpenStyleMenuChange}
            onChange={(color) => onPatch({ color })}
          />
        </div>
        <div className="graph-item-action-field">
          <span>{tShape("graph.pointShapeLabel")}</span>
          <Inline
            className="graph-segmented"
            gap="xs"
            role="group"
            aria-label={tShape("graph.pointShape", { index: index + 1 })}
            data-testid={index === 0 ? "overlay-graph-point-fill" : undefined}
          >
            <button
              type="button"
              aria-label={tShape("graph.pointFilled")}
              aria-pressed={pointFill === "solid"}
              className={pointFill === "solid" ? "selected" : ""}
              onClick={() => onPatch({ fill: "solid" })}
            >
              <span className="graph-point-fill-swatch solid" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={tShape("graph.pointHollow")}
              aria-pressed={pointFill === "none"}
              className={pointFill === "none" ? "selected" : ""}
              onClick={() => onPatch({ fill: "none" })}
            >
              <span className="graph-point-fill-swatch open" aria-hidden="true" />
            </button>
          </Inline>
        </div>
      </div>
      <label className="graph-item-number-field">
        <span>{tShape("graph.radius")}</span>
        <input
          className="mono-input"
          type="number"
          min="1.5"
          max="12"
          step="0.1"
          value={point.radius ?? ""}
          onChange={(event) => {
            const value = Number.parseFloat(event.target.value);
            onPatch({ radius: Number.isFinite(value) ? value : undefined });
          }}
          aria-label={tShape("graph.pointRadius", { index: index + 1 })}
        />
      </label>
      <div className="graph-item-checkboxes">
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={point.showXProjection === true}
            data-testid={index === 0 ? "overlay-graph-point-x-projection" : undefined}
            onChange={(event) => onPatch({ showXProjection: event.target.checked })}
          />
          <span>{tShape("graph.dropToX")}</span>
        </label>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={point.showYProjection === true}
            data-testid={index === 0 ? "overlay-graph-point-y-projection" : undefined}
            disabled={!cartesian}
            onChange={(event) => onPatch({ showYProjection: event.target.checked })}
          />
          <span>{tShape("graph.dropToY")}</span>
        </label>
      </div>
      <div className="graph-item-actions-separator" role="separator" />
      <Button
        tone="danger"
        size="sm"
        aria-label={tShape("graph.pointDelete", { index: index + 1 })}
        onClick={() => {
          focusGraphSettingsSurface();
          onRemove();
        }}
      >
        <Trash2 size={14} aria-hidden="true" />
        <span>{tShape("graph.deletePoint")}</span>
      </Button>
    </>
  );
}

function GraphPointCard({
  point,
  index,
  cartesian,
  openStyleMenu,
  onOpenStyleMenuChange,
  onPatch,
  onRemove,
}: {
  point: GraphPoint;
  index: number;
  cartesian: boolean;
  openStyleMenu: string | null;
  onOpenStyleMenuChange: (key: string | null) => void;
  onPatch: (patch: Partial<GraphPoint>) => void;
  onRemove: () => void;
}) {
  const tShape = useT("shape");
  const pointColor = normalizeGraphColor(point.color);

  return (
    <Inset className="graph-curve-editor" space="sm">
      <Stack gap="sm">
      <Inline className="graph-curve-header" gap="sm" justify="between">
        <Inline className="graph-curve-heading" gap="xs">
          <span
            className="graph-point-style-summary"
            data-fill={point.fill === "none" ? "none" : "solid"}
            style={{ borderColor: pointColor, background: point.fill === "none" ? "var(--background)" : pointColor }}
            aria-hidden="true"
          />
          <span className="graph-curve-title">{tShape("graph.pointN", { index: index + 1 })}</span>
        </Inline>
        <Inline className="graph-curve-header-actions" gap="xs">
          <GraphItemActionsMenu
            label={tShape("graph.pointActions", { index: index + 1 })}
            testId={index === 0 ? "overlay-graph-point-actions" : undefined}
            onCloseNestedMenus={() => onOpenStyleMenuChange(null)}
          >
            <GraphPointActionsMenuContent
              point={point}
              index={index}
              cartesian={cartesian}
              openStyleMenu={openStyleMenu}
              onOpenStyleMenuChange={onOpenStyleMenuChange}
              onPatch={onPatch}
              onRemove={onRemove}
            />
          </GraphItemActionsMenu>
        </Inline>
      </Inline>
      <Stack className="graph-style-field" gap="xs">
        <span>{tShape("graph.coordinates")}</span>
        <Grid className="graph-coordinate-pair" columns={2} gap="sm" responsive={false}>
          <label className="graph-coordinate-field">
            <MathPreview tex="x:" />
            <GraphExpressionMathInput
              tex={point.xTex?.trim() || graphExpressionToTex(point.x)}
              ariaLabel={tShape("graph.pointX", { index: index + 1 })}
              placeholderTex="1"
              live
              dataTestId={index === 0 ? "overlay-graph-point-x-input" : undefined}
              onCommitExpression={(x, xTex) => onPatch({ x, xTex })}
            />
          </label>
          <label className="graph-coordinate-field">
            <MathPreview tex="y:" />
            <GraphExpressionMathInput
              tex={point.yTex?.trim() || graphExpressionToTex(point.y)}
              ariaLabel={tShape("graph.pointY", { index: index + 1 })}
              placeholderTex="2"
              live
              dataTestId={index === 0 ? "overlay-graph-point-y-input" : undefined}
              onCommitExpression={(y, yTex) => onPatch({ y, yTex })}
            />
          </label>
        </Grid>
      </Stack>
      <Stack className="graph-style-field" gap="xs">
        <span>{tShape("graph.name")}</span>
        <MathExpressionInput
          tex={point.label ?? ""}
          ariaLabel={tShape("graph.pointName", { index: index + 1 })}
          data-testid={index === 0 ? "overlay-graph-point-label" : undefined}
          onCommit={(tex) => onPatch({ label: tex.trim() })}
        />
      </Stack>
      </Stack>
    </Inset>
  );
}

export function GraphFillActionsMenuContent({
  fill,
  index,
  openStyleMenu,
  onOpenStyleMenuChange,
  onPatch,
  onRemove,
}: {
  fill: GraphFillRegion;
  index: number;
  openStyleMenu: string | null;
  onOpenStyleMenuChange: (key: string | null) => void;
  onPatch: (patch: Partial<GraphFillRegion>) => void;
  onRemove: () => void;
}) {
  const tShape = useT("shape");
  const fillColor = normalizeGraphColor(fill.color, DEFAULT_GRAPH_FILL_COLOR);

  return (
    <>
      <div className="graph-fill-action-grid">
        <label className="graph-item-action-field">
          <span>{tShape("graph.color")}</span>
          <GraphColorControl
            label={tShape("graph.fillColor", { index: index + 1 })}
            value={fillColor}
            menuKey={`fill-color-${fill.id}`}
            openStyleMenu={openStyleMenu}
            onOpenStyleMenuChange={onOpenStyleMenuChange}
            onChange={(color) => onPatch({ color })}
            data-testid={index === 0 ? "overlay-graph-fill-color-select" : undefined}
          />
        </label>
        <label className="graph-item-action-field">
          <span>{tShape("graph.fillPatternLabel")}</span>
          <GraphFillPatternControl
            value={normalizeGraphFillPattern(fill.pattern)}
            color={fillColor}
            menuKey={`fill-pattern-${fill.id}`}
            openStyleMenu={openStyleMenu}
            onOpenStyleMenuChange={onOpenStyleMenuChange}
            onChange={(pattern) => onPatch({ pattern })}
            data-testid={index === 0 ? "overlay-graph-fill-pattern-select" : undefined}
          />
        </label>
      </div>
      <label className="graph-item-opacity-field">
        <span>{tShape("graph.opacity")}</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={normalizeGraphFillOpacity(fill.opacity)}
          aria-label={tShape("graph.fillOpacity", { index: index + 1 })}
          onChange={(event) => onPatch({ opacity: Number(event.target.value) })}
        />
        <output>{Math.round(normalizeGraphFillOpacity(fill.opacity) * 100)}%</output>
      </label>
      <div className="graph-item-actions-separator" role="separator" />
      <Button
        tone="danger"
        size="sm"
        aria-label={tShape("graph.fillDelete", { index: index + 1 })}
        onClick={() => {
          focusGraphSettingsSurface();
          onRemove();
        }}
      >
        <Trash2 size={14} aria-hidden="true" />
        <span>{tShape("graph.deleteFill")}</span>
      </Button>
    </>
  );
}

/** 閉領域の色、濃さ、パターンを Hover 時のメニューへまとめたカード。 */
function GraphFillCard({
  fill,
  index,
  openStyleMenu,
  onOpenStyleMenuChange,
  onPatch,
  onRemove,
}: {
  fill: GraphFillRegion;
  index: number;
  openStyleMenu: string | null;
  onOpenStyleMenuChange: (key: string | null) => void;
  onPatch: (patch: Partial<GraphFillRegion>) => void;
  onRemove: () => void;
}) {
  const tShape = useT("shape");
  const fillColor = normalizeGraphColor(fill.color, DEFAULT_GRAPH_FILL_COLOR);
  const fillPattern = normalizeGraphFillPattern(fill.pattern);
  const fillPatternLabel = tShape(`graphFill.${fillPattern}` as never) as string;

  return (
    <Inset className="graph-curve-editor graph-fill-editor" space="sm">
      <Inline className="graph-curve-header" gap="sm" justify="between">
        <Inline className="graph-fill-heading" gap="sm">
          <span
            className="graph-fill-swatch"
            style={graphFillSwatchStyle(fillPattern, fillColor)}
            aria-hidden="true"
          />
          <span className="graph-curve-title">{tShape("graph.fillN", { index: index + 1 })}</span>
          <span className="graph-fill-summary">{tShape("graph.fillSummary", { pattern: fillPatternLabel, percent: Math.round(normalizeGraphFillOpacity(fill.opacity) * 100) })}</span>
        </Inline>
        <GraphItemActionsMenu
          label={tShape("graph.fillActions", { index: index + 1 })}
          testId={index === 0 ? "overlay-graph-fill-actions" : undefined}
          onCloseNestedMenus={() => onOpenStyleMenuChange(null)}
        >
          <GraphFillActionsMenuContent
            fill={fill}
            index={index}
            openStyleMenu={openStyleMenu}
            onOpenStyleMenuChange={onOpenStyleMenuChange}
            onPatch={onPatch}
            onRemove={onRemove}
          />
        </GraphItemActionsMenu>
      </Inline>
    </Inset>
  );
}

function GraphFillPatternControl({
  value,
  color,
  menuKey,
  openStyleMenu,
  onOpenStyleMenuChange,
  onChange,
  "data-testid": dataTestId,
}: {
  value: NonNullable<GraphFillRegion["pattern"]>;
  color: string;
  menuKey: string;
  openStyleMenu: string | null;
  onOpenStyleMenuChange: (key: string | null) => void;
  onChange: (pattern: NonNullable<GraphFillRegion["pattern"]>) => void;
  "data-testid"?: string;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const open = openStyleMenu === menuKey;
  const tShape = useT("shape");
  const currentOption = GRAPH_FILL_PATTERN_OPTIONS.find((option) => option.value === value)
    ?? GRAPH_FILL_PATTERN_OPTIONS[0];
  const currentLabel = tShape(`graphFill.${currentOption.value}` as never) as string;

  return (
    <div className="shape-menu-anchor graph-fill-pattern-control">
      <button
        ref={buttonRef}
        type="button"
        className={`graph-fill-pattern-button ${open ? "active" : ""}`}
        aria-label={tShape("graphFill.currentAria", { pattern: currentLabel })}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={dataTestId}
        onClick={() => onOpenStyleMenuChange(open ? null : menuKey)}
      >
        <span className="graph-fill-swatch" style={graphFillSwatchStyle(value, color)} aria-hidden="true" />
        <span>{currentLabel}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={() => onOpenStyleMenuChange(null)}
        className="shape-menu graph-fill-pattern-menu"
        role="menu"
        ariaLabel={tShape("graphFill.menuAria")}
        zIndex={GRAPH_SETTINGS_POPOVER_Z_INDEX}
      >
        {GRAPH_FILL_PATTERN_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={option.value === value}
            className={option.value === value ? "selected" : ""}
            onClick={() => {
              onChange(option.value);
              onOpenStyleMenuChange(null);
            }}
          >
            <span className="graph-fill-swatch" style={graphFillSwatchStyle(option.value, color)} aria-hidden="true" />
            <span>{tShape(`graphFill.${option.value}` as never) as string}</span>
          </button>
        ))}
      </ToolbarPopover>
    </div>
  );
}

/** グラフ用の白黒推奨色を、既存の共通カラーパレットから選ぶトリガー。 */
function GraphColorControl({
  label,
  value,
  menuKey,
  openStyleMenu,
  onOpenStyleMenuChange,
  onChange,
  popoverZIndex = GRAPH_SETTINGS_POPOVER_Z_INDEX,
  "data-testid": dataTestId,
}: {
  label: string;
  value: string;
  menuKey: string;
  openStyleMenu: string | null;
  onOpenStyleMenuChange: (key: string | null) => void;
  onChange: (color: string) => void;
  popoverZIndex?: CSSProperties["zIndex"];
  "data-testid"?: string;
}) {
  const tShape = useT("shape");
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const open = openStyleMenu === menuKey;

  return (
    <div className="shape-menu-anchor">
      <button
        ref={buttonRef}
        type="button"
        className={`graph-color-button ${open ? "active" : ""}`}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={dataTestId}
        onClick={() => onOpenStyleMenuChange(open ? null : menuKey)}
      >
        <span className="graph-color-button-swatch" style={{ background: value }} aria-hidden="true" />
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={() => onOpenStyleMenuChange(null)}
        className="color-popover"
        ariaLabel={label}
        zIndex={popoverZIndex}
      >
        <ColorPalette
          value={value}
          presetColors={GRAPH_RECOMMENDED_COLORS}
          presetLabel={tShape("graph.recommendedPalette")}
          onChange={(color) => {
            if (color) {
              onChange(color);
            }
            onOpenStyleMenuChange(null);
          }}
        />
      </ToolbarPopover>
    </div>
  );
}

function GraphTickFontSizeInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (value: number) => void;
}) {
  const tShape = useT("shape");
  const [draft, setDraft] = useState(() => String(value));

  const commit = () => {
    const parsedValue = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsedValue)) {
      setDraft(String(value));
      return;
    }

    const nextValue = Math.min(48, Math.max(6, parsedValue));
    setDraft(String(nextValue));
    onCommit(nextValue);
  };

  return (
    <label className="graph-style-field graph-tick-font-size-field" htmlFor="graph-tick-font-size">
      <span>{tShape("graph.tickFontSize")}</span>
      <span className="graph-number-input">
        <input
          id="graph-tick-font-size"
          data-testid="overlay-graph-tick-font-size"
          type="number"
          min={6}
          max={48}
          step={0.5}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <span className="graph-number-input-unit" aria-hidden="true">pt</span>
      </span>
    </label>
  );
}

/**
 * 表示用 TeX と評価用グラフ式の変換境界を保つ数式入力。
 * MathExpressionInput の入力体験を再利用し、妥当な式だけを親へ確定する。
 */
export function GraphExpressionMathInput({
  tex,
  ariaLabel,
  placeholderTex,
  dataTestId,
  allowEmpty = false,
  allowImplicitEquation = false,
  disabled = false,
  live = false,
  onCommitExpression,
  onClear,
}: {
  tex: string;
  ariaLabel: string;
  placeholderTex?: string;
  dataTestId?: string;
  allowEmpty?: boolean;
  allowImplicitEquation?: boolean;
  disabled?: boolean;
  live?: boolean;
  onCommitExpression: (expression: string, tex: string) => void;
  onClear?: () => void;
}) {
  const tShape = useT("shape");
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  // 理由は**コード**で持ち、描画時に辞書へ通す (文言を state に入れると、
  // 言語を切り替えたときに古い言語のまま残る)。
  const [errorReason, setErrorReason] = useState<GraphTexErrorCode | null>(null);
  const previousTexRef = useRef(tex);

  useEffect(() => {
    if (previousTexRef.current === tex) {
      return;
    }
    previousTexRef.current = tex;
    setDraft(null);
    setErrorReason(null);
  }, [tex]);

  const commit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      if (allowEmpty) {
        setDraft(null);
        setErrorReason(null);
        onClear?.();
      } else {
        setDraft(value);
        setErrorReason("empty");
      }
      return;
    }

    const parsed = parseGraphExpressionInputTex(trimmed, { allowImplicitEquation });
    if (parsed === null) {
      setDraft(value);
      const result = texToGraphExpressionWithError(trimmed);
      if ("error" in result) {
        setErrorReason(result.error);
      }
      return;
    }
    setDraft(null);
    setErrorReason(null);
    onCommitExpression(parsed.expression, parsed.tex);
  };

  return (
    <div className="graph-expression-field">
      <MathExpressionInput
        tex={draft ?? tex}
        ariaLabel={ariaLabel}
        placeholderTex={placeholderTex}
        invalid={draft !== null}
        ariaDescribedBy={errorReason ? errorId : undefined}
        disabled={disabled}
        data-testid={dataTestId}
        onCommit={commit}
        onInputTex={live
          ? (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              return;
            }
            const parsed = parseGraphExpressionInputTex(trimmed, { allowImplicitEquation });
            if (parsed === null) {
              setDraft(value);
              const result = texToGraphExpressionWithError(trimmed);
              if ("error" in result) {
                setErrorReason(result.error);
              }
              return;
            }
            setDraft(null);
            setErrorReason(null);
            onCommitExpression(parsed.expression, parsed.tex);
          }
          : undefined}
      />
      <p
        id={errorId}
        className="graph-expression-error"
        data-empty={errorReason ? undefined : "true"}
        aria-live="polite"
      >
        {errorReason ? tShape(`texError.${errorReason}` as never) as string : null}
      </p>
    </div>
  );
}

function parseGraphExpressionInputTex(
  tex: string,
  options: { allowImplicitEquation?: boolean } = {},
): { expression: string; tex: string } | null {
  const trimmedTex = tex.trim();

  // Try implicit equation FIRST if enabled (with original input)
  if (options.allowImplicitEquation) {
    const implicitResult = parseGraphImplicitEquationTex(trimmedTex);
    if (implicitResult !== null) {
      return implicitResult;
    }
  }

  // Try explicit/parametric after stripping y=/x=/t= prefix
  let cleanedTex = trimmedTex;
  const prefixMatch = cleanedTex.match(/^([yxt])\s*=\s*/i);
  if (prefixMatch) {
    cleanedTex = cleanedTex.slice(prefixMatch[0].length);
  }

  const expression = texToGraphExpression(cleanedTex);
  if (expression !== null) {
    return { expression, tex: cleanedTex };
  }

  return null;
}

/** 左端と右端を分け、対象変数を中央に常時表示する範囲入力。 */
function GraphRangeInput({
  min,
  max,
  variableName,
  ariaLabel,
  minPlaceholderTex,
  maxPlaceholderTex,
  requireBoth = false,
  allowEmpty = false,
  disabled = false,
  dataTestId,
  onCommitRange,
}: {
  min?: string;
  max?: string;
  variableName: GraphExpressionVariableName;
  ariaLabel: string;
  minPlaceholderTex?: string;
  maxPlaceholderTex?: string;
  requireBoth?: boolean;
  allowEmpty?: boolean;
  disabled?: boolean;
  dataTestId?: string;
  onCommitRange: (parts: GraphRangeTexParts | null) => void;
}) {
  const tShape = useT("shape");
  const minTex = min?.trim() ? graphExpressionToTex(min) : "";
  const maxTex = max?.trim() ? graphExpressionToTex(max) : "";
  const canClearSide = allowEmpty || !requireBoth;

  const commitSide = (side: "min" | "max", expression: string | null) => {
    const next: GraphRangeTexParts = {
      ...(min?.trim() ? { min } : {}),
      ...(max?.trim() ? { max } : {}),
    };
    if (expression === null) {
      delete next[side];
    } else {
      next[side] = expression;
    }

    const hasMin = Boolean(next.min?.trim());
    const hasMax = Boolean(next.max?.trim());
    if (!hasMin && !hasMax) {
      if (allowEmpty) {
        onCommitRange(null);
      }
      return;
    }
    if (requireBoth && (!hasMin || !hasMax)) {
      return;
    }
    onCommitRange(next);
  };

  return (
    <Inline
      className="graph-range-pair"
      gap="xs"
      aria-label={ariaLabel}
      data-testid={dataTestId ? `${dataTestId}-pair` : undefined}
    >
      <GraphExpressionMathInput
        tex={minTex}
        ariaLabel={tShape("graph.rangeStart", { name: ariaLabel })}
        placeholderTex={minPlaceholderTex}
        allowEmpty={canClearSide}
        disabled={disabled}
        dataTestId={dataTestId ? `${dataTestId}-min` : undefined}
        onCommitExpression={(expression) => commitSide("min", expression)}
        onClear={() => commitSide("min", null)}
      />
      <MathPreview tex={`\\leqq ${variableName} \\leqq`} className="graph-range-separator" />
      <GraphExpressionMathInput
        tex={maxTex}
        ariaLabel={tShape("graph.rangeEnd", { name: ariaLabel })}
        placeholderTex={maxPlaceholderTex}
        allowEmpty={canClearSide}
        disabled={disabled}
        dataTestId={dataTestId ? `${dataTestId}-max` : undefined}
        onCommitExpression={(expression) => commitSide("max", expression)}
        onClear={() => commitSide("max", null)}
      />
    </Inline>
  );
}

function createCurveModePatch(
  curve: GraphCurve,
  mode: NonNullable<GraphCurve["mode"]>,
): Partial<GraphCurve> {
  const currentMode = normalizeGraphCurveMode(curve.mode);
  if (mode === "parametric") {
    const keepExpr = currentMode === "parametric" || usesGraphVariable(curve.expr, "t");
    const expr = keepExpr ? curve.expr : "cos(t)";
    const exprTex = keepExpr ? graphCurveExprTex(curve) : "\\cos(t)";
    const keepYExpr = Boolean(curve.yExpr?.trim());
    const yExpr = keepYExpr ? curve.yExpr : "sin(t)";
    const yExprTex = keepYExpr ? graphCurveYExprTex(curve) : "\\sin(t)";
    return {
      mode,
      expr,
      exprTex,
      yExpr,
      yExprTex,
      label: makeGraphCurveLabel(mode, exprTex, yExprTex),
      domain: currentMode === "parametric" ? curve.domain : { ...DEFAULT_PARAMETRIC_DOMAIN },
    };
  }

  if (mode === "implicit") {
    const keepExpr = currentMode === "implicit" || usesGraphVariable(curve.expr, "y");
    const expr = keepExpr ? curve.expr : "x^2 + y^2 - 1";
    const exprTex = keepExpr ? graphCurveExprTex(curve) : "x^{2}+y^{2}-1";
    return {
      mode,
      expr,
      exprTex,
      yExpr: undefined,
      yExprTex: undefined,
      label: makeGraphCurveLabel(mode, exprTex),
      domain: currentMode === "parametric" ? undefined : curve.domain,
    };
  }

  let expr = curve.expr;
  let exprTex = graphCurveExprTex(curve);
  if (currentMode === "parametric" || currentMode === "implicit" || usesGraphVariable(curve.expr, "t")) {
    expr = mode === "xOfY" ? "y^2" : "sin(x)";
    exprTex = mode === "xOfY" ? "y^{2}" : "\\sin(x)";
  }

  return {
    mode,
    expr,
    exprTex,
    yExpr: undefined,
    yExprTex: undefined,
    label: makeGraphCurveLabel(mode, exprTex),
    domain: currentMode === "parametric" ? undefined : curve.domain,
  };
}

function usesGraphVariable(expr: string, variableName: string): boolean {
  return new RegExp(`\\b${variableName}\\b`, "i").test(expr);
}

function graphFillSwatchStyle(pattern: GraphFillRegion["pattern"], color: string): CSSProperties {
  const normalizedPattern = normalizeGraphFillPattern(pattern);
  const baseColor = hexToRgba(color, normalizedPattern === "solid" ? 0.32 : 0.12);
  switch (normalizedPattern) {
    case "solid":
      return { backgroundColor: baseColor };
    case "diagonal":
      return {
        backgroundColor: baseColor,
        backgroundImage: `repeating-linear-gradient(135deg, transparent 0 5px, ${color} 5px 6.5px, transparent 6.5px 10px)`,
      };
    case "diagonalBack":
      return {
        backgroundColor: baseColor,
        backgroundImage: `repeating-linear-gradient(45deg, transparent 0 5px, ${color} 5px 6.5px, transparent 6.5px 10px)`,
      };
    case "cross":
      return {
        backgroundColor: baseColor,
        backgroundImage: [
          `repeating-linear-gradient(135deg, transparent 0 5px, ${color} 5px 6px, transparent 6px 10px)`,
          `repeating-linear-gradient(45deg, transparent 0 5px, ${color} 5px 6px, transparent 6px 10px)`,
        ].join(", "),
      };
    case "horizontal":
      return {
        backgroundColor: baseColor,
        backgroundImage: `repeating-linear-gradient(0deg, transparent 0 5px, ${color} 5px 6.5px, transparent 6.5px 10px)`,
      };
    case "vertical":
      return {
        backgroundColor: baseColor,
        backgroundImage: `repeating-linear-gradient(90deg, transparent 0 5px, ${color} 5px 6.5px, transparent 6.5px 10px)`,
      };
    case "dots":
      return {
        backgroundColor: baseColor,
        backgroundImage: `radial-gradient(${color} 1.2px, transparent 1.3px)`,
        backgroundSize: "7px 7px",
      };
  }

  return { backgroundColor: baseColor };
}

function hexToRgba(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) {
    return `rgba(156, 163, 175, ${alpha})`;
  }

  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
