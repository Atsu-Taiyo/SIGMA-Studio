import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readStylesheet as readFileSync } from "../../../tests/helpers/read-stylesheet";

import { createGraph2DSpecPreset, formatGraphIssue } from "@/lib/graph2d";
import { createTranslator } from "@/lib/i18n";

import  {
  GraphCurveActionsMenuContent,
  GraphFillActionsMenuContent,
  GraphPointActionsMenuContent,
  OverlayGraphSettings,
  formatTexIssueForClient,
  type SelectedOverlayGraph,
} from "./EditorSettings";

function createSelectedGraph(): SelectedOverlayGraph {
  const base = createGraph2DSpecPreset("line");
  return {
    shapeId: "graph_test",
    spec: {
      ...base,
      curves: [
        {
          ...base.curves[0],
          domain: { min: "-2", max: "2" },
        },
      ],
      points: [
        {
          id: "point_test",
          x: "1",
          y: "2",
          label: "P",
          color: "#0d0d0d",
          fill: "none",
        },
      ],
      fills: [
        {
          id: "fill_test",
          x: "1",
          y: "1",
        },
      ],
    },
    axisLabelShapeIdsByKey: {},
    axisLabelTextsByKey: {},
    formulaLabelShapeIds: [],
    formulaLabelShapeIdsByCurveId: {},
    pickingOrigin: false,
    pickingFill: false,
    onSpecChange: () => {},
    onAxisLabelChange: () => {},
    onAxisLabelTextChange: () => {},
    onFormulaLabelChange: () => {},
    onStartCrop: () => {},
    onStartOriginPick: () => {},
    onStartFillPick: () => {},
    onClose: () => {},
  };
}

describe("Graph settings design system", () => {
  it("uses the body math input mode without duplicating its switch in the graph dialog", () => {
    const html = renderToStaticMarkup(
      <OverlayGraphSettings selectedOverlayGraph={createSelectedGraph()} />,
    );

    expect(html).not.toContain('aria-label="数式入力モード"');
    expect(html).not.toContain(">TeX</button>");
    expect(html).not.toContain(">リアルタイム表示</button>");
  });

  it("gives a useful next step in client errors, in the current language", () => {
    // 以前は日本語の文章を正規表現で解析して言い換えていたので、訳した瞬間に
    // 言い換えが黙って止まった。いまはコード → 辞書なので、言語ごとに引き直せる。
    const ja = createTranslator("ja", "shape");
    const en = createTranslator("en", "shape");
    const brokenCurve = { code: "curveEvaluate", nodeId: "graph_bad", targetId: "curve_line" } as const;

    expect(formatGraphIssue(brokenCurve, ja)).toBe("関数を表示できません。式の書き方を確認してください。");
    expect(formatGraphIssue({ code: "pointCoordinates", nodeId: "graph_bad", targetId: "point_1" }, ja))
      .toBe("点を表示できません。x座標とy座標を確認してください。");
    expect(formatGraphIssue(brokenCurve, en))
      .toBe("The function cannot be drawn. Check how the expression is written.");
  });

  it("removes internal ids and gives a useful next step in TeX errors", () => {
    // TeX 側の言い換えはまだ文章の書き換えのまま (WI-11 の担当)。ここで
    // 既存の振る舞いを落とさないよう張っておく。
    expect(formatTexIssueForClient(
      "数式 math_1 に未許可のTeXコマンド \\foo があります。",
      createTranslator("ja", "shape"),
    )).toBe("「\\foo」は使えません。別のTeXコマンドを入力してください。");
    expect(formatTexIssueForClient(
      "数式 math_1 にTeXエラー unexpected-token があります。",
      createTranslator("ja", "shape"),
    )).toBe("数式を表示できません。TeXの書き方を確認してください。");
  });

  it("keeps internal ids out of the panel but gives them to the AI", () => {
    // パネルの id は `curve_<uuid>` で、教員はどの行のことか対応付けられない。
    // 旧経路も id を正規表現で捕獲したうえで**意図的に捨てて**いた。
    // 一方 AI は id で対象を特定して直せるので、AI へ返すときだけ付ける。
    const ja = createTranslator("ja", "shape");
    const brokenCurve = { code: "curveEvaluate", nodeId: "graph_bad", targetId: "curve_line" } as const;

    expect(formatGraphIssue(brokenCurve, ja)).not.toContain("curve_line");
    expect(formatGraphIssue(brokenCurve, ja)).not.toContain("graph_bad");
    expect(formatGraphIssue(brokenCurve, ja, { withTarget: true })).toContain("curve_line");

    // AI 経路では**どれが壊れているか**が残る。曲線が複数あるとき区別できないと直せない。
    const twoBroken = [
      formatGraphIssue({ code: "curveEvaluate", nodeId: "g", targetId: "curve_1" }, ja, { withTarget: true }),
      formatGraphIssue({ code: "curveEvaluate", nodeId: "g", targetId: "curve_2" }, ja, { withTarget: true }),
    ];
    expect(new Set(twoBroken).size).toBe(2);

    // 相手が無い問題には余計な括弧を足さない。
    expect(formatGraphIssue({ code: "axisRange", nodeId: "graph_bad" }, ja, { withTarget: true }))
      .toBe("軸の表示範囲は、最小値が最大値より小さくなるように入力してください。");
  });

  it("uses shared hover actions for points, functions, and fills", () => {
    const html = renderToStaticMarkup(
      <OverlayGraphSettings selectedOverlayGraph={createSelectedGraph()} />,
    );

    expect(html).toContain('aria-label="関数 1 の操作"');
    expect(html).toContain('aria-label="点 1 の操作"');
    expect(html).toContain('aria-label="塗り 1 の操作"');
    expect(html).not.toContain('aria-label="関数 1 を削除"');
    expect(html).not.toContain('aria-label="点 1 を削除"');
    expect(html).not.toContain('aria-label="塗り 1 を削除"');
    expect(html).toContain('aria-label="関数 1 の詳細設定"');
    expect(html).not.toContain('aria-label="点 1 の詳細設定"');
    expect(html).toContain('data-space="sm"');
    expect(html).toContain('data-gap="sm"');
  });

  it("puts function, point, and fill styling inside their card action menus", () => {
    const selectedGraph = createSelectedGraph();
    const curveHtml = renderToStaticMarkup(
      <GraphCurveActionsMenuContent
        curve={selectedGraph.spec.curves[0]}
        index={0}
        formulaLabelVisible={false}
        openStyleMenu={null}
        onOpenStyleMenuChange={() => {}}
        onFormulaLabelToggle={() => {}}
        onPatch={() => {}}
        onRemove={() => {}}
      />,
    );
    const fillHtml = renderToStaticMarkup(
      <GraphFillActionsMenuContent
        fill={selectedGraph.spec.fills![0]}
        index={0}
        openStyleMenu={null}
        onOpenStyleMenuChange={() => {}}
        onPatch={() => {}}
        onRemove={() => {}}
      />,
    );
    const pointHtml = renderToStaticMarkup(
      <GraphPointActionsMenuContent
        point={selectedGraph.spec.points![0]}
        index={0}
        cartesian
        openStyleMenu={null}
        onOpenStyleMenuChange={() => {}}
        onPatch={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(curveHtml).toContain('data-testid="overlay-graph-color-select"');
    expect(curveHtml).toContain('data-testid="overlay-graph-dash-select"');
    expect(curveHtml).toContain('data-testid="overlay-graph-stroke-width-select"');
    expect(curveHtml).toContain('aria-label="関数 1 を削除"');
    expect(curveHtml).not.toContain("disabled");
    expect(fillHtml).toContain('data-testid="overlay-graph-fill-color-select"');
    expect(fillHtml).toContain('data-testid="overlay-graph-fill-pattern-select"');
    expect(fillHtml).toContain('aria-haspopup="menu"');
    expect(fillHtml).toContain('aria-label="塗り 1 を削除"');
    expect(pointHtml).toContain('data-testid="overlay-graph-point-fill"');
    expect(pointHtml).toContain('data-testid="overlay-graph-point-x-projection"');
    expect(pointHtml).toContain('aria-label="点 1 を削除"');
  });

  it("shows card action triggers on hover without mounting graph hover actions on the canvas", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    const canvasSource = readFileSync(new URL("./OverlayCanvasEditorClient.tsx", import.meta.url), "utf8");

    expect(css).toContain(".graph-curve-editor:hover .graph-item-actions-trigger");
    expect(css).toContain('.graph-item-actions-menu[data-placement="right"]');
    expect(css).not.toContain(".origin-picking:not(.initial-origin-picking) .graph-shape");
    expect(css).not.toContain(".graph-quick-actions-button");
    expect(canvasSource).not.toContain("GraphQuickActionsLayer");
    expect(canvasSource).not.toContain("data-graph-quick-actions");
  });

  it("styles tick font size as a graph field with a separate unit", () => {
    const settingsSource = readFileSync(new URL("./EditorSettings.tsx", import.meta.url), "utf8");

    expect(settingsSource).toContain('className="graph-style-field graph-tick-font-size-field"');
    expect(settingsSource).toContain('className="graph-number-input"');
    expect(settingsSource).toContain('className="graph-number-input-unit" aria-hidden="true">pt</span>');
    expect(settingsSource).not.toContain('className="problem-number-size-field"');
  });

  it("drops the styles left behind when the controls moved into the action popover", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

    // 参照されないセレクタを残すと、次に触る人が生きている前提で読む。
    expect(css).not.toContain(".graph-curve-label-toggle");
    expect(css).not.toContain(".graph-pattern-picker");
    expect(css).not.toContain(".graph-opacity-field");
  });

  it("exposes the card action popover as a dialog: it holds form controls, not menu items", () => {
    const selectedGraph = createSelectedGraph();
    const html = renderToStaticMarkup(<OverlayGraphSettings selectedOverlayGraph={selectedGraph} />);
    const curveHtml = renderToStaticMarkup(
      <GraphCurveActionsMenuContent
        curve={selectedGraph.spec.curves[0]}
        index={0}
        formulaLabelVisible={false}
        openStyleMenu={null}
        onOpenStyleMenuChange={() => {}}
        onFormulaLabelToggle={() => {}}
        onPatch={() => {}}
        onRemove={() => {}}
      />,
    );
    const fillHtml = renderToStaticMarkup(
      <GraphFillActionsMenuContent
        fill={selectedGraph.spec.fills![0]}
        index={0}
        openStyleMenu={null}
        onOpenStyleMenuChange={() => {}}
        onPatch={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(html).toContain('aria-haspopup="dialog"');
    // `role="menu"` の直下にスライダーや色ドロップダウンを置くと、AT のメニューモードで
    // 露出しない。押下状態は既存規約どおり aria-pressed で表す。
    expect(curveHtml).not.toContain('role="menuitem');
    expect(fillHtml).not.toContain('role="menuitem');
    expect(curveHtml).toContain('aria-pressed="false"');
  });

  it("renders graph ranges with double less-than-or-equal signs", () => {
    const settingsSource = readFileSync(new URL("./EditorSettings.tsx", import.meta.url), "utf8");
    const html = renderToStaticMarkup(
      <OverlayGraphSettings selectedOverlayGraph={createSelectedGraph()} />,
    );

    expect(settingsSource).toContain('tex={`\\\\leqq ${variableName} \\\\leqq`}');
    expect(html).toContain("≦");
    expect(html).not.toContain('aria-label="関数 1 を削除" disabled');
  });

  it("shows the range-fit action when the curve is outside the display range", () => {
    const selectedGraph = createSelectedGraph();
    selectedGraph.spec = {
      ...selectedGraph.spec,
      viewBox: {
        xMin: "-1",
        xMax: "1",
        yMin: "-1",
        yMax: "1",
      },
      curves: [
        {
          ...selectedGraph.spec.curves[0],
          expr: "x^2 + 5",
        },
      ],
      points: [],
    };

    const html = renderToStaticMarkup(
      <OverlayGraphSettings selectedOverlayGraph={selectedGraph} />,
    );

    expect(html).toContain("曲線が表示範囲の外にあります");
    expect(html).toContain('data-testid="overlay-graph-fit-view-box"');
    expect(html).toContain("曲線に合わせて表示範囲を調整");
  });
  it("hides the intersection action until two curves make it meaningful", () => {
    const oneCurve = createSelectedGraph();
    const twoCurves = createSelectedGraph();
    twoCurves.spec = {
      ...twoCurves.spec,
      curves: [
        ...twoCurves.spec.curves,
        { ...twoCurves.spec.curves[0], id: "curve_second", expr: "x + 1" },
      ],
    };

    const oneCurveHtml = renderToStaticMarkup(
      <OverlayGraphSettings selectedOverlayGraph={oneCurve} />,
    );
    const twoCurvesHtml = renderToStaticMarkup(
      <OverlayGraphSettings selectedOverlayGraph={twoCurves} />,
    );

    expect(oneCurveHtml).not.toContain('aria-label="交点を追加"');
    expect(twoCurvesHtml).toContain('aria-label="交点を追加"');
  });

  it("collapses the three mode actions into an icon-only toolbar", () => {
    const html = renderToStaticMarkup(
      <OverlayGraphSettings selectedOverlayGraph={createSelectedGraph()} />,
    );

    expect(html).toContain('aria-label="グラフ操作ツール"');
    expect(html).toContain('data-testid="overlay-graph-origin-button"');
    expect(html).toContain('data-testid="overlay-graph-fill-button"');
    expect(html).toContain('data-testid="overlay-graph-crop-button"');
    expect(html.match(/data-icon-only="true"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("announces the active mode in a status line instead of closing the panel", () => {
    const pickingOrigin = createSelectedGraph();
    pickingOrigin.pickingOrigin = true;

    const html = renderToStaticMarkup(
      <OverlayGraphSettings selectedOverlayGraph={pickingOrigin} />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("グラフ上をクリックして原点を指定");
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="overlay-graph-origin-button"|data-testid="overlay-graph-origin-button"[^>]*aria-pressed="true"/);
  });
});
