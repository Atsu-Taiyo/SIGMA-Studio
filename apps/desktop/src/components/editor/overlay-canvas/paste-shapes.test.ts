import { describe, expect, it } from "vitest";

import type { OverlayAsset, OverlayShape } from "@/features/document";
import { createOverlayClipboardPayload } from "@/lib/editor-clipboard";

import { prepareOverlayShapesForPaste } from "./paste-shapes";

function geo(id: string, x: number, y: number, parentId?: string): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    ...(parentId ? { parentId } : {}),
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
  };
}

function group(id: string): OverlayShape {
  return { id, type: "group", x: 0, y: 0, props: { w: 200, h: 120 } };
}

const CANVAS = { canvasWidth: 800, canvasHeight: 1000 };

describe("prepareOverlayShapesForPaste", () => {
  it("selects only the top-level shapes of a pasted group", () => {
    // 子まで選択に入れると、貼り付け直後のドラッグでグループが分解される。
    const payload = createOverlayClipboardPayload(
      [group("group_1"), geo("child_a", 10, 10, "group_1"), geo("child_b", 40, 10, "group_1")],
      {},
      "doc_source",
    );

    const prepared = prepareOverlayShapesForPaste({ payload, ...CANVAS });

    expect(prepared.shapes).toHaveLength(3);
    expect(prepared.selectedIds).toHaveLength(1);
    const [selected] = prepared.selectedIds;
    expect(prepared.shapes.find((shape) => shape.id === selected)?.type).toBe("group");
    expect(prepared.shapes.filter((shape) => shape.parentId === selected)).toHaveLength(2);
  });

  it("gives every pasted shape a fresh id", () => {
    const payload = createOverlayClipboardPayload([geo("shape_1", 10, 10)], {}, "doc_source");

    expect(prepareOverlayShapesForPaste({ payload, ...CANVAS }).shapes[0].id).not.toBe("shape_1");
  });

  it("unlocks and unhides what it pastes so the result is immediately editable", () => {
    const payload = createOverlayClipboardPayload(
      [{ ...geo("shape_1", 10, 10), locked: true, hidden: true }],
      {},
      "doc_source",
    );

    const [pasted] = prepareOverlayShapesForPaste({ payload, ...CANVAS }).shapes;
    expect(pasted).not.toHaveProperty("locked");
    expect(pasted).not.toHaveProperty("hidden");
  });

  it("pulls a shape pasted past the target page back onto it", () => {
    // 貼り付け先の用紙がコピー元より小さいことがある。
    const payload = createOverlayClipboardPayload([geo("shape_1", 700, 900)], {}, "doc_source");

    const [pasted] = prepareOverlayShapesForPaste({
      payload,
      canvasWidth: 400,
      canvasHeight: 500,
      offset: { x: 0, y: 0 },
    }).shapes;

    expect(pasted.x + 80).toBeLessThanOrEqual(400);
    expect(pasted.y + 40).toBeLessThanOrEqual(500);
  });

  it("keeps a block anchor when the copy came from the document being pasted into", () => {
    const anchored: OverlayShape = {
      ...geo("shape_1", 10, 10),
      anchor: { type: "block", blockId: "p_1", dy: 8 },
    };
    const payload = createOverlayClipboardPayload([anchored], {}, "doc_a");

    const [pasted] = prepareOverlayShapesForPaste({ payload, ...CANVAS, targetDocId: "doc_a" }).shapes;
    expect(pasted.anchor).toMatchObject({ type: "block", blockId: "p_1" });
  });

  it("drops a block anchor when the copy came from another document", () => {
    const anchored: OverlayShape = {
      ...geo("shape_1", 10, 10),
      anchor: { type: "block", blockId: "p_1", dy: 8 },
    };
    const payload = createOverlayClipboardPayload([anchored], {}, "doc_a");

    const [pasted] = prepareOverlayShapesForPaste({ payload, ...CANVAS, targetDocId: "doc_b" }).shapes;
    expect(pasted.anchor).toEqual({ type: "page" });
  });

  it("keeps a remapped block anchor across documents and does not offset it", () => {
    const anchored: OverlayShape = {
      ...geo("shape_1", 10, 10),
      anchor: { type: "block", blockId: "p_source", dy: 8 },
    };
    const payload = createOverlayClipboardPayload([anchored], {}, "doc_a");

    const [pasted] = prepareOverlayShapesForPaste({
      payload,
      ...CANVAS,
      targetDocId: "doc_b",
      anchorBlockIdMap: { p_source: "p_target" },
    }).shapes;
    expect(pasted).toMatchObject({
      x: 10,
      y: 10,
      anchor: { type: "block", blockId: "p_target", dy: 8 },
    });
  });

  it("uses the old cross-document behavior for block anchors absent from the map", () => {
    const anchored: OverlayShape = {
      ...geo("shape_1", 10, 10),
      anchor: { type: "block", blockId: "p_other", dy: 8 },
    };
    const payload = createOverlayClipboardPayload([anchored], {}, "doc_a");

    const [pasted] = prepareOverlayShapesForPaste({
      payload,
      ...CANVAS,
      targetDocId: "doc_b",
      anchorBlockIdMap: { p_source: "p_target" },
    }).shapes;
    expect(pasted).toMatchObject({ x: 30, y: 30, anchor: { type: "page" } });
  });

  it("treats a copy with no recorded source document as coming from elsewhere", () => {
    // 旧ビルドのペイロードは出所が分からない。存在しないブロックに繋げたままにするより、
    // ページアンカーへ落として保存済み座標を尊重するほうが安全側。
    const anchored: OverlayShape = {
      ...geo("shape_1", 10, 10),
      anchor: { type: "block", blockId: "p_1", dy: 8 },
    };
    const payload = createOverlayClipboardPayload([anchored], {});

    const [pasted] = prepareOverlayShapesForPaste({ payload, ...CANVAS, targetDocId: "doc_a" }).shapes;
    expect(pasted.anchor).toEqual({ type: "page" });
  });

  it("brings the image asset along under a fresh id", () => {
    const asset: OverlayAsset = {
      id: "asset_1",
      type: "image",
      props: {
        w: 60,
        h: 40,
        name: "f.png",
        isAnimated: false,
        mimeType: "image/png",
        src: "data:image/png;base64,AAAA",
        fileSize: 4,
      },
    };
    const image: OverlayShape = { id: "image_1", type: "image", x: 10, y: 10, props: { w: 60, h: 40, assetId: "asset_1" } };
    const payload = createOverlayClipboardPayload([image], { asset_1: asset }, "doc_a");

    const prepared = prepareOverlayShapesForPaste({ payload, ...CANVAS, targetDocId: "doc_b" });
    const [assetId] = Object.keys(prepared.assets);
    const pasted = prepared.shapes[0];

    expect(assetId).not.toBe("asset_1");
    expect(pasted.type === "image" ? pasted.props.assetId : null).toBe(assetId);
  });

  it("reports nothing to paste for an empty payload", () => {
    const payload = createOverlayClipboardPayload([], {}, "doc_a");

    expect(prepareOverlayShapesForPaste({ payload, ...CANVAS }).shapes).toEqual([]);
    expect(prepareOverlayShapesForPaste({ payload, ...CANVAS }).selectedIds).toEqual([]);
  });
});
