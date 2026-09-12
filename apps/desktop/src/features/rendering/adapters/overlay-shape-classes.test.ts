import path from "node:path";
import { readStylesheet as readFileSync } from "../../../../tests/helpers/read-stylesheet";

import { describe, expect, it } from "vitest";

/**
 * `packages/viewer` mounts the static shape renderer through the print surface, and it loads only
 * `document-surface.css` plus its own stylesheet — never `globals.css`. So every class the static
 * renderer relies on for *geometry* has to live in the shared file.
 *
 * This was a real break: moving the running region's shapes from an injected SVG string to React
 * left `.overlay-shape` (and therefore `position: absolute`) undefined in the viewer, which stacked
 * every header shape in normal flow instead of at its coordinates. The injected SVG had positioned
 * everything internally, so nothing had needed these rules before.
 *
 * A prefix rule is no use here — `overlay-` also covers a hundred editor-chrome classes — so the
 * set is listed explicitly, taken from what `shape-renderer.tsx` emits on the read-only path.
 */

const appDir = path.resolve(import.meta.dirname, "../../../app");
const documentSurfaceCss = readFileSync(path.join(appDir, "document-surface.css"), "utf8");
const globalsCss = readFileSync(path.join(appDir, "globals.css"), "utf8");
/** Classes the read-only shape path needs for layout; the viewer has to get them from the shared file. */
const SHARED_SHAPE_CLASSES = [
  "overlay-shape",
  "overlay-vector-svg",
  "overlay-image-frame",
  "overlay-callout-text-frame",
  "overlay-text-shape",
  "graph-shape",
];

/**
 * Classes the read-only renderer also emits but that deliberately stay editor-only, with the
 * reason. The staleness test keeps the list honest.
 */
const EDITOR_ONLY_SHAPE_CLASSES: Record<string, string> = {
  "overlay-graph-shape": "グラフの編集クローム側の別名。読み取り専用の描画は .graph-shape だけで成立する",
  "overlay-table-shape-table": "表の静的ビューはスタイルをインライン化するので CSS を必要としない (WI-5)",
};

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Top-level selectors that define the class, i.e. the class is not merely used as an ancestor. */
function definesClass(css: string, className: string): boolean {
  return new RegExp(`(?:^|[,\\s])\\.${className}(?=$|[\\s,{.:[])`, "m").test(stripComments(css));
}

describe("the static shape renderer's classes are reachable from the viewer", () => {
  it("defines every layout-critical shape class in document-surface.css", () => {
    const missing = SHARED_SHAPE_CLASSES.filter((className) => (
      !definesClass(documentSurfaceCss, className)
    ));

    expect(missing).toEqual([]);
  });

  it("keeps the base definitions out of globals.css", () => {
    // Modifier rules (`.overlay-shape.selected`, `.overlay-image-frame.cropping`, …) are editor
    // chrome and stay; what must not come back is the base rule the viewer depends on.
    const duplicated = SHARED_SHAPE_CLASSES.filter((className) => (
      new RegExp(`(?:^|\\n)\\.${className}(?=[\\s,{])`).test(stripComments(globalsCss))
    ));

    expect(duplicated).toEqual([]);
  });

  it("gives .overlay-shape the absolute positioning the inline coordinates need", () => {
    const rule = /\.overlay-shape \{([^}]*)\}/.exec(stripComments(documentSurfaceCss))?.[1] ?? "";

    expect(rule).toContain("position: absolute");
  });

  it("keeps the editor-only list free of stale entries", () => {
    const stale = Object.keys(EDITOR_ONLY_SHAPE_CLASSES)
      .filter((className) => definesClass(documentSurfaceCss, className));

    expect(stale).toEqual([]);
  });
});
