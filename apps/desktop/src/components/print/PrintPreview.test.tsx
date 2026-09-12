import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildPrintContent,
  estimatePrintContentUnitHeight,
  paginateMeasuredPrintBlocks,
  PrintPreview,
  PrintPreviewPageNavigator,
  PrintPreviewThumbnail,
  translateNestedMeasuredBlock,
  type PrintContentUnit,
} from "@/components/print/PrintPreview";
import { PrintLayoutSectionFragment } from "@/components/print/print-static-blocks";
import { renderMathHtml } from "@/features/rendering/adapters";
import { MM_TO_PX } from "@/features/document";
import { createBoxBlock } from "@/lib/box-blocks";
import { createMathRenderEnvironment } from "@/lib/math-environment";
import { getPrintProblemFrameFragmentChromeHeightMm } from "@/lib/problem-frame";
import type { SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

const document: SigmaDocument = {
  version: "2.0",
  docId: "doc_print_preview_layout",
  metadata: {
    title: "表示モード検証",
  },
  content: [
    {
      type: "paragraph",
      id: "paragraph_print_preview_layout",
      children: [{ type: "text", text: "A4ページの表示モードを確認する。" }],
    },
  ],
  outputProfiles: {
    student: { showSolutions: false, showHints: false, includeAnswers: false },
    teacher: { showSolutions: true, showHints: true, includeAnswers: true },
    answerBook: { onlySolutions: true, showSolutions: true, showHints: false, includeAnswers: true },
  },
};

describe("PrintPreview layout modes", () => {
  it("renders page and local rules independently in the public viewer", () => {
    const ruled = documentWithColumns(2, [{
      type: "layoutSection", id: "local-rule",
      layout: { columnCount: 2, columnStartIds: ["left-rule", "right-rule"], columnRule: { style: "double", widthPx: 3, color: "#123456" } },
      children: [
        { type: "paragraph", id: "left-rule", children: [{ type: "text", text: "left" }] },
        { type: "paragraph", id: "right-rule", children: [{ type: "text", text: "right" }] },
      ],
    }]);
    ruled.pageLayout!.flow.columnRule = { style: "dashed", widthPx: 2, color: "#654321" };
    const html = renderToStaticMarkup(<PrintPreview document={ruled} profile="teacher" />);
    expect(html).toContain('class="page-column-rules"');
    expect(html).toContain("--column-rule-style:dashed");
    expect(html).toContain("--column-rule-style:double");
    expect(html).toContain('class="column-rule-separator"');
  });

  // 仕様変更: `mathFractionSizing` は「静的側だけ `\frac` を `\dfrac` へ書き換える」設定ではなく、
  // **文書の組版スタイル** (uniform=displaystyle / texDefault=textstyle) になった。静的側と
  // 編集中の math-field が同じ 1 つの出典から組版を導くので、片方だけ変わることがない。
  it("applies the document typeset style to print output without rewriting the stored TeX", () => {
    const tex = String.raw`\frac{x^{\frac{1}{2}}}{\frac{a}{b}}`;
    const fractionDocument = documentWithColumns(1, [{
      type: "paragraph",
      id: "print_fraction_sizing",
      children: [{
        type: "mathInline",
        id: "print_fraction_sizing_math",
        tex,
        display: "inline",
      }],
    }]);
    const texDefaultDocument: SigmaDocument = {
      ...fractionDocument,
      metadata: { ...fractionDocument.metadata, mathFractionSizing: "texDefault" },
    };

    const uniformHtml = renderToStaticMarkup(<PrintPreview document={fractionDocument} profile="teacher" />);
    const texDefaultHtml = renderToStaticMarkup(<PrintPreview document={texDefaultDocument} profile="teacher" />);

    expect(uniformHtml).toContain(renderMathHtml(tex, createMathRenderEnvironment(undefined, "uniform")));
    expect(texDefaultHtml).toContain(renderMathHtml(tex, createMathRenderEnvironment(undefined, "texDefault")));
    expect(uniformHtml).not.toBe(texDefaultHtml);
    // 保存される TeX はどちらの設定でも書き換わらない。
    expect(uniformHtml).toContain('data-tex="\\frac{x^{\\frac{1}{2}}}{\\frac{a}{b}}"');
    expect(texDefaultHtml).toContain('data-tex="\\frac{x^{\\frac{1}{2}}}{\\frac{a}{b}}"');
  });

  // `packages/viewer` はこのコンポーネントを直接 print surface に使う。Provider が
  // `app/print/page.tsx` 側にしか無かったころは、公開ビューアで前文マクロが一切効かなかった。
  it("expands preamble macros when rendered on its own (the public viewer surface)", () => {
    const preamble = String.raw`\newcommand{\RR}{\mathbb{R}}`;
    const tex = String.raw`\frac{a}{b}\RR`;
    const base = documentWithColumns(1, [{
      type: "paragraph",
      id: "print_preamble_macro",
      children: [{
        type: "mathInline",
        id: "print_preamble_macro_math",
        tex,
        display: "inline",
      }],
    }]);
    const preambleDocument: SigmaDocument = {
      ...base,
      metadata: { ...base.metadata, texPreamble: preamble },
    };

    const html = renderToStaticMarkup(<PrintPreview document={preambleDocument} profile="teacher" />);

    expect(html).toContain(renderMathHtml(tex, createMathRenderEnvironment(preamble)));
    expect(html).not.toContain("data-math-unrendered");
  });

  it("uses the vertical layout by default", () => {
    const html = renderToStaticMarkup(<PrintPreview document={document} profile="teacher" />);

    expect(html).toContain('data-print-preview-layout="vertical"');
    expect(html).toContain("layout-vertical");
  });

  it("renders a section number with the shared heading prefix in print, PDF, and viewer output", () => {
    const numberedDocument = documentWithColumns(1, [{
      type: "section",
      id: "numbered-section",
      title: "序章",
    }]);
    numberedDocument.metadata.headingNumbering = {
      enabled: true,
      style: "chapterJa",
      depth: 1,
    };

    const html = renderToStaticMarkup(<PrintPreview document={numberedDocument} profile="teacher" />);

    expect(html).toContain('<span class="heading-number-prefix">第1章 </span>序章');
  });

  it("applies the requested spread layout", () => {
    const html = renderToStaticMarkup(
      <PrintPreview document={document} profile="teacher" displayMode="spread" />,
    );

    expect(html).toContain('data-print-preview-layout="spread"');
    expect(html).toContain("layout-spread");
  });

  it("uses an expanded Japanese font stack in the print rendering path", () => {
    const fontFamily = '"BIZ UDPMincho", "Yu Mincho", "Hiragino Mincho ProN", serif';
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [{
          type: "paragraph",
          id: "print_biz_mincho",
          children: [{ type: "text", text: "明朝体の本文", fontFamily }],
        }])}
        profile="teacher"
      />,
    );

    expect(html).toContain("font-family");
    expect(html).toContain("BIZ UDPMincho");
    expect(html).toContain("Hiragino Mincho ProN");
  });

  it("renders rich box titles with text styling and inline math", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [{
          type: "boxBlock",
          id: "print_rich_box_title",
          styleId: "itembox",
          title: [
            {
              type: "text",
              text: "重要 ",
              marks: ["bold"],
              color: "#1d4ed8",
              fontSize: 18,
            },
            {
              type: "mathInline",
              id: "print_rich_box_title_math",
              tex: String.raw`x^2+y^2`,
              display: "inline",
              semanticRole: "expression",
            },
          ],
          blocks: [{
            type: "paragraph",
            id: "print_rich_box_body",
            children: [{ type: "text", text: "本文" }],
          }],
        }])}
        profile="teacher"
      />,
    );

    expect(html).toContain('class="print-box-title"');
    expect(html).toContain("重要");
    expect(html).toContain("color:#1d4ed8");
    expect(html).toContain("font-size:18pt");
    expect(html).toContain('data-tex="x^2+y^2"');
  });

  it("does not render a print title element for an empty box title", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [{
          type: "boxBlock",
          id: "print_empty_box_title",
          styleId: "itembox",
          title: [],
          blocks: [{
            type: "paragraph",
            id: "print_empty_box_body",
            children: [{ type: "text", text: "本文" }],
          }],
        }])}
        profile="teacher"
      />,
    );

    expect(html).not.toContain('class="print-box-title"');
    expect(html).toContain("本文");
  });

  it("passes a colored itembox background through to the print title plate", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [{
          ...createBoxBlock("itembox", "色付き見出し", {
            id: "print_colored_itembox",
            bodyId: "print_colored_itembox_body",
          }),
          frame: {
            ...createBoxBlock("itembox").frame,
            backgroundColor: "#fef3c7",
          },
        }])}
        profile="teacher"
      />,
    );

    expect(html).toContain("box-frame--title-plate");
    expect(html).toContain("--sigma-doc-box-background:#fef3c7");
    expect(html).toContain('class="print-box-title"');
  });

  it("renders nested SigmaDoc lists with inline formatting and math", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [
          {
            type: "list",
            id: "print_list_ordered",
            listType: "ordered",
            items: [
              {
                type: "listItem",
                id: "print_li_parent",
                children: [
                  { type: "text", text: "太字", marks: ["bold"] },
                  { type: "mathInline", id: "print_li_math", tex: "x^2", display: "inline" },
                ],
                nested: [
                  {
                    type: "list",
                    id: "print_list_nested",
                    listType: "bullet",
                    items: [
                      {
                        type: "listItem",
                        id: "print_li_child",
                        children: [{ type: "text", text: "下線", marks: ["underline"] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])}
        profile="teacher"
      />,
    );

    expect(html).toContain("<ol");
    expect(html).toContain("<ul");
    expect(html).toContain('data-sigma-doc-id="print_li_parent"');
    expect(html).toContain('data-sigma-doc-id="print_li_child"');
    expect(html).toContain("<strong>");
    expect(html).toContain("sigma-underline-run");
    expect(html).toContain("math-preview");
  });

  it("renders printable boxed text and math as one annotated inline run", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [
          {
            type: "paragraph",
            id: "print_boxed_inline_run",
            children: [
              { type: "text", text: "辺", marks: ["boxed"], boxedVariant: "double" },
              {
                type: "mathInline",
                id: "print_boxed_inline_math",
                tex: "P(\\alpha)Q(\\beta)",
                display: "inline",
                marks: ["boxed"],
                boxedVariant: "double",
              },
              { type: "text", text: "は", marks: ["boxed"], boxedVariant: "double" },
            ],
          },
        ])}
        profile="teacher"
      />,
    );
    const previewHtml = html.split('<div class="print-measure-layer"')[0] ?? html;

    expect(previewHtml).toContain('data-boxed-run-id="print_boxed_inline_run-boxed-run-0"');
    expect(previewHtml.match(/data-boxed-run-height-target="true"/g)).toHaveLength(3);
    expect(previewHtml.match(/data-boxed-run-connect-right="true"/g)).toHaveLength(2);
    expect(previewHtml.match(/data-boxed-run-connect-left="true"/g)).toHaveLength(2);
    expect(previewHtml).toContain('data-sigma-doc-boxed-variant="double"');
  });

  // The running region uses the body's static renderer (no `.print-*`), while the page body keeps
  // the print family — that split is what proves `PrintableRichBlock` survived as a thin wrapper.
  it("renders running headers with the body renderer and keeps the print family in the page body", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [
          paragraph("header_parity_body", "本文"),
        ], {
          preset: "A4",
          orientation: "portrait",
          pageSize: { widthMm: 210, heightMm: 297 },
          marginsMm: { top: 22, right: 17, bottom: 18, left: 17 },
          flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
          header: {
            enabled: true,
            heightMm: 14,
            offsetMm: 4,
            showOnFirstPage: true,
            blocks: [
              {
                type: "paragraph",
                id: "header_paragraph",
                align: "center",
                children: [
                  { type: "text", text: "{title} " },
                  {
                    type: "text",
                    text: "重要",
                    marks: ["boxed"],
                    boxedVariant: "thick",
                    boxedTone: "blue",
                  },
                  { type: "text", text: "\n{page} / {total}", marks: ["bold"] },
                ],
              },
              {
                type: "paragraph",
                id: "header_empty",
                children: [],
              },
              {
                type: "list",
                id: "header_list",
                listType: "bullet",
                items: [{
                  type: "listItem",
                  id: "header_item",
                  children: [
                    { type: "text", text: "式 " },
                    {
                      type: "mathInline",
                      id: "header_math",
                      tex: "x^2",
                      display: "inline",
                      marks: ["boxed"],
                      boxedVariant: "double",
                    },
                  ],
                }],
              },
            ],
          },
        })}
        profile="teacher"
      />,
    );
    const previewHtml = html.split('<div class="print-measure-layer"')[0] ?? html;
    const emptyParagraphStart = previewHtml.indexOf('data-sigma-doc-id="header_empty"');
    const emptyParagraphHtml = previewHtml.slice(emptyParagraphStart, previewHtml.indexOf("</p>", emptyParagraphStart));

    expect(emptyParagraphStart).toBeGreaterThan(-1);
    expect(previewHtml).toContain('class="page-running-region header free"');
    expect(previewHtml).toContain('class="page-running-text-layer text-flow-shell"');
    expect(previewHtml).toContain('class="text-flow-editor"');
    expect(previewHtml).toContain('data-sigma-doc-id="header_paragraph" style="text-align:center"');
    expect(previewHtml).toContain("段組み改ページ検証");
    expect(previewHtml).toContain("1 / 1");
    expect(previewHtml).toContain("<br");
    expect(previewHtml).toContain("<strong>");
    expect(previewHtml).toContain('data-sigma-doc-boxed-variant="thick"');
    expect(previewHtml).toContain('data-sigma-doc-boxed-tone="blue"');
    expect(previewHtml).toContain('data-sigma-doc-id="header_list"');
    // The page body still gets the print family from `PrintableRichBlock`.
    expect(previewHtml).toContain('data-sigma-doc-id="header_parity_body" class="print-paragraph"');
    expect(previewHtml).toContain('data-sigma-doc-id="header_item"');
    expect(previewHtml).toContain('data-sigma-doc-boxed-variant="double"');
    expect(previewHtml).toContain("math-preview-inline");
    expect(emptyParagraphHtml).toContain("<br");
  });

  it("renders notebook box blocks with the shared print frame metadata", () => {
    const note = createBoxBlock("tcolorbox-note", "", {
      id: "print_note_box",
      bodyId: "print_note_body",
    });
    const html = renderToStaticMarkup(
      <PrintPreview document={documentWithColumns(1, [note])} profile="teacher" />,
    );

    expect(html).toContain('class="print-box-block box-frame box-frame--notebook-rules box-frame--title-position-l"');
    expect(html).toContain('data-box-style="tcolorbox-note"');
    expect(html).toContain('data-box-notebook-rules="true"');
    expect(html).toContain("--sigma-doc-box-notebook-frame-left:20px");
    expect(html).toContain("--sigma-doc-box-notebook-frame-height:57.35px");
    expect(html).toContain("--sigma-doc-box-notebook-ring-count:1");
    expect(html).not.toContain("--sigma-doc-box-notebook-line-gap");
  });
});

describe("PrintPreviewThumbnail", () => {
  it("renders only the first printable page with page sizing and math content", () => {
    const html = renderToStaticMarkup(
      <PrintPreviewThumbnail document={thumbnailDocument()} />,
    );
    const previewHtml = html.split('<div class="print-measure-layer"')[0] ?? html;

    expect(html).toContain('data-print-preview-thumbnail="true"');
    expect(html).toContain('data-print-preview-max-pages="1"');
    expect(previewHtml.match(/class="print-a4-page"/g) ?? []).toHaveLength(1);
    expect(previewHtml).toContain('data-sigma-doc-id="thumbnail_heading"');
    expect(previewHtml).toContain("math-preview");
    expect(html).toContain("--print-page-width:182mm");
    expect(html).toContain("--print-page-height:257mm");
  });
});

describe("PrintPreviewPageNavigator", () => {
  it("renders a selectable paper-like page list with the active page marked", () => {
    const html = renderToStaticMarkup(
      <PrintPreviewPageNavigator
        document={documentWithColumns(1, [
          paragraph("nav_page_1", "1ページ目"),
          paragraph("nav_page_2", "2ページ目", { pagination: { break: true } }),
        ])}
        activePageNumber={2}
        onPageSelect={() => undefined}
      />,
    );
    const previewHtml = html.split('<div class="print-measure-layer"')[0] ?? html;

    expect(html).toContain('data-print-page-navigator="true"');
    expect(html).toContain('data-print-preview-page-count="2"');
    expect(previewHtml.match(/class="print-preview-page-nav-item/g) ?? []).toHaveLength(2);
    expect(previewHtml).toContain('aria-label="ページ 2 / 2"');
    expect(previewHtml).toContain('aria-current="page"');
    expect(previewHtml).toContain('class="print-preview-page-nav-paper-selection"');
    expect(previewHtml).toContain('class="print-preview-page-nav-label">-2-</span>');
    expect(previewHtml).not.toContain("print-preview-page-nav-number");
    expect(previewHtml).toContain('data-sigma-doc-id="nav_page_1"');
    expect(previewHtml).toContain('data-sigma-doc-id="nav_page_2"');
  });
});

describe("PrintPreview print pagination", () => {
  it("places each exact 90mm problem area independently without overflowing its page", () => {
    // エリア単位 keep-together：問題全体をまとめて動かす規則は 3 エンジン統一で撤去済み。
    // 各エリアは自分の予約込みで残りに収まるページに置かれる。
    const regressionDocument: SigmaDocument = {
      version: "2.0",
      docId: "doc_print_problem_pagination",
      metadata: { title: "問題と解答の改ページ確認" },
      content: [
        {
          type: "paragraph",
          id: "before_problem",
          children: [{ type: "text", text: "問題の前にある本文" }],
        },
        {
          type: "problem",
          id: "kept_problem",
          tags: [],
          numbering: { enabled: false },
          lead: [],
          prompt: [{
            type: "paragraph",
            id: "kept_prompt",
            children: [{ type: "text", text: "問題文" }],
          }],
          solution: [{
            type: "paragraph",
            id: "kept_solution",
            children: [{ type: "text", text: "解答" }],
          }],
          hints: [],
          frame: { enabled: true },
          areaLayout: {
            prompt: { minHeightMm: 32 },
            solution: { minHeightMm: 32 },
          },
        },
      ],
      outputProfiles: {
        student: { showSolutions: false },
        teacher: { showSolutions: true },
        answerBook: { onlySolutions: true, showSolutions: true },
      },
      pageLayout: {
        preset: "custom",
        orientation: "portrait",
        pageSize: { widthMm: 80, heightMm: 90 },
        marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
        flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
      },
    };
    const contentHeightPx = 70 * (96 / 25.4);
    const units = buildPrintContent(regressionDocument.content);
    // DOM 実測の本文・問題枠間の占有高は static 見積りと異なるため、
    // 実機と同じ prompt=1 ページ目、solution=2 ページ目になる入力高に較正する。
    const heights = units.map((unit, index) => (
      index === 0 ? 100 : estimatePrintContentUnitHeight(unit, contentHeightPx)
    ));
    const flowHeights = [...heights];
    const pages = paginateMeasuredPrintBlocks(
      units,
      heights,
      flowHeights,
      1,
      contentHeightPx,
      0,
      new Map(),
      0,
    );
    const areaPage = (area: "prompt" | "solution") => pages.findIndex((page) => (
      page.columns[0].blocks.some((unit) => (
        (unit.type === "problemArea" || unit.type === "problemAreaFragment") && unit.area === area
      ))
    ));
    const placedHeight = (pageIndex: number) => pages[pageIndex].columns[0].blocks.reduce((height, unit) => {
      const sourceIndex = units.findIndex((source) => source.id === unit.id);
      return height + (sourceIndex >= 0 ? heights[sourceIndex] : 0);
    }, 0);

    expect(areaPage("prompt")).toBe(0);
    expect(areaPage("solution")).toBe(1);
    expect(pages).toHaveLength(2);
    expect(placedHeight(0)).toBeLessThanOrEqual(contentHeightPx + 0.5);
    expect(placedHeight(1)).toBeLessThanOrEqual(contentHeightPx + 0.5);
    expect(units.filter((unit) => unit.type === "problemArea").map((unit) => (
      estimatePrintContentUnitHeight(unit, contentHeightPx)
    ))).toEqual(expect.arrayContaining([
      expect.closeTo(32 * (96 / 25.4), 5),
      expect.closeTo(32 * (96 / 25.4), 5),
    ]));
  });

  it("places the exact 110mm prompt on page one and solution on page two", () => {
    // エリア単位 keep-together：問題全体をまとめて動かす規則は 3 エンジン統一で撤去済み。
    // 各エリアは自分の予約込みで残りに収まるページに置かれる。
    const regressionDocument: SigmaDocument = {
      version: "2.0",
      docId: "doc_reserved_area_keep_together",
      metadata: { title: "解答欄の確保とページ送り" },
      content: [
        ...Array.from({ length: 6 }, (_, index) => ({
          type: "paragraph" as const,
          id: `filler_${index + 1}`,
          children: [{ type: "text" as const, text: `本文 ${index + 1} 行目のサンプルです` }],
        })),
        {
          type: "problem",
          id: "reserved_problem",
          tags: [],
          numbering: { enabled: false },
          lead: [],
          prompt: [{ type: "paragraph", id: "reserved_prompt", children: [{ type: "text", text: "問題文" }] }],
          solution: [{ type: "paragraph", id: "reserved_solution", children: [{ type: "text", text: "解答" }] }],
          hints: [],
          frame: { enabled: true },
          areaLayout: {
            prompt: { minHeightMm: 22 },
            solution: { minHeightMm: 22 },
          },
        },
      ],
      outputProfiles: {
        student: { showSolutions: false },
        teacher: { showSolutions: true },
        answerBook: { onlySolutions: true, showSolutions: true },
      },
      pageLayout: {
        preset: "custom",
        orientation: "portrait",
        pageSize: { widthMm: 90, heightMm: 110 },
        marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
        flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
      },
    };
    const contentHeightPx = 90 * (96 / 25.4);
    const units = buildPrintContent(regressionDocument.content);
    // DOM 実測と static 見積りの差をテスト入力側で吸収し、6 段落 + prompt が
    // 1 ページ目に収まり、solution だけが 2 ページ目に送られる実機配置を再現する。
    const heights = units.map((unit, index) => (
      index < 6 ? 40 : estimatePrintContentUnitHeight(unit, contentHeightPx)
    ));
    const flowHeights = [...heights];
    const pages = paginateMeasuredPrintBlocks(units, heights, flowHeights, 1, contentHeightPx, 0, new Map(), 0);
    const areaPage = (area: "prompt" | "solution") => pages.findIndex((page) => (
      page.columns[0].blocks.some((unit) => (
        (unit.type === "problemArea" || unit.type === "problemAreaFragment") && unit.area === area
      ))
    ));
    const placedHeight = (pageIndex: number) => pages[pageIndex].columns[0].blocks.reduce((height, unit) => {
      const sourceIndex = units.findIndex((source) => source.id === unit.id);
      return height + (sourceIndex >= 0 ? heights[sourceIndex] : 0);
    }, 0);

    expect(areaPage("prompt")).toBe(0);
    expect(areaPage("solution")).toBe(1);
    expect(pages).toHaveLength(2);
    expect(placedHeight(0)).toBeLessThanOrEqual(contentHeightPx + 0.5);
    expect(placedHeight(1)).toBeLessThanOrEqual(contentHeightPx + 0.5);
    expect(units.filter((unit) => unit.type === "problemArea").map((unit) => (
      estimatePrintContentUnitHeight(unit, contentHeightPx)
    ))).toEqual(expect.arrayContaining([
      expect.closeTo(22 * (96 / 25.4), 5),
      expect.closeTo(22 * (96 / 25.4), 5),
    ]));
  });

  it("moves an explicit break to the next column before starting a physical page", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          paragraph("p_before", "before"),
          paragraph("p_after", "after", { pagination: { break: true } }),
          paragraph("p_tail", "tail"),
        ])}
        profile="teacher"
      />,
    );

    expect(renderedPageColumns(html)).toEqual([
      [["p_before"], ["p_after", "p_tail"]],
    ]);
  });

  it("moves consecutive explicit breaks from the last column to the next physical page", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          paragraph("p_first", "first"),
          paragraph("p_second", "second", { pagination: { break: true } }),
          paragraph("p_third", "third", { pagination: { break: true } }),
        ])}
        profile="teacher"
      />,
    );

    expect(renderedPageColumns(html)).toEqual([
      [["p_first"], ["p_second"]],
      [["p_third"], []],
    ]);
  });

  it("keeps a block with its next block when the pair fits the next column", () => {
    const filler = Array.from({ length: 5 }, (_, index) => (
      paragraph(`keep_next_filler_${index + 1}`, `前置き ${index + 1}`)
    ));
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          ...filler,
          paragraph("keep_next_heading", "見出し", { pagination: { keepWithNext: true } }),
          paragraph("keep_next_body", "直後の本文"),
        ], shortTwoColumnPageLayout())}
        profile="teacher"
      />,
    );

    expect(renderedPageColumns(html)).toEqual([[
      filler.map((block) => block.id),
      ["keep_next_heading", "keep_next_body"],
    ]]);
  });

  it("flows an oversized unframed problem area from the left into the right column", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          paragraph("p_before_oversized_solution", "before"),
          {
            type: "problem",
            id: "problem_oversized_solution",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [],
            solution: Array.from({ length: 6 }, (_, index) => (
              richParagraph(`solution_oversized_body_${index + 1}`, `解答 ${index + 1}`)
            )),
            hints: [],
          },
        ], {
          preset: "custom",
          orientation: "portrait",
          pageSize: { widthMm: 80, heightMm: 90 },
          marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
          flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
        })}
        profile="teacher"
      />,
    );

    expect(renderedPageColumns(html)).toEqual([
      [[
        "p_before_oversized_solution",
        "solution_oversized_body_1",
        "solution_oversized_body_2",
        "solution_oversized_body_3",
        "solution_oversized_body_4",
      ], [
        "solution_oversized_body_5",
        "solution_oversized_body_6",
      ]],
    ]);
    expect(html).toContain('data-problem-area-fragment="first"');
    expect(html).toContain('data-problem-area-fragment="last"');
  });

  it("keeps independently fitting prompt and solution areas on the current page", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [
          paragraph("p_before_problem", "問題の前にある本文"),
          {
            type: "problem",
            id: "problem_kept_with_solution",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [richParagraph("kept_prompt", "問題文")],
            solution: [richParagraph("kept_solution", "解答")],
            hints: [],
            frame: { enabled: true },
            areaLayout: {
              prompt: { minHeightMm: 32 },
              solution: { minHeightMm: 32 },
            },
          },
        ], {
          preset: "custom",
          orientation: "portrait",
          pageSize: { widthMm: 80, heightMm: 90 },
          marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
          flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        })}
        profile="teacher"
      />,
    );

    expect(renderedPageColumns(html)).toEqual([
      [["p_before_problem", "problem_kept_with_solution", "kept_prompt", "kept_solution"]],
      [[]],
    ]);
  });

  it("splits an oversized solution area while keeping the framed prompt area atomic", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [
          {
            type: "problem",
            id: "problem_taller_than_page",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [richParagraph("tall_prompt", "問題文")],
            solution: Array.from({ length: 3 }, (_, index) => (
              richParagraph(`tall_solution_${index + 1}`, `解答 ${index + 1}`)
            )),
            hints: [],
            frame: { enabled: true },
            areaLayout: {
              prompt: { minHeightMm: 45 },
              solution: { minHeightMm: 45 },
            },
          },
        ], {
          preset: "custom",
          orientation: "portrait",
          pageSize: { widthMm: 80, heightMm: 90 },
          marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
          flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        })}
        profile="teacher"
      />,
    );

    expect(renderedPageColumns(html)).toEqual([
      [["problem_taller_than_page", "tall_prompt", "tall_solution_1", "tall_solution_2"]],
      [["tall_solution_3"]],
    ]);
  });

  it("uses min-height for problem areas", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [
          {
            type: "problem",
            id: "problem_auto_height_columns",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [],
            solution: [richParagraph("solution_auto_height_body", "解答")],
            hints: [],
            areaLayout: {
              solution: { minHeightMm: 40 },
            },
          },
        ])}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    expect(previewHtml).toContain("min-height:40mm");
    expect(previewHtml).toContain('data-problem-area-fragment="single"');
    expect(html).not.toContain("--print-problem-area-column-height");
    expect(html).not.toContain("--print-problem-area-column-fill");
  });

  it("reserves min-height when a problem area stays in one column", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [
          {
            type: "problem",
            id: "problem_reserved_min_height",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [],
            solution: [richParagraph("reserved_min_height_solution", "解答欄")],
            hints: [],
            areaLayout: { solution: { minHeightMm: 60 } },
          },
          paragraph("after_reserved_min_height", "解答欄の後"),
        ], {
          ...shortTwoColumnPageLayout(),
          flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        })}
        profile="teacher"
      />,
    );

    expect(renderedPageColumns(html)).toEqual([
      [["reserved_min_height_solution"]],
      [["after_reserved_min_height"]],
    ]);
  });

  it("honors page breaks on rich children inside a flowable problem area", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "problem",
            id: "problem_child_page_break",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [],
            solution: [
              richParagraph("child_break_before_advance", "改段前"),
              {
                ...richParagraph("child_break_after_advance", "改段後"),
                pagination: { break: true },
              },
            ],
            hints: [],
          },
        ])}
        profile="teacher"
      />,
    );

    expect(renderedPageColumns(html)).toEqual([[
      ["child_break_before_advance"],
      ["child_break_after_advance"],
    ]]);
  });

  it("places problem-internal layout sections as their own atomic fragments", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "problem",
            id: "problem_layout_section_fragment",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [],
            solution: [
              richParagraph("before_problem_layout_section", "段組み前"),
              {
                type: "layoutSection",
                id: "problem_layout_section",
                layout: { columnCount: 2, columnGapMm: 6 },
                children: [
                  richParagraph("problem_layout_section_left", "左段"),
                  richParagraph("problem_layout_section_right", "右段"),
                ],
              },
              richParagraph("after_problem_layout_section", "段組み後"),
            ],
            hints: [],
          },
        ])}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    expect(previewHtml.match(/data-problem-area-fragment="/g) ?? []).toHaveLength(3);
    expect(previewHtml).toContain('data-problem-area-fragment="first"');
    expect(previewHtml).toContain('data-problem-area-fragment="middle"');
    expect(previewHtml).toContain('data-problem-area-fragment="last"');
    expect(previewHtml).toContain('data-sigma-doc-id="problem_layout_section"');
  });

  it("splits an oversized problem-internal layout section across print columns", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "problem",
            id: "problem_split_layout_section",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [],
            solution: [{
              type: "layoutSection",
              id: "split_problem_layout_section",
              layout: { columnCount: 2, columnGapMm: 6 },
              children: Array.from({ length: 12 }, (_, index) => (
                richParagraph(`split_problem_layout_child_${index + 1}`, `内部段 ${index + 1}`)
              )),
            }],
            hints: [],
          },
        ], shortTwoColumnPageLayout())}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    expect(previewHtml).toContain('data-layout-section-fragment="first"');
    expect(previewHtml).toContain('data-layout-section-fragment="last"');
    const outerColumns = renderedPageColumns(html).flat();
    expect(outerColumns.findIndex((ids) => ids.includes("split_problem_layout_child_1")))
      .toBeLessThan(outerColumns.findIndex((ids) => ids.includes("split_problem_layout_child_12")));
    for (let index = 1; index <= 12; index += 1) {
      expect(previewHtml).toContain(`data-sigma-doc-id="split_problem_layout_child_${index}"`);
    }
  });

  it("honors a manual break inside a fitting problem-internal layout section", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [{
          type: "problem",
          id: "problem_manual_layout_section",
          tags: [],
          numbering: { enabled: false },
          lead: [],
          prompt: [],
          solution: [{
            type: "layoutSection",
            id: "manual_problem_layout_section",
            layout: { columnCount: 2, columnGapMm: 6 },
            children: [
              richParagraph("manual_problem_layout_before", "改段前"),
              {
                ...richParagraph("manual_problem_layout_after", "改段後"),
                pagination: { break: true as const },
              },
            ],
          }],
          hints: [],
        }])}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);
    const sectionHtml = previewHtml.slice(previewHtml.indexOf('data-layout-section-source-id="manual_problem_layout_section"'));
    const innerColumns = sectionHtml
      .split('<div class="print-layout-section-column"')
      .slice(1, 3)
      .map((columnHtml) => [...columnHtml.matchAll(/data-sigma-doc-id="([^"]+)"/g)].map((match) => match[1]));

    expect(previewHtml).toContain('data-layout-section-fragment="single"');
    expect(innerColumns[0]).toContain("manual_problem_layout_before");
    expect(innerColumns[0]).not.toContain("manual_problem_layout_after");
    expect(innerColumns[1]).toContain("manual_problem_layout_after");
  });

  it("flows numbered unframed problem blocks through both columns with one anchor and number", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "problem",
            id: "problem_two_column_flow",
            tags: [],
            numbering: { enabled: true },
            lead: [richParagraph("numbered_flow_lead", "問題本文")],
            prompt: [],
            solution: Array.from({ length: 6 }, (_, index) => (
              richParagraph(`numbered_flow_solution_${index + 1}`, `解答 ${index + 1}`)
            )),
            hints: [],
          },
        ], shortTwoColumnPageLayout())}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    expect(renderedPageColumns(html)).toEqual([[
      [
        "problem_two_column_flow",
        "numbered_flow_lead",
        "numbered_flow_solution_1",
        "numbered_flow_solution_2",
        "numbered_flow_solution_3",
        "numbered_flow_solution_4",
      ],
      ["numbered_flow_solution_5", "numbered_flow_solution_6"],
    ]]);
    expect(previewHtml.match(/data-problem-area-fragment="/g) ?? []).toHaveLength(3);
    expect(previewHtml).toContain('data-problem-area-fragment="single"');
    expect(previewHtml).toContain('data-problem-area-fragment="first"');
    expect(previewHtml).toContain('data-problem-area-fragment="last"');
    expect(previewHtml.match(/class="print-problem-number"/g) ?? []).toHaveLength(1);
    expect(previewHtml.match(/data-sigma-doc-id="problem_two_column_flow"/g) ?? []).toHaveLength(1);
  });

  it("does not restart fragment roles after pixel-sliced problem content", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "problem",
            id: "problem_over_tall_numbered_lead",
            tags: [],
            numbering: { enabled: true },
            lead: [
              richParagraph("over_tall_numbered_lead", "長".repeat(500)),
              richParagraph("after_over_tall_numbered_lead", "長いブロックの続き"),
            ],
            prompt: [],
            solution: [],
            hints: [],
          },
        ], shortTwoColumnPageLayout())}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    expect(previewHtml).toContain('data-block-source-id="over_tall_numbered_lead"');
    expect(previewHtml).toContain('data-problem-area-fragment="last"');
    expect(previewHtml).not.toContain('data-problem-area-fragment="first"');
    expect(previewHtml).not.toContain('data-problem-area-fragment="single"');
    expect(previewHtml).not.toContain('class="print-problem-number"');
  });

  it("rebases nested block and line left coordinates from a fragment origin", () => {
    const translated = translateNestedMeasuredBlock(
      {
        id: "nested_fragment_block",
        top: 12,
        left: 44,
        width: 120,
        height: 30,
        lines: [
          { index: 0, top: 14, left: 50, width: 80, height: 12 },
          { index: 1, top: 28, width: 70, height: 12 },
        ],
      },
      100,
      200,
      40,
    );

    expect(translated).toMatchObject({ top: 112, left: 204 });
    expect(translated.lines?.[0]).toMatchObject({ top: 114, left: 210 });
    expect(translated.lines?.[1]).toMatchObject({ top: 128 });
    expect(translated.lines?.[1]?.left).toBeUndefined();
  });

  it("renders a fitting framed problem as one fragment", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "problem",
            id: "problem_framed_atomic",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: Array.from({ length: 3 }, (_, index) => (
              richParagraph(`framed_prompt_${index + 1}`, `枠付き問題文 ${index + 1}`)
            )),
            solution: [],
            hints: [],
            frame: { enabled: true },
          },
        ], shortTwoColumnPageLayout())}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    expect(previewHtml).toContain('data-sigma-doc-id="problem_framed_atomic"');
    expect(previewHtml).toContain('class="print-problem-area with-frame');
    expect(previewHtml).toContain('data-problem-area-fragment="single"');
  });

  it("keeps full-span problem areas atomic", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "problem",
            id: "problem_full_span_atomic",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: Array.from({ length: 3 }, (_, index) => (
              richParagraph(`full_span_prompt_${index + 1}`, `全幅問題文 ${index + 1}`)
            )),
            solution: [],
            hints: [],
            areaLayout: { prompt: { columnSpan: "full" } },
          },
        ], shortTwoColumnPageLayout())}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    expect(previewHtml).toContain('class="print-page-full-span-block"');
    expect(previewHtml).toContain('data-sigma-doc-id="problem_full_span_atomic"');
    expect(previewHtml).not.toContain("data-problem-area-fragment");
  });

  it("splits a framed problem area at a manual break inside it, with an open frame across the break", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "problem",
            id: "problem_framed_split",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [
              richParagraph("framed_split_prompt_1", "前半"),
              { ...richParagraph("framed_split_prompt_2", "後半"), pagination: { break: true } },
            ],
            solution: [],
            hints: [],
            frame: { enabled: true },
          },
        ], shortTwoColumnPageLayout())}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    // The manual break makes the framed area flow into two fragments instead of
    // staying atomic — each still framed, with the border open across the break.
    expect(previewHtml).toContain('data-problem-area-fragment="first"');
    expect(previewHtml).toContain('data-problem-area-fragment="last"');

    const firstTag = sectionTagContaining(previewHtml, 'data-problem-area-fragment="first"');
    const lastTag = sectionTagContaining(previewHtml, 'data-problem-area-fragment="last"');
    expect(firstTag).toContain("with-frame");
    expect(firstTag).toContain("first-frame-area");
    expect(firstTag).not.toContain("last-frame-area");
    expect(lastTag).toContain("with-frame");
    expect(lastTag).toContain("last-frame-area");
    expect(lastTag).not.toContain("first-frame-area");

    // …and the break must actually move content. Two fragments in the same column would
    // draw an open frame around a break that paginated nothing.
    const columns = renderedPageColumns(html)
      .flat()
      .map((column) => column.filter((id) => id.startsWith("framed_split_prompt_")));
    const columnOfFirst = columns.findIndex((ids) => ids.includes("framed_split_prompt_1"));
    const columnOfSecond = columns.findIndex((ids) => ids.includes("framed_split_prompt_2"));
    expect(columnOfFirst).toBeGreaterThanOrEqual(0);
    expect(columnOfSecond).toBeGreaterThan(columnOfFirst);
  });

  it("splits a full-span problem area at a manual break inside it", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "problem",
            id: "problem_full_span_split",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [
              richParagraph("full_span_split_prompt_1", "前半"),
              { ...richParagraph("full_span_split_prompt_2", "後半"), pagination: { break: true } },
            ],
            solution: [],
            hints: [],
            areaLayout: { prompt: { columnSpan: "full" } },
          },
        ], shortTwoColumnPageLayout())}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    // The manual break makes the full-span area flow instead of staying atomic;
    // each fragment still renders as a full-span block (outside the columns).
    expect(previewHtml).toContain('data-problem-area-fragment="first"');
    expect(previewHtml).toContain('data-problem-area-fragment="last"');
    const fullSpanBlockCount = previewHtml.split('class="print-page-full-span-block"').length - 1;
    expect(fullSpanBlockCount).toBeGreaterThanOrEqual(2);
  });

  it("carries a split problem area's remaining min-height on its final fragments and counts trailing pages", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "problem",
            id: "problem_split_min_height",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [],
            solution: Array.from({ length: 6 }, (_, index) => (
              richParagraph(`split_min_height_${index + 1}`, `解答欄 ${index + 1}`)
            )),
            hints: [],
            areaLayout: { solution: { minHeightMm: 180 } },
          },
        ], shortTwoColumnPageLayout())}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    expect(previewHtml).toContain('data-problem-area-fragment="first"');
    expect(previewHtml).toContain('data-problem-area-fragment="last"');
    expect(sectionTagContaining(previewHtml, 'data-problem-area-fragment="first"')).not.toContain("min-height");
    expect(sectionTagContaining(previewHtml, 'data-problem-area-fragment="last"')).toContain("min-height");
    expect(renderedPageColumns(html).length).toBeGreaterThan(1);
  });

  it("renders an empty problem-area reservation as page-spanning fragments", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [{
          type: "problem",
          id: "empty_page_spanning_reservation",
          tags: [],
          numbering: { enabled: false },
          lead: [],
          prompt: [],
          solution: [],
          hints: [],
          areaLayout: { solution: { minHeightMm: 180 } },
        }], {
          ...shortTwoColumnPageLayout(),
          flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        })}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    expect(previewHtml).toContain('data-print-preview-page-count="3"');
    expect(previewHtml).toContain('data-problem-area-fragment="first"');
    expect(previewHtml).toContain('data-problem-area-fragment="middle"');
    expect(previewHtml).toContain('data-problem-area-fragment="last"');
    expect(previewHtml).toContain("print-problem-area-reservation-only");
  });

  it("flows a tall unframed problem area across one-column page boundaries", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [
          paragraph("before_one_column_problem", "問題前の本文"),
          {
            type: "problem",
            id: "problem_one_column_flow",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [],
            solution: Array.from({ length: 5 }, (_, index) => (
              richParagraph(`one_column_solution_${index + 1}`, `解答 ${index + 1}`)
            )),
            hints: [],
          },
        ], {
          ...shortTwoColumnPageLayout(),
          flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        })}
        profile="teacher"
      />,
    );

    expect(renderedPageColumns(html)).toEqual([
      [[
        "before_one_column_problem",
        "one_column_solution_1",
        "one_column_solution_2",
        "one_column_solution_3",
        "one_column_solution_4",
      ]],
      [["one_column_solution_5"]],
    ]);
  });

  it("renders full-span problem prompts above n-column solution content", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "problem",
            id: "problem_full_prompt",
            tags: [],
            lead: [],
            prompt: [richParagraph("prompt_body", "問題文")],
            solution: [richParagraph("solution_body", "解答")],
            hints: [],
            areaLayout: {
              prompt: { columnSpan: "full" },
            },
          },
          paragraph("p_tail", "tail"),
        ])}
        profile="teacher"
      />,
    );

    const previewHtml = html.split('<div class="print-measure-layer"')[0] ?? html;
    const fullSpanIndex = previewHtml.indexOf('class="print-page-full-span-block"');
    const columnsIndex = previewHtml.indexOf('class="print-page-columns"', fullSpanIndex);

    expect(fullSpanIndex).toBeGreaterThanOrEqual(0);
    expect(columnsIndex).toBeGreaterThan(fullSpanIndex);
    expect(previewHtml.indexOf('data-sigma-doc-id="prompt_body"')).toBeGreaterThan(fullSpanIndex);
    expect(previewHtml.indexOf('data-sigma-doc-id="prompt_body"')).toBeLessThan(columnsIndex);
    expect(previewHtml.indexOf('data-sigma-doc-id="solution_body"')).toBeGreaterThan(columnsIndex);
    expect(previewHtml.indexOf('data-sigma-doc-id="p_tail"')).toBeGreaterThan(columnsIndex);
  });

  it("splits oversized box blocks into print fragments across pages", () => {
    const note = createBoxBlock("tcolorbox-note", "", {
      id: "split_note_box",
      bodyId: "split_note_body_1",
    });
    note.blocks = Array.from({ length: 18 }, (_, index) => (
      richParagraph(`split_note_body_${index + 1}`, `ノート本文 ${index + 1}`)
    ));

    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [note], {
          preset: "custom",
          orientation: "portrait",
          pageSize: { widthMm: 96, heightMm: 72 },
          marginsMm: { top: 8, right: 8, bottom: 8, left: 8 },
          flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        })}
        profile="teacher"
      />,
    );
    const previewHtml = html.split('<div class="print-measure-layer"')[0] ?? html;
    const pageColumns = renderedPageColumns(html);
    const renderedNoteBodyIds = pageColumns.flat(2).filter((id) => id.startsWith("split_note_body_"));

    expect(pageColumns.length).toBeGreaterThan(1);
    expect(previewHtml).toContain('data-box-fragment="first"');
    expect(previewHtml).toContain('data-box-fragment="last"');
    expect(renderedNoteBodyIds).toContain("split_note_body_1");
    expect(renderedNoteBodyIds).toContain("split_note_body_18");
  });

  it("renders a manual column break inside a multi-column layout in a box without forcing a box fragment", () => {
    const note = createBoxBlock("tcolorbox-note", "", {
      id: "box_manual_break_note",
      bodyId: "box_manual_break_body_1",
    });
    note.blocks = [{
      type: "layoutSection",
      id: "box_manual_break_columns",
      layout: { columnCount: 2, columnGapMm: 4 },
      children: [
        richParagraph("box_manual_break_body_1", "改段の前"),
        {
          ...richParagraph("box_manual_break_body_2", "改段の後"),
          pagination: { break: true as const },
        },
      ],
    }];

    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [note], {
          preset: "custom",
          orientation: "portrait",
          pageSize: { widthMm: 96, heightMm: 140 },
          marginsMm: { top: 8, right: 8, bottom: 8, left: 8 },
          flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        })}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    expect(previewHtml).toContain("print-independent-columns");
    expect(previewHtml).toContain("grid-template-columns:minmax(0, 5000fr) minmax(0, 5000fr)");
    expect(previewHtml).toContain("column-gap:4mm");
    expect(previewHtml.match(/class="print-layout-section-column"/g)).toHaveLength(2);
    expect(previewHtml).not.toContain("data-box-fragment=");
    expect(previewHtml).toContain('data-sigma-doc-id="box_manual_break_body_1"');
    expect(previewHtml).toContain('data-sigma-doc-id="box_manual_break_body_2"');
  });

  it("keeps a box whole when it fits the available page height", () => {
    const note = createBoxBlock("tcolorbox-note", "", {
      id: "box_no_break_note",
      bodyId: "box_no_break_body_1",
    });
    note.blocks = [
      richParagraph("box_no_break_body_1", "本文 1"),
      richParagraph("box_no_break_body_2", "本文 2"),
    ];

    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [note], {
          preset: "custom",
          orientation: "portrait",
          pageSize: { widthMm: 96, heightMm: 140 },
          marginsMm: { top: 8, right: 8, bottom: 8, left: 8 },
          flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        })}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    expect(previewHtml).not.toContain("data-box-fragment=");
  });

  it("moves a keepTogether box instead of splitting it across pages", () => {
    const note = createBoxBlock("tcolorbox-note", "", {
      id: "keep_together_note",
      bodyId: "keep_together_body_1",
    });
    note.pagination = { keepTogether: true };
    note.blocks = [
      richParagraph("keep_together_body_1", "本文 1"),
      richParagraph("keep_together_body_2", "本文 2"),
    ];
    const filler = Array.from({ length: 4 }, (_, index) => (
      paragraph(`keep_together_filler_${index + 1}`, `前置き ${index + 1}`)
    ));

    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [...filler, note], {
          ...shortTwoColumnPageLayout(),
          flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        })}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    expect(renderedPageColumns(html)).toEqual([
      [filler.map((block) => block.id)],
      [["keep_together_note", "keep_together_body_1", "keep_together_body_2"]],
    ]);
    expect(previewHtml).not.toContain("data-box-fragment=");
  });

  it("pixel-slices a standalone block taller than a whole page across pages", () => {
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [
          richParagraph("tall_para_intro", "導入"),
          richParagraph("tall_para", `非常に長い段落。${"ページの高さを超える本文がここに続きます。".repeat(60)}`),
        ], {
          preset: "custom",
          orientation: "portrait",
          pageSize: { widthMm: 96, heightMm: 72 },
          marginsMm: { top: 8, right: 8, bottom: 8, left: 8 },
          flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        })}
        profile="teacher"
      />,
    );
    const previewHtml = html.split('<div class="print-measure-layer"')[0] ?? html;
    const pageColumns = renderedPageColumns(html);
    const sliceRoles = [...previewHtml.matchAll(/data-block-slice="([^"]+)"/g)].map((m) => m[1]);

    expect(pageColumns.length).toBeGreaterThan(1);
    expect(sliceRoles).toContain("first");
    expect(sliceRoles).toContain("last");
    expect(previewHtml).toContain('data-block-source-id="tall_para"');
  });

  it("pixel-slices a box whose single child is taller than a column", () => {
    const note = createBoxBlock("tcolorbox-note", "", {
      id: "giant_child_box",
      bodyId: "giant_child_body",
    });
    note.blocks = [
      richParagraph("giant_child_body", `巨大な単一の子。${"区切れない長い本文が延々と続きます。".repeat(60)}`),
    ];

    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [note], {
          preset: "custom",
          orientation: "portrait",
          pageSize: { widthMm: 96, heightMm: 72 },
          marginsMm: { top: 8, right: 8, bottom: 8, left: 8 },
          flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        })}
        profile="teacher"
      />,
    );
    const previewHtml = html.split('<div class="print-measure-layer"')[0] ?? html;
    const pageColumns = renderedPageColumns(html);
    const sliceRoles = [...previewHtml.matchAll(/data-block-slice="([^"]+)"/g)].map((m) => m[1]);

    expect(pageColumns.length).toBeGreaterThan(1);
    expect(sliceRoles).toContain("first");
    expect(sliceRoles).toContain("last");
    expect(previewHtml).toContain('data-block-source-id="giant_child_box"');
  });

  it("honors a manual break on a layout section child that would otherwise fit one column", () => {
    // The section fits a column and holds no box, so print used to keep it atomic and
    // drop the child's break — while the editor always flows a section that carries a
    // manual break (hasManualColumnBreak). Print must follow the editor.
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "layoutSection",
            id: "layout_section_manual_break",
            layout: { columnCount: 2, columnGapMm: 6 },
            children: [
              richParagraph("layout_manual_break_first", "改段の前"),
              {
                ...richParagraph("layout_manual_break_second", "改段の後"),
                pagination: { break: true },
              },
            ],
          },
        ], shortTwoColumnPageLayout())}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);

    // Going through the breakable path at all is what makes the child break reachable:
    // atomic placement renders the section as CSS multicol, where break is inert.
    expect(previewHtml).toContain("print-layout-section-fragment");

    // Inside the section, the break moves the child to the section's next column.
    const sectionColumns = previewHtml
      .split('<div class="print-layout-section-column"')
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf("</div>")));
    const columnOfFirst = sectionColumns.findIndex((chunk) => chunk.includes("layout_manual_break_first"));
    const columnOfSecond = sectionColumns.findIndex((chunk) => chunk.includes("layout_manual_break_second"));
    expect(columnOfFirst).toBeGreaterThanOrEqual(0);
    expect(columnOfSecond).toBeGreaterThan(columnOfFirst);
  });

  it("reserves frame chrome height when fitting a split framed problem area", () => {
    // A framed fragment draws its own border+padding, so its box is taller than the sum
    // of its blocks. If pagination ignored that, the blocks below a manual break would be
    // packed into a column that cannot actually hold them once the frame is drawn.
    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(2, [
          {
            type: "problem",
            id: "problem_framed_chrome",
            tags: [],
            numbering: { enabled: false },
            lead: [],
            prompt: [
              richParagraph("framed_chrome_1", "枠内 1"),
              { ...richParagraph("framed_chrome_2", "枠内 2"), pagination: { break: true } },
              richParagraph("framed_chrome_3", "枠内 3"),
            ],
            solution: [],
            hints: [],
            frame: { enabled: true, styleId: "cornerbox" },
          },
        ], shortTwoColumnPageLayout())}
        profile="teacher"
      />,
    );
    const previewHtml = renderedPreviewHtml(html);
    const columns = renderedPageColumns(html)
      .flat()
      .map((column) => column.filter((id) => id.startsWith("framed_chrome_")));

    // cornerbox has the largest padding (6.4mm top+bottom), so its chrome is what most
    // easily pushes a fragment past a column bottom.
    expect(previewHtml).toContain('data-problem-frame-style="cornerbox"');
    const columnOfFirst = columns.findIndex((ids) => ids.includes("framed_chrome_1"));
    const columnOfSecond = columns.findIndex((ids) => ids.includes("framed_chrome_2"));
    expect(columnOfFirst).toBeGreaterThanOrEqual(0);
    expect(columnOfSecond).toBeGreaterThan(columnOfFirst);
    // Every block still renders — reserving chrome must not drop content.
    expect(columns.flat()).toEqual(
      expect.arrayContaining(["framed_chrome_1", "framed_chrome_2", "framed_chrome_3"]),
    );
  });

  it("splits oversized box blocks inside layout sections into print fragments", () => {
    const note = createBoxBlock("tcolorbox-note", "", {
      id: "layout_split_note_box",
      bodyId: "layout_split_note_body_1",
    });
    note.blocks = Array.from({ length: 18 }, (_, index) => (
      richParagraph(`layout_split_note_body_${index + 1}`, `段組みノート本文 ${index + 1}`)
    ));

    const html = renderToStaticMarkup(
      <PrintPreview
        document={documentWithColumns(1, [
          {
            type: "layoutSection",
            id: "layout_section_with_split_box",
            layout: { columnCount: 2, columnGapMm: 6 },
            children: [
              richParagraph("layout_split_intro", "段組み内の導入文"),
              note,
            ],
          },
        ], {
          preset: "custom",
          orientation: "portrait",
          pageSize: { widthMm: 96, heightMm: 72 },
          marginsMm: { top: 8, right: 8, bottom: 8, left: 8 },
          flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        })}
        profile="teacher"
      />,
    );
    const previewHtml = html.split('<div class="print-measure-layer"')[0] ?? html;
    const pageColumns = renderedPageColumns(html);
    const renderedNoteBodyIds = pageColumns.flat(2).filter((id) => id.startsWith("layout_split_note_body_"));

    expect(pageColumns.length).toBeGreaterThan(1);
    expect(previewHtml).toContain('data-layout-section-fragment="first"');
    expect(previewHtml).toContain('data-layout-section-fragment="last"');
    expect(previewHtml).toContain('data-box-source-id="layout_split_note_box"');
    expect(previewHtml).toContain('data-box-fragment="first"');
    expect(previewHtml).toContain('data-box-fragment="last"');
    expect(renderedNoteBodyIds).toContain("layout_split_note_body_1");
    expect(renderedNoteBodyIds).toContain("layout_split_note_body_18");
  });
});

function thumbnailDocument(): SigmaDocument {
  return documentWithColumns(1, [
    {
      type: "heading",
      id: "thumbnail_heading",
      level: 2,
      children: [
        { type: "text", text: "二次関数の確認" },
        { type: "mathInline", id: "thumbnail_math", tex: "y=ax^2", display: "inline" },
      ],
    },
    paragraph("thumbnail_body", "グラフの形と係数の関係を確認する。"),
    ...Array.from({ length: 80 }, (_, index) => (
      paragraph(`thumbnail_tail_${index}`, `追加問題 ${index + 1}`)
    )),
  ], {
    preset: "B5",
    orientation: "portrait",
    pageSize: { widthMm: 182, heightMm: 257 },
    marginsMm: { top: 18, right: 16, bottom: 18, left: 16 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
  });
}

function documentWithColumns(
  columnCount: number,
  content: SigmaBlock[],
  pageLayout?: SigmaDocument["pageLayout"],
): SigmaDocument {
  return {
    ...document,
    docId: `doc_print_preview_columns_${columnCount}`,
    metadata: {
      title: "段組み改ページ検証",
    },
    content,
    pageLayout: pageLayout ?? {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 17, bottom: 18, left: 17 },
      flow: { type: "columns", columnCount, columnGapMm: 8 },
    },
  };
}

function shortTwoColumnPageLayout(): NonNullable<SigmaDocument["pageLayout"]> {
  return {
    preset: "custom",
    orientation: "portrait",
    pageSize: { widthMm: 80, heightMm: 90 },
    marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
  };
}

function paragraph(
  id: string,
  text: string,
  options: Pick<SigmaBlock, "pagination"> = {},
): SigmaBlock {
  return {
    type: "paragraph",
    id,
    pagination: options.pagination,
    children: [{ type: "text", text }],
  };
}

function richParagraph(id: string, text: string) {
  return {
    type: "paragraph" as const,
    id,
    children: [{ type: "text" as const, text }],
  };
}

function renderedPageColumns(html: string): string[][][] {
  const previewHtml = renderedPreviewHtml(html);
  const pageChunks = previewHtml.split(/<section class="print-a4-page"[^>]*>/).slice(1);

  return pageChunks.map((pageHtml) => {
    const columnsStart = pageHtml.indexOf('<div class="print-page-columns">');
    if (columnsStart < 0) {
      return [];
    }

    return pageHtml
      .slice(columnsStart)
      .split('<div class="print-page-column">')
      .slice(1)
      .map((columnHtml) => (
        [...columnHtml.matchAll(/data-sigma-doc-id="([^"]+)"/g)].map((idMatch) => idMatch[1])
      ));
  });
}

function renderedPreviewHtml(html: string): string {
  return html.split('<div class="print-measure-layer"')[0] ?? html;
}

/** The opening `<section ...>` tag containing the given marker attribute, so a
 * test can assert on that one fragment's classes without matching a sibling's. */
function sectionTagContaining(html: string, marker: string): string {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    return "";
  }
  const start = html.lastIndexOf("<section", markerIndex);
  const end = html.indexOf(">", markerIndex);
  return html.slice(start, end + 1);
}

describe("paginateMeasuredPrintBlocks keeps a block whose only overflow is its space below", () => {
  /**
   * 紙面のページ割りは本文フロー (`pagination-decisions.ts`) と同じ規約でなければならない:
   * 収まり判定から末尾のブロック下余白を除き、カーソル前進には含める。ここが揃っていないと、
   * 同じ文書をエディタと印刷プレビュー/埋め込みビューアで開いたときに改ページ位置だけが食い違う。
   */
  function unit(id: string, spaceAfterPx?: number): PrintContentUnit {
    return {
      type: "block",
      id,
      block: {
        type: "paragraph",
        id,
        children: [{ type: "text", text: id }],
        ...(spaceAfterPx ? { spaceAfterPx } : {}),
      },
    };
  }

  function paginate(units: PrintContentUnit[], heights: number[]) {
    return paginateMeasuredPrintBlocks(units, heights, heights, 1, 1000, 0, new Map(), 8);
  }

  it("leaves the block on its page and sends the next one over", () => {
    const pages = paginate(
      [unit("a"), unit("b", 100), unit("c")],
      [900, 150, 100],
    );

    expect(pages.map((page) => page.blocks.map((block) => block.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("moves the same block over once its own content does not fit", () => {
    const pages = paginate(
      [unit("a"), unit("b", 100), unit("c")],
      [900, 250, 100],
    );

    expect(pages.map((page) => page.blocks.map((block) => block.id))).toEqual([["a"], ["b", "c"]]);
  });

  it("is unchanged for a document without the field", () => {
    const pages = paginate([unit("a"), unit("b"), unit("c")], [900, 150, 100]);

    expect(pages.map((page) => page.blocks.map((block) => block.id))).toEqual([["a"], ["b", "c"]]);
  });

  it("excludes the following block's trailing space from keep-with-next fitting", () => {
    const heading = unit("heading");
    heading.pagination = { keepWithNext: true };
    const units = [unit("filler"), heading, unit("body", 20)];
    const run = () => paginate(units, [70, 20, 30]);

    const first = run();
    expect(first.map((page) => page.blocks.map((block) => block.id))).toEqual([["filler", "heading", "body"]]);
    expect(run()).toEqual(first);
  });
});

describe("paginateMeasuredPrintBlocks problem-area reservations and nested sections", () => {
  function problemArea(
    id: string,
    area: "lead" | "prompt" | "solution",
    blocks: Extract<PrintContentUnit, { type: "problemArea" }>["blocks"],
    options: { hasFrame?: boolean; minHeightMm?: number; columnSpan?: "column" | "full" } = {},
  ): Extract<PrintContentUnit, { type: "problemArea" }> {
    return {
      type: "problemArea",
      id,
      problemId: `${id}:problem`,
      area,
      blocks,
      minHeightMm: options.minHeightMm,
      numberFontSize: 12,
      hasFrame: options.hasFrame ?? false,
      columnSpan: options.columnSpan,
      isFirstProblemArea: true,
      isLastProblemArea: true,
      isFirstProblemFrameArea: options.hasFrame ?? false,
      isLastProblemFrameArea: options.hasFrame ?? false,
    };
  }

  function measured(entries: Record<string, number>): Map<string, number> {
    return new Map(Object.entries(entries));
  }

  function paginateTwice(
    units: PrintContentUnit[],
    heights: number[],
    descendantHeights: Map<string, number>,
    columnCount = 1,
  ) {
    const run = () => paginateMeasuredPrintBlocks(
      units,
      heights,
      heights,
      columnCount,
      100,
      0,
      descendantHeights,
      8,
    );
    const first = run();
    expect(run()).toEqual(first);
    return first;
  }

  it("keeps a problem lead with the following framed prompt on the same page", () => {
    const lead = problemArea("lead_keep_lead", "lead", [richParagraph("lead_keep_number", "1")]);
    const prompt = problemArea(
      "lead_keep_prompt",
      "prompt",
      [richParagraph("lead_keep_prompt_block", "prompt")],
      { hasFrame: true },
    );
    lead.problemId = "lead_keep_problem";
    prompt.problemId = "lead_keep_problem";
    prompt.isFirstProblemArea = false;

    const pages = paginateTwice(
      [
        { type: "block", id: "lead_keep_filler", block: richParagraph("lead_keep_filler", "filler") },
        lead,
        prompt,
      ],
      [70, 20, 40],
      measured({ lead_keep_number: 20, lead_keep_prompt_block: 40 }),
    );

    expect(pages.map((page) => page.blocks.map((block) => block.id))).toEqual([
      ["lead_keep_filler"],
      ["lead_keep_lead:area-fragment:0", "lead_keep_prompt:area-fragment:0"],
    ]);
  });

  it("keeps a problem lead on the page where its full-span prompt starts", () => {
    const lead = problemArea("full_lead_keep_lead", "lead", [richParagraph("full_lead_number", "1")]);
    const prompt = problemArea(
      "full_lead_keep_prompt",
      "prompt",
      [richParagraph("full_lead_prompt_block", "prompt")],
      { columnSpan: "full" },
    );
    lead.problemId = "full_lead_keep_problem";
    prompt.problemId = "full_lead_keep_problem";
    prompt.isFirstProblemArea = false;

    const pages = paginateTwice(
      [
        { type: "block", id: "full_lead_filler", block: richParagraph("full_lead_filler", "filler") },
        lead,
        prompt,
      ],
      [70, 20, 40],
      measured({ full_lead_number: 20, full_lead_prompt_block: 40 }),
    );

    expect(pages.map((page) => page.blocks.map((block) => block.id))).toEqual([
      ["full_lead_filler"],
      ["full_lead_keep_lead:area-fragment:0", "full_lead_keep_prompt"],
    ]);
  });

  it("automatically fragments a framed area taller than one page", () => {
    const blocks = [
      richParagraph("auto_frame_1", "first"),
      richParagraph("auto_frame_2", "second"),
      richParagraph("auto_frame_3", "third"),
    ];
    const pages = paginateTwice(
      [problemArea("auto_frame", "prompt", blocks, { hasFrame: true })],
      [120],
      measured({ auto_frame_1: 40, auto_frame_2: 40, auto_frame_3: 40 }),
    );
    const fragments = pages.flatMap((page) => page.columns.flatMap((column) => column.blocks))
      .filter((unit): unit is Extract<PrintContentUnit, { type: "problemAreaFragment" }> => (
        unit.type === "problemAreaFragment"
      ));

    expect(fragments.length).toBeGreaterThanOrEqual(2);
    expect(fragments[0].fragmentRole).toBe("first");
    expect(fragments.at(-1)?.fragmentRole).toBe("last");
    for (const fragment of fragments) {
      const contentHeight = fragment.blocks.reduce(
        (height, block) => height + (block.id.startsWith("auto_frame_") ? 40 : 0),
        0,
      );
      expect(fragment.estimatedHeightPx - contentHeight).toBeCloseTo(
        getPrintProblemFrameFragmentChromeHeightMm(undefined, fragment.fragmentRole) * MM_TO_PX,
        5,
      );
    }
  });

  it("keeps every slice of one over-tall framed child inside framed area fragments", () => {
    const child = richParagraph("single_tall_framed_child", "one long paragraph");
    const breakOffsets = new Map([[child.id, [40, 80, 120, 160, 200]]]);
    const run = () => paginateMeasuredPrintBlocks(
      [problemArea("single_tall_framed_area", "prompt", [child], { hasFrame: true })],
      [240],
      [240],
      1,
      100,
      0,
      measured({ [child.id]: 240 }),
      8,
      breakOffsets,
    );

    const pages = run();
    expect(run()).toEqual(pages);
    const fragments = pages.flatMap((page) => page.columns.flatMap((column) => column.blocks))
      .filter((unit): unit is Extract<PrintContentUnit, { type: "problemAreaFragment" }> => (
        unit.type === "problemAreaFragment"
      ));

    expect(fragments.length).toBeGreaterThanOrEqual(3);
    expect(fragments.every((fragment) => fragment.hasFrame && fragment.blockSlice !== undefined)).toBe(true);
    expect(fragments.map((fragment) => fragment.fragmentRole)).toEqual([
      "first",
      ...Array.from({ length: fragments.length - 2 }, () => "middle" as const),
      "last",
    ]);
    expect(fragments.every((fragment) => fragment.estimatedHeightPx <= 100.5)).toBe(true);
    expect(fragments.slice(1).every((fragment) => breakOffsets.get(child.id)?.includes(
      fragment.blockSlice?.sliceTop ?? -1,
    ))).toBe(true);
  });

  it("fragments when frame chrome alone pushes a fitting child over page capacity", () => {
    const child = richParagraph("chrome_boundary_child", "frame boundary");
    const pages = paginateMeasuredPrintBlocks(
      [problemArea("chrome_boundary_area", "prompt", [child], { hasFrame: true })],
      [110],
      [110],
      1,
      100,
      0,
      measured({ [child.id]: 95 }),
      8,
      new Map([[child.id, [50]]]),
    );
    const fragments = pages.flatMap((page) => page.columns.flatMap((column) => column.blocks))
      .filter((unit): unit is Extract<PrintContentUnit, { type: "problemAreaFragment" }> => (
        unit.type === "problemAreaFragment"
      ));

    expect(fragments).toHaveLength(2);
    expect(fragments.every((fragment) => fragment.estimatedHeightPx <= 100.5)).toBe(true);
    expect(fragments.reduce((height, fragment) => height + (fragment.blockSlice?.sliceHeight ?? 0), 0)).toBe(95);
  });

  it("uses fixed page and slice budgets for malicious measured heights", () => {
    const child = richParagraph("budgeted_tall_child", "bounded remainder");
    const pages = paginateMeasuredPrintBlocks(
      [problemArea("budgeted_tall_area", "prompt", [child], { hasFrame: true })],
      [1_000_010],
      [1_000_010],
      1,
      100,
      0,
      measured({ [child.id]: 1_000_000 }),
      8,
    );
    const slices = pages.flatMap((page) => page.columns.flatMap((column) => column.blocks))
      .flatMap((unit) => unit.type === "problemAreaFragment" && unit.blockSlice ? [unit.blockSlice] : []);

    expect(pages.length).toBeLessThanOrEqual(1_000);
    expect(slices).toHaveLength(1_000);
    expect(slices.reduce((height, slice) => height + slice.sliceHeight, 0)).toBe(1_000_000);
    expect(slices.at(-1)?.sliceHeight).toBeGreaterThan(100);
  });

  it("keeps a fitting framed area atomic and moves it whole", () => {
    const filler = paragraph("before_fitting_frame", "before");
    const framed = problemArea(
      "fitting_frame",
      "prompt",
      [richParagraph("fitting_frame_block", "prompt")],
      { hasFrame: true },
    );
    const pages = paginateTwice(
      [{ type: "block", id: filler.id, block: filler }, framed],
      [30, 90],
      measured({ before_fitting_frame: 30, fitting_frame_block: 70 }),
    );

    expect(pages[0].columns[0].blocks.map((unit) => unit.id)).toEqual([filler.id]);
    expect(pages[1].columns[0].blocks).toEqual([expect.objectContaining({
      type: "problemAreaFragment",
      sourceId: framed.id,
      fragmentRole: "single",
      hasFrame: true,
      blocks: framed.blocks,
    })]);
  });

  it("automatically fragments a full-span area taller than one page", () => {
    const blocks = [
      richParagraph("auto_full_1", "first"),
      richParagraph("auto_full_2", "second"),
    ];
    const pages = paginateTwice(
      [problemArea("auto_full", "prompt", blocks, { columnSpan: "full" })],
      [120],
      measured({ auto_full_1: 60, auto_full_2: 60 }),
      2,
    );
    const fragments = pages.flatMap((page) => page.columns[0].blocks)
      .filter((unit): unit is Extract<PrintContentUnit, { type: "problemAreaFragment" }> => (
        unit.type === "problemAreaFragment"
      ));

    expect(fragments).toHaveLength(2);
    expect(fragments.map((fragment) => fragment.fragmentRole)).toEqual(["first", "last"]);
    expect(pages).toHaveLength(2);
  });

  it("uses the starting column remainder for the first nested-section fragment", () => {
    const children = Array.from({ length: 8 }, (_, index) => richParagraph(`nested_remainder_${index + 1}`, "段内"));
    const section = {
      type: "layoutSection" as const,
      id: "nested_remainder_section",
      layout: { columnCount: 2, columnGapMm: 4 },
      children,
    };
    const filler = paragraph("nested_remainder_filler", "前置き");
    const units: PrintContentUnit[] = [
      { type: "block", id: filler.id, block: filler },
      problemArea("nested_remainder_area", "solution", [section]),
    ];
    const heights = measured({
      nested_remainder_section: 160,
      ...Object.fromEntries(children.map((child) => [child.id, 20])),
    });
    const pages = paginateTwice(units, [40, 160], heights, 2);
    const firstAreaFragment = pages[0].columns[0].blocks.find(
      (unit): unit is Extract<PrintContentUnit, { type: "problemAreaFragment" }> => unit.type === "problemAreaFragment",
    );
    const firstNestedIds = firstAreaFragment?.layoutSectionFragment?.columns
      .flatMap((column) => column.blocks.map((unit) => unit.id));

    expect(firstNestedIds).toHaveLength(6);
    expect(pages[0].columns[0].estimatedContentHeightPx).toBeLessThanOrEqual(100);
  });

  it("line-slices one over-tall paragraph inside a top-level two-column section", () => {
    const tall = richParagraph("top_nested_tall", "一つの長い段落");
    const tail = richParagraph("top_nested_tail", "後続段落");
    const section = {
      type: "layoutSection" as const,
      id: "top_nested_section",
      layout: { columnCount: 2, columnGapMm: 4 },
      children: [tall, tail],
    };
    const breakOffsets = new Map([[tall.id, [40, 80, 120]]]);
    const run = () => paginateMeasuredPrintBlocks(
      [{ type: "block", id: section.id, block: section }],
      [150],
      [150],
      1,
      100,
      0,
      measured({
        top_nested_section: 150,
        top_nested_tall: 130,
        top_nested_tail: 20,
      }),
      8,
      breakOffsets,
    );

    const pages = run();
    expect(run()).toEqual(pages);
    const fragment = pages[0].columns[0].blocks.find(
      (unit): unit is Extract<PrintContentUnit, { type: "layoutSectionFragment" }> => (
        unit.type === "layoutSectionFragment"
      ),
    );
    const nested = fragment?.columns.flatMap((column) => column.blocks) ?? [];
    const slices = nested.filter(
      (unit): unit is Extract<PrintContentUnit, { type: "blockSlice" }> => unit.type === "blockSlice",
    );

    expect(slices.map((slice) => [slice.sliceTop, slice.sliceHeight, slice.fragmentRole])).toEqual([
      [0, 80, "first"],
      [80, 50, "last"],
    ]);
    expect(nested.at(-1)?.id).toBe(tail.id);
    expect(fragment && renderToStaticMarkup(
      <PrintLayoutSectionFragment unit={fragment} />,
    )).toContain('data-block-source-id="top_nested_tall"');
  });

  it("line-slices one over-tall paragraph inside a solution two-column section", () => {
    const tall = richParagraph("solution_nested_tall", "解答内の長い段落");
    const tail = richParagraph("solution_nested_tail", "解答内の後続段落");
    const section = {
      type: "layoutSection" as const,
      id: "solution_nested_section",
      layout: { columnCount: 2, columnGapMm: 4 },
      children: [tall, tail],
    };
    const breakOffsets = new Map([[tall.id, [40, 80, 120]]]);
    const run = () => paginateMeasuredPrintBlocks(
      [problemArea("solution_nested_area", "solution", [section])],
      [150],
      [150],
      1,
      100,
      0,
      measured({
        solution_nested_section: 150,
        solution_nested_tall: 130,
        solution_nested_tail: 20,
      }),
      8,
      breakOffsets,
    );

    const pages = run();
    expect(run()).toEqual(pages);
    const areaFragments = pages.flatMap((page) => page.columns.flatMap((column) => column.blocks))
      .filter((unit): unit is Extract<PrintContentUnit, { type: "problemAreaFragment" }> => (
        unit.type === "problemAreaFragment"
      ));
    const nested = areaFragments.flatMap((fragment) => (
      fragment.layoutSectionFragment?.columns.flatMap((column) => column.blocks) ?? []
    ));
    const slices = nested.filter(
      (unit): unit is Extract<PrintContentUnit, { type: "blockSlice" }> => unit.type === "blockSlice",
    );

    expect(slices.map((slice) => [slice.sliceTop, slice.sliceHeight, slice.fragmentRole])).toEqual([
      [0, 80, "first"],
      [80, 50, "last"],
    ]);
    expect(nested.at(-1)?.id).toBe(tail.id);
  });

  it("uses open-edged box fragments inside a two-column section", () => {
    const box = createBoxBlock("itembox", "", {
      id: "nested_print_box",
      bodyId: "nested_print_box_body",
    });
    box.blocks = [
      richParagraph("nested_print_box_1", "枠内一"),
      richParagraph("nested_print_box_2", "枠内二"),
      richParagraph("nested_print_box_3", "枠内三"),
    ];
    const section = {
      type: "layoutSection" as const,
      id: "nested_print_box_section",
      layout: { columnCount: 2, columnGapMm: 4 },
      children: [box],
    };
    const run = () => paginateMeasuredPrintBlocks(
      [{ type: "block", id: section.id, block: section }],
      [159],
      [159],
      1,
      100,
      0,
      measured({
        nested_print_box_section: 159,
        nested_print_box: 159,
        nested_print_box_1: 45,
        nested_print_box_2: 45,
        nested_print_box_3: 45,
      }),
      8,
    );

    const pages = run();
    expect(run()).toEqual(pages);
    const fragments = pages.flatMap((page) => page.columns.flatMap((column) => column.blocks)).filter(
      (unit): unit is Extract<PrintContentUnit, { type: "layoutSectionFragment" }> => (
        unit.type === "layoutSectionFragment"
      ),
    );
    const boxFragments = fragments.flatMap((fragment) => fragment.columns.flatMap((column) => column.blocks))
      .filter((unit): unit is Extract<PrintContentUnit, { type: "boxFragment" }> => unit.type === "boxFragment");

    expect(boxFragments.map((boxFragment) => boxFragment.fragmentRole)).toEqual(["first", "middle", "last"]);
    expect(boxFragments.flatMap((boxFragment) => boxFragment.blocks.map((child) => child.id))).toEqual([
      "nested_print_box_1",
      "nested_print_box_2",
      "nested_print_box_3",
    ]);
    expect(fragments.map((fragment) => renderToStaticMarkup(
      <PrintLayoutSectionFragment unit={fragment} />,
    )).join("")).toContain('data-box-fragment="last"');
  });

  it("moves a keep-with-next pair from a short recursive page to the next full page", () => {
    const heading = {
      ...richParagraph("short_keep_heading", "heading"),
      pagination: { keepWithNext: true },
    };
    const body = richParagraph("short_keep_body", "body");
    const units: PrintContentUnit[] = [
      { type: "block", id: heading.id, block: heading, pagination: heading.pagination },
      { type: "block", id: body.id, block: body },
    ];
    const run = () => paginateMeasuredPrintBlocks(
      units,
      [20, 30],
      [20, 30],
      2,
      100,
      60,
      measured({ short_keep_heading: 20, short_keep_body: 30 }),
      8,
    );

    const first = run();
    expect(first[0].columns.flatMap((column) => column.blocks)).toEqual([]);
    expect(first[1].columns[0].blocks.map((block) => block.id)).toEqual([
      "short_keep_heading",
      "short_keep_body",
    ]);
    expect(run()).toEqual(first);
  });

  it("moves a keep-together nested section before fragmenting it", () => {
    const box = createBoxBlock("itembox", "", { id: "kept_nested_box", bodyId: "kept_nested_body" });
    box.blocks = [richParagraph("kept_nested_body", "枠")];
    const section = {
      type: "layoutSection" as const,
      id: "kept_nested_section",
      layout: { columnCount: 2, columnGapMm: 4 },
      pagination: { keepTogether: true },
      children: [box],
    };
    const filler = paragraph("kept_nested_filler", "前置き");
    const heights = measured({
      kept_nested_section: 40,
      kept_nested_box: 40,
      kept_nested_body: 20,
    });
    const run = () => paginateMeasuredPrintBlocks(
      [
        { type: "block", id: filler.id, block: filler },
        problemArea("kept_nested_area", "solution", [section]),
      ],
      [80, 40],
      [80, 40],
      2,
      100,
      0,
      heights,
      8,
    );

    const first = run();
    expect(first[0].columns[0].blocks.every((unit) => unit.type !== "problemAreaFragment")).toBe(true);
    expect(first[0].columns[1].blocks.some((unit) => unit.type === "problemAreaFragment")).toBe(true);
    expect(run()).toEqual(first);
  });

  it("subtracts framed-fragment chrome from nested-section capacity", () => {
    const children = Array.from({ length: 8 }, (_, index) => richParagraph(`framed_nested_${index + 1}`, "枠内段"));
    const section = {
      type: "layoutSection" as const,
      id: "framed_nested_section",
      layout: { columnCount: 2, columnGapMm: 4 },
      pagination: { break: true as const },
      children,
    };
    const before = richParagraph("framed_nested_before", "枠の前半");
    const heights = measured({
      framed_nested_before: 10,
      framed_nested_section: 360,
      ...Object.fromEntries(children.map((child) => [child.id, 45])),
    });
    const pages = paginateTwice(
      [problemArea("framed_nested_area", "prompt", [before, section], { hasFrame: true })],
      [370],
      heights,
      2,
    );

    expect(pages.flatMap((page) => page.columns).every((column) => column.estimatedContentHeightPx <= 100.5)).toBe(true);
    expect(pages.flatMap((page) => page.oversizedBlockIds)).toEqual([]);
  });

  it("counts frame chrome once when consuming a framed area's min-height", () => {
    const before = richParagraph("framed_reservation_before", "前半");
    const after = {
      ...richParagraph("framed_reservation_after", "後半"),
      pagination: { break: true as const },
    };
    const pages = paginateTwice(
      [problemArea("framed_reservation_area", "prompt", [before, after], {
        hasFrame: true,
        minHeightMm: 100 / (96 / 25.4),
      })],
      [100],
      measured({ framed_reservation_before: 20, framed_reservation_after: 20 }),
      2,
    );
    const occupied = pages.flatMap((page) => page.columns)
      .reduce((height, column) => height + column.estimatedContentHeightPx, 0);

    expect(occupied).toBeCloseTo(100, 5);
  });

  it("excludes the following problem child trailing space from keep-with-next fitting", () => {
    const heading = {
      ...richParagraph("problem_keep_heading", "heading"),
      pagination: { keepWithNext: true },
    };
    const body = {
      ...richParagraph("problem_keep_body", "body"),
      spaceAfterPx: 20,
    };
    const area = problemArea("problem_keep_area", "solution", [
      richParagraph("problem_keep_filler", "filler"),
      heading,
      body,
    ]);
    const heights = measured({
      problem_keep_filler: 70,
      problem_keep_heading: 20,
      problem_keep_body: 30,
    });
    const run = () => paginateMeasuredPrintBlocks(
      [area],
      [120],
      [120],
      2,
      100,
      0,
      heights,
      8,
    );

    const first = run();
    expect(first[0].columns[0].blocks).toHaveLength(1);
    expect(first[0].columns[1].blocks).toHaveLength(0);
    expect(run()).toEqual(first);
  });

  it("splits an empty problem-area reservation across pages", () => {
    const pages = paginateTwice(
      [problemArea("empty_reserved_area", "solution", [], { minHeightMm: 250 / (96 / 25.4) })],
      [250],
      new Map(),
    );

    expect(pages.map((page) => page.columns[0].estimatedContentHeightPx)).toEqual([100, 100, 50]);
    expect(pages.flatMap((page) => page.oversizedBlockIds)).toEqual([]);
  });

  it("moves a fitting boxed problem-area reservation to the next page without splitting it", () => {
    const filler = paragraph("fitting_reservation_filler", "前置き");
    const pages = paginateTwice(
      [
        { type: "block", id: filler.id, block: filler },
        problemArea("fitting_boxed_reservation", "prompt", [], {
          hasFrame: true,
          minHeightMm: 70 / (96 / 25.4),
        }),
      ],
      [50, 70],
      new Map(),
    );
    const areaFragments = pages.flatMap((page) => page.columns[0].blocks)
      .filter((unit): unit is Extract<PrintContentUnit, { type: "problemAreaFragment" }> => (
        unit.type === "problemAreaFragment"
      ));

    expect(pages).toHaveLength(2);
    expect(pages[0].columns[0].blocks.map((unit) => unit.id)).toEqual([filler.id]);
    expect(areaFragments).toHaveLength(1);
    expect(areaFragments[0].fragmentRole).toBe("single");
    expect(areaFragments[0].estimatedHeightPx).toBeCloseTo(70, 5);
  });

  it("splits a boxed problem-area reservation that exceeds a full page", () => {
    const pages = paginateTwice(
      [problemArea("oversized_boxed_reservation", "solution", [], {
        hasFrame: true,
        minHeightMm: 250 / (96 / 25.4),
      })],
      [250],
      new Map(),
    );
    const areaFragments = pages.flatMap((page) => page.columns[0].blocks)
      .filter((unit): unit is Extract<PrintContentUnit, { type: "problemAreaFragment" }> => (
        unit.type === "problemAreaFragment"
      ));

    expect(pages.map((page) => page.columns[0].estimatedContentHeightPx)).toEqual([100, 100, 50]);
    expect(areaFragments).toHaveLength(3);
    expect(areaFragments.map((fragment) => fragment.fragmentRole)).toEqual(["first", "middle", "last"]);
    expect(pages.flatMap((page) => page.oversizedBlockIds)).toEqual([]);
  });

  it("does not loop when a positive reservation has no column capacity", () => {
    const run = () => paginateMeasuredPrintBlocks(
      [problemArea("zero_capacity_reservation", "solution", [], { minHeightMm: 10 })],
      [40],
      [40],
      1,
      0,
      0,
      new Map(),
      8,
    );

    const first = run();
    expect(first).toHaveLength(1);
    expect(first[0].columns[0].estimatedContentHeightPx).toBe(0);
    expect(run()).toEqual(first);
  });
});
