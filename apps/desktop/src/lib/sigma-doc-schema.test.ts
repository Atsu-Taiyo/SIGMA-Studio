import { describe, expect, it } from "vitest";

import { getDocumentIssues, parseSigmaDocument, recoverSigmaDocument } from "@/lib/sigma-doc-schema";
import { ensurePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { ListNode, PageOverlay } from "@/features/document";
import type { SigmaDocument } from "@/types/sigma-doc";

function parenList(): ListNode {
  return {
    type: "list",
    id: "list_paren",
    listType: "ordered",
    markerStyle: "paren",
    items: [{
      type: "listItem",
      id: "li_paren",
      children: [{ type: "text", text: "括弧付き番号" }],
    }],
  };
}

describe("SigmaDoc schema", () => {
  it("preserves external provenance without requiring a format-specific importer", () => {
    const document = {
      ...sampleDocument,
      metadata: {
        ...sampleDocument.metadata,
        source: { format: "external-authoring-tool", originalFileName: "lesson.data" },
      },
    };
    const parsed = parseSigmaDocument(document);
    expect(parsed.metadata.source).toEqual(document.metadata.source);
    expect(parseSigmaDocument(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("preserves a file-scoped TeX preamble", () => {
    const texPreamble = String.raw`\newcommand{\answerbox}[1]{\doubleboxed{#1}}`;
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      metadata: { ...sampleDocument.metadata, texPreamble },
    });

    expect(parsed.metadata.texPreamble).toBe(texPreamble);
  });

  it("refuses a document whose overlay text shape is not in canonical block form", () => {
    const legacyDocument = {
      ...sampleDocument,
      pageLayout: {
        ...sampleDocument.pageLayout,
        overlay: {
          overlaySnapshot: {
            version: 1,
            shapes: [{
              id: "legacy_text",
              type: "text",
              x: 0,
              y: 0,
              props: {
                w: 100,
                richText: { type: "doc", content: [{ type: "mathInline", attrs: { tex: "a+b" } }] },
                autoSize: true,
                color: "black",
                size: "m",
              },
            }],
            assets: {},
          },
        },
      },
    };

    // The schema boundary no longer translates an older content representation on the way in, so
    // the document fails to parse (and the app shows it through the broken-document surface)
    // instead of loading with a shape nothing can draw.
    expect(() => parseSigmaDocument(legacyDocument)).toThrow();
  });

  it("canonicalizes overlay metadata into namespaced extensions at the schema boundary", () => {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      pageLayout: {
        ...sampleDocument.pageLayout,
        overlay: {
          overlaySnapshot: {
            version: 1,
            shapes: [{
              id: "shape_with_meta",
              type: "geo",
              x: 0,
              y: 0,
              meta: { source: "pptx" },
              props: {
                w: 20,
                h: 20,
                geo: "rectangle",
                fill: "none",
                color: "black",
                labelColor: "black",
                dash: "solid",
                size: "m",
                unknown: true,
              },
            }],
            assets: {},
          },
        },
      },
    });
    const snapshot = parsed.pageLayout?.overlay?.overlaySnapshot;

    expect(snapshot?.shapes[0]).not.toHaveProperty("meta");
    expect(snapshot?.shapes[0]?.props).not.toHaveProperty("unknown");
    expect(snapshot?.extensions).toEqual({
      "sigma.legacy.metadata": {
        shapes: {
          shape_with_meta: { source: "pptx" },
        },
      },
    });
  });

  it("accepts the bundled sample document", () => {
    expect(parseSigmaDocument(sampleDocument).version).toBe("2.0");
    expect(getDocumentIssues(sampleDocument)).toEqual([]);
  });

  it("preserves a code-only dark theme and falls unknown values back to light", () => {
    const dark = parseSigmaDocument({
      ...sampleDocument,
      content: [{
        type: "codeBlock",
        id: "code_dark",
        theme: "dark",
        children: [{ type: "text", text: "const answer = 42;" }],
      }],
    });
    const unknown = parseSigmaDocument({
      ...sampleDocument,
      content: [{
        type: "codeBlock",
        id: "code_unknown",
        theme: "sepia",
        children: [{ type: "text", text: "answer = 42" }],
      }],
    });

    expect(dark.content[0]).toMatchObject({ type: "codeBlock", theme: "dark" });
    expect(unknown.content[0]?.type === "codeBlock" ? unknown.content[0].theme : null).toBeUndefined();
  });

  it("preserves the document math fraction sizing metadata", () => {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      metadata: {
        ...sampleDocument.metadata,
        mathFractionSizing: "uniform",
      },
    });

    expect(parsed.metadata.mathFractionSizing).toBe("uniform");
  });

  it("normalizes page layouts in the current document format", () => {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      version: "2.0",
      pageLayout: {
        preset: "A4",
        orientation: "portrait",
        pageSize: { widthMm: 210, heightMm: 297 },
        marginsMm: { top: 18, right: 17, bottom: 18, left: 17 },
      },
    });

    expect(parsed.version).toBe("2.0");
    expect(parsed.pageLayout?.flow).toEqual({ type: "columns", columnCount: 1, columnGapMm: 8 });
  });

  it("accepts an empty whiteboard document and enforces its layout", () => {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      content: [],
      pageLayout: {
        preset: "whiteboard",
        orientation: "portrait",
        pageSize: { widthMm: 400, heightMm: 300 },
        marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
        flow: { type: "columns", columnCount: 3, columnGapMm: 12 },
        header: { enabled: true },
        footer: { enabled: true },
      },
    });

    expect(parsed.pageLayout).toMatchObject({
      preset: "whiteboard",
      pageSize: { widthMm: 400, heightMm: 300 },
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
    });
    expect(parsed.pageLayout?.header).toBeUndefined();
    expect(parsed.pageLayout?.footer).toBeUndefined();
  });

  it("rejects body blocks in a whiteboard document", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      pageLayout: {
        ...ensurePageLayout(sampleDocument).pageLayout!,
        preset: "whiteboard",
      },
    };

    expect(() => parseSigmaDocument(document)).toThrow(
      "無限キャンバス(ホワイトボード)モードの教材には本文ブロックを追加できません",
    );
    expect(getDocumentIssues(document)).toContain(
      "無限キャンバス(ホワイトボード)モードの教材には本文ブロックを追加できません",
    );
  });

  it("rejects page and block anchors in a whiteboard document", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [],
      pageLayout: {
        ...ensurePageLayout({ ...sampleDocument, content: [] }).pageLayout!,
        preset: "whiteboard",
        overlay: {
          overlaySnapshot: {
            version: 1,
            shapes: [{
              id: "anchored_whiteboard_shape",
              type: "geo",
              x: 10,
              y: 20,
              rotation: 0,
              anchor: { type: "page" },
              props: {
                w: 100,
                h: 60,
                geo: "rectangle",
                fill: "none",
                color: "#111111",
                fillColor: "#ffffff",
                labelColor: "#111111",
                dash: "solid",
                size: "m",
              },
            }],
            assets: {},
          },
        },
      },
    };

    expect(() => parseSigmaDocument(document)).toThrow("絶対座標");
    expect(getDocumentIssues(document).some((issue) => issue.includes("絶対座標"))).toBe(true);
  });

  it("rejects old document versions instead of migrating them", () => {
    expect(() => parseSigmaDocument({ ...sampleDocument, version: "1.4" })).toThrow();
    expect(() => parseSigmaDocument({ ...sampleDocument, version: "1.0" })).toThrow();
  });

  it("recovers legacy chapter-model documents by flattening chapters into content", () => {
    const block0 = { ...sampleDocument.content[0], id: "blk_ch_0" };
    const block1 = { ...sampleDocument.content[0], id: "blk_ch_1" };
    const legacy: Record<string, unknown> = {
      ...sampleDocument,
      chapters: [
        { id: "chapter_a", content: [block0] },
        { id: "chapter_b", content: [block1] },
      ],
    };
    delete legacy.content;

    const parsed = parseSigmaDocument(legacy);

    expect(parsed.content.map((block) => block.id)).toEqual(["blk_ch_0", "blk_ch_1"]);
    expect(parsed).not.toHaveProperty("chapters");
  });

  it("accepts justified text alignment", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "paragraph",
          id: "p_justify",
          align: "justify",
          lineHeight: "1.15",
          children: [{ type: "text", text: "両端揃えの本文" }],
        },
      ],
    };

    expect(parseSigmaDocument(document).content[0]).toMatchObject({ type: "paragraph", align: "justify", lineHeight: "1.15" });
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("accepts custom numeric line height multipliers", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "paragraph",
          id: "p_custom_line_height",
          lineHeight: "1.2",
          children: [{ type: "text", text: "行間を数値指定した本文" }],
        },
      ],
    };

    expect(parseSigmaDocument(document).content[0]).toMatchObject({ type: "paragraph", lineHeight: "1.2" });
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("accepts valid nested lists", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "list",
          id: "list_root",
          listType: "ordered",
          start: 2,
          items: [
            {
              type: "listItem",
              id: "li_parent",
              children: [
                { type: "text", text: "太字", marks: ["bold"] },
                { type: "mathInline", id: "m_list", tex: "x^2", display: "inline" },
              ],
              nested: [
                {
                  type: "list",
                  id: "list_nested",
                  listType: "bullet",
                  items: [
                    {
                      type: "listItem",
                      id: "li_child",
                      children: [{ type: "text", text: "下線", marks: ["underline"] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(parseSigmaDocument(document).content[0]).toMatchObject({ type: "list", listType: "ordered" });
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("accepts an ordered list that renders its marker as (1)", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [parenList()],
    };

    expect(parseSigmaDocument(document).content[0]).toMatchObject({
      type: "list",
      listType: "ordered",
      markerStyle: "paren",
    });
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("preserves alignment on an ordered list item", () => {
    const list = parenList();
    list.items[0].align = "center";
    const parsed = parseSigmaDocument({ ...sampleDocument, content: [list] });

    expect((parsed.content[0] as ListNode).items[0].align).toBe("center");
    expect(getDocumentIssues(parsed)).toEqual([]);
  });

  it("preserves independently aligned continuation paragraphs in one list item", () => {
    const list = parenList();
    list.items[0].continuations = [
      { type: "paragraph", id: "li_paren_center", children: [{ type: "text", text: "中央" }], align: "center" },
      { type: "paragraph", id: "li_paren_left", children: [{ type: "text", text: "左" }], align: "left" },
    ];
    const parsed = parseSigmaDocument({ ...sampleDocument, content: [list] });

    expect((parsed.content[0] as ListNode).items[0].continuations).toMatchObject([
      { id: "li_paren_center", align: "center" },
      { id: "li_paren_left", align: "left" },
    ]);
  });

  it("keeps lists without a marker style valid", () => {
    const listWithoutMarkerStyle: ListNode = { ...parenList() };
    delete listWithoutMarkerStyle.markerStyle;
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [listWithoutMarkerStyle],
    };

    expect(parseSigmaDocument(document).content[0]).not.toHaveProperty("markerStyle");
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("rejects an unknown marker style instead of persisting it", () => {
    expect(() =>
      parseSigmaDocument({
        ...sampleDocument,
        content: [{ ...parenList(), markerStyle: "roman" }],
      }),
    ).toThrow();
  });

  it("accepts paragraph-based layout sections with column settings", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "layoutSection",
          id: "layout_section_columns",
          layout: { columnCount: 3, columnGapMm: 6 },
          children: [
            {
              type: "paragraph",
              id: "layout_section_p1",
              children: [{ type: "text", text: "1段目から流す本文" }],
            },
            {
              type: "paragraph",
              id: "layout_section_p2",
              children: [{ type: "mathInline", id: "layout_section_math", tex: "x^2", display: "inline" }],
            },
          ],
        },
      ],
    };

    expect(parseSigmaDocument(document).content[0]).toMatchObject({
      type: "layoutSection",
      layout: { columnCount: 3, columnGapMm: 6 },
    });
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("accepts SigmaDoc-native box blocks with frame decorations", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "boxBlock",
          id: "box_cornerbox_schema",
          styleId: "cornerbox",
          title: [{ type: "text", text: "定理" }],
          frame: {
            borderWidthPx: 0,
            borderColor: "transparent",
            borderStyle: "none",
            titleAlign: "center",
            titlePosition: "c",
            titleFontFamily: "\"Yu Mincho\", serif",
            titleFontWeight: "normal",
            titleFontSizePx: 32,
            titleLineHeight: "1",
            bodyAlign: "left",
            bodyFontFamily: "\"Hiragino Sans\", sans-serif",
            bodyFontSizePx: 15,
            bodyLineHeight: "1.6",
            paddingPx: { top: 26, right: 18, bottom: 24, left: 18 },
            decorations: [
              { type: "titleDoubleRule", ruleWidthPx: 1.2, ruleColor: "#111111", guideColor: "#9ca3af" },
              { type: "cornerSquares", sizePx: 8, color: "#000000" },
            ],
          },
          blocks: [
            {
              type: "paragraph",
              id: "box_cornerbox_schema_body",
              children: [{ type: "text", text: "箱の中身" }],
            },
          ],
        },
      ],
    };

    expect(parseSigmaDocument(document).content[0]).toMatchObject({
      type: "boxBlock",
      styleId: "cornerbox",
      frame: { titlePosition: "c" },
    });
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("accepts a box block with a rich title inside a problem area", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      metadata: {
        ...sampleDocument.metadata,
        styleUnits: {
          ...sampleDocument.metadata.styleUnits,
          fontSize: "pt",
        },
      },
      content: [{
        type: "problem",
        id: "problem_with_box",
        tags: [],
        lead: [],
        prompt: [{
          type: "boxBlock",
          id: "problem_box",
          styleId: "itembox",
          title: [
            {
              type: "text",
              text: "重要",
              marks: ["bold"],
              color: "#dc2626",
              fontFamily: "serif",
              fontSize: 14,
            },
            {
              type: "mathInline",
              id: "problem_box_title_math",
              tex: "x^2",
              display: "inline",
            },
          ],
          blocks: [{
            type: "paragraph",
            id: "problem_box_body",
            children: [{ type: "text", text: "箱の本文" }],
          }],
        }],
        hints: [],
        solution: [],
      }],
    };

    const parsed = parseSigmaDocument(document);
    const problem = parsed.content[0];
    expect(problem?.type).toBe("problem");
    expect(problem?.type === "problem" ? problem.prompt[0] : null).toEqual(
      document.content[0]?.type === "problem"
        ? document.content[0].prompt[0]
        : null,
    );
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("accepts a manual page break directly inside a box", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [{
        type: "boxBlock",
        id: "box_with_direct_break",
        styleId: "itembox",
        blocks: [
          {
            type: "paragraph",
            id: "box_first",
            children: [{ type: "text", text: "前" }],
          },
          {
            type: "paragraph",
            id: "box_direct_break",
            pagination: { break: true },
            children: [{ type: "text", text: "後" }],
          },
        ],
      }],
    };

    expect(parseSigmaDocument(document).content).toEqual(document.content);
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("accepts a manual column break in a multi-column layout inside a box", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [{
        type: "boxBlock",
        id: "box_with_columns",
        styleId: "itembox",
        blocks: [{
          type: "layoutSection",
          id: "box_columns",
          layout: { columnCount: 2, columnGapMm: 8 },
          children: [
            {
              type: "paragraph",
              id: "box_column_first",
              children: [{ type: "text", text: "左" }],
            },
            {
              type: "paragraph",
              id: "box_column_break",
              pagination: { break: true },
              children: [{ type: "text", text: "右" }],
            },
          ],
        }],
      }],
    };

    expect(() => parseSigmaDocument(document)).not.toThrow();
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("accepts a manual break in a one-column layout inside a box", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [{
        type: "boxBlock",
        id: "box_with_one_column",
        styleId: "itembox",
        blocks: [{
          type: "layoutSection",
          id: "box_one_column",
          layout: { columnCount: 1, columnGapMm: 8 },
          children: [
            {
              type: "paragraph",
              id: "box_one_column_first",
              children: [{ type: "text", text: "前" }],
            },
            {
              type: "paragraph",
              id: "box_one_column_break",
              pagination: { break: true },
              children: [{ type: "text", text: "後" }],
            },
          ],
        }],
      }],
    };

    expect(parseSigmaDocument(document).content).toEqual(document.content);
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("rejects unsupported box title positions", () => {
    expect(() =>
      parseSigmaDocument({
        ...sampleDocument,
        content: [{
          type: "boxBlock",
          id: "box_invalid_title_position",
          styleId: "itembox",
          frame: { titlePosition: "center" },
          blocks: [{
            type: "paragraph",
            id: "box_invalid_title_position_body",
            children: [],
          }],
        }],
      }),
    ).toThrow();
  });

  it("accepts notebook box decoration geometry from the official tcolorbox-note material", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "boxBlock",
          id: "box_tcolorbox_note_schema",
          styleId: "tcolorbox-note",
          frame: {
            borderWidthPx: 1,
            borderColor: "#9ca3af",
            borderStyle: "solid",
            backgroundColor: "#ffffff",
            paddingPx: { top: 18, right: 18, bottom: 16, left: 56 },
            decorations: [{
              type: "notebookRules",
              baseBodyWidthPx: 660,
              frameLeftPx: 20,
              frameHeightPx: 350,
              frameStrokeOpacity: 0.85,
              bindingColor: "#b9b3a1",
              bindingWidthPx: 1,
              bindingXPx: 20,
              bindingStrokeOpacity: 0.75,
              ringColor: "#706b5a",
              ringWidthPx: 38,
              ringHeightPx: 12,
              ringStrokePx: 1.2,
              ringGapPx: 23.35,
              ringTopPx: 8,
              ringCount: 15,
              ringLeftOverhangPx: 14,
              minHeightPx: 350,
            }],
          },
          blocks: [
            {
              type: "paragraph",
              id: "box_tcolorbox_note_schema_body",
              children: [],
            },
          ],
        },
      ],
    };

    expect(parseSigmaDocument(document).content[0]).toMatchObject({ type: "boxBlock", styleId: "tcolorbox-note" });
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("rejects invalid layout section column counts", () => {
    expect(() =>
      parseSigmaDocument({
        ...sampleDocument,
        content: [
          {
            type: "layoutSection",
            id: "layout_section_bad_columns",
            layout: { columnCount: 0 },
            children: [{
              type: "paragraph",
              id: "layout_section_bad_p",
              children: [{ type: "text", text: "本文" }],
            }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects invalid list nodes", () => {
    expect(() =>
      parseSigmaDocument({
        ...sampleDocument,
        content: [{ type: "list", id: "list_empty", listType: "bullet", items: [] }],
      }),
    ).toThrow();

    expect(() =>
      parseSigmaDocument({
        ...sampleDocument,
        content: [
          {
            type: "list",
            id: "list_bad_type",
            listType: "check",
            items: [{ type: "listItem", id: "li_bad", children: [] }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects removed mathBlock nodes", () => {
    expect(() =>
      parseSigmaDocument({
        ...sampleDocument,
        content: [
          {
            type: "mathBlock",
            id: "m_removed",
            tex: "x=1",
          },
        ],
      }),
    ).toThrow();
  });

  it("reports unsupported TeX commands in inline math", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "paragraph",
          id: "p_bad",
          children: [
            {
              type: "mathInline",
              id: "m_bad",
              tex: "\\unknown{x}",
              display: "inline",
            },
          ],
        },
      ],
    };

    expect(getDocumentIssues(document)).toContain(
      "数式 m_bad に未許可のTeXコマンド \\unknown があります。",
    );
  });

  it("accepts MathLive-supported inline math", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "paragraph",
          id: "p_mathlive",
          children: [
            {
              type: "mathInline",
              id: "m_mathlive",
              tex: "\\begin{aligned}x&=1\\\\y&=2\\end{aligned}\\iff\\placeholder{}",
              display: "inline",
            },
          ],
        },
      ],
    };

    expect(parseSigmaDocument(document).content[0]).toMatchObject({ type: "paragraph" });
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("accepts KaTeX-supported inline math commands", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "paragraph",
          id: "p_katex",
          children: [
            {
              type: "mathInline",
              id: "m_katex",
              tex: String.raw`\begin{array}{c}a\\\hline b\end{array}+\dots`,
              display: "inline",
            },
          ],
        },
      ],
    };

    expect(parseSigmaDocument(document).content[0]).toMatchObject({ type: "paragraph" });
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("accepts boxed inline math styling", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "paragraph",
          id: "p_boxed_math",
          children: [
            {
              type: "text",
              text: "重要",
              marks: ["boxed"],
              boxedVariant: "thick",
            },
            {
              type: "mathInline",
              id: "m_boxed_math",
              tex: "\\frac{1}{x}",
              display: "inline",
              marks: ["boxed"],
              color: "#111827",
              backgroundColor: "#f6e500",
              fontFamily: '"Yu Mincho", serif',
              fontSize: 14,
              boxedPaddingY: 4,
              boxedVariant: "double",
            },
          ],
        },
      ],
    };

    expect(parseSigmaDocument(document).content[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", marks: ["boxed"], boxedVariant: "thick" },
        {
          type: "mathInline",
          marks: ["boxed"],
          backgroundColor: "#f6e500",
          fontFamily: '"Yu Mincho", serif',
          fontSize: 10.5,
          boxedPaddingY: 4,
          boxedVariant: "double",
        },
      ],
    });
    expect(getDocumentIssues(document)).toEqual([]);
  });

  it("accepts document comments with inline math replies and output profile comment toggles", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      outputProfiles: {
        ...sampleDocument.outputProfiles,
        teacher: {
          ...sampleDocument.outputProfiles.teacher,
          includeComments: true,
        },
      },
      content: [
        {
          type: "paragraph",
          id: "p_comment_target",
          children: [
            { type: "text", text: "半径 " },
            { type: "mathInline", id: "m_radius", tex: "r", display: "inline" },
            { type: "text", text: " の円" },
          ],
        },
      ],
      comments: [
        {
          id: "comment_thread_1",
          anchor: {
            type: "inlineMath",
            blockId: "p_comment_target",
            mathInlineId: "m_radius",
            tex: "r",
          },
          messages: [
            {
              id: "comment_message_1",
              body: [
                { type: "text", text: "ここは " },
                { type: "mathInline", id: "m_comment_body", tex: "r>0", display: "inline" },
              ],
              reactions: [
                {
                  id: "comment_message_reaction_1",
                  emoji: "💡",
                  authorName: "ゲスト",
                  createdAt: "2026-06-16T00:01:00.000Z",
                },
              ],
              createdAt: "2026-06-16T00:00:00.000Z",
            },
          ],
          reactions: [
            {
              id: "comment_reaction_1",
              emoji: "👍",
              authorName: "ゲスト",
              createdAt: "2026-06-16T00:01:00.000Z",
            },
          ],
          createdAt: "2026-06-16T00:00:00.000Z",
        },
        {
          id: "comment_thread_overlay_math",
          anchor: {
            type: "overlayMath",
            tex: "y=x^2",
            quote: "$y=x^2$",
          },
          messages: [
            {
              id: "comment_message_overlay_math",
              body: [{ type: "text", text: "図中数式へのコメント" }],
              createdAt: "2026-06-16T00:00:00.000Z",
            },
          ],
          createdAt: "2026-06-16T00:00:00.000Z",
        },
      ],
    };

    const parsed = parseSigmaDocument(document);

    expect(parsed.comments?.[0].messages[0].body[1]).toMatchObject({ type: "mathInline", tex: "r>0" });
    expect(parsed.comments?.[0].messages[0].reactions?.[0]).toMatchObject({ emoji: "💡", authorName: "ゲスト" });
    expect(parsed.comments?.[0].reactions?.[0]).toMatchObject({ emoji: "👍", authorName: "ゲスト" });
    expect(parsed.comments?.[1].anchor).toMatchObject({ type: "overlayMath", tex: "y=x^2" });
    expect(parsed.outputProfiles.teacher.includeComments).toBe(true);
    expect(getDocumentIssues(parsed)).toEqual([]);
  });

  it("reports overlay math comments only when a referenced shape id is missing", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      comments: [
        {
          id: "comment_thread_idless_overlay_math",
          anchor: { type: "overlayMath", tex: "x+y" },
          messages: [
            {
              id: "comment_message_idless_overlay_math",
              body: [{ type: "text", text: "IDなしでも表示する" }],
              createdAt: "2026-06-16T00:00:00.000Z",
            },
          ],
          createdAt: "2026-06-16T00:00:00.000Z",
        },
        {
          id: "comment_thread_missing_overlay_math",
          anchor: { type: "overlayMath", shapeId: "missing_shape", tex: "x-y" },
          messages: [
            {
              id: "comment_message_missing_overlay_math",
              body: [{ type: "text", text: "対象なし" }],
              createdAt: "2026-06-16T00:00:00.000Z",
            },
          ],
          createdAt: "2026-06-16T00:00:00.000Z",
        },
      ],
    };

    expect(getDocumentIssues(document)).toContain("コメント comment_thread_missing_overlay_math の図中数式が見つかりません。");
    expect(getDocumentIssues(document)).not.toContain("コメント comment_thread_idless_overlay_math の図中数式が見つかりません。");
  });

  it("reports empty comment bodies, duplicate comment ids, and invalid anchors", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "paragraph",
          id: "p_comment_target",
          children: [{ type: "text", text: "本文" }],
        },
      ],
      comments: [
        {
          id: "comment_thread_1",
          anchor: { type: "block", blockId: "missing_block" },
          messages: [
            {
              id: "comment_thread_1",
              body: [{ type: "text", text: "  " }],
              reactions: [
                {
                  id: "comment_thread_1",
                  emoji: "💡",
                  createdAt: "2026-06-16T00:00:00.000Z",
                },
              ],
              createdAt: "2026-06-16T00:00:00.000Z",
            },
          ],
          reactions: [
            {
              id: "comment_thread_1",
              emoji: "👀",
              createdAt: "2026-06-16T00:00:00.000Z",
            },
          ],
          createdAt: "2026-06-16T00:00:00.000Z",
        },
      ],
    };

    const issues = getDocumentIssues(document);

    expect(issues).toContain("ID comment_thread_1 が重複しています。");
    expect(issues).toContain("コメント comment_thread_1 の返信 comment_thread_1 に本文がありません。");
    expect(issues).toContain("コメント comment_thread_1 のブロック missing_block が見つかりません。");
  });

  it("accepts inline text font size styling", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "paragraph",
          id: "p_inline_font_size",
          children: [{ type: "text", text: "強調", fontSize: 20 }],
        },
      ],
    };

    expect(parseSigmaDocument(document).content[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "強調", fontSize: 15 }],
    });
  });

  it("accepts headings inside problem content", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "problem",
          id: "problem_with_heading",
          tags: [],
          lead: [],
          prompt: [
            {
              type: "heading",
              id: "prompt_heading",
              level: 2,
              children: [{ type: "text", text: "小見出し" }],
            },
            {
              type: "paragraph",
              id: "prompt_paragraph",
              children: [{ type: "text", text: "本文" }],
            },
          ],
          solution: [],
          hints: [],
        },
      ],
    };

    const parsed = parseSigmaDocument(document).content[0];
    expect(parsed.type).toBe("problem");
    if (parsed.type !== "problem") {
      return;
    }

    expect(parsed.prompt[0]).toMatchObject({ type: "heading", level: 2 });
  });

  it("strips unsupported problem metadata and defaults lead content", () => {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      content: [
        {
          type: "problem",
          id: "unsupported_problem_metadata",
          kind: "practice",
          difficulty: 2,
          points: 5,
          tags: [],
          prompt: [],
          solution: [],
          hints: [],
        },
      ],
    });

    const problem = parsed.content[0];
    expect(problem.type).toBe("problem");
    if (problem.type !== "problem") {
      return;
    }

    expect(problem.lead).toEqual([]);
    expect("kind" in problem).toBe(false);
    expect("difficulty" in problem).toBe(false);
    expect("points" in problem).toBe(false);
  });

  it("accepts multiple rich blocks in problem lead content", () => {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      content: [
        {
          type: "problem",
          id: "problem_with_long_lead",
          tags: [],
          lead: [
            {
              type: "paragraph",
              id: "lead_1",
              children: [{ type: "text", text: "導入文1" }],
            },
            {
              type: "paragraph",
              id: "lead_2",
              children: [{ type: "text", text: "導入文2" }],
            },
          ],
          prompt: [],
          solution: [],
          hints: [],
        },
      ],
    });

    const problem = parsed.content[0];
    expect(problem?.type === "problem" ? problem.lead.map((block) => block.id) : [])
      .toEqual(["lead_1", "lead_2"]);
  });

  it("accepts problem area layout minimum heights", () => {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      content: [
        {
          type: "problem",
          id: "problem_with_area_layout",
          tags: [],
          lead: [],
          prompt: [
            {
              type: "paragraph",
              id: "prompt_with_area_layout",
              children: [{ type: "text", text: "問題文" }],
            },
          ],
          solution: [],
          hints: [],
          areaLayout: {
            lead: { minHeightMm: 8 },
            prompt: { minHeightMm: 24, columnSpan: "full" },
            solution: { minHeightMm: 36.5 },
          },
        },
      ],
    });

    const problem = parsed.content[0];
    expect(problem.type).toBe("problem");
    if (problem.type !== "problem") {
      return;
    }

    expect(problem.areaLayout?.lead?.minHeightMm).toBe(8);
    expect(problem.areaLayout?.prompt?.minHeightMm).toBe(24);
    expect(problem.areaLayout?.prompt?.columnSpan).toBe("full");
    expect(problem.areaLayout?.solution?.minHeightMm).toBe(36.5);
  });

  it("accepts layout sections inside problem solutions", () => {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      content: [
        {
          type: "problem",
          id: "problem_with_solution_layout_section",
          tags: [],
          lead: [],
          prompt: [],
          solution: [
            {
              type: "layoutSection",
              id: "solution_layout_section",
              layout: { columnCount: 2, columnGapMm: 8 },
              children: [
                {
                  type: "paragraph",
                  id: "solution_column_child",
                  children: [{ type: "text", text: "解答の一部" }],
                },
              ],
            },
          ],
          hints: [],
        },
      ],
    });

    const problem = parsed.content[0];
    expect(problem.type).toBe("problem");
    if (problem.type !== "problem") {
      return;
    }

    expect(problem.solution[0]?.type).toBe("layoutSection");
  });

  it("accepts optional problem numbering settings", () => {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      content: [
        {
          type: "problem",
          id: "problem_with_numbering",
          tags: [],
          lead: [],
          prompt: [],
          solution: [],
          hints: [],
          numbering: {
            enabled: false,
            fontSize: 22,
            value: 7,
          },
        },
      ],
    });

    const problem = parsed.content[0];
    expect(problem.type).toBe("problem");
    if (problem.type !== "problem") {
      return;
    }

    expect(problem.numbering?.enabled).toBe(false);
    expect(problem.numbering?.fontSize).toBe(16.5);
    expect(problem.numbering?.value).toBe(7);
  });

  it("migrates legacy font sizes from px to pt once", () => {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      metadata: { title: "legacy font sizes" },
      content: [
        {
          type: "problem",
          id: "problem_legacy_font_size",
          tags: [],
          lead: [],
          prompt: [
            {
              type: "paragraph",
              id: "p_legacy_font_size",
              children: [{ type: "text", text: "本文", fontSize: 16 }],
            },
          ],
          solution: [],
          hints: [],
          numbering: { fontSize: 16 },
        },
      ],
    });

    const problem = parsed.content[0];
    expect(parsed.metadata.styleUnits?.fontSize).toBe("pt");
    expect(problem.type).toBe("problem");
    if (problem.type !== "problem") {
      return;
    }
    const prompt = problem.prompt[0];
    expect(prompt?.type).toBe("paragraph");
    if (prompt?.type !== "paragraph") {
      return;
    }
    expect(prompt.children[0]).toMatchObject({ fontSize: 12 });
    expect(problem.numbering?.fontSize).toBe(12);
    expect(parseSigmaDocument(parsed).content[0]).toMatchObject({
      type: "problem",
      numbering: { fontSize: 12 },
    });
  });

  it("accepts optional problem frame settings", () => {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      content: [
        {
          type: "problem",
          id: "problem_with_frame",
          tags: [],
          lead: [],
          prompt: [],
          solution: [],
          hints: [],
          frame: {
            enabled: true,
          },
        },
      ],
    });

    const problem = parsed.content[0];
    expect(problem.type).toBe("problem");
    if (problem.type !== "problem") {
      return;
    }

    expect(problem.frame?.enabled).toBe(true);
  });

  it("rejects negative problem area minimum heights", () => {
    expect(() =>
      parseSigmaDocument({
        ...sampleDocument,
        content: [
          {
            type: "problem",
            id: "problem_bad_area_layout",
            tags: [],
            lead: [],
            prompt: [],
            solution: [],
            hints: [],
            areaLayout: {
              prompt: { minHeightMm: -1 },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects invalid problem area column spans", () => {
    expect(() =>
      parseSigmaDocument({
        ...sampleDocument,
        content: [
          {
            type: "problem",
            id: "problem_bad_area_span",
            tags: [],
            lead: [],
            prompt: [],
            solution: [],
            hints: [],
            areaLayout: {
              prompt: { columnSpan: "wide" },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("drops an imported previewSvg when an editable overlay snapshot is present", () => {
    const document = ensurePageLayout(sampleDocument);
    // Untyped JSON: `previewSvg` is no longer part of the model, but hand-written or
    // third-party documents can still carry the key.
    document.pageLayout!.overlay = {
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "shape_test",
            type: "arc",
            x: 0,
            y: 0,
            props: { r: 60, startAngle: 0, endAngle: Math.PI, color: "black", dash: "solid", size: "m" },
          },
        ],
        assets: {},
      },
      previewSvg: "<svg viewBox=\"0 0 10 10\"></svg>",
      updatedAt: "2026-05-14T00:00:00.000Z",
    } as unknown as PageOverlay;

    const parsed = parseSigmaDocument(document);

    expect((parsed.pageLayout?.overlay as Record<string, unknown> | undefined)?.previewSvg).toBeUndefined();
    expect(parsed.pageLayout?.overlay?.overlaySnapshot).toMatchObject({
      version: 1,
      shapes: expect.any(Array),
    });
  });

  it("persists a sanitized color when an injected overlay color is saved", () => {
    // `prepareOverlaySnapshotForValidation` is the schema's preprocess, so what this test observes
    // is also what gets written back to disk — the injected string never survives a round trip.
    const document = ensurePageLayout(sampleDocument);
    document.pageLayout!.overlay = {
      overlaySnapshot: {
        version: 1,
        shapes: [{
          id: "shape_injected",
          type: "geo",
          x: 0,
          y: 0,
          props: {
            w: 100,
            h: 60,
            geo: "rectangle",
            fill: "none",
            color: "red;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:2147483647",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        }],
        assets: {},
      },
    };

    const shape = parseSigmaDocument(document).pageLayout?.overlay?.overlaySnapshot?.shapes[0];

    expect(shape).toMatchObject({ id: "shape_injected", type: "geo", props: { w: 100, h: 60 } });
    expect((shape?.props as { color: string }).color).toBe("black");
  });

  it("drops a preview-only legacy overlay entirely", () => {
    const document = ensurePageLayout(sampleDocument);
    document.pageLayout!.overlay = {
      previewSvg: "<img src=x onerror=alert(1)>",
      updatedAt: "2026-05-14T00:00:00.000Z",
    } as unknown as PageOverlay;

    expect(parseSigmaDocument(document).pageLayout?.overlay).toBeUndefined();
  });

  it("rejects invalid page layout geometry", () => {
    const document = ensurePageLayout(sampleDocument);
    document.pageLayout = {
      ...document.pageLayout!,
      preset: "custom",
      pageSize: { widthMm: 100, heightMm: 100 },
      marginsMm: { top: 10, right: 60, bottom: 10, left: 50 },
    };

    expect(() => parseSigmaDocument(document)).toThrow();
  });

  it("rejects unsupported column counts", () => {
    const document = ensurePageLayout(sampleDocument);
    document.pageLayout = {
      ...document.pageLayout!,
      flow: { type: "columns", columnCount: 5, columnGapMm: 8 },
    };

    expect(() => parseSigmaDocument(document)).toThrow();
  });

  it("rejects malformed local overlay snapshots", () => {
    const document = ensurePageLayout(sampleDocument);
    document.pageLayout!.overlay = {
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "shape_bad",
            type: "arc",
            x: 0,
            y: 0,
            props: { startAngle: 0, endAngle: Math.PI, color: "black", dash: "solid", size: "m" },
          },
        ],
        assets: {},
      } as never,
      updatedAt: "2026-05-14T00:00:00.000Z",
    };

    expect(() => parseSigmaDocument(document)).toThrow();
  });
});

describe("block space after", () => {
  function parseWithSpaceAfter(spaceAfterPx: unknown): unknown {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      content: [{
        type: "paragraph",
        id: "p_space_after",
        children: [{ type: "text", text: "余白付き" }],
        spaceAfterPx,
      }],
    });
    const block = parsed.content[0];
    return block.type === "paragraph" ? block.spaceAfterPx : "not-a-paragraph";
  }

  it("keeps the value instead of stripping it as an unknown key", () => {
    expect(parseWithSpaceAfter(24)).toBe(24);
  });

  it("normalizes a fractional value to whole px", () => {
    expect(parseWithSpaceAfter(24.4)).toBe(24);
  });

  it("clamps above the maximum rather than refusing the document", () => {
    expect(parseWithSpaceAfter(10_000)).toBe(400);
  });

  it("drops a negative value and still opens the document", () => {
    expect(parseWithSpaceAfter(-1)).toBeUndefined();
  });

  it("drops a non-numeric value and still opens the document", () => {
    expect(parseWithSpaceAfter("24")).toBeUndefined();
  });

  it("drops NaN and still opens the document", () => {
    expect(parseWithSpaceAfter(Number.NaN)).toBeUndefined();
  });

  it("does not add the key to an untouched block (the JSON stays identical)", () => {
    // キーが `undefined` で生えるだけでも、書き出した JSON の差分・ハッシュ・AI 編集の
    // 鮮度判定に無関係な揺れが出る。「未指定は一切書かない」を固定する。
    const paragraph = { type: "paragraph", id: "p_plain", children: [{ type: "text", text: "素" }] };
    const parsed = parseSigmaDocument({ ...sampleDocument, content: [paragraph] });

    expect(Object.keys(parsed.content[0]).sort()).toEqual(["children", "id", "type"]);
  });

  it("keeps the value on every block family that can carry it", () => {
    const parsed = parseSigmaDocument({
      ...sampleDocument,
      content: [
        { type: "divider", id: "d_space", spaceAfterPx: 8 },
        {
          type: "list",
          id: "list_space",
          listType: "bullet",
          spaceAfterPx: 9,
          items: [{ type: "listItem", id: "li_space", children: [{ type: "text", text: "項目" }] }],
        },
        {
          type: "problem",
          id: "problem_space",
          tags: [],
          lead: [],
          prompt: [{ type: "paragraph", id: "p_in_problem", children: [], spaceAfterPx: 10 }],
          solution: [],
          hints: [],
        },
        {
          type: "layoutSection",
          id: "layout_space",
          layout: { columnCount: 2 },
          spaceAfterPx: 11,
          children: [{ type: "paragraph", id: "p_in_layout", children: [], spaceAfterPx: 12 }],
        },
      ],
    });

    const [divider, list, problem, layout] = parsed.content;
    expect([
      divider.spaceAfterPx,
      list.spaceAfterPx,
      problem.type === "problem" ? problem.prompt[0].spaceAfterPx : undefined,
      layout.spaceAfterPx,
      layout.type === "layoutSection" ? layout.children[0].spaceAfterPx : undefined,
    ]).toEqual([8, 9, 10, 11, 12]);
  });
});

describe("recoverSigmaDocument schema failures", () => {
  it("reports every unrecoverable field with the expected and actual value", () => {
    // 別ブランチ/新しいアプリで保存された値 (未知のpreset) は要素の除外では救えない。
    const document = ensurePageLayout(sampleDocument) as SigmaDocument & { pageLayout: { preset: string } };
    const result = recoverSigmaDocument({
      ...document,
      pageLayout: { ...document.pageLayout, preset: "scroll" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("(pageLayout.preset)");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      path: "pageLayout.preset",
      code: "invalid_value",
      received: "\"scroll\"",
    });
    expect(result.failures[0].expected).toContain("\"A4\"");
  });

  it("formats array positions and keeps nested union causes", () => {
    const result = recoverSigmaDocument({
      version: "2.0",
      docId: "doc_1",
      metadata: { title: "テスト", source: { format: 123 } },
      content: [],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
      comments: [{ id: "thread_1", anchor: { type: "unknown" }, messages: [] }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    // 独立して捨てられるコメントは除外され、必須構造の違反だけが残る。
    expect(result.failures.map((failure) => failure.path)).toContain("metadata.source.format");
    expect(result.failures.some((failure) => failure.received === "123")).toBe(true);
  });

  it("returns an empty failure list only when the document parses", () => {
    const result = recoverSigmaDocument(ensurePageLayout(sampleDocument));
    expect(result.ok).toBe(true);
  });
});
