import { describe, expect, it } from "vitest";

import {
  DEFAULT_AI_EDIT_REASONING_EFFORT,
  applySigmaDocMutationOp,
  createAiEditDocumentDraft,
  createAiEditSessionDocumentDraft,
  isAdditiveInsertOnlyDraft,
  normalizeAiEditReasoningEffort,
  parseAiEditSessionDraft,
  validateAiEditDraftForDocument,
  validateAiEditSessionDraftForDocument,
  type AiEditDraft,
} from "@/lib/ai/sigma-doc-edit-schema";
import type { OverlayAsset, OverlayShape, OverlayTableShape } from "@/features/document";
import { MIN_PAGE_BODY_HEIGHT_MM, ensurePageLayout, getDefaultPageLayout } from "@/lib/page-layout";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { Graph2DSpec, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

const VALID_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
const VALID_JPEG_DATA_URL = "data:image/jpeg;base64,/9j/wAAHCAABAAEA";
const VALID_WEBP_DATA_URL = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAAAAAAAAAAA==";

describe("AI SigmaDoc edit draft validation", () => {
  it("normalizes AI edit reasoning effort for UI and API payloads", () => {
    expect(normalizeAiEditReasoningEffort("HIGH")).toBe("high");
    expect(normalizeAiEditReasoningEffort(" xhigh ")).toBe("xhigh");
    expect(normalizeAiEditReasoningEffort("none")).toBe("none");
    expect(normalizeAiEditReasoningEffort("MAX")).toBe("max");
    expect(normalizeAiEditReasoningEffort(undefined)).toBe(DEFAULT_AI_EDIT_REASONING_EFFORT);
  });

  it("applies a valid paragraph replacement without changing other blocks", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "元の本文" }],
      },
      {
        type: "heading",
        id: "h_1",
        level: 2,
        children: [{ type: "text", text: "残す見出し" }],
      },
    ]);
    const draft: AiEditDraft = {
      summary: "本文を説明的にしました。",
      targetId: "p_1",
      replacementBlock: {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "新しい本文" }],
      },
    };

    const { nextDocument } = createAiEditDocumentDraft(document, "p_1", draft);

    expect(nextDocument.content[0]).toMatchObject({
      type: "paragraph",
      id: "p_1",
      children: [{ type: "text", text: "新しい本文" }],
    });
    expect(nextDocument.content[1]).toEqual(document.content[1]);
  });

  it("accepts valid heading and problem replacements", () => {
    const document = createDocument([
      {
        type: "heading",
        id: "h_1",
        level: 2,
        children: [{ type: "text", text: "一次方程式" }],
      },
      createProblem("problem_1"),
    ]);

    const headingDraft = validateAiEditDraftForDocument(document, "h_1", {
      summary: "見出しを短くしました。",
      targetId: "h_1",
      replacementBlock: {
        type: "heading",
        id: "h_1",
        level: 2,
        children: [{ type: "text", text: "方程式" }],
      },
    });
    const problemDraft = validateAiEditDraftForDocument(document, "problem_1", {
      summary: "解説を補足しました。",
      targetId: "problem_1",
      replacementBlock: {
        ...createProblem("problem_1"),
        solution: [
          {
            type: "paragraph",
            id: "solution_1",
            children: [{ type: "text", text: "両辺に同じ数を足します。" }],
          },
        ],
      },
    });

    expect(headingDraft.nextDocument.content[0]).toMatchObject({
      type: "heading",
      children: [{ type: "text", text: "方程式" }],
    });
    expect(problemDraft.nextDocument.content[1]).toMatchObject({
      type: "problem",
      solution: [{ children: [{ text: "両辺に同じ数を足します。" }] }],
    });
  });

  it("rejects mismatched target ids", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    expect(() =>
      validateAiEditDraftForDocument(document, "p_1", {
        summary: "別IDです。",
        targetId: "p_2",
        replacementBlock: {
          type: "paragraph",
          id: "p_2",
          children: [{ type: "text", text: "本文" }],
        },
      }),
    ).toThrow("対象ID");
  });

  it("rejects invalid replacement block shapes", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    expect(() =>
      validateAiEditDraftForDocument(document, "p_1", {
        summary: "childrenがありません。",
        targetId: "p_1",
        replacementBlock: {
          type: "paragraph",
          id: "p_1",
        },
      }),
    ).toThrow();
  });

  it("rejects edits that change the selected block type", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    expect(() =>
      validateAiEditDraftForDocument(document, "p_1", {
        summary: "種別を変えています。",
        targetId: "p_1",
        replacementBlock: {
          type: "heading",
          id: "p_1",
          level: 2,
          children: [{ type: "text", text: "見出し" }],
        },
      }),
    ).toThrow("ブロック種別");
  });

  it("rejects replacement blocks with invalid MathLive TeX", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    expect(() =>
      validateAiEditDraftForDocument(document, "p_1", {
        summary: "未対応のTeXを含みます。",
        targetId: "p_1",
        replacementBlock: {
          type: "paragraph",
          id: "p_1",
          children: [
            {
              type: "mathInline",
              id: "m_bad",
              tex: "\\unknown{x}",
              display: "inline",
            },
          ],
        },
      }),
    ).toThrow("不正なMathLive TeX");
  });

  it("normalizes likely AI // math newlines before validating the draft", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    const { draft, nextDocument } = validateAiEditDraftForDocument(document, "p_1", {
      summary: "途中式を追加しました。",
      targetId: "p_1",
      replacementBlock: {
        type: "paragraph",
        id: "p_1",
        children: [
          {
            type: "mathInline",
            id: "m_steps",
            tex: "x+1=3//x=2",
            display: "inline",
          },
        ],
      },
    });

    expect(asReplaceDraft(draft).replacementBlock).toMatchObject({
      children: [{ tex: "\\begin{aligned}x+1=3\\\\x=2\\end{aligned}" }],
    });
    expect(nextDocument.content[0]).toMatchObject({
      children: [{ tex: "\\begin{aligned}x+1=3\\\\x=2\\end{aligned}" }],
    });
  });

  it("canonicalizes AI mathInline nodes and preserves an existing semantic role", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    const { draft, nextDocument } = validateAiEditDraftForDocument(document, "p_1", {
      summary: "数式の意味役割を正規化しました。",
      targetId: "p_1",
      replacementBlock: {
        type: "paragraph",
        id: "p_1",
        children: [
          {
            type: "mathInline",
            id: "m_expression",
            tex: "x+1",
            display: "inline",
            marks: ["boxed"],
            color: "#112233",
            backgroundColor: "#f4f4f5",
            fontFamily: "serif",
            fontSize: 18,
            boxedPaddingY: 2,
            boxedVariant: "thick",
            boxedTone: "blue",
          },
          {
            type: "mathInline",
            id: "m_equation",
            tex: "x=1",
            display: "inline",
            semanticRole: "equation",
          },
        ],
      },
    });

    const replacementBlock = asReplaceDraft(draft).replacementBlock;
    if (replacementBlock.type !== "paragraph") {
      throw new Error("normalized replacement paragraph missing");
    }
    expect(replacementBlock.children[0]).toEqual({
      type: "mathInline",
      id: "m_expression",
      tex: "x+1",
      display: "inline",
      marks: ["boxed"],
      color: "#112233",
      backgroundColor: "#f4f4f5",
      fontFamily: "serif",
      fontSize: 18,
      boxedPaddingY: 2,
      boxedVariant: "thick",
      boxedTone: "blue",
      semanticRole: "expression",
    });
    expect(Object.keys(replacementBlock.children[0]!)).toEqual([
      "type",
      "id",
      "tex",
      "display",
      "marks",
      "color",
      "backgroundColor",
      "fontFamily",
      "fontSize",
      "boxedPaddingY",
      "boxedVariant",
      "boxedTone",
      "semanticRole",
    ]);
    expect(replacementBlock.children[1]).toEqual({
      type: "mathInline",
      id: "m_equation",
      tex: "x=1",
      display: "inline",
      semanticRole: "equation",
    });
    expect(nextDocument.content[0]).toMatchObject({
      children: [
        { type: "mathInline", semanticRole: "expression" },
        { type: "mathInline", semanticRole: "equation" },
      ],
    });
  });

  it("preserves mathInline altText through the public replacement operation", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    const { draft, nextDocument } = validateAiEditDraftForDocument(document, "p_1", {
      summary: "数式の代替テキストを保持しました。",
      targetId: "p_1",
      replacementBlock: {
        type: "paragraph",
        id: "p_1",
        children: [{
          type: "mathInline",
          id: "m_alt_text",
          tex: "x+1",
          display: "inline",
          altText: "diagram label",
        }],
      },
    });

    const replacementBlock = asReplaceDraft(draft).replacementBlock;
    if (replacementBlock.type !== "paragraph") {
      throw new Error("normalized replacement paragraph missing");
    }
    expect(replacementBlock.children[0]).toEqual({
      type: "mathInline",
      id: "m_alt_text",
      tex: "x+1",
      display: "inline",
      altText: "diagram label",
      semanticRole: "expression",
    });
    expect(Object.keys(replacementBlock.children[0]!)).toEqual([
      "type",
      "id",
      "tex",
      "display",
      "altText",
      "semanticRole",
    ]);
    expect(nextDocument.content[0]).toMatchObject({
      children: [{
        type: "mathInline",
        id: "m_alt_text",
        altText: "diagram label",
      }],
    });
  });

  it("converts LaTeX delimiters in draft text nodes into inline math nodes", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    const { draft, nextDocument } = validateAiEditDraftForDocument(document, "p_1", {
      operation: "insertAfter",
      summary: "式の扱いを追加しました。",
      targetId: "p_1",
      insertedBlock: {
        type: "paragraph",
        id: "ai_p_formula_note",
        children: [{
          type: "text",
          text: "\\(x^2+1\\) を展開せずに扱う。\\(a+b\\) と \\(a-b\\) を別々に確認する。",
        }],
      },
    });

    expect(asInsertDraft(draft).insertedBlock).toMatchObject({
      children: [
        { type: "mathInline", tex: "x^2+1", semanticRole: "expression" },
        { type: "text", text: " を展開せずに扱う。" },
        { type: "mathInline", tex: "a+b", semanticRole: "expression" },
        { type: "text", text: " と " },
        { type: "mathInline", tex: "a-b", semanticRole: "expression" },
        { type: "text", text: " を別々に確認する。" },
      ],
    });
    expect(nextDocument.content[1]).toMatchObject({
      children: [
        { type: "mathInline", tex: "x^2+1", semanticRole: "expression" },
        { type: "text", text: " を展開せずに扱う。" },
        { type: "mathInline", tex: "a+b", semanticRole: "expression" },
        { type: "text", text: " と " },
        { type: "mathInline", tex: "a-b", semanticRole: "expression" },
        { type: "text", text: " を別々に確認する。" },
      ],
    });
  });

  it("inserts a MathLive array paragraph after a selected top-level block", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [
          { type: "mathInline", id: "m_source", tex: "\\frac{\\log x}{x}", display: "inline" },
          { type: "text", text: "の増減表を作成して" },
        ],
      },
      {
        type: "paragraph",
        id: "p_2",
        children: [{ type: "text", text: "次の本文" }],
      },
    ]);

    const { draft, nextDocument } = validateAiEditDraftForDocument(document, "p_1", {
      operation: "insertAfter",
      summary: "増減表を挿入しました。",
      targetId: "p_1",
      insertedBlock: {
        type: "paragraph",
        id: "ai_p_monotonicity",
        align: "center",
        children: [
          {
            type: "mathInline",
            id: "ai_m_monotonicity",
            display: "inline",
            tex: "\\begin{array}{c|ccc}x&0&e&\\infty\\\\f'(x)&+&0&-\\\\f(x)&\\nearrow&\\frac{1}{e}&\\searrow\\end{array}",
          },
        ],
      },
    });

    expect(draft).toMatchObject({ operation: "insertAfter" });
    expect(nextDocument.content.map((block) => block.id)).toEqual([
      "p_1",
      "ai_p_monotonicity",
      "p_2",
    ]);
    expect(nextDocument.content[1]).toMatchObject({
      type: "paragraph",
      children: [{ tex: expect.stringContaining("\\begin{array}") }],
    });
  });

  it("inserts a rich paragraph after a selected problem rich block", () => {
    const document = createDocument([createProblem("problem_1")]);

    const { nextDocument } = validateAiEditDraftForDocument(document, "prompt_1", {
      operation: "insertAfter",
      summary: "補足説明を挿入しました。",
      targetId: "prompt_1",
      insertedBlock: {
        type: "paragraph",
        id: "ai_p_hint",
        children: [{ type: "text", text: "まず両辺から1を引きます。" }],
      },
    });

    const problem = nextDocument.content[0];
    expect(problem).toMatchObject({
      type: "problem",
      prompt: [
        { id: "prompt_1" },
        { id: "ai_p_hint", children: [{ text: "まず両辺から1を引きます。" }] },
      ],
    });
  });

  it("inserts a tableShape into the document overlay", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [
          { type: "mathInline", id: "m_source", tex: "\\frac{\\log x}{x}", display: "inline" },
          { type: "text", text: "の増減表を作成して" },
        ],
      },
    ]);

    const { draft, nextDocument } = validateAiEditDraftForDocument(document, "p_1", {
      operation: "insertTableShape",
      summary: "増減表をtableShapeとして挿入しました。",
      targetId: "p_1",
      tableShape: createVariationTableShape("p_1"),
    });

    const shapes = nextDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    expect(draft).toMatchObject({ operation: "insertTableShape" });
    expect(nextDocument.content).toEqual(document.content);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({
      id: "ai_table_variation",
      type: "tableShape",
      anchor: { type: "block", blockId: "p_1" },
      props: {
        table: {
          kind: "variation",
        },
      },
    });
    const table = shapes[0]?.type === "tableShape" ? shapes[0].props.table : null;
    expect(table ? getTableCellMathTex(table, "table_cell_x_label") : undefined).toBe("x");
    expect(table ? getTableCellMathTex(table, "table_cell_x_left") : undefined).toBe("0<x<e");
    expect(table ? getTableCellMathTex(table, "table_cell_d_left") : undefined).toBe("+");
    expect(table ? getTableCellMathNode(table, "table_cell_x_label") : undefined).toMatchObject({
      semanticRole: "expression",
    });
  });

  it("inserts a CANVAS tableShape on a whiteboard without an anchor", () => {
    const document: SigmaDocument = {
      ...createDocument([]),
      pageLayout: getDefaultPageLayout("whiteboard"),
    };
    const tableShape = createVariationTableShape("CANVAS");
    tableShape.x = 420;
    tableShape.y = 260;

    const { nextDocument } = validateAiEditDraftForDocument(document, "CANVAS", {
      operation: "insertTableShape",
      summary: "ホワイトボードに表を挿入しました。",
      targetId: "CANVAS",
      tableShape,
    });

    const inserted = nextDocument.pageLayout?.overlay?.overlaySnapshot?.shapes[0];
    expect(inserted).toMatchObject({ id: "ai_table_variation", type: "tableShape", x: 420, y: 260 });
    expect(inserted).not.toHaveProperty("anchor");
  });

  it("normalizes loose AI tableShape output before inserting it", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "増減表を作成して" }],
      },
    ]);
    const looseShape = structuredClone(createVariationTableShape("p_1")) as unknown as {
      props: {
        table: {
          columns: Array<Record<string, unknown>>;
          rows: Array<Record<string, unknown>>;
          cells: Array<Record<string, unknown>>;
          grid?: unknown;
          defaultCellStyle?: unknown;
        };
      };
    };
    looseShape.props.table.columns[0].role = "unknown-role";
    looseShape.props.table.columns[0].width = { mode: "auto", min: 0 };
    looseShape.props.table.rows[0].height = { mode: "auto", min: 0 };
    looseShape.props.table.cells[1].content = [
      {
        type: "paragraph",
        id: "table_cell_x_left_p",
        children: [{ type: "text", text: "~" }],
      },
    ];
    looseShape.props.table.cells = looseShape.props.table.cells.slice(0, 2);
    delete looseShape.props.table.grid;
    delete looseShape.props.table.defaultCellStyle;

    const { nextDocument } = validateAiEditDraftForDocument(document, "p_1", {
      operation: "insertTableShape",
      summary: "ラフな表を補正して挿入しました。",
      targetId: "p_1",
      tableShape: looseShape,
    });

    const tableShape = nextDocument.pageLayout?.overlay?.overlaySnapshot?.shapes[0];
    expect(tableShape).toMatchObject({
      type: "tableShape",
      props: {
        table: {
          grid: { borderColor: "#111827", borderWidth: 1 },
          defaultCellStyle: { align: "center", verticalAlign: "middle" },
        },
      },
    });
    expect(tableShape?.type === "tableShape" ? tableShape.props.table.cells : []).toHaveLength(12);
    expect(tableShape?.type === "tableShape" ? getTableCellMathTex(tableShape.props.table, "table_cell_x_left") : undefined).toBe("\\sim");
  });

  it("rejects tableShape cells with invalid MathLive TeX", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);
    const tableShape = createVariationTableShape("p_1");
    const badCell = tableShape.props.table.cells[0];
    tableShape.props.table.cells[0] = {
      ...badCell,
      content: [
        {
          type: "paragraph",
          id: "table_p_bad",
          align: "center",
          children: [{ type: "mathInline", id: "table_m_bad", tex: "\\unknown{x}", display: "inline" }],
        },
      ],
    };

    expect(() =>
      validateAiEditDraftForDocument(document, "p_1", {
        operation: "insertTableShape",
        summary: "不正なTeXです。",
        targetId: "p_1",
        tableShape,
      }),
    ).toThrow("不正なMathLive TeX");
  });

  it("rejects insertAfter blocks with duplicate target IDs", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    expect(() =>
      validateAiEditDraftForDocument(document, "p_1", {
        operation: "insertAfter",
        summary: "IDが重複しています。",
        targetId: "p_1",
        insertedBlock: {
          type: "paragraph",
          id: "p_1",
          children: [{ type: "text", text: "追加本文" }],
        },
      }),
    ).toThrow("重複");
  });

  it("rejects overlay asset map keys that do not match asset.id", () => {
    const document = documentWithOverlayAssets({});

    expect(() => validateAiEditDraftForDocument(document, "anchor", {
      operation: "insertOverlayShape",
      summary: "画像を挿入しました。",
      targetId: "anchor",
      overlayShape: imageShape("shape_new", "asset_actual"),
      assets: { asset_wrong_key: imageAsset("asset_actual") },
    })).toThrow("asset mapのキーとasset.id");
  });

  it.each([
    "javascript:alert(1)",
    "file:///tmp/private.png",
    "blob:https://example.com/asset",
    "data:text/html,<script>alert(1)</script>",
    "http://example.com/image.png",
    "https://example.com/image.png",
    "http://127.0.0.1/image.png",
    "https://[::1]/image.png",
    "HtTpS://example.com/image.png",
    "//example.com/image.png",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  ])("rejects a non-allow-listed overlay asset source: %s", (src) => {
    const document = documentWithOverlayAssets({});

    expect(() => validateAiEditDraftForDocument(document, "anchor", {
      operation: "insertOverlayShape",
      summary: "画像を挿入しました。",
      targetId: "anchor",
      overlayShape: imageShape("shape_new", "asset_new"),
      assets: { asset_new: imageAsset("asset_new", src) },
    })).toThrow("ラスター画像・検証済み静的SVGのdata URLまたは内部ストレージ参照");
  });

  it("rejects an overlay asset data URL above the size limit", () => {
    const document = documentWithOverlayAssets({});
    // PNG header is 24 bytes (= base64 groups align), followed by >2 MiB decoded bytes.
    const oversizedSrc = `${VALID_PNG_DATA_URL}${"AAAA".repeat(Math.ceil((2 * 1024 * 1024 + 1) / 3))}`;

    expect(() => validateAiEditDraftForDocument(document, "anchor", {
      operation: "insertOverlayShape",
      summary: "画像を挿入しました。",
      targetId: "anchor",
      overlayShape: imageShape("shape_new", "asset_new"),
      assets: { asset_new: imageAsset("asset_new", oversizedSrc) },
    })).toThrow("ラスター画像・検証済み静的SVGのdata URLまたは内部ストレージ参照");
  });

  it.each([
    VALID_PNG_DATA_URL,
    VALID_JPEG_DATA_URL,
    VALID_WEBP_DATA_URL,
    "sigma-doc-storage://asset_new",
  ])("accepts an explicitly allow-listed overlay asset source: %s", (src) => {
    const document = documentWithOverlayAssets({});

    expect(() => validateAiEditDraftForDocument(document, "anchor", {
      operation: "insertOverlayShape",
      summary: "画像を挿入しました。",
      targetId: "anchor",
      overlayShape: imageShape("shape_new", "asset_new"),
      assets: { asset_new: imageAsset("asset_new", src) },
    })).not.toThrow();
  });

  it.each([
    "SIGMA-DOC-STORAGE://asset_new",
    "sigma-doc-storage://folder/asset_new",
    "sigma-doc-storage://asset_new?raw=1",
    `sigma-doc-storage://${"a".repeat(129)}`,
  ])("rejects a non-canonical internal asset reference: %s", (src) => {
    const document = documentWithOverlayAssets({});
    expect(() => validateAiEditDraftForDocument(document, "anchor", {
      operation: "insertOverlayShape",
      summary: "画像を挿入しました。",
      targetId: "anchor",
      overlayShape: imageShape("shape_new", "asset_new"),
      assets: { asset_new: imageAsset("asset_new", src) },
    })).toThrow("内部ストレージ参照");
  });

  it("caps image assets per operation", () => {
    const assets = Object.fromEntries(Array.from({ length: 17 }, (_, index) => {
      const id = `asset_${index}`;
      return [id, imageAsset(id, `sigma-doc-storage://${id}`)];
    }));
    expect(() => parseAiEditSessionDraft({
      summary: "画像を挿入",
      plan: ["画像を挿入"],
      operations: [{
        operation: "insertOverlayShape",
        summary: "画像を挿入",
        targetId: "anchor",
        overlayShape: imageShape("shape_new", "asset_0"),
        assets,
      }],
      warnings: [],
    })).toThrow("1操作に指定できる画像素材は16件まで");
  });

  it("caps total operation count per proposal", () => {
    expect(() => parseAiEditSessionDraft({
      summary: "大量の操作",
      plan: ["大量の操作"],
      operations: Array.from({ length: 257 }, (_, index) => ({
        operation: "insertAfter",
        summary: "追記",
        targetId: "anchor",
        insertedBlock: { type: "paragraph", id: `p_${index}`, children: [{ type: "text", text: "x" }] },
      })),
      warnings: [],
    })).toThrow("1提案に保存できる編集操作は256件まで");
  });

  it("caps total image asset count per proposal", () => {
    expect(() => parseAiEditSessionDraft({
      summary: "大量の画像",
      plan: ["大量の画像"],
      operations: Array.from({ length: 5 }, (_, operationIndex) => {
        const assets = Object.fromEntries(Array.from({ length: 13 }, (_, assetIndex) => {
          const id = `asset_${operationIndex}_${assetIndex}`;
          return [id, imageAsset(id, `sigma-doc-storage://${id}`)];
        }));
        return {
          operation: "insertOverlayShape",
          summary: "画像を挿入",
          targetId: "anchor",
          overlayShape: imageShape(`shape_${operationIndex}`, `asset_${operationIndex}_0`),
          assets,
        };
      }),
      warnings: [],
    })).toThrow("1提案に保存できる画像素材は64件まで");
  });

  it("caps total decoded image bytes per proposal", () => {
    const largePng = `${VALID_PNG_DATA_URL}${"AAAA".repeat(Math.ceil((1_750_000 - 24) / 3))}`;
    expect(() => parseAiEditSessionDraft({
      summary: "大量の画像",
      plan: ["大量の画像"],
      operations: Array.from({ length: 5 }, (_, index) => ({
        operation: "insertOverlayShape",
        summary: "画像を挿入",
        targetId: "anchor",
        overlayShape: imageShape(`shape_${index}`, `asset_${index}`),
        assets: { [`asset_${index}`]: imageAsset(`asset_${index}`, largePng) },
      })),
      warnings: [],
    })).toThrow("合計デコードサイズが上限");
  });

  it("counts the assets carried by updateOverlayShape against the same per-proposal byte budget", () => {
    const largePng = `${VALID_PNG_DATA_URL}${"AAAA".repeat(Math.ceil((1_750_000 - 24) / 3))}`;
    expect(() => parseAiEditSessionDraft({
      summary: "大量の派生画像",
      plan: ["大量の派生画像"],
      operations: [],
      mutationOperations: Array.from({ length: 5 }, (_, index) => ({
        operation: "updateOverlayShape",
        summary: "派生画像を差し替え",
        shapeId: `shape_${index}`,
        patch: { props: {} },
        assets: { [`asset_${index}`]: imageAsset(`asset_${index}`, largePng) },
      })),
      warnings: [],
    })).toThrow("合計デコードサイズが上限");
  });

  it.each([
    "data:image/png;base64,",
    "data:image/png;base64,!!!!",
    `${VALID_PNG_DATA_URL}=`,
    `${VALID_WEBP_DATA_URL}junk`,
    `data:image/jpeg;base64,${VALID_PNG_DATA_URL.split(",")[1]}`,
    `data:image/webp;base64,${VALID_PNG_DATA_URL.split(",")[1]}`,
  ])("rejects empty, malformed, trailing, or MIME-spoofed raster data: %s", (src) => {
    const document = documentWithOverlayAssets({});
    expect(() => validateAiEditDraftForDocument(document, "anchor", {
      operation: "insertOverlayShape",
      summary: "画像を挿入しました。",
      targetId: "anchor",
      overlayShape: imageShape("shape_new", "asset_new"),
      assets: { asset_new: imageAsset("asset_new", src) },
    })).toThrow("ラスター画像・検証済み静的SVGのdata URLまたは内部ストレージ参照");
  });

  it("rejects a small PNG payload whose intrinsic dimensions form a pixel bomb", () => {
    const header = "iVBORw0KGgoAAAANSUhEUgAAIAAAACAA"; // 8192 x 8192, only the PNG header bytes.
    const document = documentWithOverlayAssets({});
    expect(() => validateAiEditDraftForDocument(document, "anchor", {
      operation: "insertOverlayShape",
      summary: "画像を挿入しました。",
      targetId: "anchor",
      overlayShape: imageShape("shape_new", "asset_new"),
      assets: { asset_new: imageAsset("asset_new", `data:image/png;base64,${header}`) },
    })).toThrow("ラスター画像・検証済み静的SVGのdata URLまたは内部ストレージ参照");
  });

  it("blocks a non-identical overlay asset ID collision instead of overwriting the existing asset", () => {
    const existing = imageAsset("asset_shared", VALID_PNG_DATA_URL);
    const document = documentWithOverlayAssets({ asset_shared: existing });

    expect(() => validateAiEditDraftForDocument(document, "anchor", {
      operation: "insertOverlayShape",
      summary: "画像を挿入しました。",
      targetId: "anchor",
      overlayShape: imageShape("shape_new", "asset_shared"),
      assets: { asset_shared: imageAsset("asset_shared", `${VALID_PNG_DATA_URL}AAAA`) },
    })).toThrow("既存assetと競合");
    expect(document.pageLayout?.overlay?.overlaySnapshot?.assets.asset_shared).toStrictEqual(existing);
  });

  it("classifies asset-bearing overlay insertion as additive only when every asset ID is absent", () => {
    const operation = {
      operation: "insertOverlayShape" as const,
      summary: "画像を挿入しました。",
      targetId: "anchor",
      overlayShape: imageShape("shape_new", "asset_new"),
      assets: { asset_new: imageAsset("asset_new") },
    };
    const draft = {
      summary: operation.summary,
      plan: [operation.summary],
      operations: [operation],
      warnings: [],
    };

    expect(isAdditiveInsertOnlyDraft(draft)).toBe(false);
    expect(isAdditiveInsertOnlyDraft(draft, documentWithOverlayAssets({}))).toBe(true);
    expect(isAdditiveInsertOnlyDraft(
      draft,
      documentWithOverlayAssets({ asset_new: imageAsset("asset_new") }),
    )).toBe(false);
  });

  it("normalizes // row separators inside multiline MathLive environments", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    const { draft } = validateAiEditDraftForDocument(document, "p_1", {
      summary: "場合分けを追加しました。",
      targetId: "p_1",
      replacementBlock: {
        type: "paragraph",
        id: "p_1",
        children: [
          {
            type: "mathInline",
            id: "m_cases",
            tex: "\\begin{cases}x>0//x\\le0\\end{cases}",
            display: "inline",
          },
        ],
      },
    });

    expect(asReplaceDraft(draft).replacementBlock).toMatchObject({
      children: [{ tex: "\\begin{cases}x>0\\\\x\\le0\\end{cases}" }],
    });
  });

  it("does not rewrite ambiguous // that does not look like a newline", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    const { draft } = validateAiEditDraftForDocument(document, "p_1", {
      summary: "曖昧なスラッシュです。",
      targetId: "p_1",
      replacementBlock: {
        type: "paragraph",
        id: "p_1",
        children: [
          {
            type: "mathInline",
            id: "m_ambiguous",
            tex: "l//m",
            display: "inline",
          },
        ],
      },
    });

    expect(asReplaceDraft(draft).replacementBlock).toMatchObject({
      children: [{ tex: "l//m" }],
    });
  });

  it("applies multiple session operations sequentially", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "元の本文" }],
      },
      {
        type: "paragraph",
        id: "p_2",
        children: [{ type: "text", text: "次の本文" }],
      },
    ]);

    const { draft, nextDocument, operationResults } = validateAiEditSessionDraftForDocument(document, "p_1", {
      summary: "本文を直し、補足を追加しました。",
      plan: ["本文を説明的にする", "直後に補足を入れる"],
      operations: [
        {
          summary: "本文を説明的にしました。",
          targetId: "p_1",
          replacementBlock: {
            type: "paragraph",
            id: "p_1",
            children: [{ type: "text", text: "新しい本文" }],
          },
        },
        {
          operation: "insertAfter",
          summary: "補足を追加しました。",
          targetId: "p_1",
          insertedBlock: {
            type: "paragraph",
            id: "ai_p_note",
            children: [{ type: "text", text: "補足説明" }],
          },
        },
      ],
      warnings: [],
    });

    expect(operationResults).toHaveLength(2);
    expect(draft.operations.map((operation) => operation.summary)).toEqual([
      "本文を説明的にしました。",
      "補足を追加しました。",
    ]);
    expect(nextDocument.content.map((block) => block.id)).toEqual(["p_1", "ai_p_note", "p_2"]);
    expect(nextDocument.content[0]).toMatchObject({
      children: [{ text: "新しい本文" }],
    });
  });

  it("applies session operations by their target IDs without a selected block", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "元の本文" }],
      },
      {
        type: "paragraph",
        id: "p_2",
        children: [{ type: "text", text: "末尾の本文" }],
      },
    ]);

    const { draft, nextDocument } = createAiEditSessionDocumentDraft(document, null, {
      summary: "末尾に補足を追加しました。",
      plan: ["operationのtargetIdを挿入基準にする"],
      operations: [
        {
          operation: "insertAfter",
          summary: "補足を追加しました。",
          targetId: "p_2",
          insertedBlock: {
            type: "paragraph",
            id: "ai_p_unselected_note",
            children: [{ type: "text", text: "選択なしで追加した補足" }],
          },
        },
      ],
      warnings: [],
    });

    expect(draft.operations[0]).toMatchObject({
      operation: "insertAfter",
      targetId: "p_2",
    });
    expect(nextDocument.content.map((block) => block.id)).toEqual([
      "p_1",
      "p_2",
      "ai_p_unselected_note",
    ]);
  });

  it("adds an editable body paragraph after an inserted problem when no text flow block follows it", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "元の本文" }],
      },
    ]);

    const { nextDocument } = createAiEditSessionDocumentDraft(document, null, {
      summary: "問題を追加しました。",
      plan: ["問題として追加し、続けて本文を入力できるようにする"],
      operations: [
        {
          operation: "insertAfter",
          summary: "問題を追加しました。",
          targetId: "p_1",
          insertedBlock: createProblem("problem_inserted"),
        },
      ],
      warnings: [],
    });

    expect(nextDocument.content).toHaveLength(3);
    expect(nextDocument.content[1]).toMatchObject({ type: "problem", id: "problem_inserted" });
    expect(nextDocument.content[2]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "" }],
    });
  });

  it("does not add a duplicate body paragraph when the session inserts one after the problem", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "元の本文" }],
      },
    ]);

    const { nextDocument } = createAiEditSessionDocumentDraft(document, null, {
      summary: "問題と本文を追加しました。",
      plan: ["問題として追加する", "続きの本文を追加する"],
      operations: [
        {
          operation: "insertAfter",
          summary: "問題を追加しました。",
          targetId: "p_1",
          insertedBlock: createProblem("problem_inserted"),
        },
        {
          operation: "insertAfter",
          summary: "続きの本文を追加しました。",
          targetId: "problem_inserted",
          insertedBlock: {
            type: "paragraph",
            id: "p_after_problem",
            children: [{ type: "text", text: "続きの本文" }],
          },
        },
      ],
      warnings: [],
    });

    expect(nextDocument.content.map((block) => block.id)).toEqual([
      "p_1",
      "problem_inserted",
      "p_after_problem",
    ]);
  });

  it("rejects session operations that target missing IDs", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    expect(() =>
      validateAiEditSessionDraftForDocument(document, "p_1", {
        summary: "存在しない対象です。",
        plan: ["存在しないIDを編集する"],
        operations: [
          {
            summary: "失敗します。",
            targetId: "p_missing",
            replacementBlock: {
              type: "paragraph",
              id: "p_missing",
              children: [{ type: "text", text: "本文" }],
            },
          },
        ],
        warnings: [],
      }),
    ).toThrow("対象ブロック");
  });

  it("rejects session operations that introduce duplicate IDs", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
      {
        type: "paragraph",
        id: "p_2",
        children: [{ type: "text", text: "次の本文" }],
      },
    ]);

    expect(() =>
      createAiEditSessionDocumentDraft(document, "p_1", {
        summary: "重複IDです。",
        plan: ["既存IDで挿入する"],
        operations: [
          {
            operation: "insertAfter",
            summary: "重複IDを挿入します。",
            targetId: "p_1",
            insertedBlock: {
              type: "paragraph",
              id: "p_2",
              children: [{ type: "text", text: "重複" }],
            },
          },
        ],
        warnings: [],
      }),
    ).toThrow();
  });

  it("rejects session operations with invalid MathLive TeX", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ]);

    expect(() =>
      validateAiEditSessionDraftForDocument(document, "p_1", {
        summary: "不正なTeXです。",
        plan: ["不正なTeXへ置換する"],
        operations: [
          {
            summary: "不正なTeXを含みます。",
            targetId: "p_1",
            replacementBlock: {
              type: "paragraph",
              id: "p_1",
              children: [{ type: "mathInline", id: "m_bad", tex: "\\unknown{x}", display: "inline" }],
            },
          },
        ],
        warnings: [],
      }),
    ).toThrow("不正なMathLive TeX");
  });
});

describe("applySigmaDocMutationOp", () => {
  it("deep-merges a page-layout patch while preserving unspecified flow and running regions", () => {
    const document = ensurePageLayout(createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
    ]));
    document.pageLayout = {
      ...document.pageLayout!,
      flow: { type: "columns", columnCount: 2, columnGapMm: 12 },
      header: {
        enabled: true,
        heightMm: 8,
        offsetMm: 5,
        showOnFirstPage: false,
        blocks: [{ type: "paragraph", id: "header_1", children: [{ type: "text", text: "見出し" }] }],
      },
      footer: {
        enabled: true,
        heightMm: 7,
        offsetMm: 4,
        showOnFirstPage: true,
        blocks: [{ type: "paragraph", id: "footer_1", children: [{ type: "text", text: "{page}" }] }],
      },
    };

    const { op, nextDocument } = applySigmaDocMutationOp(document, {
      operation: "updatePageLayout",
      summary: "用紙を横向きにして右余白を変更しました。",
      patch: {
        orientation: "landscape",
        marginsMm: { right: 24 },
      },
    });

    expect(op.operation).toBe("updatePageLayout");
    expect(nextDocument.pageLayout).toMatchObject({
      preset: "A4",
      orientation: "landscape",
      pageSize: { widthMm: 297, heightMm: 210 },
      marginsMm: { top: 18, right: 24, bottom: 18, left: 17 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 12 },
    });
    expect(nextDocument.pageLayout?.header).toEqual(document.pageLayout?.header);
    expect(nextDocument.pageLayout?.footer).toEqual(document.pageLayout?.footer);
  });

  it("updates a custom paper preset with partial page dimensions", () => {
    const document = ensurePageLayout(createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
    ]));

    const { nextDocument: customDocument } = applySigmaDocMutationOp(document, {
      operation: "updatePageLayout",
      summary: "カスタム用紙サイズへ変更しました。",
      patch: {
        preset: "custom",
        pageSize: { widthMm: 160, heightMm: 240 },
      },
    });
    const { nextDocument } = applySigmaDocMutationOp(customDocument, {
      operation: "updatePageLayout",
      summary: "カスタム用紙幅だけを変更しました。",
      patch: {
        pageSize: { widthMm: 180 },
      },
    });

    expect(nextDocument.pageLayout).toMatchObject({
      preset: "custom",
      orientation: "portrait",
      pageSize: { widthMm: 180, heightMm: 240 },
    });
  });

  it("updates an empty document to a normalized whiteboard layout", () => {
    const document = ensurePageLayout(createDocument([]));

    const { nextDocument: whiteboardDocument } = applySigmaDocMutationOp(document, {
      operation: "updatePageLayout",
      summary: "無限キャンバスへ変更しました。",
      patch: {
        preset: "whiteboard",
        pageSize: { widthMm: 400, heightMm: 300 },
        marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      },
    });
    const { nextDocument } = applySigmaDocMutationOp(whiteboardDocument, {
      operation: "updatePageLayout",
      summary: "キャンバスの基準幅を変更しました。",
      patch: { pageSize: { widthMm: 500 } },
    });

    expect(nextDocument.pageLayout).toMatchObject({
      preset: "whiteboard",
      pageSize: { widthMm: 500, heightMm: 300 },
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
    });
    expect(nextDocument.pageLayout?.header).toBeUndefined();
    expect(nextDocument.pageLayout?.footer).toBeUndefined();
  });

  it("rejects changing a whiteboard back to a paper preset", () => {
    const document = ensurePageLayout({
      ...createDocument([]),
      pageLayout: getDefaultPageLayout("whiteboard"),
    });

    expect(() => applySigmaDocMutationOp(document, {
      operation: "updatePageLayout",
      summary: "A4へ変更しました。",
      patch: { preset: "A4" },
    })).toThrow("ホワイトボードから用紙形式へは変更できません");
  });

  it("rejects changing a document with body blocks to whiteboard", () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
    ]);

    expect(() => applySigmaDocMutationOp(document, {
      operation: "updatePageLayout",
      summary: "無限キャンバスへ変更しました。",
      patch: { preset: "whiteboard" },
    })).toThrow("無限キャンバス(ホワイトボード)モードの教材には本文ブロックを追加できません");
  });

  it("rejects non-positive custom dimensions and negative margins", () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
    ]);

    expect(() => applySigmaDocMutationOp(document, {
      operation: "updatePageLayout",
      summary: "不正な用紙幅です。",
      patch: { preset: "custom", pageSize: { widthMm: 0 } },
    })).toThrow("用紙サイズは0より大きい値");
    expect(() => applySigmaDocMutationOp(document, {
      operation: "updatePageLayout",
      summary: "不正な余白です。",
      patch: { marginsMm: { left: -1 } },
    })).toThrow("余白は0以上");
  });

  it(`requires page-layout margins to leave at least ${MIN_PAGE_BODY_HEIGHT_MM}mm of body height`, () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
    ]);
    const bottomMm = document.pageLayout?.marginsMm.bottom ?? 18;
    const exactMinimumTopMm = 297 - bottomMm - MIN_PAGE_BODY_HEIGHT_MM;

    const { nextDocument } = applySigmaDocMutationOp(document, {
      operation: "updatePageLayout",
      summary: "本文高さを最小値にしました。",
      patch: { marginsMm: { top: exactMinimumTopMm } },
    });
    expect(
      nextDocument.pageLayout!.pageSize.heightMm
        - nextDocument.pageLayout!.marginsMm.top
        - nextDocument.pageLayout!.marginsMm.bottom,
    ).toBe(MIN_PAGE_BODY_HEIGHT_MM);

    expect(() => applySigmaDocMutationOp(document, {
      operation: "updatePageLayout",
      summary: "本文高さが不足しています。",
      patch: { marginsMm: { top: exactMinimumTopMm + 0.1 } },
    // 文面は `shape.validation.pageMarginTooTall` に一本化した (以前は同じ趣旨の
    // 注意書きが二重に並んでいた)。
    })).toThrow(`本文を${MIN_PAGE_BODY_HEIGHT_MM}mm以上残す`);
  });

  it("sets document columns while preserving page preset, orientation, and margins", () => {
    const base = ensurePageLayout(createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
    ]));
    const document: SigmaDocument = {
      ...base,
      pageLayout: {
        ...base.pageLayout!,
        preset: "B5",
        orientation: "landscape",
        pageSize: { widthMm: 257, heightMm: 182 },
        marginsMm: { top: 11, right: 12, bottom: 13, left: 14 },
        flow: { type: "columns", columnCount: 1, columnGapMm: 6.5 },
        header: {
          enabled: true,
          heightMm: 6,
          offsetMm: 4,
          showOnFirstPage: true,
          blocks: [{ type: "paragraph", id: "header_p", children: [{ type: "text", text: "ヘッダー" }] }],
        },
        footer: {
          enabled: true,
          heightMm: 5,
          offsetMm: 4,
          showOnFirstPage: false,
          blocks: [{ type: "paragraph", id: "footer_p", children: [{ type: "text", text: "フッター" }] }],
        },
      },
    };
    const originalLayout = document.pageLayout!;

    const { nextDocument } = applySigmaDocMutationOp(document, {
      operation: "setDocumentColumns",
      summary: "文書全体を2段組みにしました。",
      columnCount: 2,
    });

    expect(nextDocument.pageLayout).toEqual({
      ...originalLayout,
      flow: { ...originalLayout.flow, columnCount: 2 },
    });
  });

  it("rejects an invalid document column count", () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
    ]);

    expect(() => applySigmaDocMutationOp(document, {
      operation: "setDocumentColumns",
      summary: "不正な段数です。",
      columnCount: 5,
    })).toThrow();
    expect(() => applySigmaDocMutationOp(document, {
      operation: "setDocumentColumns",
      summary: "段間が広すぎます。",
      columnCount: 4,
      columnGapMm: 100,
    })).toThrow("段組みの設定が不正");
  });

  it("wraps contiguous text-flow blocks in a layoutSection", () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "一" }] },
      { type: "paragraph", id: "p_2", children: [{ type: "text", text: "二" }] },
      { type: "paragraph", id: "p_3", children: [{ type: "text", text: "三" }] },
    ]);

    const { nextDocument } = applySigmaDocMutationOp(document, {
      operation: "wrapBlocksInColumns",
      summary: "2件を2段組みにしました。",
      blockIds: ["p_1", "p_2"],
      columnCount: 2,
      columnGapMm: 5,
    });

    expect(nextDocument.content).toHaveLength(2);
    expect(nextDocument.content[0]).toMatchObject({
      type: "layoutSection",
      layout: { columnCount: 2, columnGapMm: 5 },
      children: [{ id: "p_1" }, { id: "p_2" }],
    });
    expect(nextDocument.content[1]?.id).toBe("p_3");
  });

  it("rejects non-contiguous blocks when wrapping in columns", () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "一" }] },
      { type: "paragraph", id: "p_2", children: [{ type: "text", text: "二" }] },
      { type: "paragraph", id: "p_3", children: [{ type: "text", text: "三" }] },
    ]);

    expect(() => applySigmaDocMutationOp(document, {
      operation: "wrapBlocksInColumns",
      summary: "離れたブロックを段組みにします。",
      blockIds: ["p_1", "p_3"],
      columnCount: 2,
    })).toThrow("連続した本文ブロック");
  });

  it("rejects a one-column wrap because local wrapping starts at two columns", () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
    ]);

    expect(() => applySigmaDocMutationOp(document, {
      operation: "wrapBlocksInColumns",
      summary: "1段のsectionは作りません。",
      blockIds: ["p_1"],
      columnCount: 1,
    })).toThrow();
  });

  it("rejects non-text-flow blocks when wrapping in columns", () => {
    const document = createDocument([createProblem("problem_1")]);

    expect(() => applySigmaDocMutationOp(document, {
      operation: "wrapBlocksInColumns",
      summary: "problem全体は段組みにできません。",
      blockIds: ["problem_1"],
      columnCount: 2,
    })).toThrow("テキストフローブロック");
  });

  it("rejects blocks that are already inside a layoutSection", () => {
    const document = createDocument([{
      type: "layoutSection",
      id: "layout_1",
      layout: { columnCount: 2, columnGapMm: 8 },
      children: [{ type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] }],
    }]);

    expect(() => applySigmaDocMutationOp(document, {
      operation: "wrapBlocksInColumns",
      summary: "入れ子の段組みは作りません。",
      blockIds: ["p_1"],
      columnCount: 2,
    })).toThrow("既にローカル段組み内");
  });

  it("patches and unwraps an existing layoutSection", () => {
    const document = createDocument([{
      type: "layoutSection",
      id: "layout_1",
      layout: { columnCount: 2, columnGapMm: 8 },
      children: [
        { type: "paragraph", id: "p_1", children: [{ type: "text", text: "一" }] },
        { type: "paragraph", id: "p_2", children: [{ type: "text", text: "二" }] },
      ],
    }]);

    const patched = applySigmaDocMutationOp(document, {
      operation: "updateLayoutSection",
      summary: "段数を更新しました。",
      sectionId: "layout_1",
      columnCount: 3,
    }).nextDocument;
    expect(patched.content[0]).toMatchObject({
      type: "layoutSection",
      layout: { columnCount: 3, columnGapMm: 8 },
    });

    const gapPatched = applySigmaDocMutationOp(patched, {
      operation: "updateLayoutSection",
      summary: "段間を更新しました。",
      sectionId: "layout_1",
      columnGapMm: 4,
    }).nextDocument;
    expect(gapPatched.content[0]).toMatchObject({
      type: "layoutSection",
      layout: { columnCount: 3, columnGapMm: 4 },
    });

    const unwrapped = applySigmaDocMutationOp(gapPatched, {
      operation: "updateLayoutSection",
      summary: "段組みを解除しました。",
      sectionId: "layout_1",
      unwrap: true,
    }).nextDocument;
    expect(unwrapped.content.map((block) => block.id)).toEqual(["p_1", "p_2"]);
  });

  it("validates updateLayoutSection column values", () => {
    const document = createDocument([{
      type: "layoutSection",
      id: "layout_1",
      layout: { columnCount: 2 },
      children: [{ type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] }],
    }]);

    expect(() => applySigmaDocMutationOp(document, {
      operation: "updateLayoutSection",
      summary: "不正な段数です。",
      sectionId: "layout_1",
      columnCount: 0,
    })).toThrow();
  });

  it("deletes blocks from anywhere in the tree", () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "keep" }] },
      { type: "paragraph", id: "p_2", children: [{ type: "text", text: "drop" }] },
    ]);

    const { op, nextDocument } = applySigmaDocMutationOp(document, {
      operation: "deleteBlocks",
      summary: "不要な段落を削除しました。",
      blockIds: ["p_2"],
    });

    expect(op.operation).toBe("deleteBlocks");
    expect(nextDocument.content.map((block) => block.id)).toEqual(["p_1"]);
  });

  it("rejects deleteBlocks when a block id does not exist", () => {
    const document = createDocument([{ type: "paragraph", id: "p_1", children: [{ type: "text", text: "a" }] }]);

    expect(() =>
      applySigmaDocMutationOp(document, {
        operation: "deleteBlocks",
        summary: "存在しないIDを削除しようとしています。",
        blockIds: ["missing"],
      }),
    ).toThrow();
  });

  it("moves blocks before/after a target block", () => {
    const document = createDocument([
      { type: "paragraph", id: "a", children: [{ type: "text", text: "a" }] },
      { type: "paragraph", id: "b", children: [{ type: "text", text: "b" }] },
      { type: "paragraph", id: "c", children: [{ type: "text", text: "c" }] },
    ]);

    const { nextDocument } = applySigmaDocMutationOp(document, {
      operation: "moveBlocks",
      summary: "cをaの前に移動しました。",
      blockIds: ["c"],
      targetId: "a",
      position: "before",
    });

    expect(nextDocument.content.map((block) => block.id)).toEqual(["c", "a", "b"]);
  });

  it("rejects moveBlocks when the target is one of the moved blocks", () => {
    const document = createDocument([
      { type: "paragraph", id: "a", children: [{ type: "text", text: "a" }] },
      { type: "paragraph", id: "b", children: [{ type: "text", text: "b" }] },
    ]);

    expect(() =>
      applySigmaDocMutationOp(document, {
        operation: "moveBlocks",
        summary: "不正な移動です。",
        blockIds: ["a"],
        targetId: "a",
        position: "after",
      }),
    ).toThrow();
  });

  it("shallow-merges a patch into an overlay shape without allowing id/type changes", () => {
    const document = documentWithOverlayShapes([
      geoShape("shape_1", 10, 20, 40, 30),
    ]);

    const { nextDocument } = applySigmaDocMutationOp(document, {
      operation: "updateOverlayShape",
      summary: "図形の位置と色を更新しました。",
      shapeId: "shape_1",
      patch: { x: 99, id: "hacked_id", type: "text", props: { color: "#ff0000" } },
    });

    const shape = getOverlayShapes(nextDocument)[0];
    expect(shape).toMatchObject({
      id: "shape_1",
      type: "geo",
      x: 99,
      y: 20,
      props: { color: "#ff0000", w: 40, h: 30 },
    });
  });

  it("rejects updateOverlayShape when the shape does not exist", () => {
    const document = documentWithOverlayShapes([geoShape("shape_1", 0, 0, 10, 10)]);

    expect(() =>
      applySigmaDocMutationOp(document, {
        operation: "updateOverlayShape",
        summary: "存在しない図形です。",
        shapeId: "missing",
        patch: { x: 1 },
      }),
    ).toThrow();
  });

  it("writes the replacement assets an updateOverlayShape carries into the overlay snapshot", () => {
    const document = documentWithOverlayShapes([imageShape("shape_1", "asset_1")]);
    const withAsset = parseSigmaDocument({
      ...document,
      pageLayout: {
        ...document.pageLayout!,
        overlay: {
          overlaySnapshot: {
            version: 1,
            assets: { asset_1: imageAsset("asset_1"), asset_other: imageAsset("asset_other") },
            shapes: document.pageLayout!.overlay!.overlaySnapshot!.shapes,
          },
        },
      },
    });

    const { nextDocument } = applySigmaDocMutationOp(withAsset, {
      operation: "updateOverlayShape",
      summary: "派生画像を差し替えました。",
      shapeId: "shape_1",
      patch: { props: { assetId: "asset_1" } },
      assets: { asset_1: imageAsset("asset_1", VALID_JPEG_DATA_URL) },
    });

    const assets = nextDocument.pageLayout?.overlay?.overlaySnapshot?.assets ?? {};
    // 同じidへの上書きが要点 (派生画像は図形と1:1で、孤児を増やさない)。
    expect(assets.asset_1?.props.src).toBe(VALID_JPEG_DATA_URL);
    // 無関係のassetは残る。
    expect(assets.asset_other).toBeTruthy();
  });

  it("rejects updateOverlayShape assets whose source is not an allowed raster", () => {
    const document = documentWithOverlayShapes([imageShape("shape_1", "asset_1")]);

    expect(() =>
      applySigmaDocMutationOp(document, {
        operation: "updateOverlayShape",
        summary: "派生画像を差し替えました。",
        shapeId: "shape_1",
        patch: { props: {} },
        assets: { asset_1: imageAsset("asset_1", "data:image/svg+xml;base64,PHN2Zy8+") },
      }),
    ).toThrow();
  });

  it("aligns overlay shapes to the left edge", () => {
    const document = documentWithOverlayShapes([
      geoShape("shape_1", 10, 0, 40, 30),
      geoShape("shape_2", 50, 0, 20, 20),
    ]);

    const { nextDocument } = applySigmaDocMutationOp(document, {
      operation: "alignOverlayShapes",
      summary: "左端で揃えました。",
      shapeIds: ["shape_1", "shape_2"],
      mode: "left",
    });

    const shapes = getOverlayShapes(nextDocument);
    expect(shapes.find((shape) => shape.id === "shape_1")?.x).toBe(10);
    expect(shapes.find((shape) => shape.id === "shape_2")?.x).toBe(10);
  });

  it("distributes three or more overlay shapes evenly", () => {
    const document = documentWithOverlayShapes([
      geoShape("shape_1", 0, 0, 10, 10),
      geoShape("shape_2", 20, 0, 10, 10),
      geoShape("shape_3", 90, 0, 10, 10),
    ]);

    const { nextDocument } = applySigmaDocMutationOp(document, {
      operation: "alignOverlayShapes",
      summary: "均等に分布させました。",
      shapeIds: ["shape_1", "shape_2", "shape_3"],
      mode: "distributeX",
    });

    const shapes = getOverlayShapes(nextDocument);
    const middle = shapes.find((shape) => shape.id === "shape_2");
    // span = [0, 100], total width = 30, 2 gaps => gap = 35; shape_2 starts at 0 + 10 + 35 = 45.
    expect(middle?.x).toBe(45);
  });

  it("rejects distribute alignment with fewer than 3 shapes", () => {
    const document = documentWithOverlayShapes([
      geoShape("shape_1", 0, 0, 10, 10),
      geoShape("shape_2", 20, 0, 10, 10),
    ]);

    expect(() =>
      applySigmaDocMutationOp(document, {
        operation: "alignOverlayShapes",
        summary: "図形が足りません。",
        shapeIds: ["shape_1", "shape_2"],
        mode: "distributeX",
      }),
    ).toThrow();
  });

  it("deletes overlay shapes and cascade-deletes children of a deleted group", () => {
    const document = documentWithOverlayShapes([
      { id: "group_1", type: "group", x: 0, y: 0, props: { w: 100, h: 50 } },
      { ...geoShape("child_1", 0, 0, 20, 20), parentId: "group_1" },
      { ...geoShape("child_2", 40, 0, 20, 20), parentId: "group_1" },
      geoShape("standalone", 0, 0, 10, 10),
    ] as OverlayShape[]);

    const { nextDocument } = applySigmaDocMutationOp(document, {
      operation: "deleteOverlayShapes",
      summary: "グループごと削除しました。",
      shapeIds: ["group_1"],
    });

    const remainingIds = getOverlayShapes(nextDocument).map((shape) => shape.id);
    expect(remainingIds).toEqual(["standalone"]);
  });

  it("removes deleted label shape ids from graph2dShape label-ownership maps", () => {
    const spec: Graph2DSpec = {
      kind: "cartesian",
      title: "",
      width: 300,
      height: 200,
      viewBox: { xMin: "-5", xMax: "5", yMin: "-5", yMax: "5" },
      axes: { grid: true },
      curves: [{ id: "curve_1", expr: "x", color: "#000000" }],
    };
    const graphShape: OverlayShape = {
      id: "graph_1",
      type: "graph2dShape",
      x: 0,
      y: 0,
      props: {
        w: 300,
        h: 200,
        spec,
        labelTextShapeIdsByCurveId: { curve_1: "label_1" },
        labelTextShapeIds: ["label_1"],
      },
    };
    const labelShape = geoShape("label_1", 5, 5, 10, 10);
    const document = documentWithOverlayShapes([graphShape, labelShape]);

    const { nextDocument } = applySigmaDocMutationOp(document, {
      operation: "deleteOverlayShapes",
      summary: "ラベルを削除しました。",
      shapeIds: ["label_1"],
    });

    const nextGraphShape = getOverlayShapes(nextDocument).find((shape) => shape.id === "graph_1");
    expect(nextGraphShape?.type).toBe("graph2dShape");
    if (nextGraphShape?.type !== "graph2dShape") {
      return;
    }
    expect(nextGraphShape.props.labelTextShapeIdsByCurveId).toEqual({});
    expect(nextGraphShape.props.labelTextShapeIds).toEqual([]);
  });

  it("rejects deleteOverlayShapes when the shape does not exist", () => {
    const document = documentWithOverlayShapes([geoShape("shape_1", 0, 0, 10, 10)]);

    expect(() =>
      applySigmaDocMutationOp(document, {
        operation: "deleteOverlayShapes",
        summary: "存在しない図形です。",
        shapeIds: ["missing"],
      }),
    ).toThrow();
  });

  it("hints at delete_blocks when deleteOverlayShapes is given a body block id instead of a shape id", () => {
    const document = documentWithOverlayShapes([geoShape("shape_1", 0, 0, 10, 10)]);

    expect(() =>
      applySigmaDocMutationOp(document, {
        operation: "deleteOverlayShapes",
        summary: "本文ブロックIDを誤って渡した。",
        shapeIds: ["anchor"],
      }),
    ).toThrow("delete_blocks");
  });
});

// A pending MCP edit proposal's `draft` field (AiEditSessionDraft) is what a later "approve"
// persists to disk and later re-applies via createAiEditSessionDocumentDraft(currentDoc, null,
// proposal.draft) — see electron/main.ts's approve path. These tests pin that a mutationOperations-
// only draft (as produced by the new delete_blocks/move_blocks/update_shape/align_shapes/
// delete_shapes MCP tools) survives a JSON round-trip (as if written to and read back from the
// proposals directory) and re-applies cleanly, and that a stale target produces a clean error.
describe("createAiEditSessionDocumentDraft with mutationOperations (persisted MCP proposal round-trip)", () => {
  it("round-trips a deleteBlocks-only session draft through JSON and reproduces the same nextDocument on re-apply", () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "keep" }] },
      { type: "paragraph", id: "p_2", children: [{ type: "text", text: "drop" }] },
    ]);

    const created = createAiEditSessionDocumentDraft(document, null, {
      summary: "不要な段落を削除しました。",
      plan: ["p_2を削除する"],
      operations: [],
      mutationOperations: [{ operation: "deleteBlocks", summary: "不要な段落を削除しました。", blockIds: ["p_2"] }],
      warnings: [],
    });

    expect(created.nextDocument.content.map((block) => block.id)).toEqual(["p_1"]);

    // Simulate LocalMcpEditProposalStore persisting `draft` as JSON and reading it back.
    const persistedDraft = JSON.parse(JSON.stringify(created.draft));

    // parseSigmaDocument re-stamps `updatedAt` to "now" on every call, so compare content
    // (the part a mutation op can actually change) rather than the whole document.
    const reapplied = createAiEditSessionDocumentDraft(document, null, persistedDraft);
    expect(reapplied.nextDocument.content).toEqual(created.nextDocument.content);
  });

  it("throws a clean Japanese error re-applying a persisted mutationOperations draft whose target block has vanished", () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "keep" }] },
      { type: "paragraph", id: "p_2", children: [{ type: "text", text: "drop" }] },
    ]);

    const created = createAiEditSessionDocumentDraft(document, null, {
      summary: "不要な段落を削除しました。",
      plan: ["p_2を削除する"],
      operations: [],
      mutationOperations: [{ operation: "deleteBlocks", summary: "不要な段落を削除しました。", blockIds: ["p_2"] }],
      warnings: [],
    });
    const persistedDraft = JSON.parse(JSON.stringify(created.draft));

    // p_2 is already gone (e.g. a different proposal approved first) — re-applying against the
    // current document must fail with a readable message, not a generic crash.
    const documentWithTargetAlreadyGone = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "keep" }] },
    ]);

    expect(() => createAiEditSessionDocumentDraft(documentWithTargetAlreadyGone, null, persistedDraft))
      .toThrow(/ブロック/);
  });

  it("applies operations before mutationOperations, in that order, when a draft carries both", () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "元の本文" }] },
      { type: "paragraph", id: "p_2", children: [{ type: "text", text: "drop" }] },
    ]);

    const { nextDocument } = createAiEditSessionDocumentDraft(document, null, {
      summary: "本文を更新し、不要な段落を削除しました。",
      plan: ["p_1を更新する", "p_2を削除する"],
      operations: [
        {
          operation: "replace",
          summary: "本文を更新しました。",
          targetId: "p_1",
          replacementBlock: { type: "paragraph", id: "p_1", children: [{ type: "text", text: "更新後の本文" }] },
        },
      ],
      mutationOperations: [{ operation: "deleteBlocks", summary: "不要な段落を削除しました。", blockIds: ["p_2"] }],
      warnings: [],
    });

    expect(nextDocument.content.map((block) => block.id)).toEqual(["p_1"]);
    expect(nextDocument.content[0]).toMatchObject({ children: [{ text: "更新後の本文" }] });
  });

  it("preserves an explicit delete-before-insert order when the inserted problem reuses the deleted prompt id", () => {
    const document = createDocument([
      { type: "heading", id: "heading_1", level: 2, children: [{ type: "text", text: "教材" }] },
      { type: "paragraph", id: "prompt_1", children: [{ type: "text", text: "元の問題文" }] },
    ]);

    const created = createAiEditSessionDocumentDraft(document, null, {
      summary: "段落を問題形式にしました。",
      plan: ["元段落を削除する", "同じIDを問題文として再利用する"],
      operations: [{
        operation: "insertAfter",
        summary: "問題を作成しました。",
        targetId: "heading_1",
        insertedBlock: {
          type: "problem",
          id: "problem_1",
          tags: [],
          lead: [],
          prompt: [{ type: "paragraph", id: "prompt_1", children: [{ type: "text", text: "元の問題文" }] }],
          solution: [],
          hints: [],
        },
      }],
      mutationOperations: [{
        operation: "deleteBlocks",
        summary: "元段落を削除しました。",
        blockIds: ["prompt_1"],
      }],
      operationOrder: [
        { kind: "mutation", index: 0 },
        { kind: "operation", index: 0 },
      ],
      warnings: [],
    });

    const persistedDraft = JSON.parse(JSON.stringify(created.draft));
    const reapplied = createAiEditSessionDocumentDraft(document, null, persistedDraft);
    const problem = reapplied.nextDocument.content.find((block) => block.id === "problem_1");

    expect(reapplied.nextDocument.content.slice(0, 2).map((block) => block.id)).toEqual(["heading_1", "problem_1"]);
    expect(reapplied.nextDocument.content.some((block) => block.id === "prompt_1")).toBe(false);
    expect(problem).toMatchObject({
      type: "problem",
      prompt: [{ id: "prompt_1", children: [{ type: "text", text: "元の問題文" }] }],
    });
  });

});

function documentWithOverlayShapes(shapes: OverlayShape[]): SigmaDocument {
  const base = ensurePageLayout(
    createDocument([{ type: "paragraph", id: "anchor", children: [{ type: "text", text: "anchor" }] }]),
  );
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

function documentWithOverlayAssets(assets: Record<string, OverlayAsset>): SigmaDocument {
  const base = ensurePageLayout(
    createDocument([{ type: "paragraph", id: "anchor", children: [{ type: "text", text: "anchor" }] }]),
  );
  return parseSigmaDocument({
    ...base,
    pageLayout: {
      ...base.pageLayout!,
      overlay: {
        overlaySnapshot: { version: 1, assets, shapes: [] },
      },
    },
  });
}

function imageAsset(id: string, src = VALID_PNG_DATA_URL): OverlayAsset {
  return {
    id,
    type: "image",
    props: {
      w: 120,
      h: 80,
      name: `${id}.png`,
      isAnimated: false,
      mimeType: "image/png",
      src,
      fileSize: 4,
    },
  };
}

function imageShape(id: string, assetId: string): OverlayShape {
  return {
    id,
    type: "image",
    x: 10,
    y: 10,
    props: { assetId, w: 120, h: 80 },
  };
}

function getOverlayShapes(document: SigmaDocument): OverlayShape[] {
  return document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
}

function geoShape(id: string, x: number, y: number, w: number, h: number): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    props: {
      w,
      h,
      geo: "rectangle",
      fill: "none",
      color: "#111827",
      labelColor: "#111827",
      dash: "solid",
      size: "m",
    },
  };
}

function asReplaceDraft(draft: AiEditDraft): Extract<AiEditDraft, { replacementBlock: unknown }> {
  if (draft.operation === "insertAfter" || draft.operation === "insertTableShape" || draft.operation === "insertOverlayShape") {
    throw new Error("Expected a replacement draft.");
  }

  return draft;
}

function asInsertDraft(draft: AiEditDraft): Extract<AiEditDraft, { operation: "insertAfter" }> {
  if (draft.operation !== "insertAfter") {
    throw new Error("Expected an insertAfter draft.");
  }

  return draft;
}

function createVariationTableShape(targetId: string): OverlayTableShape {
  const columns = [
    { id: "table_col_label", width: { mode: "auto", min: 48, max: 96 } as const, role: "label" as const },
    { id: "table_col_left", width: { mode: "fr", value: 1, min: 60 } as const, role: "interval" as const },
    { id: "table_col_point", width: { mode: "auto", min: 56, max: 96 } as const, role: "point" as const },
    { id: "table_col_right", width: { mode: "fr", value: 1, min: 60 } as const, role: "interval" as const },
  ];
  const rows = [
    { id: "table_row_x", height: { mode: "auto", min: 32 } as const, role: "variable" as const },
    { id: "table_row_derivative", height: { mode: "auto", min: 32 } as const, role: "derivative" as const },
    { id: "table_row_variation", height: { mode: "auto", min: 38 } as const, role: "variation" as const },
  ];

  return {
    id: "ai_table_variation",
    type: "tableShape",
    x: 0,
    y: 44,
    rotation: 0,
    anchor: { type: "block", blockId: targetId, dy: 44, dx: 0 },
    props: {
      w: 360,
      h: 126,
      table: {
        version: 1,
        kind: "variation",
        columns,
        rows,
        cells: [
          tableTextCell("table_cell_x_label", rows[0].id, columns[0].id, "x"),
          tableTextCell("table_cell_x_left", rows[0].id, columns[1].id, "0<x<e"),
          tableMathCell("table_cell_x_point", rows[0].id, columns[2].id, "e"),
          tableTextCell("table_cell_x_right", rows[0].id, columns[3].id, "x>e"),
          tableMathCell("table_cell_d_label", rows[1].id, columns[0].id, "f'(x)"),
          tableTextCell("table_cell_d_left", rows[1].id, columns[1].id, "+"),
          tableTextCell("table_cell_d_point", rows[1].id, columns[2].id, "0"),
          tableTextCell("table_cell_d_right", rows[1].id, columns[3].id, "-"),
          tableMathCell("table_cell_f_label", rows[2].id, columns[0].id, "f(x)"),
          tableTrendCell("table_cell_f_left", rows[2].id, columns[1].id, "up"),
          tableMathCell("table_cell_f_point", rows[2].id, columns[2].id, "\\frac{1}{e}"),
          tableTrendCell("table_cell_f_right", rows[2].id, columns[3].id, "down"),
        ],
        grid: {
          borderColor: "#111827",
          borderWidth: 1,
          borderStyle: "solid",
          showOuterBorder: true,
          showInnerBorders: true,
        },
        defaultCellStyle: {
          align: "center",
          verticalAlign: "middle",
          paddingX: 8,
          paddingY: 5,
          color: "#111827",
          fontSize: 15,
          fontWeight: "normal",
        },
      },
    },
  };
}

function tableTextCell(id: string, rowId: string, columnId: string, text: string) {
  return {
    id,
    rowId,
    columnId,
    content: [{ type: "paragraph" as const, id: `${id}_p`, align: "center" as const, children: [{ type: "text" as const, text }] }],
  };
}

function tableMathCell(id: string, rowId: string, columnId: string, tex: string) {
  return {
    id,
    rowId,
    columnId,
    content: [{
      type: "paragraph" as const,
      id: `${id}_p`,
      align: "center" as const,
      children: [{ type: "mathInline" as const, id: `${id}_m`, tex, display: "inline" as const }],
    }],
  };
}

function tableTrendCell(id: string, rowId: string, columnId: string, direction: "up" | "down" | "flat") {
  return {
    id,
    rowId,
    columnId,
    content: [{ type: "trend" as const, id: `${id}_trend`, direction }],
  };
}

function getTableCellMathTex(table: OverlayTableShape["props"]["table"], cellId: string): string | undefined {
  return getTableCellMathNode(table, cellId)?.tex;
}

function getTableCellMathNode(table: OverlayTableShape["props"]["table"], cellId: string) {
  const cell = table.cells.find((item) => item.id === cellId);
  const content = cell?.content[0];
  if (content?.type !== "paragraph") {
    return undefined;
  }

  const child = content.children[0];
  return child?.type === "mathInline" ? child : undefined;
}

function createDocument(content: SigmaBlock[]): SigmaDocument {
  return parseSigmaDocument({
    version: "2.0",
    docId: "doc_test",
    metadata: { title: "テスト教材" },
    content,
    outputProfiles: {
      student: {},
      teacher: { showSolutions: true, showHints: true },
      answerBook: { onlySolutions: true, includeAnswers: true },
    },
  });
}

function createProblem(id: string): SigmaBlock {
  return {
    type: "problem",
    id,
    tags: ["方程式"],
    lead: [],
    prompt: [
      {
        type: "paragraph",
        id: "prompt_1",
        children: [{ type: "text", text: "x + 1 = 3 を解きなさい。" }],
      },
    ],
    answer: {
      type: "math",
      expected: "x=2",
    },
    solution: [
      {
        type: "paragraph",
        id: "solution_1",
        children: [{ type: "text", text: "両辺から1を引きます。" }],
      },
    ],
    hints: [],
  };
}
