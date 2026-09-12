import { describe, expect, it } from "vitest";

import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import {
  ensurePageLayout,
  expandMarginsForRunningRegions,
  getDefaultPageLayout,
  getPageLayoutIssues,
  getPageMetrics,
  isWhiteboardPageLayout,
  normalizePageLayout,
  pageRunningRegionHasContent,
  paginateBlocks,
} from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { RichBlock } from "@/features/document";
import type { SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

describe("page layout", () => {
  it("normalizes an A4 page layout without changing content", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      pageLayout: undefined,
    };

    const withLayout = ensurePageLayout(document);

    expect(withLayout.version).toBe("2.0");
    expect(withLayout.content).toEqual(sampleDocument.content);
    expect(withLayout.pageLayout?.preset).toBe("A4");
    expect(withLayout.pageLayout?.marginsMm).toEqual({ top: 18, right: 17, bottom: 18, left: 17 });
    expect(withLayout.pageLayout?.flow).toMatchObject({ type: "columns", columnCount: 1, columnGapMm: 8 });
    expect(withLayout.pageLayout?.header?.enabled).toBe(false);
    expect(withLayout.pageLayout?.footer?.enabled).toBe(false);
    expect(withLayout.pageLayout?.overlay).toBeUndefined();
    expect(parseSigmaDocument(withLayout).pageLayout?.preset).toBe("A4");
  });

  it("does not erase body content while normalizing an inconsistent whiteboard document", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      pageLayout: getDefaultPageLayout("whiteboard"),
    };

    const withLayout = ensurePageLayout(document);

    expect(withLayout.content).toEqual(sampleDocument.content);
    expect(withLayout.pageLayout?.preset).toBe("whiteboard");
  });

  it("calculates preset and custom page metrics", () => {
    const b4Landscape = normalizePageLayout({ preset: "B4", orientation: "landscape" });
    const b4Metrics = getPageMetrics(b4Landscape);

    expect(b4Landscape.pageSize).toEqual({ widthMm: 364, heightMm: 257 });
    expect(Math.round(b4Metrics.page.widthPx)).toBe(Math.round(364 * 96 / 25.4));

    const custom = normalizePageLayout({
      preset: "custom",
      orientation: "portrait",
      pageSize: { widthMm: 240, heightMm: 320 },
    });

    expect(custom.pageSize).toEqual({ widthMm: 240, heightMm: 320 });
  });

  it("normalizes whiteboard layouts for an infinite overlay canvas", () => {
    const defaults = getDefaultPageLayout("whiteboard");

    expect(isWhiteboardPageLayout(defaults)).toBe(true);
    expect(defaults.pageSize).toEqual({ widthMm: 210, heightMm: 297 });
    expect(defaults.marginsMm).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(defaults.flow).toEqual({ type: "columns", columnCount: 1, columnGapMm: 0 });
    expect(defaults.header).toBeUndefined();
    expect(defaults.footer).toBeUndefined();

    const normalized = normalizePageLayout({
      preset: "whiteboard",
      orientation: "landscape",
      pageSize: { widthMm: 320, heightMm: 240 },
      marginsMm: { top: 12, right: 13, bottom: 14, left: 15 },
      flow: { type: "columns", columnCount: 4, columnGapMm: 20 },
      header: { enabled: true },
      footer: { enabled: true },
    });
    const metrics = getPageMetrics(normalized);

    expect(normalized).toMatchObject({
      preset: "whiteboard",
      pageSize: { widthMm: 320, heightMm: 240 },
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
    });
    expect(normalized.header).toBeUndefined();
    expect(normalized.footer).toBeUndefined();
    expect(metrics.content).toMatchObject({ widthMm: 320, heightMm: 240 });
    expect(metrics.flow).toMatchObject({ columnCount: 1, columnGapMm: 0, columnWidthMm: 320 });
    expect(expandMarginsForRunningRegions(normalized)).toEqual(normalized);
  });

  it("validates only the compatibility page size for whiteboard layouts", () => {
    const layout = {
      ...getDefaultPageLayout("whiteboard"),
      pageSize: { widthMm: 0, heightMm: 297 },
      marginsMm: { top: -1, right: -1, bottom: -1, left: -1 },
      flow: { type: "columns" as const, columnCount: 8, columnGapMm: -1 },
    };

    expect(getPageLayoutIssues(layout)).toEqual(["pageSizeRange"]);
  });

  it("calculates document-wide column metrics", () => {
    const layout = normalizePageLayout({
      preset: "A4",
      marginsMm: { left: 20, right: 20 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 10 },
    });
    const metrics = getPageMetrics(layout);

    expect(metrics.content.widthMm).toBe(170);
    expect(metrics.flow.columnWidthMm).toBe(80);
  });

  it("paginates blocks into explicit columns", () => {
    const blocks = Array.from({ length: 12 }, (_, index): SigmaBlock => ({
      type: "paragraph",
      id: `p_${index + 1}`,
      children: [{ type: "text", text: `paragraph ${index + 1} `.repeat(18) }],
    }));
    const layout = normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    });

    const pages = paginateBlocks(blocks, layout);

    expect(pages[0].columns).toHaveLength(2);
    expect(pages.flatMap((page) => page.columns.flatMap((column) => column.blocks.map((block) => block.id)))).toEqual(
      blocks.map((block) => block.id),
    );
  });

  it("clamps column count to the supported 1..4 range", () => {
    const layout = normalizePageLayout({
      flow: { type: "columns", columnCount: 8, columnGapMm: 8 },
    });

    expect(layout.flow.columnCount).toBe(4);
  });

  it("reports invalid page layout settings", () => {
    const layout = normalizePageLayout({
      preset: "custom",
      pageSize: { widthMm: 100, heightMm: 100 },
      marginsMm: { left: 60, right: 45, top: 10, bottom: 10 },
      flow: { type: "columns", columnCount: 4, columnGapMm: 20 },
    });

    // 文言ではなくコードで固定する (表示は `shape.validation.*`)。
    expect(getPageLayoutIssues(layout)).toContain("pageMarginTooWide");
  });

  it("normalizes free-form running region blocks", () => {
    const layout = normalizePageLayout({
      header: {
        enabled: true,
        blocks: [{
          type: "paragraph",
          id: "header_body",
          children: [
            {
              type: "text",
              text: "{title}  {page}",
              marks: ["boxed"],
              boxedPaddingY: 2,
              boxedVariant: "thick",
              boxedTone: "blue",
            },
            {
              type: "mathInline",
              id: "header_math",
              tex: "x^2",
              display: "inline",
              marks: ["underline", "boxed"],
              boxedPaddingY: 1,
              boxedVariant: "double",
            },
          ],
        }],
      },
    });

    expect(layout.header?.blocks).toEqual([{
      type: "paragraph",
      id: "header_body",
      children: [
        {
          type: "text",
          text: "{title}  {page}",
          marks: ["boxed"],
          boxedPaddingY: 2,
          boxedVariant: "thick",
          boxedTone: "blue",
        },
        {
          type: "mathInline",
          id: "header_math",
          tex: "x^2",
          display: "inline",
          marks: ["underline", "boxed"],
          boxedPaddingY: 1,
          boxedVariant: "double",
          semanticRole: "expression",
        },
      ],
      align: undefined,
      lineHeight: undefined,
    }]);
  });

  it("keeps a running region list's (1) marker style and drops unknown values", () => {
    // "roman" は永続データに現れうる未知の値なので、型を通さず素の JSON として渡す。
    const runningList = (id: string, listType: string, markerStyle: string) => ({
      type: "list",
      id,
      listType,
      markerStyle,
      items: [{ type: "listItem", id: `${id}_item`, children: [{ type: "text", text: "項目" }] }],
    }) as unknown as RichBlock;
    const layout = normalizePageLayout({
      header: {
        enabled: true,
        blocks: [
          runningList("header_paren", "ordered", "paren"),
          runningList("header_unknown", "ordered", "roman"),
          runningList("header_bullet", "bullet", "paren"),
        ],
      },
    });

    expect(layout.header?.blocks[0]).toMatchObject({ id: "header_paren", markerStyle: "paren" });
    expect(layout.header?.blocks[1]).toMatchObject({ id: "header_unknown", markerStyle: undefined });
    expect(layout.header?.blocks[2]).toMatchObject({ id: "header_bullet", markerStyle: undefined });
  });

  it("treats running region overlays as repeated region content", () => {
    const layout = normalizePageLayout({
      header: {
        enabled: true,
        overlay: {
          overlaySnapshot: {
            version: 1,
            shapes: [{
              id: "header_shape",
              type: "arc",
              x: 12,
              y: 4,
              props: { r: 10, startAngle: 0, endAngle: Math.PI, color: "#111111", dash: "solid", size: "m" },
            }],
            assets: {},
          },
        },
      },
    });

    expect(pageRunningRegionHasContent(layout.header)).toBe(true);
    expect(layout.header?.overlay?.overlaySnapshot?.shapes).toHaveLength(1);
  });

  it("drops a page overlay that only carries an untrusted preview svg", () => {
    const layout = normalizePageLayout({
      overlay: { previewSvg: "<img src=x onerror=alert(1)>" } as never,
    });

    expect(layout.overlay).toBeUndefined();
  });

  it("treats a preview-only running region overlay as empty", () => {
    const layout = normalizePageLayout({
      header: {
        enabled: true,
        blocks: [],
        overlay: { previewSvg: "<svg/>" } as never,
      },
    });

    expect(layout.header?.overlay).toBeUndefined();
    expect(pageRunningRegionHasContent(layout.header)).toBe(false);
  });

  it("expands vertical margins to fit running regions", () => {
    const layout = normalizePageLayout({
      marginsMm: { top: 8, bottom: 8 },
      header: { enabled: true, heightMm: 7, offsetMm: 3 },
      footer: { enabled: true, heightMm: 7, offsetMm: 3 },
    });
    const expanded = expandMarginsForRunningRegions(layout);

    expect(expanded.marginsMm.top).toBe(10);
    expect(expanded.marginsMm.bottom).toBe(10);
    expect(getPageLayoutIssues(expanded)).toEqual([]);
  });

  it("keeps block order stable across A4 page pagination", () => {
    const blocks = Array.from({ length: 34 }, (_, index): SigmaBlock => ({
      type: "paragraph",
      id: `p_${index + 1}`,
      children: [
        {
          type: "text",
          text: `paragraph ${index + 1} `.repeat(8),
        },
      ],
    }));

    const pages = paginateBlocks(blocks, getDefaultPageLayout());

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.blocks.map((block) => block.id))).toEqual(
      blocks.map((block) => block.id),
    );
  });

  it("forces a new page when a block requests break=always", () => {
    const blocks: SigmaBlock[] = [
      {
        type: "paragraph",
        id: "p_before",
        children: [{ type: "text", text: "before" }],
      },
      {
        type: "paragraph",
        id: "p_after",
        pagination: { break: true },
        children: [{ type: "text", text: "after" }],
      },
    ];

    const pages = paginateBlocks(blocks, getDefaultPageLayout());

    expect(pages).toHaveLength(2);
    expect(pages[1].blocks.map((block) => block.id)).toEqual(["p_after"]);
  });

  it("advances break=always to the next column in multi-column layout", () => {
    const blocks: SigmaBlock[] = [
      {
        type: "paragraph",
        id: "p_before",
        children: [{ type: "text", text: "before" }],
      },
      {
        type: "paragraph",
        id: "p_after",
        pagination: { break: true },
        children: [{ type: "text", text: "after" }],
      },
      {
        type: "paragraph",
        id: "p_tail",
        children: [{ type: "text", text: "tail" }],
      },
    ];
    const layout = normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    });

    const pages = paginateBlocks(blocks, layout);

    expect(pages).toHaveLength(1);
    expect(pages[0].columns.map((column) => column.blocks.map((block) => block.id))).toEqual([
      ["p_before"],
      ["p_after", "p_tail"],
    ]);
  });

  it("advances explicit breaks from the last column to the next physical page", () => {
    const blocks: SigmaBlock[] = [
      {
        type: "paragraph",
        id: "p_first",
        children: [{ type: "text", text: "first" }],
      },
      {
        type: "paragraph",
        id: "p_second",
        pagination: { break: true },
        children: [{ type: "text", text: "second" }],
      },
      {
        type: "paragraph",
        id: "p_third",
        pagination: { break: true },
        children: [{ type: "text", text: "third" }],
      },
    ];
    const layout = normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    });

    const pages = paginateBlocks(blocks, layout);

    expect(pages).toHaveLength(2);
    expect(pages[0].columns.map((column) => column.blocks.map((block) => block.id))).toEqual([
      ["p_first"],
      ["p_second"],
    ]);
    expect(pages[1].columns.map((column) => column.blocks.map((block) => block.id))).toEqual([
      ["p_third"],
      [],
    ]);
  });

  it("moves a keepWithNext pair together when it fits the next column", () => {
    const layout = normalizePageLayout({
      preset: "custom",
      pageSize: { widthMm: 120, heightMm: 80 },
      marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    });
    const blocks: SigmaBlock[] = [
      {
        type: "paragraph",
        id: "filler",
        children: [{ type: "text", text: "filler ".repeat(70) }],
      },
      {
        type: "heading",
        id: "heading",
        level: 2,
        pagination: { keepWithNext: true },
        children: [{ type: "text", text: "見出し" }],
      },
      {
        type: "paragraph",
        id: "body",
        children: [{ type: "text", text: "本文" }],
      },
    ];

    const pages = paginateBlocks(blocks, layout);
    const columns = pages.flatMap((page) => page.columns);
    const headingColumn = columns.findIndex((column) => column.blocks.some((block) => block.id === "heading"));
    const bodyColumn = columns.findIndex((column) => column.blocks.some((block) => block.id === "body"));
    expect(headingColumn).toBeGreaterThan(0);
    expect(bodyColumn).toBe(headingColumn);
  });

  it("keeps line-break commands in inline math at paragraph line height", () => {
    const singleLine: SigmaBlock = {
      type: "paragraph",
      id: "p_single_math",
      children: [{ type: "mathInline", id: "m_single", tex: "x=1".repeat(6), display: "inline" }],
    };
    const lineBreakCommand: SigmaBlock = {
      type: "paragraph",
      id: "p_inline_break_math",
      children: [{ type: "mathInline", id: "m_inline_break", tex: "x=1\\\\y=2\\\\z=3", display: "inline" }],
    };

    expect(paginateBlocks([singleLine], getDefaultPageLayout())[0].estimatedContentHeightPx).toBe(
      paginateBlocks([lineBreakCommand], getDefaultPageLayout())[0].estimatedContentHeightPx,
    );
  });
});

describe("page background", () => {
  it("gives a new whiteboard the dotted ground and leaves paper presets bare", () => {
    expect(getDefaultPageLayout("whiteboard").background).toBe("dots");
    expect(getDefaultPageLayout("A4").background).toBeUndefined();
  });

  it("keeps an explicit whiteboard background through normalization", () => {
    expect(normalizePageLayout({ preset: "whiteboard", background: "grid" }).background).toBe("grid");
    expect(normalizePageLayout({ preset: "whiteboard", background: "none" }).background).toBe("none");
  });

  it("falls back to dots for a whiteboard that predates the field or carries junk", () => {
    expect(normalizePageLayout({ preset: "whiteboard" }).background).toBe("dots");
    expect(normalizePageLayout({
      preset: "whiteboard",
      background: "lines" as unknown as "grid",
    }).background).toBe("dots");
  });

  it("keeps the background on a custom sheet so the print crop can carry it", () => {
    // `cropWhiteboardDocumentForPrint` は preset:"custom" の1枚紙を返す。印刷へ背景を
    // 乗せるのは別PRだが、ここで落とすとその切り出しの再正規化で必ず消えるので、
    // 用紙プリセット側でも保持しておくのが前提条件になる。
    expect(normalizePageLayout({ preset: "custom", background: "grid" }).background).toBe("grid");
    expect(normalizePageLayout({ preset: "custom", background: "none" }).background).toBe("none");
  });

  it("leaves a paper sheet without a background unless one was stored", () => {
    expect(normalizePageLayout({ preset: "A4" }).background).toBeUndefined();
    expect(normalizePageLayout({
      preset: "A4",
      background: "lines" as unknown as "grid",
    }).background).toBeUndefined();
  });

  it("survives a parse round trip through the document schema", () => {
    const document = parseSigmaDocument({
      ...sampleDocument,
      content: [],
      pageLayout: {
        preset: "whiteboard",
        orientation: "portrait",
        pageSize: { widthMm: 210, heightMm: 297 },
        marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
        flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        background: "grid",
      },
    });

    expect(document.pageLayout?.background).toBe("grid");
  });

  it("rejects a background the renderer cannot draw", () => {
    expect(() => parseSigmaDocument({
      ...sampleDocument,
      content: [],
      pageLayout: {
        preset: "whiteboard",
        orientation: "portrait",
        pageSize: { widthMm: 210, heightMm: 297 },
        marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
        flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        background: "lines",
      },
    })).toThrow();
  });
});
