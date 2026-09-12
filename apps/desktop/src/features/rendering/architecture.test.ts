import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";

import { getModuleSpecifiers as importSpecifiers } from "../../../tests/helpers/source-dependencies";

import {
  computeProblemAreaColumnFlow,
  createOverlayPageSlices,
  getVisibleOverlayShapes,
  simulateBalancedColumnHeightPx,
  type OverlayPageSlice,
  type OverlayPageWindow,
  type OverlayPreviewStackLayer,
  type TextFlowColumnBlockLayout,
  type VisiblePageRange,
} from "./core";
import {
  computeProblemAreaColumnFlow as legacyComputeProblemAreaColumnFlow,
  simulateBalancedColumnHeightPx as legacySimulateBalancedColumnHeightPx,
} from "@/components/editor/page-canvas/problem-area-flow";
import type {
  TextFlowColumnBlockLayout as LegacyTextFlowColumnBlockLayout,
} from "@/components/editor/TextFlowEditor";
import {
  createOverlayPageSlices as legacyCreateOverlayPageSlices,
  getVisibleOverlayShapes as legacyGetVisibleOverlayShapes,
} from "@/components/editor/overlay-canvas/view-cache";
import type {
  OverlayPageSlice as LegacyOverlayPageSlice,
  OverlayPageWindow as LegacyOverlayPageWindow,
  OverlayPreviewStackLayer as LegacyOverlayPreviewStackLayer,
  VisiblePageRange as LegacyVisiblePageRange,
} from "@/components/editor/overlay-canvas/view-cache";

function sourceFiles(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryUrl = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      return sourceFiles(new URL(`${entry.name}/`, directory));
    }
    // `.js` / `.jsx` / `.mjs` も Next/SWC はコンパイルするので走査対象に含める
    // (`allowJs: false` は `tsc` にしか効かない)。symlink も実体を見る。
    return (entry.isFile() || entry.isSymbolicLink()) && /\.[cm]?[jt]sx?$/.test(entry.name)
      ? [fileURLToPath(entryUrl)]
      : [];
  });
}

describe("independent column rendering", () => {
  it("shares grid geometry between the body, nested editor and output adapters", () => {
    for (const path of [
      "../../components/editor/PageCanvasEditor.tsx",
      "../../components/tiptap/layout-section-extension.ts",
      "../../components/print/print-static-blocks.tsx",
    ]) {
      const text = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(importSpecifiers(text)).toContain("@/features/rendering/core");
      expect(text).toContain("createIndependentColumnLayout(");
      expect(text).toContain("createColumnRuleStyle(");
    }
  });
});

function productionSourceFiles(directory: URL): string[] {
  return sourceFiles(directory)
    .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"));
}

function pointsToProjectPath(specifier: string, path: string): boolean {
  return specifier === `@/${path}` || specifier.startsWith(`@/${path}/`);
}

function resolvedSpecifiers(source: string, sourceFile: string): string[] {
  return importSpecifiers(source, { resolveFrom: {
    sourceFile,
    sourceRoot: fileURLToPath(new URL("../../", import.meta.url)),
  } });
}

function coreBoundaryViolations(source: string, sourceFile: string): string[] {
  return resolvedSpecifiers(source, sourceFile).filter((specifier) => (
    specifier !== "@/features/document" && !pointsToProjectPath(specifier, "features/rendering/core")
  ));
}

function importedSymbols(source: string): string[] {
  return [...source.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g)]
    .flatMap((match) => match[1].split(",")
      .map((entry) => entry.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean));
}

function desktopSourcePath(file: string): string {
  return file.slice(fileURLToPath(new URL("../../", import.meta.url)).length);
}

describe("rendering feature dependency boundary", () => {
  it("owns browser zoom notifications in a narrow adapter shared by publisher and canvas", () => {
    const pageCanvas = readFileSync(new URL("../../components/editor/PageCanvasEditor.tsx", import.meta.url), "utf8");
    const graphPreview = readFileSync(new URL("./adapters/react/Graph3DPreview.tsx", import.meta.url), "utf8");
    const core = readFileSync(new URL("./core/index.ts", import.meta.url), "utf8");

    expect(importSpecifiers(pageCanvas)).toContain("@/features/rendering/adapters/editor-zoom-event");
    expect(importSpecifiers(graphPreview)).toContain("../editor-zoom-event");
    expect(core).not.toContain("editor-zoom-event");
  });

  it("keeps core independent from frameworks, output adapters, and desktop features", () => {
    const files = productionSourceFiles(new URL("./core/", import.meta.url));
    const invalidImports = files.flatMap((file) => (
      coreBoundaryViolations(readFileSync(file, "utf8"), file)
        .map((specifier) => ({ file, specifier }))
    ));

    expect(invalidImports).toEqual([]);
  });

  it.each([
    "@/features/rendering/adapters/math-html",
    "../adapters/math-html",
    "@/features/drawing/shape-transform",
    "../../drawing/shape-transform",
    "@/components/editor/EditorShell",
    "../../../components/editor/EditorShell.tsx",
    "@/../electron/main",
    "../../../../electron/main",
  ])("rejects a resolved core dependency in every syntax: %s", (specifier) => {
    const source = `import { value } from "${specifier}"; export { value } from "${specifier}"; const load = () => import("${specifier}");`;
    expect(coreBoundaryViolations(source, fileURLToPath(new URL("./core/probe.ts", import.meta.url))))
      .toHaveLength(3);
  });

  it("accepts equivalent local spellings of its existing document and core dependencies", () => {
    const source = 'import type { SigmaDocument } from "../../document/index.js"; export * from "@/features/rendering/core/flow-fragmentation";';
    expect(coreBoundaryViolations(source, fileURLToPath(new URL("./core/probe.ts", import.meta.url)))).toEqual([]);
  });

  // The other half of the edge `features/drawing/architecture.test.ts` opens: drawing may read the
  // rendering core, so the core must never read drawing back or the two layers collapse.
  // Intentionally narrower than the rule above: named separately so the reverse edge is stated,
  // not inferred, and both alias and relative spellings reach the same check.
  it("never reaches back into the drawing feature", () => {
    const files = productionSourceFiles(new URL("./core/", import.meta.url));
    const drawingImports = files.flatMap((file) => (
      resolvedSpecifiers(readFileSync(file, "utf8"), file)
        .filter((specifier) => pointsToProjectPath(specifier, "features/drawing"))
        .map((specifier) => ({ file, specifier }))
    ));

    expect(drawingImports).toEqual([]);
  });

  /**
   * A shape's text is drawn by the body's own static block renderer, which lives in `components/`
   * — so the file that mounts React components for the SVG export reaches into that layer, and it
   * is the only one that may. Stated as an exhaustive list rather than a ban, so a second such
   * import has to be argued for here instead of appearing quietly.
   */
  it("keeps the one components import in the export's React binding", () => {
    const files = productionSourceFiles(new URL("./", import.meta.url));
    const componentImporters = files.filter((file) => (
      resolvedSpecifiers(readFileSync(file, "utf8"), file)
        .some((specifier) => pointsToProjectPath(specifier, "components"))
    ));

    expect(componentImporters.map((file) => file.split("/features/rendering/")[1])).toEqual([
      "adapters/svg/react-static-renderers.tsx",
    ]);
  });

  it("keeps adapters on the rendering-core public entrypoint", () => {
    const files = productionSourceFiles(new URL("./adapters/", import.meta.url));
    const deepCoreImports = files.flatMap((file) => (
      resolvedSpecifiers(readFileSync(file, "utf8"), file)
        .filter((specifier) => (
          specifier.startsWith("@/features/rendering/core/") ||
          specifier.startsWith("../core/")
        ))
        .map((specifier) => ({ file, specifier }))
    ));

    expect(deepCoreImports).toEqual([]);
  });

  it("keeps the React adapter independent from editor and AI components", () => {
    const files = productionSourceFiles(new URL("./adapters/react/", import.meta.url));
    const invalidImports = files.flatMap((file) => (
      resolvedSpecifiers(readFileSync(file, "utf8"), file)
        .filter((specifier) => (
          pointsToProjectPath(specifier, "components") ||
          pointsToProjectPath(specifier, "features/ai-edit") ||
          pointsToProjectPath(specifier, "lib/tiptap-adapter") ||
          pointsToProjectPath(specifier, "types/sigma-doc") ||
          specifier.startsWith("@tiptap/")
        ))
        .map((specifier) => ({ file, specifier }))
    ));

    expect(invalidImports).toEqual([]);
    expect(readFileSync(
      fileURLToPath(new URL("./adapters/react/index.ts", import.meta.url)),
      "utf8",
    )).toMatch(/^"use client";/);
  });

  it("keeps the SVG serializer headless and uses only public document/drawing boundaries", () => {
    const serializer = readFileSync(
      fileURLToPath(new URL("./adapters/svg/overlay-svg.ts", import.meta.url)),
      "utf8",
    );
    const invalidImports = importSpecifiers(serializer).filter((specifier) => (
      specifier === "react" ||
      specifier.startsWith("react/") ||
      specifier === "react-dom" ||
      specifier.startsWith("react-dom/") ||
      pointsToProjectPath(specifier, "components") ||
      pointsToProjectPath(specifier, "features/ai-edit") ||
      pointsToProjectPath(specifier, "types") ||
      pointsToProjectPath(specifier, "lib") ||
      specifier === "../react" ||
      specifier.startsWith("../react/")
    ));

    expect(invalidImports).toEqual([]);
    expect(serializer).not.toMatch(/renderToStaticMarkup|<Graph2DPreview\b/);

    const reactBindings = readFileSync(
      fileURLToPath(new URL("./adapters/svg/react-static-renderers.tsx", import.meta.url)),
      "utf8",
    );
    const reactBindingImports = importSpecifiers(reactBindings);
    expect(reactBindingImports).toContain("react-dom/server");
    expect(reactBindingImports).not.toContain("../react");
    expect(reactBindingImports.filter((specifier) => specifier.startsWith("../react/"))).toEqual([
      "../react/Graph2DPreview",
      "../react/MathEnvironment",
      "../react/OverlayChartStaticView",
      "../react/OverlayTableStaticView",
    ]);
    expect(reactBindingImports).not.toContain("../react/Graph3DPreview");

    const staticReactEntrypoint = readFileSync(
      fileURLToPath(new URL("./adapters/react/static.ts", import.meta.url)),
      "utf8",
    );
    expect(importSpecifiers(staticReactEntrypoint)).toEqual(["./InlineContent"]);
    expect(staticReactEntrypoint).not.toMatch(/Graph3DPreview|OrbitControls/);
  });

  it("keeps external consumers off rendering implementation files", () => {
    const publicEntrypoints = new Set([
      "@/features/rendering/adapters",
      // Browser event contracts must not pull HTML serializers into publishers.
      "@/features/rendering/adapters/editor-zoom-event",
      "@/features/rendering/adapters/react",
      // Electron main also renders text into AI preview SVGs. This narrow public entrypoint
      // deliberately excludes browser-only Graph3DPreview/OrbitControls from that bundle.
      "@/features/rendering/adapters/react/static",
      "@/features/rendering/adapters/svg",
      // three は react/svg と並ぶ描画アダプタ。3D教材の動画書き出しがここから入る。
      // 束ねる index を経由させるのは、three を引く経路をこの1つに保つため
      // (`@/features/rendering/adapters` に載せると全消費者が three を抱える)。
      "@/features/rendering/adapters/three",
      // ヘッドレスな3D静止画の描画だけは深いパスで引く。`adapters/svg` の index は
      // react-static-renderers を再輸出するので、index 経由にすると MCP プロセス
      // (stdio の素の node) とブラウザバンドルへ react-dom/server が入る。
      // three の例外と同じ形で、React を引く経路を index の消費者だけに閉じ込める。
      "@/features/rendering/adapters/svg/graph3d-scene-svg",
      "@/features/rendering/core",
    ]);
    const renderingRoot = fileURLToPath(new URL("./", import.meta.url));
    const files = productionSourceFiles(new URL("../../", import.meta.url))
      .filter((file) => !file.startsWith(renderingRoot));
    const deepRenderingImports = files.flatMap((file) => (
      resolvedSpecifiers(readFileSync(file, "utf8"), file)
        .filter((specifier) => (
          specifier.startsWith("@/features/rendering/") &&
          !publicEntrypoints.has(specifier)
        ))
        .map((specifier) => ({ file, specifier }))
    ));

    expect(deepRenderingImports).toEqual([]);
  });

  it("owns overlay page windowing in the public framework-neutral core", () => {
    const core = readFileSync(
      fileURLToPath(new URL(
        "./core/overlay-page-window.ts",
        import.meta.url,
      )),
      "utf8",
    );
    const viewCache = readFileSync(
      fileURLToPath(new URL(
        "../../components/editor/overlay-canvas/view-cache.ts",
        import.meta.url,
      )),
      "utf8",
    );
    const pageCanvas = readFileSync(
      fileURLToPath(new URL(
        "../../components/editor/PageCanvasEditor.tsx",
        import.meta.url,
      )),
      "utf8",
    );
    const viewCacheImport = pageCanvas.match(
      /import\s*\{([^}]*)\}\s*from\s*["']\.\/overlay-canvas\/view-cache["']/,
    );

    expect(legacyCreateOverlayPageSlices).toBe(createOverlayPageSlices);
    expect(legacyGetVisibleOverlayShapes).toBe(getVisibleOverlayShapes);
    expectTypeOf<LegacyOverlayPageSlice>()
      .toEqualTypeOf<OverlayPageSlice>();
    expectTypeOf<LegacyOverlayPageWindow>()
      .toEqualTypeOf<OverlayPageWindow>();
    expectTypeOf<LegacyOverlayPreviewStackLayer>()
      .toEqualTypeOf<OverlayPreviewStackLayer>();
    expectTypeOf<LegacyVisiblePageRange>()
      .toEqualTypeOf<VisiblePageRange>();

    expect(core).not.toMatch(
      /features\/drawing|features\/rendering\/adapters|components\/|getShapeBounds|getOverlayPreviewSvg/,
    );
    expect(viewCache).not.toMatch(
      /\bfunction\s+(?:createOverlayPageSlices|getVisibleOverlayShapes|getShapePageSpan)\b/,
    );
    expect(viewCache).toContain('from "@/features/rendering/core"');
    expect(viewCache).toContain("createResolvedOverlayView");
    // The overlay view model never reaches the SVG serializer and never carries a stored
    // SVG string: the snapshot is the only source and every drawing path is React.
    expect(viewCache).not.toMatch(/getOverlayPreviewSvg|serializeOverlayPreviewSvg/);
    expect(viewCache).not.toMatch(/fallbackSvg/);
    expect(viewCache).not.toContain("adapters/svg");
    // Membership, not the literal import block: pinning the exact text made this fail
    // whenever an unrelated symbol was added to the same (correct) entrypoint.
    const pageCanvasCoreImport = pageCanvas.match(
      /import\s*\{([^}]*)\}\s*from\s*["']@\/features\/rendering\/core["']/,
    );
    expect(pageCanvasCoreImport?.[1]).toContain("getVisibleOverlayShapes");
    expect(pageCanvasCoreImport?.[1]).toContain("OverlayPreviewStackLayer");
    expect(pageCanvasCoreImport?.[1]).toContain("TextFlowColumnBlockLayout");
    expect(viewCacheImport?.[1]).not.toContain("getVisibleOverlayShapes");
    expect(viewCacheImport?.[1]).not.toContain("OverlayPreviewStackLayer");
  });

  it("owns problem-area column flow in the public framework-neutral core", () => {
    const core = readFileSync(
      fileURLToPath(new URL(
        "./core/problem-area-column-flow.ts",
        import.meta.url,
      )),
      "utf8",
    );
    const pageAdapter = readFileSync(
      fileURLToPath(new URL(
        "../../components/editor/page-canvas/problem-area-flow.ts",
        import.meta.url,
      )),
      "utf8",
    );
    const pageCanvas = readFileSync(
      fileURLToPath(new URL(
        "../../components/editor/PageCanvasEditor.tsx",
        import.meta.url,
      )),
      "utf8",
    );

    expect(core).not.toMatch(
      /\b(?:window|HTMLElement|DOMRect|ResizeObserver)\b|\bdocument\s*\./,
    );
    expect(pageAdapter).not.toMatch(
      /\bfunction\s+(?:computeProblemAreaColumnFlow|simulateBalancedColumnHeightPx)\b/,
    );
    expect(importSpecifiers(pageAdapter)).toContain(
      "@/features/rendering/core",
    );
    expect(importSpecifiers(pageCanvas)).toContain(
      "@/features/rendering/core",
    );
    expect(legacyComputeProblemAreaColumnFlow).toBe(
      computeProblemAreaColumnFlow,
    );
    expect(legacySimulateBalancedColumnHeightPx).toBe(
      simulateBalancedColumnHeightPx,
    );
    expectTypeOf<LegacyTextFlowColumnBlockLayout>()
      .toEqualTypeOf<TextFlowColumnBlockLayout>();
  });

  it("keeps former Graph, Math, and SVG component paths as logic-free facades", () => {
    const facades = [
      {
        file: new URL("../../components/graph/Graph2DPreview.tsx", import.meta.url),
        publicEntrypoint: "@/features/rendering/adapters/react",
      },
      {
        file: new URL("../../components/math/MathPreview.tsx", import.meta.url),
        publicEntrypoint: "@/features/rendering/adapters/react",
      },
      {
        file: new URL("../../components/editor/overlay-canvas/svg-export.tsx", import.meta.url),
        publicEntrypoint: "@/features/rendering/adapters/svg",
      },
    ];

    for (const facade of facades) {
      const source = readFileSync(fileURLToPath(facade.file), "utf8");
      expect(importSpecifiers(source)).toEqual([facade.publicEntrypoint]);
      expect(source).not.toMatch(/\bfunction\b|=>|\breturn\b/);
    }

    const inlineMathExtension = readFileSync(
      fileURLToPath(new URL("../../components/tiptap/inline-math-extension.tsx", import.meta.url)),
      "utf8",
    );
    // 数式ノードビューは素の DOM を作るので、その DOM も markup も adapters の公開口から取る。
    // (React の `InlineMathPreview` はもう使わない — 編集中の入力欄だけが React。)
    expect(inlineMathExtension).toMatch(
      /import \{[^}]*\brenderMathHtml\b[^}]*\} from "@\/features\/rendering\/adapters";/,
    );
    // 記号の追加では割れないよう、束ねた import の**中に居ること**だけを固定する
    // (同じ入口から symbol が増えるため)。
    //
    // ここで見るのは `InlineMathPreview` ではなく `createInlineMathFrameElement`:
    // 非編集時のノードビューは React をやめて素の DOM で組むようになったので、
    // React の `InlineMathPreview` はもう import されない (編集中の入力欄だけが React)。
    expect(inlineMathExtension).toMatch(
      /import \{[^}]*\bcreateInlineMathFrameElement\b[^}]*\} from "@\/features\/rendering\/adapters";/,
    );
    // 無害化 (`math-markup.ts`) から辿れる依存に MathLive/KaTeX を混ぜないため、名前だけの
    // 葉モジュール (`inline-math-frame.ts`) は `math-html` を import しない。
    expect(readFileSync(
      fileURLToPath(new URL("./adapters/inline-math-frame.ts", import.meta.url)),
      "utf8",
    )).not.toMatch(/from "\.\/math-html"/);
    expect(inlineMathExtension).not.toMatch(/\bfunction\s+renderMathHtml\b/);
    // クラス名・属性を自前で書かない (書いた瞬間に静的レンダラと二重管理になる)。
    expect(inlineMathExtension).not.toContain('"inline-math-node"');
  });

  /**
   * 数式 markup の stored XSS を出口 1 本で塞ぐ設計を固定する。TeX から HTML を作る口と、
   * その HTML を DOM へ流し込む口が増えたらここが赤くなる。増やすときは
   * `adapters/math-markup.ts` の無害化を必ず通すこと。
   */
  describe("math markup has exactly one sanitizing outlet", () => {
    const desktopSourceRoot = new URL("../../", import.meta.url);

    function readDesktopSource(file: string): string {
      return readFileSync(fileURLToPath(new URL(file, desktopSourceRoot)), "utf8");
    }

    /**
     * この門番は `apps/desktop/src` 配下の本番ソースだけを見る。`packages/viewer` /
     * `packages/editor` / `apps/desktop/electron` は対象外 (いずれも現状 sink 0 件)。
     *
     * 判定は**正規表現ではなく TypeScript の構文木**で行う。字面で見ると
     * `__html :` の空白・`.replace()` の後置・名前が同じだけのローカル関数・
     * コメント内の言及などで簡単に食い違いが起き、実測でどれも素通りしたため。
     *
     * 残る穴: プロパティ名を実行時に組み立てる書き方 (`{ ["inner" + "HTML"]: x }` など) は
     * 静的には決められないので捕まえられない。門番を欺く意図がある場合の話で、
     * うっかり書けるものではないが、ここが限界であることは自覚しておくこと。
     */
    const HTML_SINK_PROPERTIES = new Set(["innerHTML", "outerHTML"]);
    const REACT_HTML_SINK = "dangerouslySetInnerHTML";

    /**
     * 無害化を通しても安全にならない、または出所を構文木で追えない DOM 書き込み。
     * **現状 0 件**なので 0 件のまま固定する。使いたくなったら設計から見直すこと。
     * (`createContextualFragment` と `srcdoc` は挿入した `<script>` が実行される。
     * `innerHTML` 系は実行しないので、これらは監視済みの sink より危険度が高い。)
     */
    const FORBIDDEN_HTML_SINKS = new Set([
      "insertAdjacentHTML",
      "createContextualFragment",
      "setHTMLUnsafe",
      "parseHTMLUnsafe",
      "srcDoc",
      "srcdoc",
    ]);

    /** `document.write` 系だけを禁止する (`this.write` や `clipboard.write` は別物)。 */
    const FORBIDDEN_DOCUMENT_WRITES = new Set(["write", "writeln"]);

    /** 内側で必ず無害化を通る生成器。`symbol` と `module` の組でだけ許可する。 */
    const HTML_GENERATORS: ReadonlyArray<{ symbol: string; module: string }> = [
      // 数式 markup の主経路 (`math-html.ts` は必ず `sanitizeMathMarkup` を通す)。
      { symbol: "renderMathHtml", module: "@/features/rendering/adapters" },
      { symbol: "renderMathHtml", module: "@/features/rendering/adapters/react" },
      { symbol: "renderMathHtml", module: "../math-html" },
      // 同じ `math-html.ts` を隣から読む面 (`adapters/inline-math-dom.ts` = 数式 DOM の共通出典)。
      { symbol: "renderMathHtml", module: "./math-html" },
      // 無害化本体。KaTeX を自分で呼ぶ面 (`Graph2DPreview`) はこれを直接使う。
      { symbol: "sanitizeMathMarkup", module: "../math-markup" },
      // 図形 SVG。
      { symbol: "exportOverlaySvg", module: "@/features/rendering/adapters/svg" },
      // 図形プレビュー: SVG の出所は `exportOverlaySvg` だけ (下の it が固定する)。
      { symbol: "buildShapesSvgPreview", module: "@/lib/ai/ai-edit-shape-preview" },
      { symbol: "buildShapeOnlyPreview", module: "@/lib/ai/ai-edit-shape-preview" },
    ];

    /**
     * 構文木は**1 ファイルにつき 1 回だけ**作る。
     *
     * この describe の `it` は同じソース集合を何度も歩くので、素直に書くと
     * 全ファイルの TypeScript パースが `it` の数だけ繰り返される。移行で
     * ファイルと行が増えるたびに線形に伸び、**フルスイート実行で 5 秒の
     * タイムアウトを超えるようになった** (実測)。走査中にソースは変わらないので、
     * 同じ入力に同じ木を返して構わない。
     */
    const parsedSources = new Map<string, ts.SourceFile>();

    function parseSource(file: string): ts.SourceFile {
      const cached = parsedSources.get(file);
      if (cached) {
        return cached;
      }
      const parsed = ts.createSourceFile(
        file,
        readDesktopSource(file),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      parsedSources.set(file, parsed);
      return parsed;
    }

    function eachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
      visit(node);
      node.forEachChild((child) => eachNode(child, visit));
    }

    function propertyName(node: ts.PropertyAssignment | ts.JsxAttribute): string | null {
      const name = node.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        return name.text;
      }
      // 計算プロパティ (`["__" + "html"]`) は名前を静的に決められないので不可。
      return null;
    }

    interface HtmlSink {
      /** DOM へ入る値。形が想定外で式を取り出せなかった場合は `null`。 */
      expression: ts.Expression | null;
      description: string;
    }

    /**
     * DOM へ HTML 文字列を書き込む口を構文木から集める。`el.innerHTML = x` /
     * `el["innerHTML"] = x` / `Object.assign(el, { innerHTML: x })` /
     * JSX とオブジェクト両方の `dangerouslySetInnerHTML` を同じ 1 つの定義で捕まえる。
     */
    function collectHtmlSinks(sourceFile: ts.SourceFile): HtmlSink[] {
      const sinks: HtmlSink[] = [];

      eachNode(sourceFile, (node) => {
        if (ts.isJsxAttribute(node) && propertyName(node) === REACT_HTML_SINK) {
          const initializer = node.initializer;
          const objectLiteral = initializer && ts.isJsxExpression(initializer) && initializer.expression
            && ts.isObjectLiteralExpression(initializer.expression)
            ? initializer.expression
            : null;
          sinks.push({
            expression: readHtmlProperty(objectLiteral),
            description: node.getText().slice(0, 80),
          });
          return;
        }

        if (ts.isPropertyAssignment(node)) {
          const name = propertyName(node);
          if (name === REACT_HTML_SINK) {
            sinks.push({
              expression: ts.isObjectLiteralExpression(node.initializer)
                ? readHtmlProperty(node.initializer)
                : null,
              description: node.getText().slice(0, 80),
            });
            return;
          }
          if (name !== null && HTML_SINK_PROPERTIES.has(name)) {
            // `Object.assign(el, { innerHTML: x })` の形。実測で本番 0 件だが、
            // 書かれたら通常の sink と同じ検査に乗せる。
            sinks.push({ expression: node.initializer, description: node.getText().slice(0, 80) });
          }
          return;
        }

        if (ts.isCallExpression(node)
          && node.expression.getText() === "Reflect.set"
          && node.arguments.length >= 3
          && ts.isStringLiteralLike(node.arguments[1])
          && HTML_SINK_PROPERTIES.has(node.arguments[1].text)) {
          sinks.push({ expression: node.arguments[2], description: node.getText().slice(0, 80) });
          return;
        }

        if (ts.isBinaryExpression(node)
          && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
          const target = node.left;
          const written = ts.isPropertyAccessExpression(target)
            ? target.name.text
            : ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)
              ? target.argumentExpression.text
              : null;
          if (written !== null && HTML_SINK_PROPERTIES.has(written)) {
            sinks.push({ expression: node.right, description: node.getText().slice(0, 80) });
          }
        }
      });

      return sinks;
    }

    /** `{ __html: X }` から X を取り出す。余計なプロパティや spread があれば `null`。 */
    function readHtmlProperty(objectLiteral: ts.ObjectLiteralExpression | null): ts.Expression | null {
      if (!objectLiteral || objectLiteral.properties.length !== 1) {
        // `{ __html: safe, ...evil }` は React が後勝ちで上書きするので 1 個だけ許す。
        return null;
      }
      const [property] = objectLiteral.properties;
      if (!ts.isPropertyAssignment(property) || propertyName(property) !== "__html") {
        return null;
      }
      return property.initializer;
    }

    /** 承認済みモジュールから承認済みシンボルとして import された名前 (別名は解決する)。 */
    function approvedGeneratorNames(sourceFile: ts.SourceFile): Set<string> {
      const names = new Set<string>();

      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
          continue;
        }
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings) || !ts.isStringLiteral(statement.moduleSpecifier)) {
          continue;
        }
        const specifier = statement.moduleSpecifier.text;
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly
            && HTML_GENERATORS.some((generator) => generator.symbol === imported && generator.module === specifier)) {
            names.add(element.name.text);
          }
        }
      }

      return names;
    }

    /** ファイル内で同じ名前が宣言されているか (import した生成器の名前を隠していないか)。 */
    function isLocallyDeclared(sourceFile: ts.SourceFile, name: string): boolean {
      let declared = false;
      eachNode(sourceFile, (node) => {
        if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableDeclaration(node))
          && node.name && ts.isIdentifier(node.name) && node.name.text === name) {
          declared = true;
        }
      });
      return declared;
    }

    /** 式そのものが承認済み生成器の呼び出しか。後置の `.replace(...)` などは含まれない。 */
    function isApprovedGeneratorCall(sourceFile: ts.SourceFile, expression: ts.Expression): boolean {
      if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
        return false;
      }
      const name = expression.expression.text;
      return approvedGeneratorNames(sourceFile).has(name) && !isLocallyDeclared(sourceFile, name);
    }

    /**
     * `html` や `preview.svg` のような名前が、同じファイルで生成器の戻り値に
     * **一度だけ** `const` 束縛されているか。再代入や同名の別宣言があれば認めない。
     */
    function isBoundToApprovedGenerator(sourceFile: ts.SourceFile, expression: ts.Expression): boolean {
      const root = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
      if (!ts.isIdentifier(root)) {
        return false;
      }

      const name = root.text;
      const declarations: ts.VariableDeclaration[] = [];
      let reassigned = false;

      eachNode(sourceFile, (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
          declarations.push(node);
        }
        if (ts.isBinaryExpression(node)
          && node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
          && node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
          && node.operatorToken.getText().endsWith("=")
          && ts.isIdentifier(node.left) && node.left.text === name) {
          reassigned = true;
        }
      });

      if (declarations.length !== 1 || reassigned) {
        return false;
      }

      const [declaration] = declarations;
      const list = declaration.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;

      return isConst
        && declaration.initializer !== undefined
        && isApprovedGeneratorCall(sourceFile, declaration.initializer);
    }

    function isAccountedByGenerator(sourceFile: ts.SourceFile, expression: ts.Expression): boolean {
      return isApprovedGeneratorCall(sourceFile, expression)
        || isBoundToApprovedGenerator(sourceFile, expression);
    }

    /**
     * 上の自動判定に載らない注入。**理由を書けるものだけ**を置く。ここに足す = レビューで
     * 「なぜ無害化を通ると言えるのか」を必ず言語化させるための関門。
     * 件数・順序・式の字面まで固定するので、同じ書き方の注入が増えたら赤くなる。
     * `wrapper` を書いた項目は、その関数が実際に生成器を呼ぶことも確かめる。
     */
    interface ReviewedInjection {
      expression: string;
      reason: string;
      wrapper?: string;
    }

    const SHAPE_PREVIEW_REASON = "図形プレビューの `svg`。現時点でこの値を作るのは"
      + " `ai-edit-shape-preview.ts` の 2 つのヘルパだけで、どちらも `exportOverlaySvg` の"
      + " 戻り値をそのまま入れる (構造的な型なので型システムでは縛れていない)";

    const REVIEWED_INJECTIONS: Record<string, ReviewedInjection[]> = {
      "components/editor/AiEditPanel.tsx": [
        { expression: "preview.svg", reason: `${SHAPE_PREVIEW_REASON}。ここは props で受け取る` },
        { expression: "preview.svg", reason: `${SHAPE_PREVIEW_REASON}。ここは props で受け取る` },
        { expression: "preview.svg", reason: `${SHAPE_PREVIEW_REASON}。ここは props で受け取る` },
      ],
      "components/editor/EditorSettings.tsx": [
        {
          expression: "renderMathTemplateButtonHtml(template.tex, mathEnvironment)",
          reason: "同ファイルの薄いラッパ。TeX 側にプレースホルダを詰めてから `renderMathHtml` に渡すだけで、markup は生成器が作る",
          wrapper: "renderMathTemplateButtonHtml",
        },
      ],
      "components/editor/MaterialPreview.tsx": [
        {
          expression: "svg",
          reason: "同ファイルの `getMaterialPreviewSvg` の戻り値。中身は `exportOverlaySvg` の呼び出しと `undefined` だけ",
          wrapper: "getMaterialPreviewSvg",
        },
      ],
      "components/print/PrintPreview.tsx": [
        {
          expression: "backgroundSvg",
          reason: "オーバーレイがある場合だけ `exportOverlaySvg` を呼ぶ三項演算子の結果 (無い場合は `undefined`)",
        },
        {
          expression: "foregroundSvg",
          reason: "`backgroundSvg` と同じ形で、`stackLayer` だけが違う",
        },
      ],
      "features/ai-edit/view/AiEditInlinePreviewCard.tsx": [
        { expression: "shapeOnlyPreview.svg", reason: `${SHAPE_PREVIEW_REASON}。ここは \`useMemo\` 越し` },
        { expression: "afterPreview.svg", reason: `${SHAPE_PREVIEW_REASON}。ここは \`useMemo\` 越し` },
      ],
      "features/rendering/adapters/react/Graph2DPreview.tsx": [
        {
          expression: "renderTex(tex, mathEnvironment)",
          reason: "同ファイルの薄いラッパ。KaTeX の出力を `sanitizeMathMarkup` に通し、危ないと判定されたら `escapeHtml(tex)` に落とす",
          wrapper: "renderTex",
        },
      ],
    };

    /**
     * 生成器を通さない注入面。根拠は「リテラルだから」の一点なので、免除するのは
     * 生成器 import の要求だけ。「1 個のリテラルであること」は下の it が課したまま。
     */
    const CONSTANT_MARKUP_SITES: Record<string, string> = {
      "components/tiptap/url-detection-extension.tsx":
        "アプリ自身が書いた固定の SVG アイコン。補間も連結も無い単一リテラルなので、文書由来の文字列は 1 つも入らない",
    };

    /**
     * 注入面の探索から外すディレクトリ。
     *
     * i18n の辞書は**文字列リテラルしか持たないデータ**で、DOM へ書く構文
     * (`innerHTML` / `dangerouslySetInnerHTML` / `document.write` / `DOMParser`) を
     * 1 つも含み得ない。にもかかわらず、ここを 1 ファイルずつ TypeScript の
     * 構文木へ起こす費用は移行が進むほど増え、**この describe の走査が
     * フルスイート実行で 5 秒のタイムアウトを超えるようになった** (実測)。
     *
     * 除外して検査が甘くならないことは下の `it` が担保する: **足切りと同じ正規表現**で
     * 辞書ディレクトリを見張り、注入面の構文が 1 文字でも現れたら落とす
     * (構文木は起こさない。安さが除外の目的なので)。
     * **除外はこの「注入面の探索」限定**で、依存境界の検査は従来どおり全ファイルを見る。
     */
    const NON_INJECTION_SOURCE_DIRS = ["/src/lib/i18n/dictionaries/"];

    /**
     * 構文木を作る前の粗い足切り。**この語が 1 つも無いファイルは、構文木を
     * 起こしても sink になり得ない**ので読み飛ばす (`readFileSync` だけで済む)。
     *
     * 下の AST 検査が探すのは `HTML_SINK_PROPERTIES` / `REACT_HTML_SINK` /
     * `FORBIDDEN_HTML_SINKS` / `document.write(ln)` / `DOMParser` だけなので、
     * ここはその**上位集合**。増やすときは必ずこの一覧にも足すこと
     * (足し忘れると検査が静かに素通りする)。
     */
    const SINK_IDENTIFIER_PATTERN = new RegExp(
      [
        // 単独で現れたら疑う識別子。
        ...[
          ...HTML_SINK_PROPERTIES,
          REACT_HTML_SINK,
          ...FORBIDDEN_HTML_SINKS,
          "DOMParser",
        ].map((name) => `\\b${name}\\b`),
        // `write` / `writeln` は英文に普通に出る語なので、**`document` が近くにある形だけ**を見る。
        // 隣接 (`\\s*`) に絞ると `document?.write` / `document /* c */ .write` /
        // 改行とコメントを挟んだ形を落としてしまい、**AST では捕まるのに足切りで消える**
        // (実測で 4 形。ここを詰めても走査対象は 19 ファイルのままで費用は増えない)。
        ...[...FORBIDDEN_DOCUMENT_WRITES].map((name) => `\\bdocument\\b[\\s\\S]{0,80}?\\.\\s*${name}\\b`),
      ].join("|"),
      "u",
    );

    function injectionScanFiles(): string[] {
      return productionSourceFiles(desktopSourceRoot)
        .filter((file) => !NON_INJECTION_SOURCE_DIRS.some((directory) => file.includes(directory)))
        .filter((file) => SINK_IDENTIFIER_PATTERN.test(readFileSync(file, "utf8")));
    }

    it("keeps the excluded data directories free of any injection syntax", () => {
      // 除外した以上、その中身が本当に「注入し得ないデータ」であり続けることを
      // ここで見張る。構文木は使わない (安さが除外の目的なので)。
      // **足切りと同じ正規表現を使う。** 手写しにすると、`FORBIDDEN_HTML_SINKS` 等へ
      // sink を足したときにこちらを直し忘れ、除外ディレクトリだけ新しい sink を
      // 検査されなくなる (出典を 1 つにする)。
      const offenders = productionSourceFiles(desktopSourceRoot)
        .filter((file) => NON_INJECTION_SOURCE_DIRS.some((directory) => file.includes(directory)))
        .filter((file) => SINK_IDENTIFIER_PATTERN.test(readFileSync(file, "utf8")))
        .map(desktopSourcePath)
        .sort();

      expect(offenders, "除外ディレクトリに注入面の構文が現れた").toEqual([]);
      // 除外パスの綴りが腐って 0 件を走査していないこと。
      expect(productionSourceFiles(desktopSourceRoot)
        .filter((file) => NON_INJECTION_SOURCE_DIRS.some((directory) => file.includes(directory)))
        .length).toBeGreaterThan(10);
    });

    let injectionSiteFileCache: string[] | null = null;

    function injectionSiteFiles(): string[] {
      injectionSiteFileCache ??= injectionScanFiles()
        .map(desktopSourcePath)
        .filter((file) => collectHtmlSinks(parseSource(file)).length > 0)
        .sort();
      return injectionSiteFileCache;
    }

    it("keeps script-executing DOM write APIs out of the app", () => {
      const users = injectionScanFiles().map(desktopSourcePath).flatMap((file) => {
        const sourceFile = parseSource(file);
        const hits: string[] = [];
        eachNode(sourceFile, (node) => {
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const method = node.expression.name.text;
            if (FORBIDDEN_HTML_SINKS.has(method)
              || (FORBIDDEN_DOCUMENT_WRITES.has(method)
                && /(^|\.)document$/.test(node.expression.expression.getText()))) {
              hits.push(`${file}: ${method}`);
            }
          }
          const attribute = ts.isJsxAttribute(node) ? propertyName(node) : null;
          if (attribute !== null && FORBIDDEN_HTML_SINKS.has(attribute)) {
            hits.push(`${file}: ${attribute}`);
          }
        });
        return hits;
      }).sort();

      expect(users).toEqual([]);
    });

    it("keeps DOM parsing confined to clipboard import", () => {
      // `DOMParser` は切り離した Document を作るだけで DOM への書き込みではないが、
      // そこから `adoptNode` で本文へ運べば無害化を迂回できる。使う面を 1 つに固定する。
      const parsers = injectionScanFiles()
        .filter((file) => /\bDOMParser\b/.test(readFileSync(file, "utf8")))
        .map(desktopSourcePath)
        .sort();

      expect(parsers).toEqual(["lib/editor-clipboard.ts"]);
    });

    it("keeps every HTML sink in a shape whose injected value can be read", () => {
      // `{{ __html: x, ...spread }}` や計算プロパティは、DOM に入る値を構文木から
      // 特定できない = 出所を検査できない。形の時点で落とす。
      const opaque = injectionSiteFiles().flatMap((file) => collectHtmlSinks(parseSource(file))
        .filter((sink) => sink.expression === null)
        .map((sink) => `${file}: ${sink.description}`));

      expect(opaque).toEqual([]);
    });

    it("accounts for every injected expression", () => {
      const unaccounted = injectionSiteFiles()
        .filter((file) => !CONSTANT_MARKUP_SITES[file])
        .flatMap((file) => {
          const sourceFile = parseSource(file);
          const reviewed = REVIEWED_INJECTIONS[file] ?? [];
          const expressions = collectHtmlSinks(sourceFile)
            .flatMap((sink) => (sink.expression ? [sink.expression] : []))
            .filter((expression) => !isAccountedByGenerator(sourceFile, expression))
            .map((expression) => expression.getText());

          // 件数・順序・字面まで一致を要求する。表の 1 行が将来の別の注入まで
          // 免罪してしまう (同じ変数名を使うだけで通る) のを防ぐため。
          return expressions.length === reviewed.length
            && expressions.every((expression, index) => expression === reviewed[index].expression)
            ? []
            : [`${file}: ${expressions.join(" / ") || "(表の項目が余っている)"}`];
        });

      expect(unaccounted).toEqual([]);
    });

    it("requires every injecting file to import an approved generator", () => {
      const unaccounted = injectionSiteFiles()
        .filter((file) => !CONSTANT_MARKUP_SITES[file])
        .filter((file) => approvedGeneratorNames(parseSource(file)).size === 0);

      expect(unaccounted).toEqual([]);
    });

    it("keeps every reviewed injection entry live and justified", () => {
      const sites = injectionSiteFiles();
      expect(Object.keys(CONSTANT_MARKUP_SITES).filter((file) => !sites.includes(file))).toEqual([]);
      expect(Object.values(CONSTANT_MARKUP_SITES).filter((reason) => reason.trim() === "")).toEqual([]);

      const stale = Object.entries(REVIEWED_INJECTIONS).flatMap(([file, entries]) => {
        if (!sites.includes(file)) {
          return [`${file}: 注入面ではなくなった`];
        }
        const sourceFile = parseSource(file);
        return entries.flatMap((entry) => [
          ...(entry.reason.trim() === "" ? [`${file}: 理由が空`] : []),
          ...(entry.wrapper && !wrapperCallsGenerator(sourceFile, entry.wrapper)
            ? [`${file}: ${entry.wrapper} が生成器を呼んでいない`]
            : []),
        ]);
      });

      expect(stale).toEqual([]);
    });

    /** 表の `wrapper` が本当に生成器を呼ぶか。コメントでの言及は構文木に無いので効かない。 */
    function wrapperCallsGenerator(sourceFile: ts.SourceFile, wrapper: string): boolean {
      let body: ts.Node | undefined;
      eachNode(sourceFile, (node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === wrapper) {
          body = node.body;
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === wrapper
          && node.initializer
          && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          body = node.initializer.body;
        }
      });

      if (!body) {
        return false;
      }

      let calls = false;
      eachNode(body, (node) => {
        if (ts.isExpression(node) && isApprovedGeneratorCall(sourceFile, node)) {
          calls = true;
        }
      });
      return calls;
    }

    it("lets an exempt surface inject only a single literal", () => {
      const dynamic = Object.keys(CONSTANT_MARKUP_SITES).flatMap((file) => {
        const sourceFile = parseSource(file);
        return collectHtmlSinks(sourceFile)
          // リテラル 1 個であることを構文木で見る。`"a" + url + "b"` は連結なので落ちる。
          .filter((sink) => !sink.expression
            || !(ts.isNoSubstitutionTemplateLiteral(sink.expression) || ts.isStringLiteral(sink.expression)))
          .map((sink) => `${file}: ${sink.description}`);
      });

      expect(dynamic).toEqual([]);
    });

    it("keeps the shape-preview helper a thin wrapper over the SVG serializer", () => {
      // 上の表が図形プレビューの `svg` を信用できるのは、そこが `exportOverlaySvg` 以外から
      // markup を作らないから。別の作り方が足されたら赤くする。
      const helperPath = "lib/ai/ai-edit-shape-preview.ts";
      const helper = parseSource(helperPath);
      const generators = approvedGeneratorNames(helper);

      // 返り値の `svg` に入る式を集める (`{ svg }` の短縮形も同じ 1 本で扱う)。
      const svgValues: ts.Expression[] = [];
      eachNode(helper, (node) => {
        if (ts.isPropertyAssignment(node) && propertyName(node) === "svg") {
          svgValues.push(node.initializer);
        }
        if (ts.isShorthandPropertyAssignment(node) && node.name.text === "svg") {
          svgValues.push(node.name);
        }
      });

      expect(generators.has("exportOverlaySvg")).toBe(true);
      expect(importSpecifiers(readDesktopSource(helperPath))).not.toContain("react-dom/server");
      expect(svgValues.length).toBeGreaterThan(0);
      // `svg` に入るのは `exportOverlaySvg` の呼び出しか、その戻り値を受けた const だけ。
      expect(svgValues
        .filter((value) => !isAccountedByGenerator(helper, value))
        .map((value) => value.getText())).toEqual([]);
    });

    it("keeps MathLive markup generation in the render adapter and the measurer", () => {
      const generators = productionSourceFiles(desktopSourceRoot)
        .filter((file) => importedSymbols(readFileSync(file, "utf8")).includes("convertLatexToMarkupCached"))
        .map(desktopSourcePath)
        .sort();

      // `math-metrics.ts` は**無害化前**の生 markup を正規表現で読んで数式の高さを決める。
      // ここに無害化を挟むと属性の順序や引用符の違いが図形テキストの箱サイズを黙って壊す。
      expect(generators).toEqual([
        "features/rendering/adapters/math-html.ts",
        "features/rendering/adapters/math-metrics.ts",
      ]);
    });

    it("keeps the KaTeX runtime behind the same three files", () => {
      const katexConsumers = productionSourceFiles(desktopSourceRoot)
        .filter((file) => resolvedSpecifiers(readFileSync(file, "utf8"), file)
          // スタイルシート (`katex/dist/katex.min.css`) は markup を作らないので数えない。
          .some((specifier) => (specifier === "katex" || specifier.startsWith("katex/")) &&
            !specifier.endsWith(".css")))
        .map(desktopSourcePath)
        .sort();

      expect(katexConsumers).toEqual([
        "features/rendering/adapters/math-metrics.ts",
        "features/rendering/adapters/react/Graph2DPreview.tsx",
        "lib/math-tex.ts",
      ]);
    });

    it("pins every surface that writes a generated HTML string into the DOM", () => {
      expect(injectionSiteFiles()).toEqual([
        "components/editor/AiEditPanel.tsx",
        "components/editor/EditorSettings.tsx",
        "components/editor/MaterialPreview.tsx",
        "components/print/PrintPreview.tsx",
        "components/tiptap/url-detection-extension.tsx",
        "features/ai-edit/view/AiAppliedDocumentDiff.tsx",
        "features/ai-edit/view/AiEditInlinePreviewCard.tsx",
        "features/rendering/adapters/inline-math-dom.ts",
        "features/rendering/adapters/react/Graph2DPreview.tsx",
        "features/rendering/adapters/react/MathPreview.tsx",
      ]);
    });

    it("keeps the sanitizer free of DOM and framework dependencies", () => {
      // markup は Electron レンダラだけでなく、SVG 書き出しの文字列シリアライザと
      // vitest の node 環境でも作られる。DOM 前提のサニタイザはこの経路で使えない。
      const sanitizer = readFileSync(
        fileURLToPath(new URL("./adapters/math-markup.ts", import.meta.url)),
        "utf8",
      );

      expect(importSpecifiers(sanitizer)).toEqual([
        "@/lib/math-macros",
        "./rich-text-html",
      ]);
      expect(sanitizer).not.toMatch(/\b(?:window|document|DOMParser|HTMLElement)\b/);
    });
  });

  it("keeps the AI shape preview on rendering and drawing feature entrypoints", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../lib/ai/ai-edit-shape-preview.ts", import.meta.url)),
      "utf8",
    );
    const specifiers = importSpecifiers(source);

    expect(specifiers).toContain("@/features/drawing");
    expect(specifiers).toContain("@/features/rendering/adapters/svg");
    expect(specifiers.filter((specifier) => pointsToProjectPath(specifier, "components")))
      .toEqual([]);
  });
});

/**
 * 数式の組版スタイル (mathstyle) と描画環境 (マクロ + 組版スタイル) の門番。
 *
 * 「同じ TeX が編集中と静的表示で別の組版になる」は 3 度再発している。原因はいつも同じ形で、
 * (1) 組版スタイルの出典が複数ある、(2) 描画環境が省略可能な引数で呼び出し側から落とせる、
 * (3) 静的側だけ TeX を書き換える、のどれかだった。ここはその 3 つを構造として塞ぐ。
 */
describe("math typeset style and render environment have a single source", () => {
  const desktopSourceRoot = new URL("../../", import.meta.url);
  const TYPESET_STYLE_MODULE = "features/rendering/core/math-typeset-style.ts";

  /** `\displaystyle` / `\textstyle` (生でも JS エスケープでも引っかかる)。 */
  const TYPESET_STYLE_COMMAND = /\\(?:display|text)style/;

  /**
   * 組版スタイルの TeX コマンドを書いてよい本番ソース。**理由を書けるものだけ**を置く。
   * ここに足す = 「なぜ描画の出典が増えないと言えるか」をレビューで言語化させるための関門。
   */
  const TYPESET_STYLE_COMMAND_EXCEPTIONS: Record<string, string> = {
    "lib/tex-command-reference.ts": "コマンド一覧に見せる TeX の例文。描画には使わない",
    "lib/tex-environment-examples.ts": "TeX 環境設定のプレビューに見せる例文。著者が書く TeX と同じ扱い",
  };

  it("emits the typeset style TeX prefix from exactly one module", () => {
    const offenders = productionSourceFiles(desktopSourceRoot)
      .filter((file) => TYPESET_STYLE_COMMAND.test(readFileSync(file, "utf8")))
      .map(desktopSourcePath)
      .filter((file) => file !== TYPESET_STYLE_MODULE && !(file in TYPESET_STYLE_COMMAND_EXCEPTIONS))
      .sort();

    expect(offenders).toEqual([]);
    // 例外リストが化石化しないよう、登録した側も実在を確かめる。
    for (const file of Object.keys(TYPESET_STYLE_COMMAND_EXCEPTIONS)) {
      expect(TYPESET_STYLE_COMMAND.test(readFileSync(fileURLToPath(new URL(file, desktopSourceRoot)), "utf8")))
        .toBe(true);
    }
  });

  it("derives every math-field mode from the shared typeset style", () => {
    // `defaultMode` は編集中の mathstyle をそのまま決める。直値に戻ると静的側とだけ食い違う。
    const fieldModeWriters = productionSourceFiles(desktopSourceRoot)
      .filter((file) => /"default-mode":|\.defaultMode\s*=/.test(readFileSync(file, "utf8")))
      .map(desktopSourcePath)
      .sort();

    // MathExpressionInput delegates its editing field to InlineMathField, so it no longer
    // writes a MathLive mode independently.
    expect(fieldModeWriters).toEqual([
      "components/tiptap/inline-math-extension.tsx",
      "lib/mathlive-config.ts",
    ]);
    for (const file of fieldModeWriters) {
      expect(readFileSync(fileURLToPath(new URL(file, desktopSourceRoot)), "utf8"), file)
        .toContain("mathFieldDefaultMode(");
    }
  });

  it("never rewrites the source TeX to change fraction size", () => {
    // 静的側だけ `\frac` を `\dfrac` へ書き換えると、編集中の math-field と必ず食い違う。
    const rewriters = productionSourceFiles(desktopSourceRoot)
      .filter((file) => /convertFractionToDisplayStyle/.test(readFileSync(file, "utf8")))
      .map(desktopSourcePath);

    expect(rewriters).toEqual([]);
    for (const file of ["lib/math-tex.ts", "features/rendering/adapters/math-html.ts"]) {
      expect(readFileSync(fileURLToPath(new URL(file, desktopSourceRoot)), "utf8"), file)
        .not.toMatch(/\\dfrac/);
    }
  });

  it("keeps the render environment a required parameter everywhere it is consumed", () => {
    // 省略できると「本文だけマクロが効く」「ダイアログのプレビューだけ組版が違う」が
    // 型検査を素通りする。既定値も `?` も持たせない。
    const REQUIRED_ENVIRONMENT_PARAMETERS: Array<{ file: string; fn: string; parameter: string }> = [
      { file: "features/rendering/adapters/math-html.ts", fn: "renderMathHtml", parameter: "environment" },
      { file: "features/rendering/adapters/math-html.ts", fn: "isMathTexRenderable", parameter: "environment" },
      { file: "lib/math-tex.ts", fn: "convertLatexToMarkupCached", parameter: "environment" },
      { file: "features/rendering/adapters/math-metrics.ts", fn: "measureTexBoxEm", parameter: "environment" },
    ];

    const optional = REQUIRED_ENVIRONMENT_PARAMETERS.filter(({ file, fn, parameter }) => {
      const source = readFileSync(fileURLToPath(new URL(file, desktopSourceRoot)), "utf8");
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      let declaration: ts.FunctionDeclaration | undefined;
      sourceFile.forEachChild((node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === fn) {
          declaration = node;
        }
      });
      expect(declaration, `${file}: ${fn}`).toBeDefined();
      const found = declaration!.parameters.find((node) => node.name.getText() === parameter);
      expect(found, `${file}: ${fn}(${parameter})`).toBeDefined();
      return Boolean(found!.questionToken) || Boolean(found!.initializer);
    });

    expect(optional.map(({ file, fn }) => `${file}: ${fn}`)).toEqual([]);
  });

  it("keeps the typeset style module free of renderer imports", () => {
    // 組版スタイルは MathLive / KaTeX のどちらの都合でもない文書側の設定。
    const source = readFileSync(fileURLToPath(new URL(TYPESET_STYLE_MODULE, desktopSourceRoot)), "utf8");

    expect(importSpecifiers(source)).toEqual(["@/features/document"]);
  });
});
