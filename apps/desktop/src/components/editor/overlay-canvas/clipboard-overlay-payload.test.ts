// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import {
  getDefaultPageLayout,
  type HeadingNode,
  type OverlayShape,
  type OverlayTextShape,
  type ParagraphNode,
  type SigmaBlock,
  type SigmaDocument,
} from "@/features/document";
import {
  createDocumentBlocksClipboardPayload,
  createInlineMathClipboardPayload,
  createOverlayClipboardPayload,
  createTextAndShapesClipboardPayload,
  createTextFlowClipboardPayload,
  EDITOR_CLIPBOARD_MIME,
  EDITOR_TEXT_SLICE_MIME,
  parseEditorClipboardPayload,
  writeEditorClipboardData,
  type EditorClipboardPayload,
} from "@/lib/editor-clipboard";

import { parseSigmaDocument } from "@/lib/sigma-doc-schema";

import { createOverlayPayloadFromClipboard } from "./clipboard-overlay-payload";
import { prepareOverlayShapesForPaste } from "./paste-shapes";

const paragraph: ParagraphNode = { type: "paragraph", id: "p_1", children: [{ type: "text", text: "一段落目" }] };
const heading: HeadingNode = { type: "heading", id: "h_1", level: 2, children: [{ type: "text", text: "見出し" }] };
const rectangle = {
  id: "shape_a",
  type: "geo",
  x: 100,
  y: 200,
  rotation: 0,
  props: { w: 100, h: 60, geo: "rectangle", fill: "none", color: "#111111", labelColor: "#111111", dash: "solid", size: "m" },
} as OverlayShape;

/** コピーが書くのと同じ bag (MIME → 文字列) を作る。 */
function clipOf(payload: EditorClipboardPayload, extra: Record<string, string> = {}): Record<string, string> {
  const data = new DataTransfer();
  writeEditorClipboardData(data, payload);
  return { ...Object.fromEntries([...data.types].map((type) => [type, data.getData(type)])), ...extra };
}

/**
 * コピーの bag が、プレーンテキストへ落ちずに SigmaDoc の payload として読み戻せること。
 * 作ったブロックが検証に弾かれると、変換はプレーンテキストの段落へ静かに落ちて、構造を見るテストが
 * 見かけだけ通ってしまう。
 */
function clipOfBlocks(payload: EditorClipboardPayload): Record<string, string> {
  const clip = clipOf(payload);
  expect(parseEditorClipboardPayload(clip[EDITOR_CLIPBOARD_MIME] ?? "")?.kind).toBe(payload.kind);
  return clip;
}

function onlyTextShape(shapes: readonly OverlayShape[]): OverlayTextShape {
  const texts = shapes.filter((shape): shape is OverlayTextShape => shape.type === "text");
  expect(texts).toHaveLength(1);
  return texts[0]!;
}

describe("createOverlayPayloadFromClipboard", () => {
  it("passes a copy of shapes through untouched", () => {
    const payload = createOverlayPayloadFromClipboard(clipOf(createOverlayClipboardPayload([rectangle], {}, "doc_a")));

    expect(payload?.kind).toBe("overlayShapes");
    expect(payload?.shapes).toEqual([rectangle]);
    expect(payload?.sourceDocId).toBe("doc_a");
  });

  it("turns copied body blocks into one text shape that keeps their types", () => {
    const payload = createOverlayPayloadFromClipboard(clipOf(createTextFlowClipboardPayload([heading, paragraph])));

    const text = onlyTextShape(payload!.shapes);
    expect(text.props.blocks.map((block) => block.type)).toEqual(["heading", "paragraph"]);
    expect(text.props.blocks[1]).toMatchObject({ children: [{ type: "text", text: "一段落目" }] });
    expect(text.props.w).toBeGreaterThan(0);
    expect(text.props.h).toBeGreaterThan(0);
  });

  it("keeps the text of a block a shape cannot hold, as a paragraph, instead of dropping it", () => {
    const box: SigmaBlock = {
      type: "boxBlock",
      id: "box_1",
      styleId: "plain",
      blocks: [paragraph],
    } as unknown as SigmaBlock;

    const payload = createOverlayPayloadFromClipboard(clipOfBlocks(createDocumentBlocksClipboardPayload([box])));

    const text = onlyTextShape(payload!.shapes);
    expect(text.props.blocks).toHaveLength(1);
    expect(text.props.blocks[0]).toMatchObject({ type: "paragraph", children: [{ type: "text", text: "一段落目" }] });
  });

  it("keeps the areas of a problem as separate blocks, in the order they are laid out on the page", () => {
    const text = (id: string, value: string): ParagraphNode => ({ type: "paragraph", id, children: [{ type: "text", text: value }] });
    const problem = {
      type: "problem",
      id: "prob_1",
      tags: ["代数"],
      lead: [text("lead", "導入文")],
      prompt: [text("prompt_a", "問題文その1"), text("prompt_b", "問題文その2")],
      // 宣言順は solution が先だが、紙面の順 (hints → solution) で持ち込む。
      solution: [text("solution", "解答")],
      hints: [text("hint", "ヒント")],
    } as unknown as SigmaBlock;

    const payload = createOverlayPayloadFromClipboard(clipOfBlocks(createDocumentBlocksClipboardPayload([problem])));

    const blocks = onlyTextShape(payload!.shapes).props.blocks;
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "paragraph", "paragraph", "paragraph"]);
    expect(blocks.map((block) => block.type === "paragraph" ? block.children.map((child) => child.type === "text" ? child.text : "") .join("") : "")).toEqual([
      "導入文", "問題文その1", "問題文その2", "ヒント", "解答",
    ]);
  });

  it("keeps the blocks inside a box as blocks, not one merged paragraph", () => {
    const box = {
      type: "boxBlock",
      id: "box_1",
      styleId: "plain",
      blocks: [
        { type: "paragraph", id: "b1", children: [{ type: "text", text: "一つ目" }] },
        { type: "heading", id: "b2", level: 2, children: [{ type: "text", text: "二つ目" }] },
      ],
    } as unknown as SigmaBlock;

    const payload = createOverlayPayloadFromClipboard(clipOfBlocks(createDocumentBlocksClipboardPayload([box])));

    expect(onlyTextShape(payload!.shapes).props.blocks.map((block) => block.type)).toEqual(["paragraph", "heading"]);
  });

  it("turns a copied formula into a paragraph holding the formula", () => {
    const payload = createOverlayPayloadFromClipboard(clipOf(createInlineMathClipboardPayload("x^2+1")));

    const text = onlyTextShape(payload!.shapes);
    expect(text.props.blocks).toHaveLength(1);
    expect(text.props.blocks[0]).toMatchObject({ type: "paragraph", children: [{ type: "mathInline", tex: "x^2+1" }] });
  });

  it("keeps the formatting of a range copied from the body (the slice), not only its plain text", () => {
    const slice = {
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "太字の" , marks: [{ type: "bold" }] },
          { type: "text", text: "文章" },
        ],
      }],
      openStart: 1,
      openEnd: 1,
    };
    const clip = {
      "text/plain": "太字の文章",
      [EDITOR_TEXT_SLICE_MIME]: JSON.stringify({ slice, text: "太字の文章" }),
    };

    const payload = createOverlayPayloadFromClipboard(clip);

    const [block] = onlyTextShape(payload!.shapes).props.blocks;
    expect(block).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "太字の", marks: ["bold"] }, { type: "text", text: "文章" }],
    });
  });

  it("falls back to plain text, one paragraph per line, when there is no structure", () => {
    const payload = createOverlayPayloadFromClipboard({ "text/plain": "\n一行目\r\n二行目\n\n" });

    const text = onlyTextShape(payload!.shapes);
    expect(text.props.blocks.map((block) => block.type === "paragraph" ? block.children : null)).toEqual([
      [{ type: "text", text: "一行目" }],
      [{ type: "text", text: "二行目" }],
    ]);
  });

  it("falls back to plain text when the slice cannot be converted", () => {
    const payload = createOverlayPayloadFromClipboard({
      "text/plain": "読める文章",
      [EDITOR_TEXT_SLICE_MIME]: JSON.stringify({ slice: { nonsense: true }, text: "読める文章" }),
    });

    expect(onlyTextShape(payload!.shapes).props.blocks[0]).toMatchObject({ children: [{ text: "読める文章" }] });
  });

  it("puts the text of a mixed copy above its shapes, and brings the shapes along", () => {
    const payload = createOverlayPayloadFromClipboard(clipOf(createTextAndShapesClipboardPayload(
      { slice: { content: [{ type: "paragraph", content: [{ type: "text", text: "説明文" }] }] }, text: "説明文" },
      [rectangle],
      {},
      "doc_a",
    )));

    const text = onlyTextShape(payload!.shapes);
    const figure = payload!.shapes.find((shape) => shape.type === "geo")!;
    expect(figure).toEqual(rectangle);
    // 文章は図の左端にそろえて、図の上に置く。
    expect(text.x).toBe(figure.x);
    expect(text.y + text.props.h).toBeLessThan(figure.y);
    expect(text.props.blocks[0]).toMatchObject({ children: [{ text: "説明文" }] });
    expect(payload!.sourceDocId).toBe("doc_a");
  });

  it("gives every text block a fresh id, so two insertions never share one", () => {
    const clip = clipOf(createTextFlowClipboardPayload([paragraph]));

    const first = onlyTextShape(createOverlayPayloadFromClipboard(clip)!.shapes);
    const second = onlyTextShape(createOverlayPayloadFromClipboard(clip)!.shapes);

    expect(first.id).not.toBe(second.id);
  });

  it("returns nothing when the copy holds nothing to place", () => {
    expect(createOverlayPayloadFromClipboard({})).toBeNull();
    expect(createOverlayPayloadFromClipboard({ "text/plain": "  \n " })).toBeNull();
    expect(createOverlayPayloadFromClipboard(clipOf(createOverlayClipboardPayload([], {}, "doc_a")))).toBeNull();
  });

  describe("what is saved to a whiteboard", () => {
    /** 紙面へ置く手順 (ID の振り直し・位置) を通した図形を、ホワイトボードの文書にして保存の往復をする。 */
    function roundTrip(clip: Record<string, string>): OverlayShape[] {
      const payload = createOverlayPayloadFromClipboard(clip)!;
      const prepared = prepareOverlayShapesForPaste({
        payload,
        canvasWidth: 20000,
        canvasHeight: 20000,
        centerAt: { x: 500, y: 400 },
      });
      const document = {
        version: "2.0",
        docId: "doc_whiteboard",
        metadata: { title: "ホワイトボード" },
        content: [],
        pageLayout: {
          ...getDefaultPageLayout("whiteboard"),
          overlay: { overlaySnapshot: { version: 1, shapes: prepared.shapes, assets: prepared.assets } },
        },
        outputProfiles: { student: {}, teacher: {}, answerBook: {} },
      } as SigmaDocument;
      // 保存 (JSON) → 読み込み (スキーマ検証) を通る。通らなければここで例外になる。
      const loaded = parseSigmaDocument(JSON.parse(JSON.stringify(document)));
      return loaded.pageLayout!.overlay!.overlaySnapshot!.shapes;
    }

    it("keeps a converted body copy as a valid text shape after a save and reload", () => {
      const shapes = roundTrip(clipOf(createTextFlowClipboardPayload([heading, paragraph])));

      const text = onlyTextShape(shapes);
      expect(text.props.blocks.map((block) => block.type)).toEqual(["heading", "paragraph"]);
      expect(JSON.stringify(text.props.blocks)).toContain("一段落目");
    });

    it("keeps a formula and formatting through a save and reload", () => {
      const formula = onlyTextShape(roundTrip(clipOf(createInlineMathClipboardPayload("x^2+1"))));
      expect(JSON.stringify(formula.props.blocks)).toContain("x^2+1");

      const bold = onlyTextShape(roundTrip({
        "text/plain": "太字",
        [EDITOR_TEXT_SLICE_MIME]: JSON.stringify({
          slice: { content: [{ type: "paragraph", content: [{ type: "text", text: "太字", marks: [{ type: "bold" }] }] }] },
          text: "太字",
        }),
      }));
      expect(JSON.stringify(bold.props.blocks)).toContain('"bold"');
    });

    it("keeps the text and the shapes of a mixed copy together", () => {
      const shapes = roundTrip(clipOf(createTextAndShapesClipboardPayload(
        { slice: { content: [{ type: "paragraph", content: [{ type: "text", text: "説明文" }] }] }, text: "説明文" },
        [rectangle],
        {},
        "doc_a",
      )));

      expect(shapes.map((shape) => shape.type).sort()).toEqual(["geo", "text"]);
    });
  });
});
