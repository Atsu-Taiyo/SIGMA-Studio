import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getModuleSpecifiers as importSpecifiers } from "../../../../tests/helpers/source-dependencies";

function readSiblingSource(fileName: string): string {
  return readFileSync(new URL(fileName, import.meta.url), "utf8");
}

function listProductionSources(
  directory: URL,
  relativeDirectory = "",
): Array<{ relativePath: string; source: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      return listProductionSources(
        new URL(`${entry.name}/`, directory),
        relativePath,
      );
    }
    if (
      !entry.isFile()
      || !/\.tsx?$/.test(entry.name)
      || entry.name.includes(".test.")
      || entry.name.includes(".spec.")
    ) {
      return [];
    }
    return [{
      relativePath,
      source: readFileSync(new URL(entry.name, directory), "utf8"),
    }];
  });
}

/**
 * Anything that reads a rendered size back out of the DOM.
 *
 * `client*` / `offset*` / `getComputedStyle` are in the list because they are the obvious way to
 * write the same measurement without calling `getBoundingClientRect`, and an observer is how it gets
 * re-run — each of these was tried against the pin and had to be added to make it fail.
 */
const LAYOUT_READ_APIS = /\.getBoundingClientRect\(|\.getClientRects\(|\bgetComputedStyle\(|\boffset(?:Width|Height|Top|Left)\b|\bclient(?:Width|Height|Top|Left)\b|\bnew (?:Resize|Intersection|Mutation)Observer\b/g;

/**
 * Code only. A pin that reads comments cannot tell "this is gone" from "this is explained", and the
 * note left where a removed measurement used to live has to be allowed to name it.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The source span of a named function, from its declaration to its closing brace.
 *
 * Brace matching rather than "the next declaration": a nested arrow function or an object literal
 * in between would end the span early, and a span that ends early is a hole in the pin below.
 */
function functionBodyRange(source: string, name: string): [number, number] {
  const declaration = new RegExp(
    `(?:function\\s+${name}\\b|(?:const|let)\\s+${name}\\s*(?::[^=]*)?=)`,
  ).exec(source);
  if (!declaration) {
    throw new Error(`${name} が見つかりません`);
  }
  const open = source.indexOf("{", declaration.index);
  if (open < 0) {
    throw new Error(`${name} の本体が見つかりません`);
  }
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return [declaration.index, index];
      }
    }
  }
  throw new Error(`${name} の本体が閉じていません`);
}

/**
 * Every place the module reads layout back out of the DOM, reported as the surrounding source line.
 *
 * Reported by position rather than by "which function is this in": resolving a site to the nearest
 * preceding declaration attributed a measurement written just after an allowed function to that
 * function, so a re-introduced `useEffect(() => { … getBoundingClientRect() … })` slipped straight
 * through. The caller states the spans that may contain one, and everything outside them fails.
 */
function layoutReadSites(rawSource: string, allowedFunctions: string[]): string[] {
  const source = withoutComments(rawSource);
  const allowedRanges = allowedFunctions.map((name) => functionBodyRange(source, name));
  return [...source.matchAll(LAYOUT_READ_APIS)]
    .filter((site) => !allowedRanges.some(([start, end]) => site.index! > start && site.index! < end))
    .map((site) => {
      const lineStart = source.lastIndexOf("\n", site.index!) + 1;
      const lineEnd = source.indexOf("\n", site.index!);
      return source.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim();
    });
}

function namedImportSource(source: string, importedName: string): string | null {
  const imports = [...source.matchAll(/import\s+(?:type\s*)?{([\s\S]*?)}\s*from\s*["']([^"']+)["'];/g)];
  const matchingImport = imports.find((match) => (
    new RegExp(`\\b${importedName}\\b`).test(match[1])
  ));
  return matchingImport?.[2] ?? null;
}

describe("overlay shape renderer dependency boundary", () => {
  it("keeps renderer views independent from the canvas controller", () => {
    const renderer = readSiblingSource("./shape-renderer.tsx");
    const editors = [
      "./shape-editors.tsx",
      "./shape-editor-types.ts",
      "./table-cell-content-editor.tsx",
      "./table-rendered-lines.tsx",
      "./table-shape-editor.tsx",
      "./text-shape-editor.tsx",
    ].map(readSiblingSource).join("\n");

    expect(renderer).not.toContain("../OverlayCanvasEditorClient");
    expect(editors).not.toContain("../OverlayCanvasEditorClient");
    expect(renderer).toContain('from "./shape-editors"');
    expect(`${renderer}\n${editors}`).not.toMatch(
      /from\s+["']@\/(?:features\/ai-edit|lib\/ai)(?:\/|["'])/,
    );
  });

  it("preserves the canvas entrypoint's editor-view compatibility exports", () => {
    const client = readSiblingSource("../OverlayCanvasEditorClient.tsx");

    expect(client).toContain("OverlayTableShapeEditor");
    expect(client).toContain("OverlayTextShapeEditor");
    expect(client).toContain("type OriginPickPreview");
    expect(client).toContain("type TableShapeResizePatch");
    expect(client).toContain('from "./overlay-canvas/shape-editors"');
  });

  it("keeps table editor leaves behind a one-way parent boundary", () => {
    const parent = readSiblingSource("./table-shape-editor.tsx");
    const cellContent = readSiblingSource("./table-cell-content-editor.tsx");
    const renderedLines = readSiblingSource("./table-rendered-lines.tsx");
    const compatibilityFacade = readSiblingSource("./shape-editors.tsx");
    const leaves = `${cellContent}\n${renderedLines}`;

    expect(parent).toContain('from "./table-cell-content-editor"');
    expect(parent).toContain('from "./table-rendered-lines"');
    expect(parent.indexOf("</table>")).toBeLessThan(parent.indexOf("<OverlayTableRenderedLines"));
    expect(leaves).not.toMatch(
      /from\s+["'].+(?:table-shape-editor|shape-editors|shape-renderer|OverlayCanvasEditorClient)["']/,
    );
    expect(compatibilityFacade).not.toContain("table-cell-content-editor");
    expect(compatibilityFacade).not.toContain("table-rendered-lines");
  });

  /**
   * The editor used to draw its table boundaries from `measureRenderedTableRowOffsets`: it read the
   * rendered `<tr>` rects back out of the DOM and positioned the `double` line overlay and the row
   * boundary handles from that. It only needed to because `resolveTrackSizes` returned rows that
   * added up to less than the shape's height, which let the browser stretch them — and the static
   * view, which has no DOM to measure, drew those boundaries at the unstretched offsets instead. The
   * total is guaranteed now (`overlay-output-read-model.test.ts`), so both surfaces draw from the
   * same computed offsets and there is no measurement left to feed back into a position.
   */
  it("draws table boundaries from computed offsets instead of a measured DOM", () => {
    const editor = readSiblingSource("./table-shape-editor.tsx");
    const model = readSiblingSource("./shapes/table-editor-model.ts");
    const renderedLines = readSiblingSource("./table-rendered-lines.tsx");

    const code = withoutComments(`${editor}\n${model}\n${renderedLines}`);
    for (const removed of [
      "measureRenderedTableRowOffsets",
      "getRenderedElementScale",
      "tableOffsetArraysEqual",
      "renderedRowOffsets",
      "rowBoundaryOffsets",
      "rowBoundaryHeights",
      "ResizeObserver",
    ]) {
      expect(code, `${removed} は描画位置に戻る経路`).not.toContain(removed);
    }
    // The line overlay reads the same offsets the static view passes its own copy
    // (`OverlayTableStaticView`), so the prop names have to stay the model's names.
    expect(renderedLines).toContain("rowOffsets");
    expect(editor).toContain("rowOffsets={rowOffsets}");
    // What may still measure, and nothing else. Each allowed function turns a client-space position
    // into model px — a zoom ratio, which cell a point is over, whether the caret is on the first or
    // last line — and none of them returns anything a boundary is drawn from.
    expect(layoutReadSites(editor, ["getTableResizeScale"])).toEqual([]);
    expect(layoutReadSites(model, [
      "getTableCellPositionFromClientPoint",
      "isTableCellCaretAtVerticalEdge",
    ])).toEqual([]);
    expect(layoutReadSites(renderedLines, [])).toEqual([]);
  });

  /**
   * A shape's text height is measured from the DOM, and that measurement has exactly one home.
   *
   * The renderer itself must stay free of layout reads — it is mounted by `packages/viewer` and by
   * the print surface, where there is nothing to write a measurement back to. The measuring module
   * gets an allow-list of function *names*: the rule is not "this file may measure" but "these two
   * functions may", so a `useEffect` that starts reading rects next to them still fails.
   */
  it("keeps the text height measurement in two named functions", () => {
    expect(layoutReadSites(readSiblingSource("./shape-renderer.tsx"), [])).toEqual([]);
    expect(layoutReadSites(readSiblingSource("./text-shape-measure.ts"), [
      "measureOverlayTextContentHeight",
      "useOverlayTextContentHeight",
    ])).toEqual([]);
  });

  /**
   * The editing surface and the static view must turn a measured height into a box height the same
   * way. They are different mounts of the same shape, so a second conversion would show up as the
   * box jumping at the moment focus arrives or leaves.
   */
  it("keeps one conversion from measured content to box height", () => {
    const editor = readSiblingSource("./text-shape-editor.tsx");
    const renderer = readSiblingSource("./shape-renderer.tsx");

    for (const source of [editor, renderer]) {
      expect(source).toContain("overlayTextBoxHeightForContent");
      expect(source).toContain('from "./text-shape-measure"');
    }
    expect(editor).toContain("measureOverlayTextContentHeight");
  });

  it("keeps re-anchoring as a UI-free overlay model", () => {
    const model = readSiblingSource("./reanchor-model.ts");
    const graphLabels = readSiblingSource("./shapes/graph-labels.ts");
    const controller = readSiblingSource("../OverlayCanvasEditorClient.tsx");
    const invalidImports = importSpecifiers(model).filter((specifier) => (
      specifier === "react"
      || specifier === "react-dom"
      || specifier.startsWith("@tiptap/")
      || specifier.startsWith("@/components/")
      || specifier.startsWith("@/features/ai-edit")
      || specifier.startsWith("@/lib/ai/")
      || specifier.startsWith("../PageCanvasEditor")
    ));

    expect(invalidImports).toEqual([]);
    expect(graphLabels).toContain('from "../reanchor-model"');
    expect(controller).toContain('from "./overlay-canvas/reanchor-model"');
    expect(controller).not.toMatch(/\bfunction reanchorShapesByPosition\s*\(/);
    expect(controller).not.toMatch(/\bfunction syncMovedOverlayShapeAnchor\s*\(/);
  });

  it("keeps generic overlay production independent from shell and AI composition", () => {
    const overlaySources = [
      {
        relativePath: "OverlayCanvasEditorClient.tsx",
        source: readSiblingSource("../OverlayCanvasEditorClient.tsx"),
      },
      ...listProductionSources(new URL("./", import.meta.url)),
    ];
    const invalidImports = overlaySources.flatMap(({ relativePath, source }) => (
      importSpecifiers(source)
        .filter((specifier) => (
          specifier.endsWith("/editor-shell/constants")
          || specifier === "@/features/ai-edit"
          || specifier.startsWith("@/features/ai-edit/")
          || specifier === "@/lib/ai"
          || specifier.startsWith("@/lib/ai/")
        ))
        .map((specifier) => ({ relativePath, specifier }))
    ));

    expect(invalidImports).toEqual([]);
  });

  it("routes shape menu consumers through the overlay gallery leaf", () => {
    // The shape/line menus moved out of EditorShell.tsx into the shared chrome group components
    // (WI-3, 振る舞い不変リファクタ). The consumer file changed; what it must import, and from
    // where, did not.
    const shell = readSiblingSource("../editor-shell/chrome/editor-chrome.tsx");
    const editorShell = readSiblingSource("../EditorShell.tsx");
    const controller = readSiblingSource("../OverlayCanvasEditorClient.tsx");
    const legacyConstants = readSiblingSource("../editor-shell/constants.ts");
    const movedLegacyNames = [
      "AI_APPLY_ADD_FLASH_MS",
      "AI_APPLY_REMOVE_ANIMATION_MS",
      "AI_SIDEBAR_WIDTH",
      "isLineToolCommand",
      "isShapeMenuCommand",
      "buildLineToolItems",
      "buildShapeGallerySections",
      "buildShapeTypeChangeSections",
    ];
    const legacyProductionConsumers = listProductionSources(new URL("../", import.meta.url))
      .flatMap(({ relativePath, source }) => (
        [...source.matchAll(
          /import\s+(?:type\s*)?{([^}]*)}\s*from\s*["']([^"']*editor-shell\/constants)["'];/g,
        )]
          .filter((match) => movedLegacyNames.some((name) => (
            new RegExp(`\\b${name}\\b`).test(match[1])
          )))
          .map(() => relativePath)
      ));

    // 一覧は文言を持つので定数ではなく builder。ただし**呼ぶのはシェル側**で、
    // memo 済みの配列をクロームへ渡す。`renderEditorChrome` は打鍵ごとに走るので、
    // ここで builder を呼ぶとポップオーバーが閉じていても毎回辞書を引くことになる。
    expect(namedImportSource(editorShell, "buildLineToolItems"))
      .toBe("@/components/editor/overlay-canvas/shape-gallery");
    expect(namedImportSource(editorShell, "buildShapeGallerySections"))
      .toBe("@/components/editor/overlay-canvas/shape-gallery");
    expect(shell).not.toMatch(/buildShapeGallerySections\(|buildLineToolItems\(/u);
    expect(namedImportSource(shell, "isLineToolCommand"))
      .toBe("@/components/editor/overlay-canvas/shape-gallery");
    expect(namedImportSource(shell, "isShapeMenuCommand"))
      .toBe("@/components/editor/overlay-canvas/shape-gallery");
    expect(namedImportSource(controller, "buildShapeTypeChangeSections"))
      .toBe("./overlay-canvas/shape-gallery");
    expect(legacyProductionConsumers).toEqual([]);
    expect(legacyConstants).toContain('from "@/components/editor/overlay-canvas/shape-gallery"');
    expect(legacyConstants).not.toContain("AI_APPLY_REMOVE_ANIMATION_MS");
    expect(legacyConstants).not.toContain("AI_APPLY_ADD_FLASH_MS");
    expect(legacyConstants).not.toContain("AI_SIDEBAR_WIDTH");
    expect(legacyConstants).not.toContain("createLucideIcon");
    expect(legacyConstants).not.toContain("function buildShapeGallerySections");
    expect(legacyConstants).not.toContain("function buildShapeTypeChangeSections");
  });
});
