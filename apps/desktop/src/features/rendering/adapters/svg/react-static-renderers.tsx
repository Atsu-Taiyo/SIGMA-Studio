import { renderToStaticMarkup } from "react-dom/server";

import {
  type OverlayAsset,
  type OverlayShape,
  type OverlayTextBlock,
  type SigmaChartData,
  type SigmaChartSpec,
  type SigmaTableSpec,
  A4_PAGE_PX,
} from "@/features/document";

/**
 * The one components-layer import in `features/rendering`, and a deliberate one: a shape's text is
 * drawn by the body's static block renderer, and this file exists precisely to mount the very
 * components the editor surface mounts so the export cannot drift from the screen. The component
 * is Tiptap-free (`package-boundary.test.ts` keeps it that way, since the embedded viewer bundles
 * it through the print surface). `architecture.test.ts` pins this as the only such import.
 */
import { OverlayTextBlocksView } from "@/components/editor/text-flow/OverlayTextBlocksView";

import {
  DEFAULT_MATH_RENDER_ENVIRONMENT,
  mathRenderEnvironmentCacheKey,
  type MathRenderEnvironment,
} from "@/lib/math-environment";

import { renderMathHtml } from "../math-html";
// Import only the static leaves used by SVG export. The React barrel also exports
// Graph3DPreview, which depends on three/examples/OrbitControls. Pulling that barrel into
// Electron main through ai-edit-shape-preview makes the packaged app require a browser-only
// module at startup (and electron-builder excludes dependency examples by default).
import { Graph2DPreview } from "../react/Graph2DPreview";
import { MathEnvironmentValueProvider } from "../react/MathEnvironment";
import { OverlayChartStaticView } from "../react/OverlayChartStaticView";
import { OverlayTableStaticView } from "../react/OverlayTableStaticView";
import {
  serializeOverlayPreviewSvg,
  serializeOverlaySvg,
  type OverlayCanvasSize,
  type OverlayPreviewSource,
  type OverlaySvgExportOptions,
  type OverlaySvgRenderers,
} from "./overlay-svg";

/**
 * Per-(table, geometry) memo for the table markup.
 *
 * Page previews re-serialize every off-screen page's overlay while the author types, and rendering
 * a table now goes through React instead of string concatenation — orders of magnitude more work
 * per call. Table specs are immutable snapshots in the overlay model, so keying on object identity
 * gets a high hit rate with no invalidation logic (same reasoning as `overlay-text-box.ts`).
 */
const tableHtmlCache = new WeakMap<SigmaTableSpec, Map<string, string>>();
/**
 * Resizing a shape keeps the table spec's identity and only changes the geometry, so the inner map
 * would otherwise grow by one multi-KB string per intermediate drag position.
 */
const TABLE_HTML_CACHE_GEOMETRIES = 8;

function renderTableHtmlMemoized(
  table: SigmaTableSpec,
  width: number,
  height: number,
  overflow: number,
  environment: MathRenderEnvironment,
): string {
  let cached = tableHtmlCache.get(table);
  if (!cached) {
    cached = new Map();
    tableHtmlCache.set(table, cached);
  }
  // セル内の数式は描画環境で変わるので、幾何だけでなく環境もキーに含める。
  const key = mathRenderEnvironmentCacheKey(environment, `${width}x${height}x${overflow}`);
  const hit = cached.get(key);
  if (hit !== undefined) {
    return hit;
  }

  const html = toXmlAttributeCasing(renderToStaticMarkup(
    <MathEnvironmentValueProvider environment={environment}>
      <OverlayTableStaticView
        height={height}
        overflow={overflow}
        selfContained
        table={table}
        width={width}
        xmlns="http://www.w3.org/1999/xhtml"
      />
    </MathEnvironmentValueProvider>,
  ));
  if (cached.size >= TABLE_HTML_CACHE_GEOMETRIES) {
    cached.delete(cached.keys().next().value as string);
  }
  cached.set(key, html);
  return html;
}

/**
 * Per-(data, geometry) memo for the chart markup, for the same reason the table has one: a page
 * preview re-serializes every off-screen page while the author types, and a chart is a full React
 * render per call. `SigmaChartData` is either the immutable snapshot on the shape or the value
 * `deriveChartData` returned for a given table, so object identity is a sound key.
 */
const chartSvgCache = new WeakMap<SigmaChartData, Map<string, string>>();
const CHART_SVG_CACHE_GEOMETRIES = 8;

function renderChartSvgMemoized(
  data: SigmaChartData,
  spec: SigmaChartSpec,
  width: number,
  height: number,
): string {
  let cached = chartSvgCache.get(data);
  if (!cached) {
    cached = new Map();
    chartSvgCache.set(data, cached);
  }
  // The spec is part of the key: the same data drawn as bars and as a pie is two different pictures.
  const key = `${width}x${height}|${JSON.stringify(spec)}`;
  const hit = cached.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const svg = renderToStaticMarkup(
    <OverlayChartStaticView data={data} height={height} spec={spec} width={width} />,
  );
  if (cached.size >= CHART_SVG_CACHE_GEOMETRIES) {
    cached.delete(cached.keys().next().value as string);
  }
  cached.set(key, svg);
  return svg;
}

/**
 * React writes `rowSpan`/`colSpan` with their DOM-property casing, which an HTML parser folds to
 * lowercase — but this markup also travels as XML: `AiEditPanel` turns the exported SVG into an
 * `image/svg+xml` data URI and rasterises it. XML attribute matching is case-sensitive, so the
 * camelCase form is simply ignored there and every merged cell collapses to a single column.
 *
 * The component keeps the React props (spelling them lowercase there makes React log an
 * "Invalid DOM property" warning once the editor mounts it), so the serialized form is fixed up
 * here, where the XML requirement actually comes from.
 */
function toXmlAttributeCasing(html: string): string {
  // Bounded to the `<td>` tag opener: cell text and `data-tex` values travel in the same string.
  return html.replace(/<td\b[^>]*>/g, (tag) => (
    tag.replace(/ (rowSpan|colSpan)=/g, (_, name: string) => ` ${name.toLowerCase()}=`)
  ));
}

/**
 * Per-blocks memo for a shape's text markup, for the same reason as the table above: page previews
 * re-serialize every off-screen page's overlay while the author types, and this is a React render
 * per shape. Block arrays are immutable snapshots in the overlay model, so object identity is a
 * usable key with no invalidation logic.
 */
const overlayTextHtmlCache = new WeakMap<readonly OverlayTextBlock[], Map<string, string>>();

function renderOverlayTextHtmlMemoized(
  blocks: readonly OverlayTextBlock[],
  environment: MathRenderEnvironment,
): string {
  let cached = overlayTextHtmlCache.get(blocks);
  if (!cached) {
    cached = new Map();
    overlayTextHtmlCache.set(blocks, cached);
  }
  const key = mathRenderEnvironmentCacheKey(environment, "overlay-text");
  const hit = cached.get(key);
  if (hit !== undefined) {
    return hit;
  }

  const html = renderToStaticMarkup(
    <MathEnvironmentValueProvider environment={environment}>
      <OverlayTextBlocksView blocks={blocks} selfContained xmlns="http://www.w3.org/1999/xhtml" />
    </MathEnvironmentValueProvider>,
  );
  cached.set(key, html);
  return html;
}

/**
 * 書き出し面の追加オプション。`OverlaySvgExportOptions` (シリアライザ側の型) は `@/lib` を
 * import できない headless な層にあるので、描画環境はこの React 束縛側で足す。
 */
export interface OverlaySvgRenderOptions extends OverlaySvgExportOptions {
  /**
   * 図形テキスト・表セル・グラフラベルの数式を描く環境 (前文マクロ + 組版スタイル)。
   * 省略すると既定環境になるので、**文書を書き出す面は必ず渡すこと**
   * (渡さないと印刷/PDF/SVG の数式だけ前文マクロが効かず、組版も本文と食い違う)。
   */
  mathEnvironment?: MathRenderEnvironment;
}

/**
 * 書き出し用のレンダラ束。**描画環境ごとに作る** — モジュール定数のままだと前文マクロも
 * 組版スタイルも既定に固定され、印刷/PDF/SVG の図形テキストだけが本文と違う組版になる。
 */
function createStaticReactRenderers(environment: MathRenderEnvironment): OverlaySvgRenderers {
  return {
    renderGraphHtml: (spec, idSeed) => renderToStaticMarkup(
      <MathEnvironmentValueProvider environment={environment}>
        <Graph2DPreview idSeed={idSeed} spec={spec} staticMode />
      </MathEnvironmentValueProvider>,
    ),
    renderMathHtml: (tex) => renderMathHtml(tex, environment),
    renderOverlayTextHtml: (blocks) => renderOverlayTextHtmlMemoized(blocks, environment),
    renderTableHtml: (table, width, height, overflow) => (
      renderTableHtmlMemoized(table, width, height, overflow, environment)
    ),
    // No math environment: a chart draws labels as plain text, so nothing here depends on it.
    renderChartSvg: (data, spec, width, height) => renderChartSvgMemoized(data, spec, width, height),
  };
}

export function exportOverlaySvg(
  shapes: OverlayShape[],
  assets: Record<string, OverlayAsset>,
  size: OverlayCanvasSize = A4_PAGE_PX,
  options: OverlaySvgRenderOptions = {},
): string | undefined {
  return serializeOverlaySvg(
    shapes,
    assets,
    size,
    createStaticReactRenderers(options.mathEnvironment ?? DEFAULT_MATH_RENDER_ENVIRONMENT),
    options,
  );
}

export function getOverlayPreviewSvg(
  overlay?: OverlayPreviewSource,
  size: OverlayCanvasSize = A4_PAGE_PX,
  options: OverlaySvgRenderOptions = {},
): string | undefined {
  return serializeOverlayPreviewSvg(
    overlay,
    size,
    createStaticReactRenderers(options.mathEnvironment ?? DEFAULT_MATH_RENDER_ENVIRONMENT),
    options,
  );
}
