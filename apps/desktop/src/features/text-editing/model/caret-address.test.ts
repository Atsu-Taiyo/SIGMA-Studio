import { describe, expect, it } from "vitest";

import type {
  BoxBlockNode,
  LayoutSectionNode,
  ListNode,
  ParagraphNode,
  QuoteBlockNode,
} from "@/features/document";

import {
  caretAddressAtBlockEdge,
  caretAddressAtBlockEnd,
  caretAddressAtBlockStart,
  clampCaretOffset,
  normalizeCaretAddressPath,
  type CaretBlockPathEntry,
} from "./caret-address";

function paragraph(id: string, text: string): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function leafEntry(
  blockId: string | null,
  contentStart: number,
  contentSize: number,
): CaretBlockPathEntry {
  return { blockId, contentSize, contentStart, isAtom: false };
}

function containerEntry(blockId: string | null, contentStart: number): CaretBlockPathEntry {
  return { blockId, contentSize: 100, contentStart, isAtom: false };
}

describe("caretAddressAtBlockEnd", () => {
  it("段落は自分自身の末尾を指す", () => {
    expect(caretAddressAtBlockEnd(paragraph("p", "本文だ")))
      .toEqual({ blockId: "p", offset: 3, affinity: "after", kind: "text" });
  });

  it("インライン数式は 1 文字ぶんとして数える", () => {
    const block: ParagraphNode = {
      type: "paragraph",
      id: "p",
      children: [
        { type: "text", text: "x" },
        { type: "mathInline", id: "m", tex: "\\frac{1}{2}", display: "inline" },
      ],
    };
    expect(caretAddressAtBlockEnd(block)).toMatchObject({ blockId: "p", offset: 2 });
  });

  it("箱は最後の子ブロックへ降りる", () => {
    const box: BoxBlockNode = {
      type: "boxBlock",
      id: "box",
      styleId: "fancybox",
      blocks: [paragraph("p1", "あ"), paragraph("p2", "いろは")],
    };
    expect(caretAddressAtBlockEnd(box)).toMatchObject({ blockId: "p2", offset: 3 });
  });

  it("箱の中に段組みがあっても最後の葉まで降りる", () => {
    const box: BoxBlockNode = {
      type: "boxBlock",
      id: "box",
      styleId: "fancybox",
      blocks: [paragraph("p1", "あ"), {
        type: "layoutSection",
        id: "sec",
        layout: { columnCount: 2, columnGapMm: 8 },
        children: [paragraph("c1", "left"), paragraph("c2", "right")],
      }],
    };
    expect(caretAddressAtBlockEnd(box)).toMatchObject({ blockId: "c2", offset: 5 });
  });

  it("段組みセクションは最後の children へ降りる", () => {
    const section: LayoutSectionNode = {
      type: "layoutSection",
      id: "sec",
      layout: { columnCount: 2, columnGapMm: 8 },
      children: [paragraph("c1", "あ"), paragraph("c2", "いろはに")],
    };
    expect(caretAddressAtBlockEnd(section)).toMatchObject({ blockId: "c2", offset: 4 });
  });

  it("引用も箱と同じく最後の子ブロックへ降りる", () => {
    const quote: QuoteBlockNode = {
      type: "quote",
      id: "q",
      blocks: [paragraph("q1", "あ"), paragraph("q2", "いろ")],
    };
    expect(caretAddressAtBlockEnd(quote)).toMatchObject({ blockId: "q2", offset: 2 });
  });

  it("リストは最後の item の continuation へ降りる", () => {
    const list: ListNode = {
      type: "list",
      id: "list",
      listType: "bullet",
      items: [
        { type: "listItem", id: "i1", children: [{ type: "text", text: "一" }] },
        {
          type: "listItem",
          id: "i2",
          children: [{ type: "text", text: "二" }],
          continuations: [{ type: "paragraph", id: "cont", children: [{ type: "text", text: "続き" }] }],
        },
      ],
    };
    expect(caretAddressAtBlockEnd(list)).toMatchObject({ blockId: "cont", offset: 2 });
  });

  it("入れ子リストは continuation より優先される", () => {
    const list: ListNode = {
      type: "list",
      id: "list",
      listType: "bullet",
      items: [{
        type: "listItem",
        id: "i1",
        children: [{ type: "text", text: "一" }],
        continuations: [{ type: "paragraph", id: "cont", children: [{ type: "text", text: "続き" }] }],
        nested: [{
          type: "list",
          id: "inner",
          listType: "bullet",
          items: [{ type: "listItem", id: "n1", children: [{ type: "text", text: "内側" }] }],
        }],
      }],
    };
    expect(caretAddressAtBlockEnd(list)).toMatchObject({ blockId: "n1", offset: 2 });
  });

  it("continuation も入れ子も無い item は item 自身の末尾", () => {
    const list: ListNode = {
      type: "list",
      id: "list",
      listType: "bullet",
      items: [{
        type: "listItem",
        id: "i1",
        children: [{ type: "text", text: "あ" }, { type: "mathInline", id: "m", tex: "x", display: "inline" }],
      }],
    };
    expect(caretAddressAtBlockEnd(list)).toMatchObject({ blockId: "i1", offset: 2 });
  });
});

describe("caretAddressAtBlockStart", () => {
  it("箱の先頭は最初の葉の offset 0", () => {
    const box: BoxBlockNode = {
      type: "boxBlock",
      id: "box",
      styleId: "fancybox",
      blocks: [{
        type: "layoutSection",
        id: "sec",
        layout: { columnCount: 2, columnGapMm: 8 },
        children: [paragraph("c1", "left"), paragraph("c2", "right")],
      }],
    };
    expect(caretAddressAtBlockStart(box))
      .toEqual({ blockId: "c1", offset: 0, affinity: "after", kind: "text" });
  });

  it("空の箱はコンテナ自身を返す", () => {
    const box: BoxBlockNode = { type: "boxBlock", id: "box", styleId: "fancybox", blocks: [] };
    expect(() => caretAddressAtBlockStart(box)).not.toThrow();
    expect(caretAddressAtBlockStart(box)).toMatchObject({ blockId: "box", offset: 0 });
    expect(caretAddressAtBlockEnd(box)).toMatchObject({ blockId: "box" });
  });

  it("項目が空のリストもコンテナ自身を返す", () => {
    const list: ListNode = { type: "list", id: "list", listType: "bullet", items: [] };
    expect(caretAddressAtBlockStart(list)).toMatchObject({ blockId: "list", offset: 0 });
    expect(caretAddressAtBlockEnd(list)).toMatchObject({ blockId: "list" });
  });
});

describe("区切り線 (中へ入れないブロック)", () => {
  it("先頭も末尾もノードとして指す", () => {
    const divider = { type: "divider" as const, id: "d_1" };
    expect(caretAddressAtBlockStart(divider))
      .toEqual({ blockId: "d_1", offset: 0, affinity: "after", kind: "node" });
    // 文字位置として表すと、復元側が「ノードの内容の中」を指して行き過ぎる。
    expect(caretAddressAtBlockEnd(divider))
      .toEqual({ blockId: "d_1", offset: 0, affinity: "after", kind: "node" });
  });
});

describe("caretAddressAtBlockEdge", () => {
  it("start/end を委譲する", () => {
    const box: BoxBlockNode = {
      type: "boxBlock",
      id: "box",
      styleId: "fancybox",
      blocks: [paragraph("p1", "あ"), paragraph("p2", "いろは")],
    };
    expect(caretAddressAtBlockEdge(box, "start")).toEqual(caretAddressAtBlockStart(box));
    expect(caretAddressAtBlockEdge(box, "end")).toEqual(caretAddressAtBlockEnd(box));
  });
});

describe("normalizeCaretAddressPath", () => {
  it("最も内側の id を持つ葉を選ぶ", () => {
    const path = [containerEntry(null, 0), containerEntry("box", 1), leafEntry("p", 5, 10)];
    expect(normalizeCaretAddressPath(path, 8, "after"))
      .toEqual({ blockId: "p", offset: 3, affinity: "after", kind: "text" });
  });

  it("offset を内容の長さでクランプする（上下とも）", () => {
    const path = [leafEntry("p", 5, 4)];
    expect(normalizeCaretAddressPath(path, 100, "after")).toMatchObject({ offset: 4 });
    expect(normalizeCaretAddressPath(path, 0, "after")).toMatchObject({ offset: 0 });
  });

  it("id を持つ祖先が無ければ null", () => {
    expect(normalizeCaretAddressPath([containerEntry(null, 0), leafEntry(null, 1, 3)], 2, "after"))
      .toBeNull();
    expect(normalizeCaretAddressPath([], 0, "after")).toBeNull();
  });

  it("中へ入れないノードは kind:\"node\"", () => {
    const path = [containerEntry(null, 0), {
      blockId: "divider",
      contentSize: 0,
      contentStart: 4,
      isAtom: true,
    }];
    expect(normalizeCaretAddressPath(path, 4, "after"))
      .toEqual({ blockId: "divider", offset: 0, affinity: "after", kind: "node" });
  });

  it("affinity は素通しする", () => {
    expect(normalizeCaretAddressPath([leafEntry("p", 0, 3)], 1, "before"))
      .toMatchObject({ affinity: "before" });
  });

  it("コンテナしか id を持たないときは、そのコンテナ内での位置をそのまま持つ", () => {
    // 箱の中の「段落と段落の隙間」など。ここでの offset はコンテナ内の位置で、復元側も同じ
    // 規約で位置へ戻すので往復すれば元の場所に着く。0 に潰すと箱の先頭へ飛ぶ。
    expect(normalizeCaretAddressPath([containerEntry(null, 0), containerEntry("box", 1)], 9, "after"))
      .toEqual({ blockId: "box", offset: 8, affinity: "after", kind: "text" });
  });
});

describe("clampCaretOffset", () => {
  it("[0, length] に丸め、数値でない値は 0 にする", () => {
    expect(clampCaretOffset(-3, 5)).toBe(0);
    expect(clampCaretOffset(9, 5)).toBe(5);
    expect(clampCaretOffset(2, 5)).toBe(2);
    expect(clampCaretOffset(1, -5)).toBe(0);
    expect(clampCaretOffset(Number.NaN, 5)).toBe(0);
  });
});
