import { describe, expect, it } from "vitest";

import type { SigmaCommentThread } from "@/features/document";

import type { TextFlowBlock } from "./text-flow-types";
import {
  areTextFlowBlockIdSequencesEqual,
  getCommentThreadsSyncKey,
  getTextFlowBreakGapSyncKey,
  getTextFlowColumnLayoutsSyncKey,
  getTextFlowFragmentLayoutsSyncKey,
  getLastTextFlowBlockId,
  getTextFlowBlockAttributes,
  getTextFlowBlockKinds,
  hasTextFlowBlockAttributeChange,
  hasTextFlowBlockKindChange,
  textFlowBlockAttributeSignature,
  getTextFlowBlockIds,
  getTextFlowBlocksSyncKey,
  shouldSyncExternalTextFlowContent,
  shouldSyncFocusedTextFlowContent,
  textFlowBlocksContainId,
} from "./block-sync";

describe("text-flow block synchronization", () => {
  it("resynchronizes a box editor when only its local column rule changes", () => {
    const before: TextFlowBlock[] = [{
      type: "boxBlock", id: "box-rule", styleId: "fancybox", blocks: [{
        type: "layoutSection", id: "columns-rule", layout: { columnCount: 2 },
        children: [{ type: "paragraph", id: "p-rule", children: [] }],
      }],
    }];
    const after = structuredClone(before);
    const box = after[0];
    if (box.type !== "boxBlock" || box.blocks[0].type !== "layoutSection") throw new Error("missing section");
    box.blocks[0].layout.columnRule = { style: "dashed", widthPx: 2, color: "#123456" };
    expect(getTextFlowBlocksSyncKey(after)).not.toBe(getTextFlowBlocksSyncKey(before));
  });

  const blocks: TextFlowBlock[] = [{
    type: "boxBlock",
    id: "box",
    styleId: "fancybox",
    blocks: [{
      type: "layoutSection",
      id: "layout",
      layout: { columnCount: 2, columnGapMm: 8 },
      children: [{
        type: "list",
        id: "list",
        listType: "bullet",
        items: [{
          type: "listItem",
          id: "item",
          children: [{ type: "text", text: "本文", marks: ["bold"] }],
          nested: [{
            type: "list",
            id: "nested-list",
            listType: "ordered",
            items: [{
              type: "listItem",
              id: "nested-item",
              children: [{ type: "mathInline", id: "math", tex: "x", display: "inline" }],
            }],
          }],
        }],
      }],
    }],
  }];

  it("collects persisted ids in document order across every nested container", () => {
    expect(getTextFlowBlockIds(blocks)).toEqual([
      "box",
      "layout",
      "list",
      "item",
      "nested-list",
      "nested-item",
    ]);
    expect(getLastTextFlowBlockId(blocks)).toBe("nested-item");
    expect(textFlowBlocksContainId(blocks, "nested-list")).toBe(true);
    expect(textFlowBlocksContainId(blocks, "missing")).toBe(false);
  });

  it("detects focused-editor ownership changes without comparing render content", () => {
    const ids = getTextFlowBlockIds(blocks);
    expect(shouldSyncFocusedTextFlowContent(ids, blocks)).toBe(false);
    expect(shouldSyncFocusedTextFlowContent(ids.slice(1), blocks)).toBe(true);
    expect(shouldSyncFocusedTextFlowContent([...ids].reverse(), blocks)).toBe(true);
  });

  it("re-syncs when only the ordered list marker style changed", () => {
    const decimal: TextFlowBlock[] = [{
      type: "list",
      id: "list",
      listType: "ordered",
      items: [{ type: "listItem", id: "item", children: [{ type: "text", text: "1つめ" }] }],
    }];
    const paren: TextFlowBlock[] = [{ ...decimal[0], markerStyle: "paren" } as TextFlowBlock];

    expect(getTextFlowBlocksSyncKey(paren)).not.toBe(getTextFlowBlocksSyncKey(decimal));
  });

  it("re-syncs when only a list item's alignment changed", () => {
    const leftList: Extract<TextFlowBlock, { type: "list" }> = {
      type: "list",
      id: "list",
      listType: "ordered",
      items: [{ type: "listItem", id: "item", children: [{ type: "text", text: "項目" }] }],
    };
    const left: TextFlowBlock[] = [leftList];
    const center: TextFlowBlock[] = [{
      ...leftList,
      items: [{ ...leftList.items[0], align: "center" }],
    }];

    expect(getTextFlowBlocksSyncKey(center)).not.toBe(getTextFlowBlocksSyncKey(left));
  });

  it("re-syncs when only a continuation paragraph's alignment changed", () => {
    const left: TextFlowBlock[] = [{
      type: "list",
      id: "list",
      listType: "ordered",
      items: [{
        type: "listItem",
        id: "item",
        children: [{ type: "text", text: "先頭" }],
        continuations: [{ type: "paragraph", id: "continued", children: [{ type: "text", text: "続き" }], align: "left" }],
      }],
    }];
    const center = structuredClone(left);
    const centerList = center[0];
    if (centerList.type !== "list" || !centerList.items[0].continuations) {
      throw new Error("continuation fixture is missing");
    }
    const continuation = centerList.items[0].continuations[0];
    if (continuation.type === "divider") {
      throw new Error("continuation fixture is not a text block");
    }
    continuation.align = "center";

    expect(getTextFlowBlocksSyncKey(center)).not.toBe(getTextFlowBlocksSyncKey(left));
  });

  it("compares id sequences by length, value, and order", () => {
    expect(areTextFlowBlockIdSequencesEqual(
      ["first", "second"],
      ["first", "second"],
    )).toBe(true);
    expect(areTextFlowBlockIdSequencesEqual(
      ["first", "second"],
      ["second", "first"],
    )).toBe(false);
    expect(areTextFlowBlockIdSequencesEqual(
      ["first"],
      ["first", "second"],
    )).toBe(false);
  });

  it("keeps break-gap keys sorted with numeric stringification and NUL separators", () => {
    expect(getTextFlowBreakGapSyncKey(undefined)).toBe("");
    expect(getTextFlowBreakGapSyncKey({})).toBe("");
    expect(getTextFlowBreakGapSyncKey({
      second: 12.5,
      first: 0,
    })).toBe("first:0\u0000second:12.5");
    expect(getTextFlowBreakGapSyncKey({
      first: 0,
      second: 12.5,
    })).toBe("first:0\u0000second:12.5");
  });

  it("keeps column-layout keys limited to x, y, and width in sorted id order", () => {
    const layoutsWithAdapterFields = {
      second: {
        x: 1.25,
        y: -2,
        width: 300,
        height: 999,
        pageIndex: 4,
      },
      first: {
        x: 0,
        y: 10.5,
        width: 200,
        height: 888,
        pageIndex: 3,
      },
    };

    expect(getTextFlowColumnLayoutsSyncKey(undefined)).toBe("");
    expect(getTextFlowColumnLayoutsSyncKey(layoutsWithAdapterFields))
      .toBe("first:0:10.5:200\u0000second:1.25:-2:300");
    expect(getTextFlowColumnLayoutsSyncKey({
      first: { x: 0, y: 10.5, width: 200 },
      second: { x: 1.25, y: -2, width: 300 },
    })).toBe("first:0:10.5:200\u0000second:1.25:-2:300");
  });

  it("keeps fragment-layout keys limited to visible and total heights", () => {
    const layoutsWithAdapterFields = {
      second: {
        visibleHeight: 80,
        totalHeight: 80,
        sourcePageIndex: 2,
      },
      first: {
        visibleHeight: 100.5,
        totalHeight: 120,
        sourcePageIndex: 1,
      },
    };

    expect(getTextFlowFragmentLayoutsSyncKey(undefined)).toBe("");
    expect(getTextFlowFragmentLayoutsSyncKey(layoutsWithAdapterFields))
      .toBe("first:100.5:120\u0000second:80:80");
    expect(getTextFlowFragmentLayoutsSyncKey({
      first: { visibleHeight: 100.5, totalHeight: 120 },
      second: { visibleHeight: 80, totalHeight: 80 },
    })).toBe("first:100.5:120\u0000second:80:80");
  });

  it("changes its synchronization key for semantic text-flow changes", () => {
    const initial = getTextFlowBlocksSyncKey(blocks);
    const changed: TextFlowBlock[] = [{
      ...blocks[0],
      pagination: { break: true },
    }];

    expect(getTextFlowBlocksSyncKey(changed)).not.toBe(initial);
    expect(getTextFlowBlocksSyncKey(blocks)).toBe(initial);
  });

  it("keeps one synchronization key for structurally identical blocks in different arrays", () => {
    const paragraph = (text: string): TextFlowBlock[] => ([{
      type: "paragraph",
      id: "p_first",
      children: [{ type: "text", text }],
    }] as TextFlowBlock[]);

    // 打鍵のたびに再構築される配列でも、中身が同じならキーは動かない
    // (このキーが effect の deps なので、識別子で比べると打鍵ごとに再同期が走る)。
    expect(getTextFlowBlocksSyncKey(paragraph("本文"))).toBe(getTextFlowBlocksSyncKey(paragraph("本文")));
    expect(getTextFlowBlocksSyncKey(paragraph("本文"))).not.toBe(getTextFlowBlocksSyncKey(paragraph("本文2")));
  });

  it("skips the passive content sync only when the editor already holds those blocks", () => {
    const mounted = getTextFlowBlocksSyncKey(blocks);
    const external = getTextFlowBlocksSyncKey([{ ...blocks[0], id: "box_after_ai_write" }] as TextFlowBlock[]);

    // マウント直後: エディタはマウント時の内容そのものなので二度打ちしない。
    expect(shouldSyncExternalTextFlowContent(null, mounted, mounted)).toBe(false);
    // 別内容が来たら外部更新なので必ず流し込む。
    expect(shouldSyncExternalTextFlowContent(null, mounted, external)).toBe(true);
    // 履歴復元が入れた内容も二度打ちしない。
    expect(shouldSyncExternalTextFlowContent(external, null, external)).toBe(false);
    // マウント時の内容を「まだ有効」と偽り続けないための呼び出し規約: 一度差し替えたら
    // マウントキーは null になり、同じ内容へ戻ってきた外部更新はきちんと流し込まれる。
    expect(shouldSyncExternalTextFlowContent(null, null, mounted)).toBe(true);
  });
});

describe("block space after synchronization keys", () => {
  /**
   * 同期キーに載らないフィールドは「保存したのに画面が変わらない」で表に出る:
   * `setTextFlowContentPreservingSelection` が走らず PM の attrs が古いままになり、
   * DOM の custom property が更新されない。
   */
  function withSpace(block: TextFlowBlock, spaceAfterPx: number): TextFlowBlock {
    return { ...block, spaceAfterPx } as TextFlowBlock;
  }

  const CASES: Array<[string, TextFlowBlock]> = [
    ["paragraph", { type: "paragraph", id: "p", children: [{ type: "text", text: "本文" }] }],
    ["heading", { type: "heading", id: "h", level: 2, children: [] }],
    ["section", { type: "section", id: "s", title: "節" }],
    [
      "list",
      { type: "list", id: "l", listType: "bullet", items: [{ type: "listItem", id: "li", children: [] }] },
    ],
    ["divider", { type: "divider", id: "d" }],
    ["quote", { type: "quote", id: "q", blocks: [{ type: "paragraph", id: "qp", children: [] }] }],
    ["codeBlock", { type: "codeBlock", id: "c", children: [] }],
    [
      "boxBlock",
      { type: "boxBlock", id: "b", styleId: "fancybox", blocks: [{ type: "paragraph", id: "bp", children: [] }] },
    ],
    [
      "layoutSection",
      {
        type: "layoutSection",
        id: "ls",
        layout: { columnCount: 2 },
        children: [{ type: "paragraph", id: "lp", children: [] }],
      },
    ],
  ];

  it.each(CASES)("changes the key when %s gains a space below", (_name, block) => {
    expect(getTextFlowBlocksSyncKey([withSpace(block, 24)]))
      .not.toBe(getTextFlowBlocksSyncKey([block]));
  });

  it("changes the key when only the amount of space differs", () => {
    const block: TextFlowBlock = { type: "paragraph", id: "p", children: [] };
    expect(getTextFlowBlocksSyncKey([withSpace(block, 24)]))
      .not.toBe(getTextFlowBlocksSyncKey([withSpace(block, 25)]));
  });

  it("changes the key when a block nested in a layout section gains a space below", () => {
    const child: TextFlowBlock = { type: "paragraph", id: "nested_p", children: [] };
    const section = (inner: TextFlowBlock): TextFlowBlock => ({
      type: "layoutSection",
      id: "ls",
      layout: { columnCount: 2 },
      children: [inner as never],
    });

    expect(getTextFlowBlocksSyncKey([section(withSpace(child, 24))]))
      .not.toBe(getTextFlowBlocksSyncKey([section(child)]));
  });
});

describe("comment thread synchronization keys", () => {
  const thread = (overrides: Partial<SigmaCommentThread> = {}): SigmaCommentThread => ({
    id: "thread_1",
    anchor: { type: "block", blockId: "p_first" },
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  it("is empty when the document carries no comments", () => {
    expect(getCommentThreadsSyncKey(undefined)).toBe("");
    expect(getCommentThreadsSyncKey([])).toBe("");
  });

  it("keeps one key for equal threads held in different arrays", () => {
    expect(getCommentThreadsSyncKey([thread()])).toBe(getCommentThreadsSyncKey([thread()]));
  });

  it("changes when a thread is resolved, re-anchored, recolored, or edited", () => {
    const base = getCommentThreadsSyncKey([thread()]);

    expect(getCommentThreadsSyncKey([thread({ resolved: true })])).not.toBe(base);
    expect(getCommentThreadsSyncKey([thread({ color: "#ff0000" })])).not.toBe(base);
    expect(getCommentThreadsSyncKey([thread({ updatedAt: "2026-01-02T00:00:00.000Z" })])).not.toBe(base);
    expect(getCommentThreadsSyncKey([thread({
      anchor: { type: "block", blockId: "p_second" },
    })])).not.toBe(base);
    expect(getCommentThreadsSyncKey([thread({
      anchor: {
        type: "textRange",
        start: { blockId: "p_first", offset: 0 },
        end: { blockId: "p_first", offset: 3 },
        quote: "本文",
      },
    })])).not.toBe(base);
    expect(getCommentThreadsSyncKey([thread(), thread({ id: "thread_2" })])).not.toBe(base);
  });
});

describe("hasTextFlowBlockKindChange", () => {
  const paragraph = (id: string): TextFlowBlock => ({ type: "paragraph", id, children: [] });
  const heading = (id: string, level: 1 | 2 | 3): TextFlowBlock => ({ type: "heading", id, level, children: [] });

  it("段落が見出しに変わったら描き直しを求める", () => {
    const editorKinds = getTextFlowBlockKinds([paragraph("p1")]);
    expect(hasTextFlowBlockKindChange(editorKinds, [heading("p1", 2)])).toBe(true);
  });

  it("見出しレベルだけが変わっても描き直しを求める", () => {
    const editorKinds = getTextFlowBlockKinds([heading("h1", 1)]);
    expect(hasTextFlowBlockKindChange(editorKinds, [heading("h1", 3)])).toBe(true);
  });

  it("同じ種別なら求めない", () => {
    const editorKinds = getTextFlowBlockKinds([paragraph("p1"), heading("h1", 2)]);
    expect(hasTextFlowBlockKindChange(editorKinds, [paragraph("p1"), heading("h1", 2)])).toBe(false);
  });

  it("section は level 1 の見出しとして数える", () => {
    const editorKinds = getTextFlowBlockKinds([heading("s1", 1)]);
    expect(hasTextFlowBlockKindChange(editorKinds, [{ type: "section", id: "s1", title: "章" }])).toBe(false);
  });

  it("片側にしか無い id は突き合わせない (リスト項目など)", () => {
    const editorKinds = getTextFlowBlockKinds([paragraph("p1")]);
    expect(hasTextFlowBlockKindChange(editorKinds, [paragraph("p2")])).toBe(false);
  });

  it("枠や段組の中の段落も見る", () => {
    const editorKinds = getTextFlowBlockKinds([{
      type: "boxBlock",
      id: "box",
      styleId: "fancybox",
      blocks: [paragraph("inner")],
    }]);
    expect(hasTextFlowBlockKindChange(editorKinds, [{
      type: "boxBlock",
      id: "box",
      styleId: "fancybox",
      blocks: [heading("inner", 2)],
    }])).toBe(true);
  });
});

describe("hasTextFlowBlockAttributeChange", () => {
  // 入れ物の中へも入れるので、union ではなく段落そのものの型で返す。
  const paragraph = (id: string, spaceAfterPx?: number) => (
    spaceAfterPx === undefined
      ? { type: "paragraph" as const, id, children: [] }
      : { type: "paragraph" as const, id, children: [], spaceAfterPx }
  );

  it("下余白が付いたら描き直しを求める", () => {
    const editorAttributes = getTextFlowBlockAttributes([paragraph("p1")]);
    expect(hasTextFlowBlockAttributeChange(editorAttributes, [paragraph("p1", 40)])).toBe(true);
  });

  it("下余白が変わっても、消えても求める", () => {
    const editorAttributes = getTextFlowBlockAttributes([paragraph("p1", 40)]);
    expect(hasTextFlowBlockAttributeChange(editorAttributes, [paragraph("p1", 80)])).toBe(true);
    expect(hasTextFlowBlockAttributeChange(editorAttributes, [paragraph("p1")])).toBe(true);
  });

  it("同じ値なら求めない", () => {
    const editorAttributes = getTextFlowBlockAttributes([paragraph("p1", 40), paragraph("p2")]);
    expect(hasTextFlowBlockAttributeChange(editorAttributes, [paragraph("p1", 40), paragraph("p2")])).toBe(false);
  });

  /**
   * 正規化を挟まないと、PM 側の `null` / SigmaDoc 側の `0` / 小数が別の署名になり、
   * 焦点面への `setContent` が毎レンダー走り続ける (同期が止まらない)。
   */
  it("「値なし」と同じ意味の値は同じ署名になる", () => {
    const editorAttributes = getTextFlowBlockAttributes([paragraph("p1")]);
    expect(hasTextFlowBlockAttributeChange(editorAttributes, [paragraph("p1", 0)])).toBe(false);
    expect(textFlowBlockAttributeSignature({ spaceAfterPx: null }))
      .toBe(textFlowBlockAttributeSignature({}));
    expect(textFlowBlockAttributeSignature({ spaceAfterPx: 40.4 }))
      .toBe(textFlowBlockAttributeSignature({ spaceAfterPx: 40 }));
  });

  it("片側にしか無い id は突き合わせない", () => {
    const editorAttributes = getTextFlowBlockAttributes([paragraph("p1")]);
    expect(hasTextFlowBlockAttributeChange(editorAttributes, [paragraph("p2", 40)])).toBe(false);
  });

  it("枠・段組・リストの中のブロックも見る", () => {
    const nested = (spaceAfterPx?: number): TextFlowBlock[] => ([{
      type: "boxBlock",
      id: "box",
      styleId: "fancybox",
      blocks: [{
        type: "layoutSection",
        id: "layout",
        layout: { columnCount: 2 },
        children: [paragraph("inner", spaceAfterPx)],
      }],
    }]);
    expect(hasTextFlowBlockAttributeChange(getTextFlowBlockAttributes(nested()), nested(40))).toBe(true);

    const list = (spaceAfterPx?: number): TextFlowBlock[] => ([{
      type: "list",
      id: "list",
      listType: "bullet",
      items: [{
        type: "listItem",
        id: "item",
        children: [],
        continuations: [paragraph("continuation", spaceAfterPx)],
      }],
    }]);
    expect(hasTextFlowBlockAttributeChange(getTextFlowBlockAttributes(list()), list(40))).toBe(true);
  });

  it("リスト項目自身の下余白変更も見る", () => {
    const list = (spaceAfterPx?: number): TextFlowBlock[] => ([{
      type: "list",
      id: "list",
      listType: "bullet",
      items: [{
        type: "listItem",
        id: "item",
        children: [],
        ...(spaceAfterPx === undefined ? {} : { spaceAfterPx }),
      }],
    }]);

    expect(hasTextFlowBlockAttributeChange(getTextFlowBlockAttributes(list()), list(40))).toBe(true);
  });
});


describe("code block settings synchronization", () => {
  const code = {
    type: "codeBlock" as const,
    id: "code-settings",
    children: [{ type: "text" as const, text: "const x = 1;" }],
  };

  it("detects language and background changes with unchanged code", () => {
    const original = getTextFlowBlocksSyncKey([code]);
    expect(getTextFlowBlocksSyncKey([{ ...code, language: "typescript" }])).not.toBe(original);
    expect(getTextFlowBlocksSyncKey([{ ...code, theme: "dark" }])).not.toBe(original);
    expect(getTextFlowBlocksSyncKey([{ ...code, theme: "light" }])).toBe(original);
  });

  it("detects settings changes inside a containing quote", () => {
    const quote = { type: "quote" as const, id: "quote", blocks: [code] };
    expect(getTextFlowBlocksSyncKey([{ ...quote, blocks: [{ ...code, theme: "dark" }] }]))
      .not.toBe(getTextFlowBlocksSyncKey([quote]));
  });
});
