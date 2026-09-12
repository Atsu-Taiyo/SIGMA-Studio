import { describe, expect, it } from "vitest";
import { readStylesheet as readFileSync } from "../../../tests/helpers/read-stylesheet";

import { createTranslator } from "@/lib/i18n";

/**
 * 非モーダルであること自体が要件なので、構造の契約をソースで固定する
 * (`design-tokens.test.ts` と同じ手法)。DOM を伴う振る舞いは e2e が担保する。
 */
const panelSource = readFileSync(new URL("./GraphSettingsPanel.tsx", import.meta.url), "utf8");
const editorShellSource = readFileSync(new URL("./EditorShell.tsx", import.meta.url), "utf8");
const editorSettingsSource = readFileSync(new URL("./EditorSettings.tsx", import.meta.url), "utf8");
const overlayCanvasSource = readFileSync(new URL("./OverlayCanvasEditorClient.tsx", import.meta.url), "utf8");
const placementSource = readFileSync(new URL("./graph-settings-panel-placement.ts", import.meta.url), "utf8");
const globalCss = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

describe("GraphSettingsPanel contract", () => {
  it("keeps the dialog role and label that assistive tech and e2e rely on", () => {
    expect(panelSource).toContain('role="dialog"');
    expect(panelSource).toContain('ariaLabel={t("graphPanel.title")}');
    expect(panelSource).toContain("aria-label={ariaLabel}");
    // 文言は辞書へ移った。**e2e が掴むのは描画後の名前**なので、ソースの呼び出し形と
    // 日本語ロケールでの実値の両方を固定する (どちらか片方だと名前が黙って変わる)。
    expect(createTranslator("ja", "shape")("graphPanel.title")).toBe("グラフの設定");
  });

  it("is not a modal: no aria-modal, no backdrop, no ModalFrame", () => {
    expect(panelSource).not.toMatch(/aria-modal\s*=/);
    expect(panelSource).not.toContain("data-modal-backdrop");
    expect(panelSource).not.toContain('from "@/components/ui/Modal"');
  });

  it("passes the selected graph through without wrapping the mode callbacks", () => {
    // closeAndRun の回帰防止: 原点指定・塗りつぶし・トリミングの開始でパネルを閉じない。
    expect(panelSource).toContain("selectedOverlayGraph={selectedOverlayGraph}");
    expect(panelSource).not.toContain("onStartOriginPick:");
    expect(panelSource).not.toContain("onStartFillPick:");
    expect(panelSource).not.toContain("onStartCrop:");
  });

  it("renders through a body portal so it never resizes the page canvas", () => {
    // `.overlay-canvas-editor` の矩形＝ページ矩形という既存の前提を崩さないため。
    expect(panelSource).toContain("createPortal(panel, document.body)");
    expect(panelSource).toContain("getGraphSettingsPanelPlacement");
  });

  it("no longer lets the open panel disable every editor shortcut", () => {
    // 非モーダルなのでパネルを開いたまま Undo / Delete / ズームが効かなければならない。
    expect(editorShellSource).not.toContain("graphSettingsShapeId !== null");
  });

  it("closes when focus moves away from the selected graph", () => {
    expect(editorShellSource).toContain("if (!detail && graphSettingsShapeIdRef.current)");
    expect(editorShellSource).toContain("本文・空白・別図形へ選択が移り detail が null になった時だけ閉じる");
    expect(editorShellSource).not.toContain("if (shapeExists) {\n          graphSettingsShapeWasInDocumentRef.current = true;\n          return;");
  });

  it("exempts the panel from the canvas keyboard handler so Delete cannot destroy the graph", () => {
    // backdrop が無いので、パネル内にフォーカスがあるまま Delete / 矢印キーを押すと
    // キャンバスのハンドラに届いて図形が消える・動く。
    expect(overlayCanvasSource).toContain("keyboardTarget?.closest(NON_MODAL_KEYBOARD_SURFACE_SELECTOR)");
    expect(overlayCanvasSource).toContain('NON_MODAL_KEYBOARD_SURFACE_SELECTOR = "[data-non-modal-surface], [data-toolbar-popover]"');
  });

  it("escapes focus to the panel before a menu item deletes its own anchor", () => {
    // 削除項目はアンカーごと unmount するので ToolbarPopover のフォーカス復帰先が消える。
    // body へ落ちると次の Delete がキャンバスへ届き、選択中のグラフごと消える。
    expect(editorSettingsSource).toContain('document.querySelector<HTMLElement>("[data-graph-settings-panel]")');
    const removeHandlers = editorSettingsSource.match(/focusGraphSettingsSurface\(\);\n\s+onRemove\(\);/g);
    // 2D曲線・2D点・3D項目の各削除操作が同じフォーカス退避を行う。
    expect(removeHandlers?.length).toBe(3);
  });

  it("closes the panel when the document instance is replaced", () => {
    // resetEditorDocument は documentInstanceRevision を進めて overlay を再マウントする。
    // 再マウント後の選択は空で、パネルが握るコールバックは破棄済みインスタンスを指すので、
    // 「開いたまま残す」分岐は成立しない (dispatch される detail:null に必ず負ける)。
    expect(editorShellSource).not.toContain("preserveOpenGraphSettings");
  });

  it("keeps the panel width token and the placement constant in sync", () => {
    const tokenMatch = /--graph-panel-width:\s*(\d+)px/.exec(globalCss);
    const constantMatch = /GRAPH_SETTINGS_PANEL_WIDTH_PX = (\d+)/.exec(placementSource);

    expect(tokenMatch?.[1]).toBeDefined();
    expect(constantMatch?.[1]).toBe(tokenMatch?.[1]);
    expect(Number(constantMatch?.[1])).toBeLessThanOrEqual(320);
  });

  it("keeps a status surface for mode guidance and unresolved fills", () => {
    expect(editorSettingsSource).toContain("GRAPH_FILL_UNRESOLVED_EVENT");
    expect(editorSettingsSource).toContain('tShape("graph.fillUnresolved")');
    expect(createTranslator("ja", "shape")("graph.fillUnresolved")).toContain("この領域は閉じていません");
    expect(editorSettingsSource).toContain('data-testid="overlay-graph-mode-status"');
  });
});
