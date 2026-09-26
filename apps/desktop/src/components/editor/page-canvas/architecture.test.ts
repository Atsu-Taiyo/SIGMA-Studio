import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getModuleSpecifiers as importSpecifiers } from "../../../../tests/helpers/source-dependencies";

function readSiblingSource(fileName: string): string {
  return readFileSync(new URL(fileName, import.meta.url), "utf8");
}

describe("page canvas pure-model dependency boundary", () => {
  it("shares column eligibility between the ribbon and context menus", () => {
    const facade = readSiblingSource("../editor-shell/chrome/layout-commands.ts");
    expect(importSpecifiers(facade)).toEqual(["../../page-canvas/column-command-state"]);
    const model = readSiblingSource("./column-command-state.ts");
    expect(importSpecifiers(model).filter(specifier => /editor-shell|PageCanvasEditor|react|@tiptap/.test(specifier))).toEqual([]);
    const canvas = readSiblingSource("../PageCanvasEditor.tsx");
    expect(importSpecifiers(canvas)).toContain("./page-canvas/column-command-state");
    expect(importSpecifiers(canvas)).toContain("./page-canvas/manual-break-context");
  });

  it("paginates with an open loop: probe natural geometry, place once, adopt", () => {
    const probe = readSiblingSource("./flow-probe.ts");
    const invalidImports = importSpecifiers(probe).filter((specifier) => (
      specifier === "react"
      || specifier === "react-dom"
      || specifier.startsWith("@tiptap/")
      || specifier.startsWith("@/features/ai-edit")
      || specifier.startsWith("@/lib/ai/")
      || /(?:PageCanvasEditor|TextFlowEditor|EditorShell|OverlayCanvasEditorClient)/.test(specifier)
    ));
    expect(invalidImports).toEqual([]);
    expect(probe).not.toMatch(/\b(?:useState|useRef|useEffect|requestAnimationFrame|ResizeObserver)\b/);

    const pageCanvas = readSiblingSource("../PageCanvasEditor.tsx");
    const measure = pageCanvas.indexOf("probeFlow(flow, {");
    const build = pageCanvas.indexOf("buildFlowModel(tree,", measure);
    const place = pageCanvas.indexOf("placeFlow(built.model,", build);
    const plan = pageCanvas.indexOf("planFlowRender(built, placement)", place);
    const adopt = pageCanvas.indexOf("setLayoutViewState(", plan);
    expect(measure).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(measure);
    expect(place).toBeGreaterThan(build);
    expect(plan).toBeGreaterThan(place);
    expect(adopt).toBeGreaterThan(plan);
    // 閉ループ (隙間を入れた DOM の再計測・振動ガード・凍結) を二度と持ち込まない。
    expect(pageCanvas).not.toMatch(/detectGapOscillation|frozenPaginationGaps|MAX_PAGINATION_PASSES|buildAppliedGapIndex|readAppliedGapPx/);
  });

  it("keeps page models independent from UI and AI", () => {
    const runningRegionTextModel = readSiblingSource("./running-region-text-model.ts");
    const problemAreaModel = readSiblingSource("./problem-area-model.ts");
    const inlineContentComposition = readSiblingSource("./inline-content-composition.ts");
    const visibilityModel = readSiblingSource("./virtualization.ts");
    const spaceAfterPreview = readSiblingSource("./space-after-preview.ts");
    const sources = [
      readSiblingSource("./body-text-flow-transition.ts"),
      readSiblingSource("./reconciliation.ts"),
      readSiblingSource("./id-normalization.ts"),
      readSiblingSource("./space-after-drag-session.ts"),
      inlineContentComposition,
      readSiblingSource("./pointer-model.ts"),
      problemAreaModel,
      runningRegionTextModel,
      visibilityModel,
      spaceAfterPreview,
    ];
    const invalidImports = sources.flatMap((source) => importSpecifiers(source)).filter((specifier) => (
      specifier === "react"
      || specifier === "react-dom"
      || specifier.startsWith("@tiptap/")
      || specifier.startsWith("@/components/")
      || specifier.startsWith("@/features/ai-edit")
      || specifier.startsWith("@/lib/ai/")
      || specifier.startsWith("@/electron/")
      || specifier.includes("PageCanvasEditor")
      || specifier.includes("TextFlowEditor")
    ));

    expect(invalidImports).toEqual([]);
    expect(runningRegionTextModel).not.toMatch(
      /\b(?:window|HTMLElement|NodeList|Range)\b|\bdocument\s*\./,
    );
    expect(problemAreaModel).not.toMatch(
      /\b(?:window|HTMLElement|NodeList|Range)\b|\bdocument\s*\./,
    );
    expect(problemAreaModel).not.toContain('from "@/lib/id"');
    expect(inlineContentComposition).not.toMatch(
      /\b(?:window|HTMLElement|NodeList|Range|ReactNode)\b|\bdocument\s*\./,
    );
    expect(visibilityModel).not.toMatch(
      /\b(?:window|HTMLElement|DOMRect|ResizeObserver|IntersectionObserver|performance)\b|\bdocument\s*\./,
    );
    // ドラッグ中プレビューの「誰が追従するか」は幾何だけで決まる。DOM を覗くと、掴んで
    // いる最中に実測が動いて答えが揺れる (cohort は pointerdown で 1 回きり決める約束)。
    expect(spaceAfterPreview).not.toMatch(
      /\b(?:window|HTMLElement|DOMRect|PointerEvent|ResizeObserver)\b|\bdocument\s*\./,
    );
  });

  it("keeps the space-after paint adapter below its canvas controller", () => {
    const source = readSiblingSource("./space-after-commit-paint.ts");
    expect(importSpecifiers(source).filter((specifier) => (
      specifier === "react" || specifier.startsWith("@/features/ai-edit")
      || /(?:PageCanvasEditor|EditorShell|TextFlowEditor)/.test(specifier)
    ))).toEqual([]);
    const session = readSiblingSource("./space-after-drag-session.ts");
    expect(session).not.toMatch(/\b(?:window|HTMLElement|MutationObserver|requestAnimationFrame)\b/);
  });

  it("keeps the page controller as the one-way composition entrypoint", () => {
    const pageCanvas = readSiblingSource("../PageCanvasEditor.tsx");

    expect(pageCanvas).toContain('from "./page-canvas/body-text-flow-transition"');
    expect(pageCanvas).toContain('from "./page-canvas/inline-content-composition"');
    expect(pageCanvas).toContain('from "./page-canvas/pointer-model"');
    expect(pageCanvas).toContain('from "./page-canvas/problem-area-model"');
    expect(pageCanvas).toContain('from "./page-canvas/running-region-text-model"');
    expect(pageCanvas).toContain('from "./page-canvas/virtualization"');
    expect(pageCanvas).toContain('from "./page-canvas/flow-probe"');
    expect(pageCanvas).toContain('from "./page-canvas/space-after-preview"');
    // ドラッグ中の換算と追従集合はページ制御側で書き直さない (純関数側の 1 箇所だけ)。
    expect(pageCanvas).not.toMatch(/\bfunction resolveSpaceAfterDragPx\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction resolveSpaceAfterPreviewCohort\s*\(/);
    // 関数宣言だけを見張っても、インラインで書き直されたら気付けない。換算に要る材料を
    // ページ制御側が握っていないことまで見る (クランプの上限を持ち込んだ瞬間に落ちる)。
    // ページの刻みは他の用途でも使うので、ここでは見張らない。
    expect(pageCanvas).not.toContain("MAX_BLOCK_SPACE_AFTER_PX");
    expect(pageCanvas).not.toMatch(/Math\.round\([^)]*startPx/);
    expect(pageCanvas).not.toContain('from "./page-canvas/reconciliation"');
    expect(pageCanvas).not.toMatch(/\bfunction collectReservedProblemAreaIds\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction collectReservedLayoutSectionIds\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction replaceProblemAreaRichBlocks\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction replaceLayoutSectionChildren\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction getPageDoubleTapHit\s*\(/);
    // ページ割りの判定と gap の読み戻しは純関数モジュール側にしか置かない。
    expect(pageCanvas).not.toMatch(/\bfunction decidePagination\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction gapMapSignature\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction detectGapOscillation\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction buildAppliedGapIndex\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction measureAppliedGapPx\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction arePageDoubleTapHitsEqual\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction pageRunningRegionToTextFlowBlocks\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction textFlowBlocksToRunningBlocks\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction getHiddenOptionalProblemAreas\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction ensureOptionalProblemArea\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction clearOptionalProblemArea\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction setProblemAreaMinHeight\s*\(/);
    expect(pageCanvas).not.toMatch(/\bfunction splitTextFlowBlocksByInlineContent\s*\(/);
    expect(pageCanvas).not.toMatch(/\btype TextFlowExtensionPart\b/);
    expect(pageCanvas).not.toMatch(/\bconst PAGE_WINDOW_OVERSCAN\s*=/);
    expect(pageCanvas).not.toMatch(/\bconst PAGE_WINDOW_FAST_SCROLL_OVERSCAN\s*=/);
    expect(pageCanvas).not.toMatch(/\bconst scrollSpeed\s*=/);
    expect(pageCanvas).toContain("createInitialVisiblePageRange()");
    expect(pageCanvas).toContain("resolvePageVisibilityWindow({");

    const runningRegionUpdate = pageCanvas.slice(
      pageCanvas.indexOf("const updateRunningRegionBlocks"),
      pageCanvas.indexOf("const resizeRunningRegionForContent"),
    );
    expect(runningRegionUpdate).toMatch(
      /onPageLayoutChange\(nextLayout\);\s*setPageLayoutDraft\(null\);\s*pageLayoutDraftRef\.current = null;/,
    );

    const problemAreaResize = pageCanvas.slice(
      pageCanvas.indexOf("const startProblemAreaResize"),
      pageCanvas.indexOf("const handleTextFlowFocusChange"),
    );
    expect(problemAreaResize).toMatch(
      /problemAreaHeightDraftsRef\.current = rest;\s*setProblemAreaHeightDrafts\(rest\);[\s\S]*?onChange\(transition\.targetId, transition\.reduce\);/,
    );

    const problemMenuActions = pageCanvas.slice(
      pageCanvas.indexOf("{contextMenuHiddenAreas.map"),
      pageCanvas.indexOf("{activeBodyContextMenu"),
    );
    expect(problemMenuActions).toMatch(
      /showProblemArea\([^;]+;\s*setProblemContextMenu\(null\);/,
    );
    expect(problemMenuActions).toMatch(
      /clearProblemArea\([^;]+;\s*setProblemContextMenu\(null\);/,
    );

    const problemAreaView = pageCanvas.slice(
      pageCanvas.indexOf("function ProblemAreaFlowUnit"),
      pageCanvas.indexOf("function problemAreaSideLabel"),
    );
    const textFlowIndex = problemAreaView.indexOf("<TextFlowWithInlineContent");
    const afterContentIndex = problemAreaView.indexOf(
      "{afterInlineContent.length > 0",
    );
    const resizeHandleIndex = problemAreaView.indexOf(
      'className="problem-area-resize-handle"',
    );
    expect(textFlowIndex).toBeGreaterThanOrEqual(0);
    expect(afterContentIndex).toBeGreaterThan(textFlowIndex);
    expect(resizeHandleIndex).toBeGreaterThan(afterContentIndex);

    expect(pageCanvas).toContain(
      'scroller.addEventListener("scroll", scheduleUpdate, { passive: true })',
    );
    // 可視ページ範囲は page canvas が 1 箇所で決めて配る (受け手が各自で数え直さない)。
    // 受け手は読み取り専用プレビュー 3 つと、編集モードの overlay 1 つ。
    expect(
      pageCanvas.match(/visiblePageRange=\{visiblePageRange\}/g),
    ).toHaveLength(4);
    // The running region used to take a `variant` prop that every production caller set to
    // `"print"`; the header/footer body is now drawn by the same renderer as the page body, so there
    // is no fork left to pin. What matters is that the page canvas still composes the view itself.
    expect(pageCanvas).toContain("<PageRunningRegionView");
    const runningRegionElements = pageCanvas.match(/<PageRunningRegionView[^>]*>/g) ?? [];
    expect(runningRegionElements).toHaveLength(2);
    expect(runningRegionElements.join("")).not.toContain("variant=");
  });
});
