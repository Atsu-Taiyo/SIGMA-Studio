import {
  evaluateTableFormulas,
  inlineNodesToPlainText,
  overlayTextBlockInlineRuns,
  overlayTextBlocksToInlineNodes,
} from "@/features/document";
import { describe, expect, it } from "vitest";

import { createGraphShapeProps } from "@/components/editor/overlay-canvas/shapes/graph";
import { createTableShapeProps } from "@/components/editor/overlay-canvas/shapes/table";
import type {
  InlineNode,
  ListItemContinuationNode,
  OverlayAsset,
  OverlayShape,
  OverlayTextBlock,
  SigmaTableSpec,
} from "@/features/document";
import { createGraph3DSpecPreset } from "@/features/drawing";
import { buildGraph3DPresetNames } from "@/lib/graph3d-preset-names";
import { createTranslator } from "@/lib/i18n";
import {
  cloneDocumentBlocksForPaste,
  cloneOverlayShapesForPaste,
  cloneTextFlowBlocksForPaste,
  createDocumentBlocksClipboardPayload,
  createEditorClipboardHtml,
  createInlineMathClipboardPayload,
  createOverlayClipboardPayload,
  createTiptapSliceClipboardPayload,
  createTextAndShapesClipboardPayload,
  createTextFlowClipboardPayload,
  getEditorClipboardPlainText,
  parseEditorClipboardHtml,
  parseEditorClipboardPayload,
  serializeEditorClipboardPayload,
  toOverlayShapesClipboardPayload,
  type ClipboardTextFlowBlock,
} from "@/lib/editor-clipboard";

describe("editor clipboard", () => {
  it("copies and remaps a derived 3D preview asset without changing its canonical spec", () => {
    const preview: OverlayAsset = {
      id: "preview_source",
      type: "image",
      props: {
        w: 640,
        h: 440,
        name: "3D preview.png",
        isAnimated: false,
        mimeType: "image/png",
        src: "data:image/png;base64,AA==",
        fileSize: 1,
      },
    };
    const spec = createGraph3DSpecPreset("revolution", buildGraph3DPresetNames(createTranslator("ja", "shape")));
    const shape: OverlayShape = {
      id: "graph3d_source",
      type: "graph3dShape",
      x: 20,
      y: 30,
      props: {
        w: 320,
        h: 220,
        spec,
        previewAssetId: preview.id,
        previewSourceHash: "fnv1a32:test",
      },
    };

    const payload = createOverlayClipboardPayload([shape], { [preview.id]: preview });
    expect(payload.assets).toEqual({ [preview.id]: preview });

    const pasted = cloneOverlayShapesForPaste(payload);
    const pastedShape = pasted.shapes[0];
    expect(pastedShape.type).toBe("graph3dShape");
    if (pastedShape.type !== "graph3dShape") return;
    expect(pastedShape.props.spec).toEqual(spec);
    expect(pastedShape.props.previewAssetId).not.toBe(preview.id);
    expect(pasted.assets[pastedShape.props.previewAssetId ?? ""]?.props.src).toBe(preview.props.src);
  });

  it("round-trips a mixed text and shapes payload without replacing its rich HTML", () => {
    const shape = {
      id: "mixed_shape",
      type: "geo" as const,
      x: 12,
      y: 34,
      props: {
        w: 80,
        h: 40,
        geo: "rectangle" as const,
        fill: "none" as const,
        color: "#111111",
        labelColor: "#111111",
        dash: "solid" as const,
        size: "m" as const,
      },
    };
    const payload = createTextAndShapesClipboardPayload(
      { slice: { content: [{ type: "paragraph" }] }, text: "本文" },
      [shape],
      {},
      "doc_source",
    );
    const html = createEditorClipboardHtml(payload, "<p><strong>本文</strong></p>");

    expect(parseEditorClipboardPayload(serializeEditorClipboardPayload(payload))).toEqual(payload);
    expect(parseEditorClipboardHtml(html)).toEqual(payload);
    expect(html).toContain("<p><strong>本文</strong></p>");
    expect(getEditorClipboardPlainText(payload)).toBe("本文");
    expect(toOverlayShapesClipboardPayload(payload)).toMatchObject({ kind: "overlayShapes", shapes: [shape] });
  });

  it("rejects an overlay clipboard payload whose text shape is not in canonical block form", () => {
    const serialized = JSON.stringify({
      type: "application/sigma-studio",
      version: 1,
      kind: "overlayShapes",
      shapes: [{
        id: "legacy_text",
        type: "text",
        x: 0,
        y: 0,
        props: {
          w: 120,
          richText: { type: "doc", content: [{ type: "mathInline", attrs: { id: "m1", tex: "x" } }] },
          autoSize: true,
          color: "black",
          size: "m",
        },
      }],
      assets: {},
    });

    // Pasting is one of the boundaries the schema guards; nothing translates an older content
    // representation on the way in, so the whole payload is refused rather than half-read.
    expect(parseEditorClipboardPayload(serialized)).toBeNull();
  });

  /**
   * A pasted copy is a new shape holding the same words. Every block, list item and inline math
   * node therefore needs a fresh id — two blocks sharing one id is what makes an edit to the copy
   * land on the original — while the text itself must come through untouched.
   */
  it("gives a pasted text shape fresh block ids and the same content", () => {
    const original: OverlayShape = {
      id: "text_source",
      type: "text",
      x: 10,
      y: 20,
      rotation: 0,
      props: {
        w: 200,
        h: 48,
        color: "#111827",
        size: "m",
        blocks: [{
          type: "list",
          id: "list_1",
          listType: "bullet",
          items: [{
            type: "listItem",
            id: "li_1",
            children: [
              { type: "text", text: "項目" },
              { type: "mathInline", id: "math_1", tex: "x^2", display: "inline" },
            ],
            continuations: [{
              type: "paragraph",
              id: "li_1_cont",
              children: [
                { type: "text", text: "続き" },
                { type: "mathInline", id: "math_2", tex: "y=1", display: "inline" },
              ],
            }],
            nested: [{
              type: "list",
              id: "list_2",
              listType: "bullet",
              items: [{ type: "listItem", id: "li_2", children: [{ type: "text", text: "入れ子" }] }],
            }],
          }],
        }],
      },
    };

    const copy = cloneOverlayShapesForPaste({
      type: "application/sigma-studio",
      version: 1,
      kind: "overlayShapes",
      shapes: [original],
      assets: {},
    }).shapes[0] as Extract<OverlayShape, { type: "text" }>;

    const originalIds = collectBlockIds(original.props.blocks);
    const copiedIds = collectBlockIds(copy.props.blocks);

    expect(copiedIds).toHaveLength(originalIds.length);
    expect(copiedIds.some((id) => originalIds.includes(id))).toBe(false);
    expect(plainTextOf(copy.props.blocks)).toBe(plainTextOf(original.props.blocks));
    expect(copy.props).toMatchObject({ w: 200, h: 48, size: "m" });
  });

  it("round-trips an inline math payload", () => {
    const payload = createInlineMathClipboardPayload("x^2+1");

    expect(parseEditorClipboardPayload(serializeEditorClipboardPayload(payload))).toEqual(payload);
    expect(parseEditorClipboardHtml(createEditorClipboardHtml(payload))).toEqual(payload);
    expect(getEditorClipboardPlainText(payload)).toBe("$x^2+1$");
  });

  it("writes the (1) marker style into the plain-text flavour and keeps it on the payload", () => {
    const blocks: ClipboardTextFlowBlock[] = [{
      type: "list",
      id: "list_paren",
      listType: "ordered",
      markerStyle: "paren",
      start: 2,
      items: [
        { type: "listItem", id: "li_1", children: [{ type: "text", text: "ひとつめ" }] },
        { type: "listItem", id: "li_2", children: [{ type: "text", text: "ふたつめ" }] },
      ],
    }];
    const payload = createTextFlowClipboardPayload(blocks);

    expect(getEditorClipboardPlainText(payload)).toBe("(2) ひとつめ\n(3) ふたつめ");
    expect(parseEditorClipboardPayload(serializeEditorClipboardPayload(payload))).toEqual(payload);
  });

  it("round-trips a column section with its pagination hints", () => {
    // 段組はクリップボードから外れていた (跨ぎコピーでも貼り付けでも黙って落ちていた)。
    const blocks: ClipboardTextFlowBlock[] = [{
      type: "layoutSection",
      id: "layout_1",
      layout: { columnCount: 3, columnGapMm: 12 },
      pagination: { break: true },
      children: [
        { type: "paragraph", id: "layout_p1", children: [{ type: "text", text: "左" }] },
        { type: "paragraph", id: "layout_p2", children: [{ type: "text", text: "右" }] },
      ],
    }];
    const payload = createTextFlowClipboardPayload(blocks);

    expect(getEditorClipboardPlainText(payload)).toBe("左\n右");
    expect(parseEditorClipboardPayload(serializeEditorClipboardPayload(payload))).toEqual(payload);
  });

  it("gives a pasted column section and its children fresh ids", () => {
    const [pasted] = cloneTextFlowBlocksForPaste([{
      type: "layoutSection",
      id: "layout_1",
      layout: { columnCount: 2 },
      children: [{ type: "paragraph", id: "layout_p1", children: [{ type: "text", text: "左" }] }],
    }]);

    expect(pasted?.type).toBe("layoutSection");
    expect(pasted?.id).not.toBe("layout_1");
    if (pasted?.type === "layoutSection") {
      expect(pasted.children[0]?.id).not.toBe("layout_p1");
      expect(pasted.layout).toEqual({ columnCount: 2 });
    }
  });

  it("refuses a column section nested inside another column section", () => {
    // 段の中に段組は入れられない (SigmaDoc の LayoutSectionChildBlock と同じ規約)。
    // 型では作れない形なので、クリップボード上の JSON として直接与えて検査する。
    const serialized = JSON.stringify({
      type: "application/sigma-studio",
      version: 1,
      kind: "textFlowBlocks",
      blocks: [{
        type: "layoutSection",
        id: "layout_outer",
        layout: { columnCount: 2 },
        children: [{
          type: "layoutSection",
          id: "layout_inner",
          layout: { columnCount: 2 },
          children: [{ type: "paragraph", id: "p", children: [] }],
        }],
      }],
    });

    expect(parseEditorClipboardPayload(serialized)).toBeNull();
  });

  it("keeps writing plain decimals for lists without a marker style", () => {
    const payload = createTextFlowClipboardPayload([{
      type: "list",
      id: "list_decimal",
      listType: "ordered",
      items: [{ type: "listItem", id: "li_1", children: [{ type: "text", text: "ひとつめ" }] }],
    }]);

    expect(getEditorClipboardPlainText(payload)).toBe("1. ひとつめ");
  });

  it("pastes a list with an unknown marker style as a plain decimal list", () => {
    const blocks = [{
      type: "list",
      id: "list_bad",
      listType: "ordered",
      markerStyle: "roman",
      items: [{ type: "listItem", id: "li_1", children: [{ type: "text", text: "本文" }] }],
    }] as unknown as ClipboardTextFlowBlock[];

    const [pasted] = cloneTextFlowBlocksForPaste(blocks);
    expect(pasted).not.toHaveProperty("markerStyle");
    expect(pasted).toMatchObject({ type: "list", listType: "ordered" });
  });

  it("drops a marker style that a bullet list should never carry", () => {
    const blocks = [{
      type: "list",
      id: "list_bullet",
      listType: "bullet",
      markerStyle: "paren",
      items: [{ type: "listItem", id: "li_1", children: [{ type: "text", text: "本文" }] }],
    }] as unknown as ClipboardTextFlowBlock[];

    expect(cloneTextFlowBlocksForPaste(blocks)[0]).not.toHaveProperty("markerStyle");
  });

  it("keeps a known marker style through the paste clone", () => {
    const blocks: ClipboardTextFlowBlock[] = [{
      type: "list",
      id: "list_paren",
      listType: "ordered",
      markerStyle: "paren",
      items: [{ type: "listItem", id: "li_1", children: [{ type: "text", text: "本文" }] }],
    }];

    expect(cloneTextFlowBlocksForPaste(blocks)[0]).toMatchObject({ markerStyle: "paren" });
  });

  it("round-trips a Tiptap slice payload for mixed text and inline math selections", () => {
    const payload = createTiptapSliceClipboardPayload(
      {
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "本文 " },
              { type: "mathInline", attrs: { id: "math_source", tex: "x^2+1" } },
              { type: "text", text: " の確認" },
            ],
          },
        ],
      },
      "本文 $x^2+1$ の確認",
    );

    expect(parseEditorClipboardPayload(serializeEditorClipboardPayload(payload))).toEqual(payload);
    expect(parseEditorClipboardHtml(createEditorClipboardHtml(payload))).toEqual(payload);
    expect(getEditorClipboardPlainText(payload)).toBe("本文 $x^2+1$ の確認");
  });

  it("round-trips clipboard payloads through json and html", () => {
    const payload = createTextFlowClipboardPayload([
      {
        type: "paragraph",
        id: "p_source",
        align: "center",
        lineHeight: "1.75",
        children: [
          { type: "text", text: "二次方程式", marks: ["bold"], color: "#dc2626", fontSize: 18 },
          {
            type: "mathInline",
            id: "math_source",
            tex: "x^2",
            display: "inline",
            semanticRole: "expression",
          },
        ],
      },
    ]);

    expect(parseEditorClipboardPayload(serializeEditorClipboardPayload(payload))).toEqual(payload);
    expect(parseEditorClipboardHtml(createEditorClipboardHtml(payload))).toEqual(payload);

    const invalid = JSON.parse(serializeEditorClipboardPayload(payload));
    invalid.version = 999;
    expect(parseEditorClipboardPayload(JSON.stringify(invalid))).toBeNull();

    invalid.version = 1;
    invalid.kind = "unknown";
    expect(parseEditorClipboardPayload(JSON.stringify(invalid))).toBeNull();
  });

  it("clones text flow blocks while preserving style and refreshing ids", () => {
    const blocks: ClipboardTextFlowBlock[] = [
      {
        type: "heading",
        id: "heading_source",
        level: 2,
        align: "right",
        lineHeight: "1.5",
        children: [
          { type: "text", text: "見出し", marks: ["underline"] },
          {
            type: "mathInline",
            id: "math_source",
            tex: "a+b",
            display: "inline",
            semanticRole: "expression",
          },
        ],
      },
    ];

    const [clone] = cloneTextFlowBlocksForPaste(blocks);
    expect(clone).toMatchObject({
      type: "heading",
      level: 2,
      align: "right",
      lineHeight: "1.5",
      children: [
        { type: "text", text: "見出し", marks: ["underline"] },
        { type: "mathInline", tex: "a+b", display: "inline" },
      ],
    });
    expect(clone.id).not.toBe("heading_source");
    expect(clone.type).toBe("heading");
    if (clone.type === "heading" && clone.children[1].type === "mathInline") {
      expect(clone.children[1].id).not.toBe("math_source");
    }
  });

  it("round-trips and clones a copied problem block", () => {
    const payload = createDocumentBlocksClipboardPayload([
      {
        type: "problem",
        id: "problem_source",
        tags: [],
        lead: [],
        prompt: [
          {
            type: "paragraph",
            id: "prompt_source",
            children: [
              { type: "text", text: "次を解け。" },
              {
                type: "mathInline",
                id: "math_source",
                tex: "x^2=1",
                display: "inline",
              },
            ],
          },
        ],
        answer: { type: "math", expected: "x=\\pm 1" },
        solution: [
          {
            type: "paragraph",
            id: "solution_source",
            children: [{ type: "text", text: "因数分解する。" }],
          },
        ],
        hints: [],
      },
    ]);

    expect(parseEditorClipboardPayload(serializeEditorClipboardPayload(payload))).toEqual(payload);
    expect(parseEditorClipboardHtml(createEditorClipboardHtml(payload))).toEqual(payload);
    expect(getEditorClipboardPlainText(payload)).toContain("次を解け。");

    const [clone] = cloneDocumentBlocksForPaste(payload.blocks);
    expect(clone.type).toBe("problem");
    expect(clone.id).not.toBe("problem_source");
    if (clone.type === "problem") {
      expect(clone.prompt[0]?.id).not.toBe("prompt_source");
      expect(clone.solution[0]?.id).not.toBe("solution_source");
      const promptBlock = clone.prompt[0];
      const mathNode = promptBlock?.type === "paragraph" || promptBlock?.type === "heading"
        ? promptBlock.children[1]
        : undefined;
      expect(mathNode?.type).toBe("mathInline");
      if (mathNode?.type === "mathInline") {
        expect(mathNode.id).not.toBe("math_source");
      }
    }
  });

  it("運ぶ: 問題エリアの中の箱と段組 (検証が段落しか通さず落としていた)", () => {
    const payload = createDocumentBlocksClipboardPayload([
      {
        type: "problem",
        id: "problem_source",
        tags: [],
        lead: [],
        prompt: [
          {
            type: "boxBlock",
            id: "box_source",
            styleId: "fancybox",
            title: [{ type: "text", text: "定理" }],
            blocks: [{ type: "paragraph", id: "box_p_source", children: [{ type: "text", text: "箱の中身" }] }],
          },
        ],
        solution: [
          {
            type: "layoutSection",
            id: "layout_source",
            layout: { columnCount: 2 },
            children: [
              { type: "paragraph", id: "col1_source", children: [{ type: "text", text: "左" }] },
              { type: "paragraph", id: "col2_source", children: [{ type: "text", text: "右" }] },
            ],
          },
        ],
        hints: [],
      },
    ]);

    // 別ウィンドウ / 別アプリからの貼り付けはこの経路を通る。
    const parsed = parseEditorClipboardHtml(createEditorClipboardHtml(payload));
    expect(parsed).toEqual(payload);
    expect(getEditorClipboardPlainText(payload)).toContain("箱の中身");

    const [clone] = cloneDocumentBlocksForPaste(payload.blocks);
    expect(clone.type).toBe("problem");
    if (clone.type === "problem") {
      const box = clone.prompt[0];
      expect(box?.type).toBe("boxBlock");
      expect(box?.id).not.toBe("box_source");
      if (box?.type === "boxBlock") {
        expect(box.blocks[0]?.id).not.toBe("box_p_source");
      }
      const section = clone.solution[0];
      expect(section?.type).toBe("layoutSection");
      expect(section?.id).not.toBe("layout_source");
      if (section?.type === "layoutSection") {
        expect(section.children.map((child) => child.id)).not.toContain("col1_source");
        expect(section.children).toHaveLength(2);
      }
    }
  });

  it("捨てる: 文書に入れられないブロック", () => {
    const payload = createDocumentBlocksClipboardPayload([
      { type: "problem", id: "problem_source", tags: [] } as never,
    ]);

    expect(parseEditorClipboardPayload(serializeEditorClipboardPayload(payload))).toBeNull();
  });

  it("貼り付けは中身の id を全部振り直す (リスト項目の続き・入れ子も)", () => {
    const [clone] = cloneTextFlowBlocksForPaste([
      {
        type: "list",
        id: "list_source",
        listType: "ordered",
        items: [
          {
            type: "listItem",
            id: "li_source",
            children: [{ type: "text", text: "1つ目" }],
            continuations: [
              {
                type: "paragraph",
                id: "cont_source",
                children: [{ type: "mathInline", id: "math_source", tex: "x", display: "inline" }],
              },
            ],
            nested: [
              {
                type: "list",
                id: "nested_source",
                listType: "bullet",
                items: [{ type: "listItem", id: "nested_li_source", children: [] }],
              },
            ],
          },
        ],
      },
    ]);

    const ids = JSON.stringify(clone);
    for (const sourceId of ["list_source", "li_source", "cont_source", "math_source", "nested_source", "nested_li_source"]) {
      expect(ids).not.toContain(sourceId);
    }
  });

  it("clones overlay shapes with fresh shape, asset, rich text, and graph ids", () => {
    const graphProps = createGraphShapeProps("sine");
    const tableProps = createTableShapeProps("plain", 240, 120);
    tableProps.table.cells[0] = {
      ...tableProps.table.cells[0],
      content: [
        {
          type: "paragraph",
          id: "table_p_source",
          children: [{
            type: "mathInline",
            id: "table_math_source",
            tex: "x^2",
            display: "inline",
          }],
        },
      ],
    };
    const asset: OverlayAsset = {
      id: "asset_source",
      type: "image",
      props: {
        w: 80,
        h: 50,
        name: "shape.svg",
        isAnimated: false,
        mimeType: "image/svg+xml",
        src: "data:image/svg+xml,<svg></svg>",
        fileSize: 28,
      },
    };
    const shapes: OverlayShape[] = [
      {
        id: "shape_rect",
        type: "geo",
        x: 10,
        y: 20,
        rotation: Math.PI / 8,
        props: {
          w: 120,
          h: 80,
          geo: "rectangle",
          fill: "none",
          color: "black",
          labelColor: "black",
          dash: "solid",
          size: "m",
        },
      },
      {
        id: "shape_text",
        type: "text",
        x: 40,
        y: 60,
        props: {
          w: 220,
          h: 16,
          color: "black",
          size: "m",
          blocks: [
            {
              type: "paragraph",
              id: "p_clip_text",
              children: [{
                type: "mathInline",
                id: "text_math_source",
                tex: "x^2",
                display: "inline",
              }],
            },
          ],
        },
      },
      {
        id: "shape_graph",
        type: "graph2dShape",
        x: 80,
        y: 90,
        props: {
          ...graphProps,
          spec: {
            ...graphProps.spec,
            points: [{ id: "point_source", x: "1", y: "0" }],
            annotations: [{ id: "annotation_source", x: "0", y: "1", text: "A" }],
            fills: [{ id: "fill_source", x: "0.5", y: "0.5" }],
          },
        },
      },
      {
        id: "shape_image",
        type: "image",
        x: 120,
        y: 140,
        props: {
          assetId: asset.id,
          w: 80,
          h: 50,
        },
      },
      {
        id: "shape_table",
        type: "tableShape",
        x: 150,
        y: 180,
        props: tableProps,
      },
    ];

    const payload = createOverlayClipboardPayload(shapes, { [asset.id]: asset });
    const cloned = cloneOverlayShapesForPaste(payload, { x: 20, y: 20 });

    expect(cloned.shapes).toHaveLength(5);
    expect(Object.values(cloned.assets)).toHaveLength(1);
    expect(cloned.shapes[0]).toMatchObject({ type: "geo", x: 30, y: 40, rotation: Math.PI / 8 });
    expect(cloned.shapes[0].id).not.toBe("shape_rect");

    const textShape = cloned.shapes.find((shape): shape is Extract<OverlayShape, { type: "text" }> => shape.type === "text");
    const textMath = overlayTextBlocksToInlineNodes(textShape?.props.blocks ?? [])[0];
    expect(textMath?.type === "mathInline" ? textMath.id : undefined).not.toBe("text_math_source");

    const graphShape = cloned.shapes.find((shape): shape is Extract<OverlayShape, { type: "graph2dShape" }> => shape.type === "graph2dShape");
    expect(graphShape?.props.spec.curves[0].id).not.toBe(graphProps.spec.curves[0].id);
    expect(graphShape?.props.spec.points?.[0].id).not.toBe("point_source");
    expect(graphShape?.props.spec.annotations?.[0].id).not.toBe("annotation_source");
    expect(graphShape?.props.spec.fills?.[0].id).not.toBe("fill_source");

    const imageShape = cloned.shapes.find((shape): shape is Extract<OverlayShape, { type: "image" }> => shape.type === "image");
    expect(imageShape?.props.assetId).not.toBe(asset.id);
    expect(cloned.assets[imageShape?.props.assetId ?? ""]?.props.src).toBe(asset.props.src);

    const tableShape = cloned.shapes.find((shape): shape is Extract<OverlayShape, { type: "tableShape" }> => shape.type === "tableShape");
    expect(tableShape?.props.table.rows[0].id).not.toBe(tableProps.table.rows[0].id);
    expect(tableShape?.props.table.columns[0].id).not.toBe(tableProps.table.columns[0].id);
    expect(tableShape?.props.table.cells[0].id).not.toBe(tableProps.table.cells[0].id);
    const tableParagraph = tableShape?.props.table.cells[0].content[0];
    expect(tableParagraph?.id).not.toBe("table_p_source");
    const firstTableChild = tableParagraph?.type === "paragraph" ? tableParagraph.children[0] : null;
    expect(firstTableChild && "id" in firstTableChild ? firstTableChild.id : "").not.toBe("table_math_source");
  });

  it("migrates legacy graph outer bounds before cloning for paste", () => {
    const legacyProps = createGraphShapeProps("line");
    delete legacyProps.boundsMode;
    legacyProps.w = legacyProps.spec.width;
    legacyProps.h = legacyProps.spec.height;
    const payload = createOverlayClipboardPayload([
      {
        id: "legacy_graph",
        type: "graph2dShape",
        x: 80,
        y: 90,
        props: legacyProps,
      },
    ], {});

    const cloned = cloneOverlayShapesForPaste(payload, { x: 20, y: 20 });
    const graph = cloned.shapes[0];

    expect(graph).toMatchObject({
      type: "graph2dShape",
      x: 146,
      y: 128,
      props: {
        boundsMode: "plot",
        w: 296,
      },
    });
  });

  it("clones explicit overlay groups and remaps child parent ids", () => {
    const shapes: OverlayShape[] = [
      {
        id: "group_source",
        type: "group",
        x: 10,
        y: 20,
        props: {
          w: 80,
          h: 30,
        },
      },
      {
        id: "shape_a",
        type: "geo",
        x: 10,
        y: 20,
        parentId: "group_source",
        props: {
          w: 30,
          h: 30,
          geo: "rectangle",
          fill: "none",
          color: "black",
          labelColor: "black",
          dash: "solid",
          size: "m",
        },
      },
      {
        id: "shape_b",
        type: "geo",
        x: 60,
        y: 20,
        parentId: "group_source",
        props: {
          w: 30,
          h: 30,
          geo: "ellipse",
          fill: "none",
          color: "black",
          labelColor: "black",
          dash: "solid",
          size: "m",
        },
      },
    ];

    const cloned = cloneOverlayShapesForPaste(createOverlayClipboardPayload(shapes, {}), { x: 20, y: 20 });
    const clonedGroup = cloned.shapes.find((shape) => shape.type === "group");
    const clonedChildren = cloned.shapes.filter((shape) => shape.type !== "group");

    expect(cloned.shapes).toHaveLength(3);
    expect(clonedGroup?.id).not.toBe("group_source");
    expect(clonedGroup).toMatchObject({ x: 30, y: 40 });
    expect(clonedChildren).toHaveLength(2);
    expect(clonedChildren.every((shape) => shape.parentId === clonedGroup?.id)).toBe(true);
    expect(clonedChildren.map((shape) => shape.id)).not.toContain("shape_a");
  });
});

describe("cross-document overlay paste", () => {
  const asset: OverlayAsset = {
    id: "asset_remote",
    type: "image",
    props: {
      w: 120,
      h: 90,
      name: "figure.png",
      isAnimated: false,
      mimeType: "image/png",
      src: "data:image/png;base64,AAAA",
      fileSize: 4,
      storage: { kind: "remote-asset", storageKey: "workspaces/a/figure.png", assetId: "asset_remote" },
    },
  };

  function anchoredShapes(): OverlayShape[] {
    return [
      {
        id: "shape_anchored",
        type: "geo",
        x: 10,
        y: 20,
        anchor: { type: "block", blockId: "p_source_only", dy: 12 },
        props: {
          w: 80,
          h: 40,
          geo: "rectangle",
          fill: "none",
          color: "#111111",
          labelColor: "#111111",
          dash: "solid",
          size: "m",
        },
      },
      {
        id: "shape_image",
        type: "image",
        x: 40,
        y: 60,
        props: { w: 120, h: 90, assetId: "asset_remote" },
      },
    ];
  }

  it("remembers which document a copy came from", () => {
    const payload = createOverlayClipboardPayload(anchoredShapes(), { [asset.id]: asset }, "doc_source");

    expect(payload.sourceDocId).toBe("doc_source");
    expect(parseEditorClipboardPayload(serializeEditorClipboardPayload(payload))).toEqual(payload);
    expect(parseEditorClipboardHtml(createEditorClipboardHtml(payload))).toEqual(payload);
  });

  it("stays valid when the copy predates the source-document marker", () => {
    const payload = createOverlayClipboardPayload(anchoredShapes(), { [asset.id]: asset });

    expect(payload).not.toHaveProperty("sourceDocId");
    expect(parseEditorClipboardPayload(serializeEditorClipboardPayload(payload))).toEqual(payload);
  });

  it("drops a block anchor the target document has no block for", () => {
    // 貼り付け先にその段落は存在しない。推測で別の段落に付け直すより、保存済み x/y を尊重して
    // ページアンカーに落とすほうが安全。
    const payload = createOverlayClipboardPayload(anchoredShapes(), {}, "doc_source");
    const cloned = cloneOverlayShapesForPaste(payload, { x: 0, y: 0 }, { dropBlockAnchors: true });

    expect(cloned.shapes[0].anchor).toEqual({ type: "page" });
  });

  it("keeps block anchors by default so same-document paste and material insert do not regress", () => {
    // `materials.ts` はこの clone の結果を受けてから自前でブロック id を張り替えるので、
    // ここで既定が変わると素材の図形が本文に追従しなくなる。
    const payload = createOverlayClipboardPayload(anchoredShapes(), {}, "doc_source");

    expect(cloneOverlayShapesForPaste(payload, { x: 0, y: 0 }).shapes[0].anchor)
      .toMatchObject({ type: "block", blockId: "p_source_only", dy: 12 });
  });

  it("remaps a copied block anchor without applying the normal paste offset", () => {
    const payload = createOverlayClipboardPayload(anchoredShapes(), {}, "doc_source");
    const cloned = cloneOverlayShapesForPaste(payload, { x: 20, y: 20 }, {
      dropBlockAnchors: true,
      anchorBlockIdMap: { p_source_only: "p_pasted" },
    });

    expect(cloned.shapes[0]).toMatchObject({
      x: payload.shapes[0].x,
      y: payload.shapes[0].y,
      anchor: { type: "block", blockId: "p_pasted", dy: 12 },
    });
    expect(cloned.shapes[1]).toMatchObject({
      x: payload.shapes[1].x + 20,
      y: payload.shapes[1].y + 20,
    });
  });

  it("carries the image bytes but not the source document's storage reference", () => {
    const payload = createOverlayClipboardPayload(anchoredShapes(), { [asset.id]: asset }, "doc_source");
    const cloned = cloneOverlayShapesForPaste(payload, { x: 0, y: 0 }, { dropBlockAnchors: true });
    const [pastedAsset] = Object.values(cloned.assets);

    expect(pastedAsset.props.src).toBe(asset.props.src);
    expect(pastedAsset.props).not.toHaveProperty("storage");
    expect(pastedAsset.id).not.toBe(asset.id);
  });

  it("keeps the storage reference for a same-document paste", () => {
    const payload = createOverlayClipboardPayload(anchoredShapes(), { [asset.id]: asset }, "doc_source");
    const [pastedAsset] = Object.values(cloneOverlayShapesForPaste(payload, { x: 0, y: 0 }).assets);

    expect(pastedAsset.props.storage).toMatchObject({ kind: "remote-asset" });
  });

  it("repoints the pasted image at the freshly created asset", () => {
    const payload = createOverlayClipboardPayload(anchoredShapes(), { [asset.id]: asset }, "doc_source");
    const cloned = cloneOverlayShapesForPaste(payload, { x: 0, y: 0 }, { dropBlockAnchors: true });
    const image = cloned.shapes.find((shape) => shape.type === "image");
    const [pastedAssetId] = Object.keys(cloned.assets);

    expect(image?.type === "image" ? image.props.assetId : null).toBe(pastedAssetId);
  });
});

describe("overlay paste edge cases found in review", () => {
  it("keeps a storage reference when the bytes are not inline", () => {
    // `src` が storage の URL のとき `storage` まで落とすと、解決手段がゼロの画像になる。
    const storageAsset: OverlayAsset = {
      id: "asset_storage_only",
      type: "image",
      props: {
        w: 10,
        h: 10,
        name: "remote.png",
        isAnimated: false,
        mimeType: "image/png",
        src: "sigma-doc-storage://workspaces/a/remote.png",
        fileSize: 10,
        storage: { kind: "remote-asset", storageKey: "workspaces/a/remote.png", assetId: "asset_storage_only" },
      },
    };
    const image: OverlayShape = {
      id: "image_storage",
      type: "image",
      x: 0,
      y: 0,
      props: { w: 10, h: 10, assetId: "asset_storage_only" },
    };
    const payload = createOverlayClipboardPayload([image], { asset_storage_only: storageAsset }, "doc_a");

    const [pasted] = Object.values(cloneOverlayShapesForPaste(payload, { x: 0, y: 0 }, { dropBlockAnchors: true }).assets);
    expect(pasted.props.storage).toMatchObject({ kind: "remote-asset" });
  });

  it("points a pasted graph at the pasted copies of its label shapes", () => {
    // ラベルは id 参照の兄弟 text 図形。所有関係を張り替えないと、貼り付けたグラフが自分の
    // ラベルを見失い、同じ位置にもう一組作り直してしまう。
    const label: OverlayShape = {
      id: "graph_label_x",
      type: "text",
      x: 0,
      y: 0,
      props: {
        w: 40,
        h: 16,
        blocks: [{ type: "paragraph", id: "p_label_x", children: [{ type: "text", text: "x" }] }],
        color: "#111111",
        size: "m",
      },
    };
    const graph: OverlayShape = {
      id: "graph_with_labels",
      type: "graph2dShape",
      x: 0,
      y: 0,
      props: {
        ...createGraphShapeProps(),
        axisLabelTextShapeIds: { x: "graph_label_x" },
        labelTextShapeIds: ["graph_label_x"],
      },
    };
    const payload = createOverlayClipboardPayload([graph, label], {}, "doc_a");

    const cloned = cloneOverlayShapesForPaste(payload, { x: 0, y: 0 }, { dropBlockAnchors: true });
    const pastedGraph = cloned.shapes.find((shape) => shape.type === "graph2dShape");
    const pastedLabel = cloned.shapes.find((shape) => shape.type === "text");

    expect(pastedGraph?.type === "graph2dShape" ? pastedGraph.props.axisLabelTextShapeIds?.x : null)
      .toBe(pastedLabel?.id);
    expect(pastedGraph?.type === "graph2dShape" ? pastedGraph.props.labelTextShapeIds : null)
      .toEqual([pastedLabel?.id]);
  });

  it("drops label ownership that was not part of the copy", () => {
    const graph: OverlayShape = {
      id: "graph_lonely",
      type: "graph2dShape",
      x: 0,
      y: 0,
      props: {
        ...createGraphShapeProps(),
        axisLabelTextShapeIds: { x: "label_left_behind" },
        labelTextShapeIds: ["label_left_behind"],
      },
    };
    const payload = createOverlayClipboardPayload([graph], {}, "doc_a");

    const [pasted] = cloneOverlayShapesForPaste(payload, { x: 0, y: 0 }, { dropBlockAnchors: true }).shapes;
    expect(pasted.type === "graph2dShape" ? pasted.props : {}).not.toHaveProperty("axisLabelTextShapeIds");
    expect(pasted.type === "graph2dShape" ? pasted.props : {}).not.toHaveProperty("labelTextShapeIds");
  });
});

describe("clipboard overlay asset sources", () => {
  it("drops a pasted asset that points at the victim's disk", () => {
    // `text/html` のクリップボードは任意の Web ページが書ける。貼り付けは正規化境界を
    // 通らない 4 つ目の入口なので、ここを素通しにすると Web からのコピーで `file://` を
    // 差し込める。
    const payload = {
      type: "application/sigma-studio",
      version: 1,
      kind: "overlayShapes",
      shapes: [{ id: "shape_image", type: "image", x: 0, y: 0, props: { assetId: "asset_1", w: 10, h: 10 } }],
      assets: {
        asset_1: {
          id: "asset_1",
          type: "image",
          props: { w: 10, h: 10, name: "x.png", isAnimated: false, mimeType: "image/png", src: "file:///Users/victim/private.png", fileSize: 1 },
        },
        asset_2: {
          id: "asset_2",
          type: "image",
          props: { w: 10, h: 10, name: "y.png", isAnimated: false, mimeType: "image/png", src: "data:image/png;base64,iVBORw0KGgo=", fileSize: 1 },
        },
      },
    };

    const parsed = parseEditorClipboardPayload(JSON.stringify(payload));

    expect(parsed).not.toBeNull();
    expect(Object.keys((parsed as { assets: Record<string, unknown> }).assets)).toEqual(["asset_2"]);
  });
});

/** Every id a text shape's blocks carry: blocks, list items, and inline math nodes. */
function collectBlockIds(blocks: readonly (OverlayTextBlock | ListItemContinuationNode)[]): string[] {
  return blocks.flatMap((block): string[] => {
    if (block.type === "divider") {
      return [block.id];
    }
    if (block.type === "list") {
      return [
        block.id,
        ...block.items.flatMap((item) => [
          item.id,
          ...item.children.flatMap((child) => (child.type === "mathInline" ? [child.id] : [])),
          ...collectBlockIds(item.continuations ?? []),
          ...collectBlockIds(item.nested ?? []),
        ]),
      ];
    }
    return [
      block.id,
      ...overlayTextBlockInlineRuns(block).flatMap((child) => (child.type === "mathInline" ? [child.id] : [])),
    ];
  });
}

function plainTextOf(blocks: readonly (OverlayTextBlock | ListItemContinuationNode)[]): string {
  const inlines = (children: readonly InlineNode[]): string => children
    .map((child) => (child.type === "text" ? child.text : child.type === "mathInline" ? child.tex : ""))
    .join("");
  return blocks.map((block) => {
    if (block.type === "divider") {
      return "---";
    }
    if (block.type === "list") {
      return block.items.map((item) => [
        inlines(item.children),
        plainTextOf(item.continuations ?? []),
        plainTextOf(item.nested ?? []),
      ].join("")).join("|");
    }
    return inlines(overlayTextBlockInlineRuns(block));
  }).join("\n");
}

describe("pasting a chart with its table", () => {
  function chartTable(): SigmaTableSpec {
    const rowIds = ["r1", "r2"];
    const columnIds = ["c1", "c2"];
    return {
      version: 1,
      kind: "plain",
      columns: columnIds.map((id) => ({ id, width: { mode: "auto" } })),
      rows: rowIds.map((id) => ({ id, height: { mode: "auto" } })),
      cells: rowIds.flatMap((rowId) => columnIds.map((columnId) => ({
        id: `${rowId}-${columnId}`,
        rowId,
        columnId,
        content: [{
          type: "paragraph" as const,
          id: `${rowId}-${columnId}-p`,
          children: [{ type: "text" as const, text: rowId === "r1" ? "Math" : "10" }],
        }],
      }))),
      grid: { borderColor: "#111827", borderWidth: 1 },
      defaultCellStyle: {},
    };
  }

  function pair(): OverlayShape[] {
    return [
      {
        id: "table-1",
        type: "tableShape",
        x: 0,
        y: 0,
        props: { w: 200, h: 100, table: chartTable() },
      } as OverlayShape,
      {
        id: "chart-1",
        type: "chartShape",
        x: 0,
        y: 140,
        props: {
          w: 200,
          h: 130,
          spec: {
            version: 1,
            kind: "bar",
            orientation: "columns",
            headerRow: true,
            labelColumn: true,
            legend: true,
            seriesColors: { c2: "#123456" },
          },
          sourceTableShapeId: "table-1",
          dataSnapshot: { labels: ["10"], series: [{ id: "c2", name: "Math", values: [10] }] },
        },
      } as OverlayShape,
    ];
  }

  function paste(shapes: OverlayShape[]) {
    const cloned = cloneOverlayShapesForPaste(createOverlayClipboardPayload(shapes, {}), { x: 20, y: 20 });
    const table = cloned.shapes.find((shape) => shape.type === "tableShape");
    const chart = cloned.shapes.find((shape) => shape.type === "chartShape");
    if (chart?.type !== "chartShape") throw new Error("no chart");
    return { table, chart };
  }

  it("re-points the chart at the pasted copy of its table", () => {
    const { table, chart } = paste(pair());

    expect(chart.props.sourceTableShapeId).toBe(table?.id);
  });

  it("does not leave the chart pointing at the original table", () => {
    expect(paste(pair()).chart.props.sourceTableShapeId).not.toBe("table-1");
  });

  it("re-keys the author's series colours onto the regenerated column ids", () => {
    // `cloneTableSpecForPaste` mints new row/column ids, and the chart keys its colours on them.
    const { table, chart } = paste(pair());
    const columnId = table?.type === "tableShape" ? table.props.table.columns[1].id : "";

    expect(chart.props.spec.seriesColors).toEqual({ [columnId]: "#123456" });
  });

  it("keeps the colour reachable for the series that is actually derived", () => {
    const { table, chart } = paste(pair());
    const columnId = table?.type === "tableShape" ? table.props.table.columns[1].id : "";

    expect(Object.keys(chart.props.spec.seriesColors)).toEqual([columnId]);
  });

  it("re-keys the snapshot's series ids too", () => {
    const { table, chart } = paste(pair());
    const columnId = table?.type === "tableShape" ? table.props.table.columns[1].id : "";

    expect(chart.props.dataSnapshot.series[0].id).toBe(columnId);
  });

  it("re-keys a pie slice colour, whose key carries the track id plus the label", () => {
    const shapes = pair();
    const chartShape = shapes[1];
    if (chartShape.type !== "chartShape") throw new Error("fixture");
    chartShape.props.spec = { ...chartShape.props.spec, kind: "pie", seriesColors: { "c2:Math": "#abcdef" } };
    const { table, chart } = paste(shapes);
    const columnId = table?.type === "tableShape" ? table.props.table.columns[1].id : "";

    expect(chart.props.spec.seriesColors).toEqual({ [`${columnId}:Math`]: "#abcdef" });
  });

  it("keeps the live link when a chart alone is duplicated in the same document", () => {
    // ⌘D and same-document paste run through this path, and the table is still sitting there.
    const chartOnly = pair().filter((shape) => shape.type === "chartShape");
    const cloned = cloneOverlayShapesForPaste(createOverlayClipboardPayload(chartOnly, {}), { x: 20, y: 20 });
    const chart = cloned.shapes[0];
    if (chart.type !== "chartShape") throw new Error("no chart");

    expect(chart.props.sourceTableShapeId).toBe("table-1");
  });

  it("freezes a chart pasted into another document onto its snapshot", () => {
    const chartOnly = pair().filter((shape) => shape.type === "chartShape");
    const cloned = cloneOverlayShapesForPaste(
      createOverlayClipboardPayload(chartOnly, {}),
      { x: 20, y: 20 },
      { dropBlockAnchors: true },
    );
    const chart = cloned.shapes[0];
    if (chart.type !== "chartShape") throw new Error("no chart");

    expect(chart.props.sourceTableShapeId).toBeUndefined();
  });

  it("keeps the snapshot data when the table did not come along", () => {
    const chartOnly = pair().filter((shape) => shape.type === "chartShape");
    const cloned = cloneOverlayShapesForPaste(
      createOverlayClipboardPayload(chartOnly, {}),
      { x: 20, y: 20 },
      { dropBlockAnchors: true },
    );
    const chart = cloned.shapes[0];
    if (chart.type !== "chartShape") throw new Error("no chart");

    expect(chart.props.dataSnapshot.series[0].values).toEqual([10]);
  });

  it("re-points the chart even when it is cloned before its table", () => {
    // Order matters: the chart is cloned first here, so a single-pass remap would miss the table.
    const [table, chart] = pair();
    const result = paste([chart, table]);

    expect(result.chart.props.sourceTableShapeId).toBe(result.table?.id);
  });
});

describe("pasting a table that holds formulas", () => {
  function formulaTable(): SigmaTableSpec {
    const rowIds = ["r1", "r2", "r3"];
    const texts: Record<string, [string, string]> = {
      r1: ["月", "点数"],
      r2: ["1月", "10"],
      r3: ["合計", "=SUM(B2:B2)"],
    };
    return {
      version: 1,
      kind: "plain",
      columns: ["c1", "c2"].map((id) => ({ id, width: { mode: "auto" } })),
      rows: rowIds.map((id) => ({ id, height: { mode: "auto" } })),
      cells: rowIds.flatMap((rowId) => ["c1", "c2"].map((columnId, columnIndex) => ({
        id: `${rowId}-${columnId}`,
        rowId,
        columnId,
        content: [{
          type: "paragraph" as const,
          id: `${rowId}-${columnId}-p`,
          children: [{ type: "text" as const, text: texts[rowId][columnIndex] }],
        }],
      }))),
      grid: { borderColor: "#111827", borderWidth: 1 },
      defaultCellStyle: {},
    };
  }

  function pasteTable(): SigmaTableSpec {
    const shapes: OverlayShape[] = [{
      id: "table-formula",
      type: "tableShape",
      x: 0,
      y: 0,
      props: { w: 200, h: 100, table: formulaTable() },
    } as OverlayShape];
    const cloned = cloneOverlayShapesForPaste(createOverlayClipboardPayload(shapes, {}), { x: 20, y: 20 });
    const pasted = cloned.shapes.find((shape) => shape.type === "tableShape");
    if (pasted?.type !== "tableShape") {
      throw new Error("no table");
    }
    return pasted.props.table;
  }

  it("keeps the formula text through the paste", () => {
    const table = pasteTable();
    const formulaCell = table.cells[table.cells.length - 1];
    const content = formulaCell.content[0];

    expect(content.type === "paragraph" ? inlineNodesToPlainText(content.children) : null)
      .toBe("=SUM(B2:B2)");
  });

  it("still evaluates to the same value after the row and column ids are regenerated", () => {
    // A1 references address grid positions, not row or column ids, so re-minting the ids on paste
    // cannot break them — this is the test that keeps that true.
    const table = pasteTable();
    const formulaCell = table.cells[table.cells.length - 1];

    expect(evaluateTableFormulas(table).byCellId.get(formulaCell.id)?.display).toBe("10");
  });

  it("evaluates the pasted table through its own cells", () => {
    // The real property: the pasted cell objects are new, and the pasted table's evaluation
    // resolves *them*. Comparing the two evaluation objects would pass by construction, since they
    // are memoized per table object and the tables are necessarily different objects.
    const original = formulaTable();
    const pasted = pasteTable();
    const pastedCell = pasted.cells[pasted.cells.length - 1];
    const originalCell = original.cells[original.cells.length - 1];

    expect([
      pastedCell === originalCell,
      evaluateTableFormulas(pasted).byCell.get(pastedCell)?.display,
      evaluateTableFormulas(pasted).byCell.get(originalCell),
    ]).toEqual([false, "10", undefined]);
  });
});
