import { describe, expect, it } from "vitest";

import type { OverlayShape, ParagraphNode } from "@/features/document";
import {
  createEditorClipboardHtml,
  createInlineMathClipboardPayload,
  createOverlayClipboardPayload,
  createTextAndShapesClipboardPayload,
  createTextFlowClipboardPayload,
  EDITOR_CLIPBOARD_MIME,
  getEditorClipboardPlainText,
  serializeEditorClipboardPayload,
  type EditorClipboardPayload,
} from "@/lib/editor-clipboard";

import { collapseWhitespace, derivePocketPreview } from "./pocket-preview";

function paragraph(id: string, text: string): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function rectangle(id: string): OverlayShape {
  return {
    id,
    type: "geo",
    x: 10,
    y: 20,
    rotation: 0,
    props: { w: 120, h: 70, geo: "rectangle", fill: "solid", color: "#1133cc", labelColor: "#111111", dash: "solid", size: "m" },
  } as OverlayShape;
}

/** コピーが書く 4 種のうち、payload を持つ 3 種 (独自 MIME・HTML・プレーンテキスト) を作る。 */
function bagOf(payload: EditorClipboardPayload): Record<string, string> {
  return {
    [EDITOR_CLIPBOARD_MIME]: serializeEditorClipboardPayload(payload),
    "text/html": createEditorClipboardHtml(payload),
    "text/plain": getEditorClipboardPlainText(payload),
  };
}

describe("derivePocketPreview", () => {
  it("summarizes copied body blocks and gives the render copy fresh block ids", () => {
    const source = [paragraph("p_one", "一つ目"), paragraph("p_two", "二つ目")];
    const preview = derivePocketPreview(bagOf(createTextFlowClipboardPayload(source)));

    expect(preview).toMatchObject({ kind: "blocks", blockCount: 2, text: "一つ目 二つ目" });
    if (preview?.kind !== "blocks") throw new Error("expected blocks");
    // 紙面の同じ ID の要素と取り違えない: 描画用の写しは元の ID を一つも持ち越さない。
    expect(preview.blocks.map((block) => block.id)).not.toContain("p_one");
    expect(preview.blocks.map((block) => block.id)).not.toContain("p_two");
    expect(new Set(preview.blocks.map((block) => block.id)).size).toBe(2);
  });

  it("summarizes copied shapes", () => {
    const preview = derivePocketPreview(bagOf(createOverlayClipboardPayload([rectangle("a"), rectangle("b")], {}, "doc_a")));

    expect(preview).toMatchObject({ kind: "shapes", shapeCount: 2 });
  });

  it("summarizes a mixed text-and-shapes copy with its text", () => {
    const payload = createTextAndShapesClipboardPayload(
      { slice: { content: [] }, text: "選んだ  文章\nです" },
      [rectangle("a")],
      {},
    );

    expect(derivePocketPreview(bagOf(payload))).toMatchObject({
      kind: "mixed",
      text: "選んだ 文章 です",
      shapeCount: 1,
    });
  });

  it("falls back to text when a mixed copy carries no shapes", () => {
    const payload = createTextAndShapesClipboardPayload({ slice: { content: [] }, text: "文章だけ" }, [], {});

    expect(derivePocketPreview(bagOf(payload))).toEqual({ kind: "text", text: "文章だけ" });
  });

  it("summarizes inline math", () => {
    expect(derivePocketPreview(bagOf(createInlineMathClipboardPayload("x^2+1")))).toEqual({ kind: "math", tex: "x^2+1" });
    expect(derivePocketPreview(bagOf(createInlineMathClipboardPayload("  ")))).toBeNull();
  });

  it("reads the payload from the HTML when the custom MIME was refused", () => {
    const payload = createTextFlowClipboardPayload([paragraph("p_one", "HTML 経由")]);
    const preview = derivePocketPreview({ "text/html": createEditorClipboardHtml(payload), "text/plain": "HTML 経由" });

    expect(preview).toMatchObject({ kind: "blocks", blockCount: 1 });
  });

  it("treats a copy with no payload as plain text, and an empty copy as nothing", () => {
    expect(derivePocketPreview({ "text/plain": "  ただの\n文字  " })).toEqual({ kind: "text", text: "ただの 文字" });
    expect(derivePocketPreview({})).toBeNull();
    expect(derivePocketPreview({ "text/plain": "   " })).toBeNull();
  });

  it("ignores a payload that does not parse instead of throwing", () => {
    expect(derivePocketPreview({ [EDITOR_CLIPBOARD_MIME]: "{not json", "text/plain": "残る文字" }))
      .toEqual({ kind: "text", text: "残る文字" });
  });
});

describe("collapseWhitespace", () => {
  it("folds runs of whitespace and trims", () => {
    expect(collapseWhitespace("  a \n\t b  ")).toBe("a b");
  });
});
