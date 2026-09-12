import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";

/**
 * What the *built* viewer stylesheet actually does to a rendered document.
 *
 * `packages/viewer/src/styles-sync.test.ts` compares the two stylesheets as text: it proves the
 * viewer imports `document-surface.css` and does not silently redeclare its selectors. It never
 * applies them, so a change that alters the *result* — a dropped `--editor-font-size`, a border
 * that stops painting, a list indent that moves — passes it untouched.
 *
 * This spec closes that hole from the other side. It serves `packages/viewer/dist` (the artifact
 * that ships, not the authored source), renders one document that carries every construct the
 * shared surface styles, and records `getComputedStyle` + `getBoundingClientRect` for every
 * element under `.sigma-viewer`. The recording is committed as a snapshot, so a CSS change that
 * moves anything shows up as `<element> | <property>` lines in the diff.
 *
 * Deliberately NOT a screenshot comparison: font rasterisation differs between machines and a
 * pixel diff cannot say *which* declaration changed. Numbers name the property.
 *
 * ## Baseline
 *
 * The snapshot carries Playwright's platform suffix (`-darwin`) because layout depends on the
 * host's fonts and Chromium build. It is therefore only meaningful on the machine/browser that
 * wrote it; on another platform Playwright will look for a differently-suffixed file and the run
 * will report a missing snapshot rather than a false failure.
 *
 * Update it deliberately, never to make a red run green:
 *
 * ```
 * cd apps/desktop
 * SIGMA_STUDIO_E2E_BASE_URL=http://127.0.0.1:<空きポート> \
 *   npx playwright test tests/e2e/viewer-css-parity.spec.ts --update-snapshots
 * ```
 *
 * and read the resulting diff line by line — each line is one property on one element.
 *
 * ## Requires a build
 *
 * `packages/viewer/dist` is a build output and is gitignored. This repository's working tree has a
 * Japanese directory name, and `packages/viewer/scripts/build.mjs` resolves paths through
 * `new URL().pathname`, which percent-encodes them — so `npm run viewer:build` only succeeds from
 * an ASCII path. Build there and copy `packages/viewer/dist` back, or run this spec from the ASCII
 * clone.
 *
 * Without `dist` — or with a `dist` older than the CSS it was built from — the tests skip with that
 * reason instead of failing. Skipping is the only safe answer: measuring a stale build would report
 * green for a regression that is already in the working tree.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const VIEWER_DIST_DIR = path.join(REPO_ROOT, "packages", "viewer", "dist");
const VIEWER_DIST_ENTRY = path.join(VIEWER_DIST_DIR, "index.js");
const VIEWER_DIST_CSS = path.join(VIEWER_DIST_DIR, "styles.css");
/**
 * Everything the viewer build reads. Both halves matter: `dist/styles.css` comes from the two
 * stylesheets, and `dist/index.js` bundles the desktop renderers (`build.mjs` aliases `@` to
 * `apps/desktop/src`), which decide the markup whose geometry the baseline records.
 */
const VIEWER_BUILD_INPUTS = [
  path.join(REPO_ROOT, "packages", "viewer", "src"),
  path.join(REPO_ROOT, "apps", "desktop", "src"),
];

function modifiedAt(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** Newest mtime under a directory tree (759 files here, ~5ms — cheap enough to do at load). */
function newestModifiedAt(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const candidate = entry.isDirectory() ? newestModifiedAt(child) : (modifiedAt(child) ?? 0);
    newest = Math.max(newest, candidate);
  }
  return newest;
}

/**
 * Why staleness is a skip and not a pass: `dist` has to be copied in from an ASCII clone, so the
 * normal failure mode is not "no dist" but "dist from before the change". Measuring that build
 * would report green for a regression the working tree already contains — the one outcome this
 * spec must never produce.
 *
 * The check is by mtime, so it is conservative in the safe direction: a content-neutral touch
 * (branch switch, `git restore`, an editor save) also makes it skip, and the fix for that is the
 * same rebuild the skip message asks for.
 */
const DIST_BUILT_AT = Math.min(modifiedAt(VIEWER_DIST_CSS) ?? 0, modifiedAt(VIEWER_DIST_ENTRY) ?? 0);
const DIST_MISSING = !existsSync(VIEWER_DIST_ENTRY) || !existsSync(VIEWER_DIST_CSS);
const DIST_STALE = !DIST_MISSING
  && VIEWER_BUILD_INPUTS.some((source) => newestModifiedAt(source) > DIST_BUILT_AT);

const BUILD_INSTRUCTIONS =
  "ASCII パスのクローンで `npm run viewer:build` を実行し packages/viewer/dist を作ってから走らせる "
  + "(日本語ディレクトリ名の作業ツリーでは scripts/build.mjs の new URL().pathname が percent-encode "
  + "されるためビルドできない)";
const SKIP_REASON = DIST_STALE
  ? `packages/viewer/dist が packages/viewer/src・apps/desktop/src より古い (再ビルドされていない)。${BUILD_INSTRUCTIONS}`
  : `packages/viewer/dist が無い。${BUILD_INSTRUCTIONS}`;
const SKIP_TESTS = DIST_MISSING || DIST_STALE;

/** The mount is wider than an A4 sheet so `ResponsivePageFrame` settles on scale 1. */
const MOUNT_WIDTH_PX = 900;

// ---------------------------------------------------------------------------------------------
// The document under test
// ---------------------------------------------------------------------------------------------

/**
 * One page that carries every family of rule in `document-surface.css`: headings, paragraphs and
 * both list types, a box block with a title, boxed inline runs in each variant and tone, inline
 * math, a problem with a frame and a number, a two-column page flow, header/footer running
 * regions, and overlay shapes (table, graph, text, callout, vector).
 *
 * Overlay shapes are positioned page-absolutely rather than block-anchored on purpose: anchor
 * resolution is JavaScript, not CSS, and it keeps moving shapes for several frames after the text
 * has settled. This spec is about what the stylesheet does, so it takes the shapes' positions out
 * of the equation and leaves their *styling* in.
 */
function viewerCssDocument(): unknown {
  const text = (
    value: string,
    extra: Record<string, unknown> = {},
  ) => ({ type: "text", text: value, ...extra });
  const math = (id: string, tex: string, extra: Record<string, unknown> = {}) => ({
    type: "mathInline",
    id,
    tex,
    display: "inline",
    ...extra,
  });
  const paragraph = (id: string, children: unknown[]) => ({ type: "paragraph", id, children });

  return {
    version: "2.0",
    docId: "doc_viewer_css_parity",
    metadata: { title: "ビューアCSS回帰", styleUnits: { fontSize: "pt" } },
    updatedAt: "2026-08-05T00:00:00.000+09:00",
    outputProfiles: {
      student: { showSolutions: false },
      teacher: { showSolutions: true },
      answerBook: { onlySolutions: true, showSolutions: true },
    },
    content: [
      {
        type: "heading",
        id: "h1_title",
        level: 1,
        children: [text("ビューアCSSの回帰確認")],
      },
      paragraph("p_intro", [
        text("この段落は本文の既定タイポグラフィを測る。"),
        text("太字", { marks: ["bold"] }),
        text("・"),
        text("斜体", { marks: ["italic"] }),
        text("・"),
        text("下線", { marks: ["underline"] }),
        text("と、インライン数式 "),
        math("m_intro", "\\int_0^a x^2e^{-x}\\,dx"),
        text(" を1行に混ぜている。"),
      ]),
      { type: "heading", id: "h2_boxes", level: 2, children: [text("囲み文字と囲み枠")] },
      paragraph("p_boxed", [
        text("枠", { marks: ["boxed"] }),
        text(" "),
        text("太枠", { marks: ["boxed"], boxedVariant: "thick" }),
        text(" "),
        text("二重", { marks: ["boxed"], boxedVariant: "double" }),
        text(" "),
        text("丸枠", { marks: ["boxed"], boxedVariant: "oval" }),
        text(" "),
        text("網掛", { marks: ["boxed"], boxedVariant: "shade", boxedTone: "blue" }),
        text(" "),
        math("m_boxed", "x^2+1", { marks: ["boxed"] }),
      ]),
      {
        type: "boxBlock",
        id: "box_notes",
        styleId: "fancybox",
        title: [text("囲み枠のタイトル")],
        blocks: [
          paragraph("box_notes_body", [
            text("囲み枠の本文。枠線・余白・タイトル帯はすべて共有の document-surface.css が描く。"),
          ]),
        ],
        frame: {
          borderWidthPx: 1.4,
          borderColor: "#355f4b",
          backgroundColor: "#f4faf6",
          cornerStyle: "round",
          radiusPx: 8,
          paddingPx: { top: 12, right: 14, bottom: 12, left: 14 },
          decorations: [{ type: "titleBand", heightPx: 22, backgroundColor: "#dcefe3" }],
        },
      },
      { type: "heading", id: "h3_lists", level: 3, children: [text("リスト")] },
      {
        type: "list",
        id: "list_bullet",
        listType: "bullet",
        items: [
          { type: "listItem", id: "list_bullet_1", children: [text("箇条書きの1項目め")] },
          {
            type: "listItem",
            id: "list_bullet_2",
            children: [text("数式入りの項目 "), math("m_list", "a_{n+1}=a_n^2")],
          },
        ],
      },
      {
        type: "list",
        id: "list_ordered",
        listType: "ordered",
        items: [
          { type: "listItem", id: "list_ordered_1", children: [text("番号付きの1項目め")] },
          { type: "listItem", id: "list_ordered_2", children: [text("番号付きの2項目め")] },
        ],
      },
      {
        type: "problem",
        id: "problem_sample",
        tags: ["回帰"],
        lead: [paragraph("problem_lead", [text("次の問いに答えよ。")])],
        prompt: [
          paragraph("problem_prompt", [
            text("関数 "),
            math("m_problem", "f(x)=x^2e^{-x}"),
            text(" の増減を調べよ。"),
          ]),
        ],
        solution: [paragraph("problem_solution", [text("微分して符号を調べる。")])],
        hints: [],
        areaLayout: { prompt: { minHeightMm: 18 } },
        numbering: { enabled: true, value: 1, fontSize: 12 },
        frame: { enabled: true, styleId: "simple" },
      },
    ],
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
      header: {
        enabled: true,
        heightMm: 14,
        offsetMm: 5,
        showOnFirstPage: true,
        // The list is here because one of the viewer's registered overrides
        // (`.page-running-region :is(ul, ol)`) exists only for running-region lists: they stopped
        // getting `.print-list` when the header body moved onto the body renderer. Without a list
        // in a running region, that override has nothing to act on and could rot unnoticed.
        blocks: [
          paragraph("header_line", [text("ヘッダーの本文")]),
          {
            type: "list",
            id: "header_list",
            listType: "bullet",
            items: [{ type: "listItem", id: "header_list_1", children: [text("ヘッダーの箇条書き")] }],
          },
        ],
      },
      footer: {
        enabled: true,
        heightMm: 7,
        offsetMm: 5,
        showOnFirstPage: true,
        blocks: [paragraph("footer_line", [text("フッターの本文")])],
      },
      overlay: {
        updatedAt: "2026-08-05T00:00:00.000+09:00",
        overlaySnapshot: {
          version: 1,
          assets: {},
          shapes: [
            {
              id: "shape_table",
              type: "tableShape",
              x: 40,
              y: 620,
              rotation: 0,
              props: { w: 240, h: 96, table: parityTable() },
            },
            {
              id: "shape_graph",
              type: "graph2dShape",
              x: 320,
              y: 620,
              rotation: 0,
              props: {
                boundsMode: "plot",
                w: 240,
                h: 150,
                spec: {
                  kind: "cartesian",
                  title: "y=x²e⁻ˣ",
                  width: 240,
                  height: 150,
                  viewBox: { xMin: "-0.5", xMax: "6", yMin: "-0.2", yMax: "0.8" },
                  axes: {
                    grid: true,
                    showX: true,
                    showY: true,
                    showTicks: true,
                    xLabel: "x",
                    yLabel: "y",
                    originLabel: "O",
                    xTickStep: "1",
                    yTickStep: "0.2",
                  },
                  curves: [{
                    id: "curve_main",
                    expr: "x^2*exp(-x)",
                    exprTex: "x^2e^{-x}",
                    label: "C",
                    color: "#1f6f4a",
                    mode: "yOfX",
                    strokeWidth: 2,
                    domain: { min: "0", max: "6" },
                    samples: 60,
                  }],
                  showFormulaLabels: false,
                },
              },
            },
            {
              id: "shape_text",
              type: "text",
              x: 40,
              y: 780,
              rotation: 0,
              props: {
                w: 220,
                color: "#1f2937",
                fontSize: 11,
                size: "m",
                blocks: [{
                    type: "paragraph", id: "viewer_css_parity_spec_41",
                    align: "left",
                    children: [
                      { type: "text", text: "図中テキスト " },
                      { type: "mathInline", id: "m_shape_text", tex: "S'(a)=a^2e^{-a}", display: "inline" },
                    ],
                  }],
              },
            },
            {
              id: "shape_callout",
              type: "callout",
              x: 300,
              y: 790,
              rotation: 0,
              props: {
                w: 200,
                h: 70,
                radius: 12,
                tail: {
                  baseStart: { x: 34, y: 70 },
                  baseEnd: { x: 64, y: 70 },
                  tip: { x: 18, y: 100 },
                },
                blocks: [{
                    type: "paragraph", id: "viewer_css_parity_spec_42",
                    align: "center",
                    children: [{ type: "text", text: "吹き出しの本文", marks: ["bold"] }],
                  }],
                color: "#244a38",
                fontSize: 11,
                size: "m",
                dash: "solid",
                strokeWidth: "s",
              },
            },
            {
              id: "shape_geo",
              type: "geo",
              x: 40,
              y: 900,
              rotation: 0,
              props: {
                w: 140,
                h: 70,
                geo: "rectangle",
                radius: 6,
                fill: "none",
                color: "#1f2937",
                labelColor: "#1f2937",
                dash: "solid",
                size: "m",
                label: "図形",
              },
            },
          ],
        },
      },
    },
  };
}

/** A 2×2 table with an outer and inner border, i.e. every grid line the renderer can draw. */
function parityTable(): unknown {
  const cell = (id: string, rowId: string, columnId: string, value: string) => ({
    id,
    rowId,
    columnId,
    content: [{
      type: "paragraph",
      id: `${id}_p`,
      align: "center",
      children: [{ type: "text", text: value }],
    }],
  });

  return {
    version: 1,
    kind: "plain",
    columns: [
      { id: "tbl_col_1", width: { mode: "fr", value: 1, min: 60 } },
      { id: "tbl_col_2", width: { mode: "fr", value: 1, min: 60 } },
    ],
    rows: [
      { id: "tbl_row_1", height: { mode: "auto", min: 28 }, role: "header" },
      { id: "tbl_row_2", height: { mode: "auto", min: 28 }, role: "body" },
    ],
    cells: [
      cell("tbl_c11", "tbl_row_1", "tbl_col_1", "見出しA"),
      cell("tbl_c12", "tbl_row_1", "tbl_col_2", "見出しB"),
      cell("tbl_c21", "tbl_row_2", "tbl_col_1", "値1"),
      cell("tbl_c22", "tbl_row_2", "tbl_col_2", "値2"),
    ],
    grid: {
      borderColor: "#111827",
      borderWidth: 1,
      borderStyle: "solid",
      showOuterBorder: true,
      showInnerBorders: true,
      lineOverrides: [],
    },
    defaultCellStyle: {
      align: "center",
      verticalAlign: "middle",
      paddingX: 8,
      paddingY: 5,
      color: "#111827",
      fontSize: 14,
      fontWeight: "normal",
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Serving `packages/viewer/dist` to a real browser
// ---------------------------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function pageHtml(options: { withViewerStylesheet: boolean; documentJson: string }): string {
  // `</` inside a <script> would end the element early.
  const embedded = options.documentJson.replace(/</g, "\\u003c");
  const stylesheet = options.withViewerStylesheet
    ? '<link rel="stylesheet" href="/viewer/styles.css">'
    : "";
  const script = options.withViewerStylesheet
    ? '<script type="module" src="/app.js"></script>'
    : "";
  // The <body> deliberately carries no styling of its own: one of the assertions below is that the
  // viewer stylesheet leaves the embedding host's <body> exactly as it found it.
  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>viewer css parity</title>",
    stylesheet,
    "</head>",
    "<body>",
    `<div id="mount" style="width: ${MOUNT_WIDTH_PX}px;"></div>`,
    `<script type="application/json" id="sigma-doc">${embedded}</script>`,
    script,
    "</body>",
    "</html>",
  ].join("\n");
}

const ENTRY_SOURCE = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { SigmaDocViewer } from "@sigma-studio/viewer";

const doc = JSON.parse(document.getElementById("sigma-doc").textContent);
createRoot(document.getElementById("mount")).render(createElement(SigmaDocViewer, { document: doc }));
`;

/**
 * Bundles an entry that imports the built viewer, with React bundled in rather than external, so
 * the page needs nothing but the files this server hands out.
 */
async function bundleViewerEntry(outfile: string): Promise<void> {
  await build({
    stdin: { contents: ENTRY_SOURCE, resolveDir: REPO_ROOT, loader: "js", sourcefile: "entry.js" },
    // Pinning the specifier to dist is the point of this spec: the artifact, not the source.
    alias: { "@sigma-studio/viewer": VIEWER_DIST_ENTRY },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
    outfile,
  });
}

function isReadableFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function startStaticServer(files: Map<string, string>): Promise<Server> {
  const server = createServer((request, response) => {
    const requested = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    // Resolve the directory index first so the content type is derived from the file that is
    // actually sent: `/` has no extension and would otherwise be served as text/plain.
    const requestPath = requested === "/" ? "/index.html" : requested;
    const inMemory = files.get(requestPath);
    if (inMemory !== undefined) {
      response.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(requestPath)] ?? "text/plain" });
      response.end(inMemory);
      return;
    }

    if (requestPath.startsWith("/viewer/")) {
      const resolved = path.resolve(VIEWER_DIST_DIR, `.${requestPath.slice("/viewer".length)}`);
      // Anything that escapes dist is a bug in this spec, not a file to serve. Directories are not
      // files: `readFileSync` on one throws EISDIR, and an exception in this callback is uncaught.
      if (resolved.startsWith(`${VIEWER_DIST_DIR}${path.sep}`) && isReadableFile(resolved)) {
        response.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream" });
        response.end(readFileSync(resolved));
        return;
      }
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ---------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------

/**
 * The computed properties worth recording: everything the shared surface and the viewer overrides
 * actually declare (typography, box model, borders, flow), and nothing that changes for reasons
 * other than CSS. Four-sided values are recorded as one `top right bottom left` string so a diff
 * line names one property rather than four.
 */
/*
 * The recording contains the document twice on purpose: the print surface keeps a hidden
 * `.print-measure-layer` copy that pagination measures. If its typography ever stops matching the
 * visible layer, page breaks are decided from numbers the reader never sees — so both copies are
 * recorded and any drift between them shows up as a diff on one of the two.
 */
const STYLE_PROPERTIES = [
  "display",
  "position",
  "zIndex",
  "boxSizing",
  "overflow",
  // The read-only viewer's whole promise: overlay layers must not take pointer input.
  "pointerEvents",
  "opacity",
  "fill",
  "stroke",
  "strokeWidth",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "color",
  "backgroundColor",
  "textAlign",
  "textDecorationLine",
  "verticalAlign",
  "whiteSpace",
] as const;

type StyleMap = Record<string, string>;

async function captureViewerStyles(page: Page): Promise<StyleMap> {
  return page.evaluate((properties) => {
    const root = document.querySelector<HTMLElement>(".sigma-viewer");
    if (!root) {
      throw new Error(".sigma-viewer が描画されていません");
    }
    const rootRect = root.getBoundingClientRect();
    // Half a CSS pixel is below one device pixel: rounding there keeps sub-pixel jitter out of the
    // recording without hiding any movement a reader could see on paper.
    const half = (value: number) => (Math.round(value * 2) / 2).toFixed(1);

    /*
     * Keys identify an element by what it *is*, not by where it falls in document order.
     *
     * A document-order index would be simpler, but inserting one `<span>` would then shift the key
     * of every element after it and turn a one-line change into thousands. Nothing could be read
     * line by line after that, and a baseline nobody reads is a baseline that gets accepted
     * unread. Descriptor + per-descriptor occurrence keeps an unrelated insertion local.
     */
    const seen = new Map<string, number>();
    const describe = (element: Element): string => {
      const classes = [...element.classList].sort().map((name) => `.${name}`).join("");
      const identity = element.getAttribute("data-sigma-doc-id")
        ?? element.getAttribute("data-overlay-shape-id")
        ?? element.getAttribute("data-problem-area")
        ?? element.getAttribute("data-sigma-viewer-page");
      const descriptor = `${element.tagName.toLowerCase()}${classes}${identity ? `[${identity}]` : ""}`;
      const occurrence = (seen.get(descriptor) ?? 0) + 1;
      seen.set(descriptor, occurrence);
      return `${descriptor} #${String(occurrence).padStart(3, "0")}`;
    };

    const map: Record<string, string> = {};
    const queue: Element[] = [root];

    while (queue.length > 0) {
      const element = queue.shift()!;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const key = describe(element);

      for (const property of properties) {
        map[`${key} | ${property}`] = style[property as keyof CSSStyleDeclaration] as string;
      }
      const sides = (make: (side: string) => string) =>
        ["Top", "Right", "Bottom", "Left"]
          .map((side) => style[make(side) as keyof CSSStyleDeclaration] as string)
          .join(" ");
      map[`${key} | margin`] = sides((side) => `margin${side}`);
      map[`${key} | padding`] = sides((side) => `padding${side}`);
      map[`${key} | borderWidth`] = sides((side) => `border${side}Width`);
      map[`${key} | borderStyle`] = sides((side) => `border${side}Style`);
      map[`${key} | borderColor`] = sides((side) => `border${side}Color`);
      map[`${key} | borderRadius`] = [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ].join(" ");
      map[`${key} | rect.top`] = half(rect.top - rootRect.top);
      map[`${key} | rect.left`] = half(rect.left - rootRect.left);
      map[`${key} | rect.width`] = half(rect.width);
      map[`${key} | rect.height`] = half(rect.height);

      // Math (MathLive's `.ML__latex`, KaTeX's `.katex`) and the graph SVG are hundreds of nodes
      // laid out by their own renderers. The shared stylesheet reaches them through exactly these
      // roots (`.math-preview-inline .ML__latex`, `.graph-shape .graph2d-svg`), so the root is
      // recorded and its internals are left to the renderer that owns them. The overlay layer's
      // own `<svg>` is NOT one of these: shapes, tables and callout bodies live inside it.
      if (
        element.classList.contains("katex")
        || element.classList.contains("ML__latex")
        || element.classList.contains("graph2d-svg")
      ) {
        continue;
      }
      queue.unshift(...Array.from(element.children));
    }

    // Sorted so a moved element changes only its own lines: document order is already pinned by
    // `rect.top` / `rect.left`, and re-serialising it as key order would double every move.
    return Object.fromEntries(
      Object.entries(map).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  }, STYLE_PROPERTIES as unknown as string[]);
}

/**
 * A fingerprint of every measured position, sampled until it stops changing.
 *
 * Web fonts (KaTeX's, and the body font) land asynchronously and the viewer re-renders when
 * `document.fonts.ready` resolves, so a measurement taken too early describes a layout that no
 * longer exists.
 */
async function layoutSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".sigma-viewer");
    if (!root) {
      return "";
    }
    const rootRect = root.getBoundingClientRect();
    const parts: number[] = [];
    for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const rect = element.getBoundingClientRect();
      parts.push(
        Math.round((rect.top - rootRect.top) * 100),
        Math.round((rect.left - rootRect.left) * 100),
        Math.round(rect.width * 100),
        Math.round(rect.height * 100),
      );
    }
    return `${parts.length}:${parts.join(",")}`;
  });
}

async function waitForStableLayout(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);

  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const signature = await layoutSignature(page);
    if (signature && signature === previous) {
      stable += 1;
      if (stable >= 6) {
        return;
      }
    } else {
      stable = 0;
      previous = signature;
    }
    await page.waitForTimeout(100);
  }
  throw new Error("ビューアのレイアウトが収束しませんでした");
}

// ---------------------------------------------------------------------------------------------
// Reading the built stylesheet back out of the browser
// ---------------------------------------------------------------------------------------------

interface ViewerSheetFacts {
  /** How many stylesheets were actually walked. Zero means the assertions below saw nothing. */
  inspectedSheets: number;
  /** Selectors that would apply outside `.sigma-viewer`, i.e. leak into the embedding host. */
  leaked: string[];
  /** For each queried selector, the values the sheet declares for its property. */
  declared: Record<string, string[]>;
}

/**
 * One pass over the parsed viewer stylesheet, answering both "is everything scoped?" and "is this
 * override still declared?". The two questions share a selector parser, and a parser that only one
 * of them exercised would rot in the other.
 */
async function readViewerSheetFacts(
  page: Page,
  queries: ReadonlyArray<{ selector: string; property: string }>,
): Promise<ViewerSheetFacts> {
  return page.evaluate((probes) => {
    // Splitting a selector list on every comma tears `:is(ul, ol)` and `:where(h1, h2, h3, p)`
    // apart and reports the fragments as unscoped selectors. Only commas at depth 0 separate.
    const splitSelectorList = (selectorText: string): string[] => {
      const parts: string[] = [];
      let depth = 0;
      let quote: string | null = null;
      let current = "";
      for (const character of selectorText) {
        if (quote) {
          current += character;
          if (character === quote) {
            quote = null;
          }
          continue;
        }
        if (character === '"' || character === "'") {
          quote = character;
        } else if (character === "(" || character === "[") {
          depth += 1;
        } else if (character === ")" || character === "]") {
          depth -= 1;
        } else if (character === "," && depth === 0) {
          parts.push(current);
          current = "";
          continue;
        }
        current += character;
      }
      parts.push(current);
      return parts.map((part) => part.trim()).filter(Boolean);
    };

    // Chromium re-serialises `:is(ul, ol)` and `a>b` with its own spacing; compare canonical forms.
    const canonical = (selector: string) => selector
      .replace(/\s*([>+~])\s*/gu, " $1 ")
      .replace(/\s+/gu, " ")
      .replace(/,\s*/gu, ",")
      .trim();
    const cssName = (jsName: string) => jsName.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

    const wanted = new Map(probes.map((probe) => [canonical(`.sigma-viewer ${probe.selector}`), probe]));
    const declared: Record<string, string[]> = {};
    const leaked: string[] = [];

    const visit = (rules: CSSRuleList, insideAtRule: boolean) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          for (const selector of splitSelectorList(rule.selectorText)) {
            if (!/^\.sigma-viewer(?=$|[\s>+~.#:[])/.test(selector)) {
              leaked.push(selector);
            }
            const probe = wanted.get(canonical(selector));
            // Only unconditional rules count as "the override is still there". `.print-a4-page`
            // declares `box-shadow` three times — once as the override and twice inside `@media`
            // — so counting guarded declarations would keep the probe green after a deletion.
            const value = probe && !insideAtRule ? rule.style.getPropertyValue(cssName(probe.property)) : "";
            if (probe && value) {
              (declared[probe.selector] ??= []).push(value.trim());
            }
          }
        }
        // `@media` / `@supports` / `@layer` nest style rules, and CSS Nesting puts them inside a
        // `CSSStyleRule` — which is why this is not an `else`. Keyframe blocks nest
        // `CSSKeyframeRule`, which is not a `CSSStyleRule`, so descending into them is harmless.
        if ("cssRules" in rule) {
          const nested = (rule as CSSGroupingRule).cssRules;
          visit(nested, insideAtRule || !(rule instanceof CSSStyleRule));
        }
      }
    };

    let inspectedSheets = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      if (sheet.href?.endsWith("/viewer/styles.css")) {
        inspectedSheets += 1;
        visit(sheet.cssRules, false);
      }
    }
    return { inspectedSheets, leaked, declared };
  }, queries as unknown as Array<{ selector: string; property: string }>);
}

// ---------------------------------------------------------------------------------------------
// The viewer's intentional overrides, checked against what the browser actually applies
// ---------------------------------------------------------------------------------------------

const STYLES_SYNC_TEST = path.join(REPO_ROOT, "packages", "viewer", "src", "styles-sync.test.ts");

/**
 * One probe per entry in `styles-sync.test.ts`'s `INTENTIONAL_OVERRIDES`, naming a property the
 * shared `document-surface.css` does *not* declare for that selector. `expected` ending in `em` is
 * read as a ratio against the element's own font size.
 *
 * Each probe is checked twice, because either check alone can pass on a dead override:
 *
 * - the built stylesheet still carries a rule for `.sigma-viewer <selector>` declaring `property`
 *   — inherited properties (`user-select`, `pointer-events`) would otherwise compute to the right
 *   value from an ancestor long after the rule itself was deleted;
 * - the browser computes `expected` on every element the selector matches — a rule that is present
 *   but outranked, or has no subject left in the document, is not doing anything.
 *
 * The list is asserted to match the registered selectors in both directions below: a new override
 * without a probe is unregistered, and a probe whose entry was removed is stale.
 */
const INTENTIONAL_OVERRIDE_PROBES: ReadonlyArray<{
  selector: string;
  property: string;
  expected: string;
  why: string;
}> = [
  {
    selector: ".print-a4-page",
    property: "boxShadow",
    expected: "rgba(15, 23, 42, 0.12) 0px 8px 28px 0px",
    why: "埋め込み先の背景から紙面を浮かせる影。共有ファイルは影を宣言しない",
  },
  {
    selector: ".print-page-overlay-layer",
    property: "userSelect",
    expected: "none",
    why: "読み取り専用ビューアは図形レイヤを不活性にする。共有側は pointer-events しか宣言しない",
  },
  {
    selector: ".page-running-overlay-preview",
    property: "userSelect",
    expected: "none",
    why: "同上 (ヘッダー/フッターの図形プレビュー)",
  },
  {
    // Both `user-select` and `pointer-events` are inherited, and the parent layer already sets
    // them — so on this one the *declaration* check is the whole assertion; the computed value
    // would agree either way.
    selector: ".print-page-overlay-layer svg",
    property: "userSelect",
    expected: "none",
    why: "同上 (図形レイヤ内の svg)",
  },
  {
    selector: ".page-running-region",
    property: "color",
    expected: "rgb(51, 51, 51)",
    why: "ビューアにはエディタ側の文字色コンテキストが無いので既定色を与える",
  },
  {
    selector: ".print-list",
    property: "paddingInlineStart",
    expected: "1.65em",
    why: "ビューア独自のぶら下げ幅 (既知の viewer↔PDF 差)。共有側は margin/line-height/font-size だけ",
  },
  {
    selector: ".page-running-region :is(ul, ol)",
    property: "paddingInlineStart",
    expected: "1.65em",
    why: "同上。running region のリストは .print-list が付かないので region スコープで同じ幅を与える",
  },
];

/**
 * The selector keys of `INTENTIONAL_OVERRIDES` in `packages/viewer/src/styles-sync.test.ts`.
 *
 * Read out of the source rather than imported: that file is a vitest suite in another workspace,
 * and importing it here would run it under Playwright. The reasons live there and stay there; this
 * side only needs to know which selectors are registered.
 */
function readRegisteredOverrideSelectors(): string[] {
  const source = readFileSync(STYLES_SYNC_TEST, "utf8");
  const declaration = source.indexOf("const INTENTIONAL_OVERRIDES");
  // The object literal starts after `=`, not after the type annotation — `Record<string, string>`
  // has no brace today but a richer value type would, and picking the annotation's brace would
  // silently read the wrong block.
  const assignment = source.indexOf("=", declaration);
  const open = source.indexOf("{", assignment);
  if (declaration < 0 || assignment < 0 || open < 0) {
    throw new Error(`INTENTIONAL_OVERRIDES を ${STYLES_SYNC_TEST} から読み取れませんでした`);
  }

  // Braces inside the reason strings (a quoted CSS snippet, say) would move the end of the block
  // and make the probe-list comparison fail as if an override had been deleted, so skip strings.
  let depth = 0;
  let close = -1;
  let quote: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) {
    throw new Error(`INTENTIONAL_OVERRIDES の終端を ${STYLES_SYNC_TEST} で見つけられませんでした`);
  }

  // Keys are quoted and followed by `:`; the multi-line reason strings continue with `+ "…"` and
  // never end in `":`, so they cannot be mistaken for keys.
  const selectors = [...source.slice(open, close).matchAll(/^\s*"([^"]+)":/gmu)].map((match) => match[1]);
  if (selectors.length === 0 || selectors.some((selector) => /[{}]/u.test(selector))) {
    throw new Error(`INTENTIONAL_OVERRIDES の解析結果がセレクタに見えません: ${JSON.stringify(selectors)}`);
  }
  return selectors;
}

// ---------------------------------------------------------------------------------------------

let server: Server | null = null;
let workDir: string | null = null;
let baseUrl = "";

test.beforeAll(async () => {
  if (SKIP_TESTS) {
    return;
  }

  workDir = mkdtempSync(path.join(tmpdir(), "sigma-viewer-css-"));
  const bundlePath = path.join(workDir, "app.js");
  await bundleViewerEntry(bundlePath);

  const documentJson = JSON.stringify(viewerCssDocument());
  const files = new Map<string, string>([
    ["/index.html", pageHtml({ withViewerStylesheet: true, documentJson })],
    ["/plain.html", pageHtml({ withViewerStylesheet: false, documentJson })],
    ["/app.js", readFileSync(bundlePath, "utf8")],
  ]);

  server = await startStaticServer(files);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

test.beforeEach(async ({ page }) => {
  test.skip(SKIP_TESTS, SKIP_REASON);
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "load" });
  await page.locator('.sigma-viewer[data-sigma-viewer-state="ready"]').waitFor();
  await waitForStableLayout(page);
});

test("the built viewer stylesheet renders the document exactly as the baseline recorded it", async ({ page }) => {
  // A page-count change would rewrite the whole recording, so name it separately: the snapshot
  // diff would otherwise read as thousands of unrelated moves.
  await expect(page.locator(".sigma-viewer__page")).toHaveCount(1);

  const styles = await captureViewerStyles(page);
  // Count elements, not entries: every element contributes ~30 entries, so an entry-count guard
  // would be satisfied by a page that rendered nothing but the sheet shell.
  const elements = new Set(Object.keys(styles).map((key) => key.split(" | ")[0]));
  expect(elements.size).toBeGreaterThan(100);
  expect(JSON.stringify(styles, null, 2)).toMatchSnapshot("viewer-css-baseline.json");
});

test("every rule in the built stylesheet is scoped under .sigma-viewer", async ({ page }) => {
  // The runtime counterpart of the guard in `packages/viewer/scripts/build.mjs`: read back what
  // the browser parsed rather than what the build believed it wrote.
  const facts = await readViewerSheetFacts(page, []);

  // Without this, a renamed or 404ing stylesheet would inspect nothing and report no leaks.
  expect(facts.inspectedSheets).toBe(1);
  expect(facts.leaked).toEqual([]);
});

test("the viewer stylesheet leaves the embedding host's <body> untouched", async ({ page }) => {
  const properties = ["fontFamily", "fontSize", "lineHeight", "color", "backgroundColor", "textAlign", "userSelect"];
  const readBody = () => page.evaluate((names) => {
    const style = getComputedStyle(document.body);
    return Object.fromEntries(names.map((name) => [name, style[name as keyof CSSStyleDeclaration] as string]));
  }, properties);

  const withStylesheet = await readBody();

  await page.goto(`${baseUrl}/plain.html`, { waitUntil: "load" });
  const withoutStylesheet = await readBody();

  // `build.mjs` rewrites `html` / `body` / `:root` selectors to `.sigma-viewer`. If that rewrite
  // stops happening, the host page's own typography changes the moment it loads the viewer CSS.
  expect(withStylesheet).toEqual(withoutStylesheet);
});

test("every registered intentional override still changes what the browser applies", async ({ page }) => {
  // `styles-sync.test.ts` proves each override is *declared* on purpose. It cannot see whether the
  // declaration still wins, or whether the markup it was written for still exists — an override
  // for a selector nothing renders any more is dead weight that reads as deliberate.
  const registered = readRegisteredOverrideSelectors();
  expect(INTENTIONAL_OVERRIDE_PROBES.map((probe) => probe.selector).sort())
    .toEqual([...registered].sort());

  // Half of the check: the rule is still in the shipped stylesheet, declaring the property it was
  // registered for. Inherited properties compute correctly from an ancestor whether or not the
  // rule survives, so the computed value below cannot see a deletion on its own.
  const facts = await readViewerSheetFacts(page, INTENTIONAL_OVERRIDE_PROBES);
  expect(INTENTIONAL_OVERRIDE_PROBES
    .filter((probe) => (facts.declared[probe.selector] ?? []).length === 0)
    .map((probe) => `${probe.selector} { ${probe.property} }`)).toEqual([]);

  const results = await page.evaluate((probes) => probes.map((probe) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(`.sigma-viewer ${probe.selector}`));
    const emRatio = probe.expected.endsWith("em") ? Number.parseFloat(probe.expected) : null;
    const actual = elements.map((element) => {
      const style = getComputedStyle(element);
      const value = style[probe.property as keyof CSSStyleDeclaration] as string;
      if (emRatio === null) {
        return value;
      }
      // `padding-inline-start: 1.65em` computes against the element's own font size, which the
      // snapshot already pins; expressing the expectation as a ratio keeps the two independent.
      const ratio = Number.parseFloat(value) / Number.parseFloat(style.fontSize);
      return `${(Math.round(ratio * 1000) / 1000).toFixed(2)}em`;
    });
    return { selector: probe.selector, count: elements.length, actual: [...new Set(actual)] };
  }), INTENTIONAL_OVERRIDE_PROBES as unknown as Array<{ selector: string; property: string; expected: string }>);

  // Zero matches means the override has no subject left in a document built to carry them all.
  expect(results.filter((result) => result.count === 0).map((result) => result.selector)).toEqual([]);
  expect(results.map(({ selector, actual }) => ({ selector, actual }))).toEqual(
    INTENTIONAL_OVERRIDE_PROBES.map((probe) => ({ selector: probe.selector, actual: [probe.expected] })),
  );
});

test("--sigma-viewer-paper drives the paper colour of every sheet", async ({ page }) => {
  const beforeOverride = await page.locator(".print-a4-page").first().evaluate((element) =>
    getComputedStyle(element).backgroundColor);
  expect(beforeOverride).toBe("rgb(255, 255, 255)");

  // The variable is the documented way for a host to restyle the paper; the `.print-a4-page`
  // override that reads it is registered in `styles-sync.test.ts` as intentional. This proves the
  // registration still describes something that happens.
  await page.addStyleTag({ content: ".sigma-viewer { --sigma-viewer-paper: rgb(254, 243, 199); }" });
  await expect(page.locator(".print-a4-page").first()).toHaveCSS("background-color", "rgb(254, 243, 199)");
});
