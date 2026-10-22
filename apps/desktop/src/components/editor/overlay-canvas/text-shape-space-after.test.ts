// @vitest-environment happy-dom

import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import type { OverlayTextBlock } from "@/features/document";
import { overlayTextBlocksToTiptapDoc, tiptapDocToOverlayTextBlocks } from "@/components/editor/text-flow/overlay-tiptap-adapter";

import { OverlayTextBlockAttrs } from "./overlay-text-block-attrs";
import {
  collectTextShapeSpaceAfterUnits,
  findInnermostTextShapeSpaceAfterUnitIndex,
  isSpaceAfterTransaction,
  measureBottomWithin,
  projectPointerDeltaToShapeY,
  readTextShapeSpaceAfterPx,
  resolveSpaceAfterUnitElement,
  setTextShapeSpaceAfter,
  SPACE_AFTER_TRANSACTION_META,
} from "./text-shape-space-after";

/** 図中テキストの編集面と同じスキーマ (`text-shape-editor.tsx` と同じオプション)。 */
const schema = getSchema(createRichTextEngineExtensions({
  blockExtensions: [OverlayTextBlockAttrs],
  bodyBlocks: true,
  drawBoxedRunFrames: false,
  enableMathDelimiters: true,
  listMarkerTypography: true,
  orderedListMarkerStyles: true,
  textBlockStyle: true,
}));

const BLOCKS: OverlayTextBlock[] = [
  { type: "paragraph", id: "p1", spaceAfterPx: 12, children: [{ type: "text", text: "いち" }] },
  { type: "heading", id: "h1", level: 2, children: [{ type: "text", text: "見出し" }] },
  {
    type: "list",
    id: "l1",
    listType: "bullet",
    items: [
      {
        type: "listItem",
        id: "li1",
        spaceAfterPx: 9,
        children: [{ type: "text", text: "項目" }],
        nested: [{
          type: "list",
          id: "l2",
          listType: "bullet",
          items: [{ type: "listItem", id: "li2", children: [{ type: "text", text: "入れ子" }] }],
        }],
      },
      { type: "listItem", id: "li3", children: [{ type: "text", text: "次の項目" }] },
    ],
  },
  { type: "quote", id: "q1", blocks: [{ type: "paragraph", id: "qp", children: [{ type: "text", text: "引用" }] }] },
  { type: "divider", id: "d1", spaceAfterPx: 4 },
];

function createState(blocks: readonly OverlayTextBlock[] = BLOCKS): EditorState {
  return EditorState.create({ schema, doc: schema.nodeFromJSON(overlayTextBlocksToTiptapDoc(blocks)) });
}

describe("text shape space-after units", () => {
  it("lists paragraphs, headings, dividers and every list item (nested too), but not quote contents", () => {
    const units = collectTextShapeSpaceAfterUnits(createState().doc);

    expect(units.map((unit) => [unit.kind, unit.node.type.name])).toEqual([
      ["block", "paragraph"],
      ["block", "heading"],
      ["listItem", "listItem"],
      ["listItem", "listItem"],
      ["listItem", "listItem"],
      ["block", "divider"],
    ]);
  });

  it("reads the stored space of a block and of a list item (which lives on its leading paragraph)", () => {
    const units = collectTextShapeSpaceAfterUnits(createState().doc);

    expect(units.map(readTextShapeSpaceAfterPx)).toEqual([12, 0, 9, 0, 0, 4]);
  });

  it("finds the innermost unit that contains a position", () => {
    const state = createState();
    const units = collectTextShapeSpaceAfterUnits(state.doc);
    let nestedTextPos = -1;
    state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "入れ子") {
        nestedTextPos = pos + 1;
      }
    });

    // 入れ子の項目の中のキャレットは、外側の項目ではなく内側の項目を指す。
    expect(findInnermostTextShapeSpaceAfterUnitIndex(units, nestedTextPos)).toBe(3);
    // どの単位にも入らない位置 (doc の末尾の外)。
    expect(findInnermostTextShapeSpaceAfterUnitIndex(units, state.doc.content.size + 5)).toBe(-1);
  });

  it("writes a block's space as a node attribute and round-trips it into the shape's blocks", () => {
    const state = createState();
    const units = collectTextShapeSpaceAfterUnits(state.doc);

    const next = state.apply(setTextShapeSpaceAfter(state.tr, units[1], 18));
    const blocks = tiptapDocToOverlayTextBlocks(next.doc.toJSON(), BLOCKS);

    expect(blocks[1]).toMatchObject({ type: "heading", id: "h1", spaceAfterPx: 18 });
    // 触っていない段落の値はそのまま残る。
    expect(blocks[0]).toMatchObject({ type: "paragraph", id: "p1", spaceAfterPx: 12 });
  });

  it("writes a list item's space on the item and round-trips it without touching its neighbours", () => {
    const state = createState();
    const units = collectTextShapeSpaceAfterUnits(state.doc);

    const next = state.apply(setTextShapeSpaceAfter(state.tr, units[3], 25));
    const [, , list] = tiptapDocToOverlayTextBlocks(next.doc.toJSON(), BLOCKS);

    expect(list.type).toBe("list");
    if (list.type !== "list") return;
    expect(list.items[0].spaceAfterPx).toBe(9);
    expect(list.items[0].nested?.[0].items[0]).toMatchObject({ id: "li2", spaceAfterPx: 25 });
    expect(list.items[1].spaceAfterPx).toBeUndefined();
  });

  it("drops the attribute at 0 so a reset reads like a block that was never touched", () => {
    const state = createState();
    const units = collectTextShapeSpaceAfterUnits(state.doc);

    const reset = state.apply(setTextShapeSpaceAfter(state.tr, units[0], 0));
    const [paragraph] = tiptapDocToOverlayTextBlocks(reset.doc.toJSON(), BLOCKS);

    expect(paragraph).not.toHaveProperty("spaceAfterPx");
  });

  it("clamps to the stored maximum instead of keeping an unbounded value", () => {
    const state = createState();
    const units = collectTextShapeSpaceAfterUnits(state.doc);

    const next = state.apply(setTextShapeSpaceAfter(state.tr, units[0], 9999));

    expect(readTextShapeSpaceAfterPx(collectTextShapeSpaceAfterUnits(next.doc)[0])).toBe(400);
  });

  it("keeps the caret where it was: only attributes change, no node moves", () => {
    const state = createState();
    const units = collectTextShapeSpaceAfterUnits(state.doc);
    const before = state.doc.content.size;

    const next = state.apply(setTextShapeSpaceAfter(state.tr, units[2], 30));

    expect(next.doc.content.size).toBe(before);
    expect(collectTextShapeSpaceAfterUnits(next.doc).map((unit) => unit.pos))
      .toEqual(units.map((unit) => unit.pos));
  });

  it("marks its own transactions so structural edits can be told apart", () => {
    const state = createState();
    const units = collectTextShapeSpaceAfterUnits(state.doc);

    expect(isSpaceAfterTransaction(state.tr)).toBe(false);
    expect(isSpaceAfterTransaction(setTextShapeSpaceAfter(state.tr, units[0], 3).setMeta(SPACE_AFTER_TRANSACTION_META, true)))
      .toBe(true);
  });
});

describe("resolveSpaceAfterUnitElement", () => {
  it("returns the innermost list item, else the top-level child that holds the target", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p><span id=a>x</span></p><ul><li><p><span id=b>y</span></p><ul><li><p><span id=c>z</span></p></li></ul></li></ul><blockquote><p><span id=d>q</span></p></blockquote>";
    const at = (id: string) => root.querySelector(`#${id}`)!;

    expect(resolveSpaceAfterUnitElement(at("a"), root)?.tagName).toBe("P");
    expect(resolveSpaceAfterUnitElement(at("b"), root)?.tagName).toBe("LI");
    expect(resolveSpaceAfterUnitElement(at("c"), root)).toBe(root.querySelectorAll("li")[1]);
    expect(resolveSpaceAfterUnitElement(at("d"), root)?.tagName).toBe("BLOCKQUOTE");
    expect(resolveSpaceAfterUnitElement(root, root)).toBeNull();
  });
});

describe("measureBottomWithin", () => {
  function fakeElement(offsetTop: number, offsetHeight: number, offsetParent: unknown): HTMLElement {
    const element = document.createElement("div");
    Object.defineProperty(element, "offsetTop", { value: offsetTop });
    Object.defineProperty(element, "offsetHeight", { value: offsetHeight });
    Object.defineProperty(element, "offsetParent", { value: offsetParent });
    return element;
  }

  it("sums the layout offsets up to the ancestor and adds the element's own height", () => {
    const wrapper = document.createElement("div");
    const root = fakeElement(2, 100, wrapper);
    const item = fakeElement(30, 20, root);

    expect(measureBottomWithin(item, wrapper)).toBe(2 + 30 + 20);
  });

  it("gives up when the ancestor is not on the offsetParent chain", () => {
    const wrapper = document.createElement("div");
    const stray = fakeElement(5, 10, null);

    expect(measureBottomWithin(stray, wrapper)).toBeNull();
  });
});

describe("projectPointerDeltaToShapeY", () => {
  it("is the vertical movement itself for an upright shape at 100%", () => {
    expect(projectPointerDeltaToShapeY(7, 20, 0, 1)).toBeCloseTo(20);
  });

  it("divides the screen movement by the zoom", () => {
    expect(projectPointerDeltaToShapeY(0, 30, 0, 1.5)).toBeCloseTo(20);
    expect(projectPointerDeltaToShapeY(0, 10, 0, 0.5)).toBeCloseTo(20);
  });

  it("follows the shape's own downward axis when it is turned a quarter turn", () => {
    // 時計回りに 90 度回った図形の「下」は画面の左。左へ 20px 動かすと局所では 20px 下がる。
    expect(projectPointerDeltaToShapeY(-20, 0, Math.PI / 2, 1)).toBeCloseTo(20);
    // 画面の縦の動きは、その図形の縦軸にはまったく効かない。
    expect(projectPointerDeltaToShapeY(0, 40, Math.PI / 2, 1)).toBeCloseTo(0);
  });

  it("turned upside down, dragging up on the screen grows the space", () => {
    expect(projectPointerDeltaToShapeY(0, -20, Math.PI, 1)).toBeCloseTo(20);
  });

  it("combines rotation and zoom", () => {
    const angle = Math.PI / 6;
    // 局所の下方向の単位ベクトルを画面で 40px 進める → 局所では 40 / 2 = 20px。
    expect(projectPointerDeltaToShapeY(-Math.sin(angle) * 40, Math.cos(angle) * 40, angle, 2)).toBeCloseTo(20);
  });

  it("falls back to an upright, unzoomed reading for unusable inputs", () => {
    expect(projectPointerDeltaToShapeY(0, 12, Number.NaN, 0)).toBeCloseTo(12);
  });
});
