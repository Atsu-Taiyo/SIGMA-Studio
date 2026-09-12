import { describe, expect, it } from "vitest";

import { searchSigmaDocument } from "@/lib/ai/sigma-doc-search";
import type {
  OverlayCalloutShape,
  OverlayShape,
  OverlayTableShape,
  OverlayTextShape,
} from "@/features/document";
import { ensurePageLayout } from "@/lib/page-layout";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { RichBlock, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

describe("searchSigmaDocument", () => {
  it("returns no matches for an empty or blank query", () => {
    const document = createDocument([paragraph("p_1", "本文")]);

    expect(searchSigmaDocument(document, "")).toEqual({ matches: [], totalMatches: 0 });
    expect(searchSigmaDocument(document, "   ")).toEqual({ matches: [], totalMatches: 0 });
  });

  it("matches a text run and reports its content[] areaPath", () => {
    const document = createDocument([paragraph("p_1", "二次方程式の解の公式")]);

    const result = searchSigmaDocument(document, "解の公式");

    expect(result.totalMatches).toBe(1);
    expect(result.matches).toEqual([
      {
        blockId: "p_1",
        blockType: "paragraph",
        areaPath: "content[0]",
        field: "text",
        excerpt: "二次方程式の「解の公式」",
        matchIndex: 6,
      },
    ]);
  });

  it("is case-insensitive", () => {
    const document = createDocument([paragraph("p_1", "The Quadratic Formula")]);

    const result = searchSigmaDocument(document, "quadratic");

    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]).toMatchObject({ blockId: "p_1", field: "text" });
  });

  it("matches mathInline tex as a separate field from text", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [
          { type: "text", text: "式は " },
          { type: "mathInline", id: "m_1", tex: "x^2 + 2x + 1", display: "inline" },
          { type: "text", text: " である。" },
        ],
      },
    ]);

    const result = searchSigmaDocument(document, "x^2");

    expect(result.matches).toEqual([
      {
        blockId: "p_1",
        blockType: "paragraph",
        areaPath: "content[0]",
        field: "tex",
        excerpt: "「x^2」 + 2x + 1",
        matchIndex: 0,
      },
    ]);
  });

  it("matches a section title", () => {
    const document = createDocument([{ type: "section", id: "s_1", title: "微分と積分" }]);

    const result = searchSigmaDocument(document, "積分");

    expect(result.matches[0]).toMatchObject({ blockId: "s_1", blockType: "section", field: "text" });
  });

  it("matches inside nested list items, addressing the list item itself", () => {
    const document = createDocument([
      {
        type: "list",
        id: "list_1",
        listType: "bullet",
        items: [
          { type: "listItem", id: "li_1", children: [{ type: "text", text: "りんご" }] },
          {
            type: "listItem",
            id: "li_2",
            children: [{ type: "text", text: "みかん" }],
            nested: [{
              type: "list",
              id: "list_2",
              listType: "bullet",
              items: [{ type: "listItem", id: "li_3", children: [{ type: "text", text: "温州みかん" }] }],
            }],
          },
        ],
      },
    ]);

    const result = searchSigmaDocument(document, "みかん");

    expect(result.totalMatches).toBe(2);
    expect(result.matches.map((match) => match.blockId)).toEqual(["li_2", "li_3"]);
    expect(result.matches.every((match) => match.blockType === "listItem")).toBe(true);
  });

  it("addresses problem-area matches with a problem_N.area path", () => {
    const document = createDocument([
      paragraph("filler", "本文"),
      createProblem("problem_1", [richParagraph("solution_1", "両辺を2で割ると答えが出ます。")]),
      createProblem("problem_2", [richParagraph("solution_2", "答えが出ます。")]),
    ]);

    const result = searchSigmaDocument(document, "答えが出ます");

    expect(result.matches.map((match) => ({ blockId: match.blockId, areaPath: match.areaPath }))).toEqual([
      { blockId: "solution_1", areaPath: "problem_1.solution" },
      { blockId: "solution_2", areaPath: "problem_2.solution" },
    ]);
  });

  it("appends an index suffix for the 2nd+ block within the same problem area", () => {
    const document = createDocument([
      createProblem("problem_1", [
        richParagraph("solution_1a", "説明その1"),
        richParagraph("solution_1b", "説明その2"),
      ]),
    ]);

    const result = searchSigmaDocument(document, "説明");

    expect(result.matches.map((match) => match.areaPath)).toEqual([
      "problem_1.solution",
      "problem_1.solution[1]",
    ]);
  });

  it("recurses into layoutSection and boxBlock children with nested areaPaths", () => {
    const document = createDocument([
      {
        type: "layoutSection",
        id: "layout_1",
        layout: { columnCount: 2 },
        children: [
          {
            type: "boxBlock",
            id: "box_1",
            styleId: "fancybox",
            blocks: [richParagraph("boxed_p", "段組の中のボックス本文")],
          },
        ],
      },
    ]);

    const result = searchSigmaDocument(document, "ボックス本文");

    expect(result.matches[0]).toMatchObject({
      blockId: "boxed_p",
      areaPath: "content[0].children[0].blocks[0]",
    });
  });

  it("finds matches inside table-shape cells, addressing the shape id", () => {
    const document = documentWithOverlayShapes([tableShapeWithCellText("table_1", "面積の最大値")]);

    const result = searchSigmaDocument(document, "最大値");

    expect(result.matches[0]).toMatchObject({
      blockId: "table_1",
      blockType: "overlayShape",
      areaPath: "overlay",
      field: "text",
    });
  });

  it("finds matches inside overlay text shapes, including math nodes", () => {
    const document = documentWithOverlayShapes([textShapeWithContent("text_1", "傾き ", "m")]);

    const textMatch = searchSigmaDocument(document, "傾き");
    const texMatch = searchSigmaDocument(document, "m");

    expect(textMatch.matches[0]).toMatchObject({ blockId: "text_1", blockType: "overlayShape", field: "text" });
    expect(texMatch.matches[0]).toMatchObject({ blockId: "text_1", blockType: "overlayShape", field: "tex" });
  });

  it("finds text and math embedded directly in a callout", () => {
    const document = documentWithOverlayShapes([calloutWithContent("callout_1", "注意 ", "x>0")]);

    expect(searchSigmaDocument(document, "注意").matches[0]).toMatchObject({
      blockId: "callout_1",
      blockType: "overlayShape",
      field: "text",
    });
    expect(searchSigmaDocument(document, "x>0").matches[0]).toMatchObject({
      blockId: "callout_1",
      blockType: "overlayShape",
      field: "tex",
    });
  });

  /**
   * A list item holds prose in three places: its own line, the blocks continuing it, and the
   * sub-lists under it. Search that stops at the first makes the rest unfindable — and unfindable
   * text is text an AI edit will never be asked to touch.
   */
  it("finds text nested inside a list in an overlay text shape", () => {
    const document = documentWithOverlayShapes([listTextShape("text_list")]);

    expect(searchSigmaDocument(document, "親項目").matches[0]).toMatchObject({ blockId: "text_list", field: "text" });
    expect(searchSigmaDocument(document, "続きの段落").matches[0]).toMatchObject({ blockId: "text_list", field: "text" });
    expect(searchSigmaDocument(document, "入れ子の項目").matches[0]).toMatchObject({ blockId: "text_list", field: "text" });
    expect(searchSigmaDocument(document, "y=ax").matches[0]).toMatchObject({ blockId: "text_list", field: "tex" });
  });

  it("truncates results at the default limit while reporting totalMatches", () => {
    const document = createDocument(
      Array.from({ length: 25 }, (_, index) => paragraph(`p_${index}`, "検索対象の本文です")),
    );

    const result = searchSigmaDocument(document, "検索対象");

    expect(result.matches).toHaveLength(20);
    expect(result.totalMatches).toBe(25);
  });

  it("clamps an explicit limit to the hard max of 50", () => {
    const document = createDocument(
      Array.from({ length: 60 }, (_, index) => paragraph(`p_${index}`, "検索対象の本文です")),
    );

    const result = searchSigmaDocument(document, "検索対象", { limit: 500 });

    expect(result.matches).toHaveLength(50);
    expect(result.totalMatches).toBe(60);
  });

  it("wraps the match in 「」 with ~40 characters of context on each side", () => {
    const longText = `${"あ".repeat(60)}キーワード${"い".repeat(60)}`;
    const document = createDocument([paragraph("p_1", longText)]);

    const result = searchSigmaDocument(document, "キーワード");

    expect(result.matches[0].excerpt.startsWith("…")).toBe(true);
    expect(result.matches[0].excerpt.endsWith("…")).toBe(true);
    expect(result.matches[0].excerpt).toContain("「キーワード」");
  });
});

function paragraph(id: string, text: string): SigmaBlock {
  return {
    type: "paragraph",
    id,
    children: [{ type: "text", text }],
  };
}

function richParagraph(id: string, text: string): RichBlock {
  return {
    type: "paragraph",
    id,
    children: [{ type: "text", text }],
  };
}

function createProblem(id: string, solution: RichBlock[]): SigmaBlock {
  return {
    type: "problem",
    id,
    tags: [],
    lead: [],
    prompt: [richParagraph(`${id}_prompt`, "問題文")],
    solution,
    hints: [],
  };
}

function createDocument(content: SigmaBlock[]): SigmaDocument {
  return parseSigmaDocument({
    version: "2.0",
    docId: "doc_search_test",
    metadata: { title: "検索テスト" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  });
}

function documentWithOverlayShapes(shapes: OverlayShape[]): SigmaDocument {
  const base = ensurePageLayout(createDocument([paragraph("anchor", "anchor")]));
  return parseSigmaDocument({
    ...base,
    pageLayout: {
      ...base.pageLayout!,
      overlay: {
        overlaySnapshot: { version: 1, assets: {}, shapes },
      },
    },
  });
}

function tableShapeWithCellText(id: string, text: string): OverlayTableShape {
  return {
    id,
    type: "tableShape",
    x: 0,
    y: 0,
    props: {
      w: 200,
      h: 100,
      table: {
        version: 1,
        kind: "plain",
        columns: [{ id: "col_1", width: { mode: "auto", min: 48 } }],
        rows: [{ id: "row_1", height: { mode: "auto", min: 32 } }],
        cells: [{
          id: "cell_1",
          rowId: "row_1",
          columnId: "col_1",
          content: [{ type: "paragraph", id: "cell_p_1", children: [{ type: "text", text }] }],
        }],
        grid: { borderColor: "#111827", borderWidth: 1 },
        defaultCellStyle: {},
      },
    },
  };
}

function textShapeWithContent(id: string, text: string, tex: string): OverlayTextShape {
  return {
    id,
    type: "text",
    x: 0,
    y: 0,
    props: {
      w: 120,
      h: 16,
      color: "#111827",
      size: "m",
      blocks: [
          {
            type: "paragraph", id: "sigma_doc_search_test_37",
            children: [
              { type: "text", text },
              { type: "mathInline", id: "tex_1", tex, display: "inline" },
            ],
          },
        ],
    },
  };
}

/** A text shape whose content is a list with a continuation paragraph and a nested sub-list. */
function listTextShape(id: string): OverlayTextShape {
  return {
    id,
    type: "text",
    x: 0,
    y: 0,
    props: {
      w: 200,
      h: 64,
      color: "#111827",
      size: "m",
      blocks: [{
        type: "list",
        id: "list_1",
        listType: "bullet",
        items: [{
          type: "listItem",
          id: "li_1",
          children: [{ type: "text", text: "親項目" }],
          continuations: [{
            type: "paragraph",
            id: "li_1_cont",
            children: [{ type: "text", text: "続きの段落" }],
          }],
          nested: [{
            type: "list",
            id: "list_2",
            listType: "bullet",
            items: [{
              type: "listItem",
              id: "li_2",
              children: [
                { type: "text", text: "入れ子の項目" },
                { type: "mathInline", id: "nested_math", tex: "y=ax", display: "inline" },
              ],
            }],
          }],
        }],
      }],
    },
  };
}

function calloutWithContent(id: string, text: string, tex: string): OverlayCalloutShape {
  return {
    id,
    type: "callout",
    x: 0,
    y: 0,
    props: {
      w: 160,
      h: 72,
      radius: 18,
      tail: {
        baseStart: { x: 36, y: 72 },
        baseEnd: { x: 68, y: 72 },
        tip: { x: 24, y: 100 },
      },
      color: "#111827",
      size: "m",
      dash: "solid",
      strokeWidth: "m",
      blocks: [{
          type: "paragraph", id: "sigma_doc_search_test_38",
          children: [
            { type: "text", text },
            { type: "mathInline", id: "callout_math", tex, display: "inline" },
          ],
        }],
    },
  };
}
