// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
  LayoutSectionExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
import { getEditorTextBlockAttributes } from "@/components/editor/TextFlowEditor";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import {
  getLayoutSectionColumns,
  getTextFlowBlockAttributes,
  hasTextFlowBlockAttributeChange,
  MAX_TEXT_FLOW_EDITOR_LAYOUT_CHARS,
  type TextFlowBlock,
} from "@/features/text-editing";

import { textFlowBlockToTiptapNode, textFlowToTiptap, tiptapToTextFlow } from "./tiptap-document-adapter";
import { sliceToTextFlowBlocks } from "./text-run-slice";
import { cloneDocumentBlocksForPaste } from "@/lib/editor-clipboard";
import { collectBlocksById, findContainingProblem, removeBlockFromDocument } from "@/lib/document-tree";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { sampleDocument } from "@/lib/sample-document";

function createEditor(blocks: TextFlowBlock[]) {
  return new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({
      blockExtensions: [
        SigmaDocTextAttrs,
        BoxBlockExtension,
        BoxBlockTitleExtension,
        BoxBlockBodyExtension,
        LayoutSectionExtension,
      ],
      // `LayoutSectionExtension` の content 式が `divider` を名指しているので、本文の
      // ブロック群と同時にしか組めない。片方だけ載せるとスキーマの構築時点で落ちる。
      bodyBlocks: true,
    }),
    content: textFlowToTiptap(blocks),
  });
}

const PARAGRAPH_WITH_BREAK: TextFlowBlock = {
  type: "paragraph",
  id: "p_break",
  children: [{ type: "text", text: "改ページの後ろ" }],
  pagination: { break: true },
};

describe("pagination round trip", () => {
  it("preserves nested problems, metadata, and breaks when editing, copying, saving, and deleting a descendant", () => {
    const blocks: TextFlowBlock[] = [{ type: "boxBlock", id: "outer", styleId: "itembox", blocks: [
      { type: "divider", id: "divider" },
      { type: "problem", id: "nested_problem", tags: ["tag"], numbering: { enabled: true, value: 4 },
        answer: { type: "text", expected: "42" },
        lead: [], hints: [], solution: [], prompt: [
          { type: "paragraph", id: "prompt", children: [{ type: "text", text: "abc" }] },
          { type: "boxBlock", id: "inner", styleId: "itembox", pagination: { break: true }, blocks: [
            { type: "paragraph", id: "inner_p", children: [{ type: "text", text: "inside" }] },
          ] },
        ],
      },
    ] }];
    const editor = createEditor(blocks);
    let position = 0;
    editor.state.doc.descendants((node, pos) => { if (node.attrs.sigmaDocId === "prompt") position = pos + 2; });
    editor.view.dispatch(editor.state.tr.insertText("!", position));
    const updated = tiptapToTextFlow(editor.getJSON(), blocks);
    editor.destroy();
    const saved = parseSigmaDocument({ ...sampleDocument, content: updated });
    expect(findContainingProblem(saved, "inner_p")).toMatchObject({ id: "nested_problem", numbering: { value: 4 }, answer: { expected: "42" } });
    expect(collectBlocksById(saved.content).get("prompt")).toMatchObject({ children: [{ type: "text", text: "a!bc" }] });
    expect(collectBlocksById(saved.content).get("inner")).toMatchObject({ pagination: { break: true } });
    const copied = cloneDocumentBlocksForPaste(saved.content);
    const joined = parseSigmaDocument({ ...saved, content: [...saved.content, ...copied] });
    expect(collectBlocksById(joined.content).size).toBe(12);
    const deleted = removeBlockFromDocument(saved, "inner_p");
    expect(collectBlocksById(deleted.content).has("inner_p")).toBe(false);
    expect(findContainingProblem(deleted, "inner")).toMatchObject({ id: "nested_problem" });
  });

  it("carries every pagination hint through the Tiptap node and back", () => {
    const blocks: TextFlowBlock[] = [
      PARAGRAPH_WITH_BREAK,
      {
        type: "heading",
        id: "h_keep",
        level: 2,
        children: [{ type: "text", text: "見出し" }],
        pagination: { break: true },
      },
      {
        type: "list",
        id: "list_together",
        listType: "bullet",
        items: [{ type: "listItem", id: "li_1", children: [{ type: "text", text: "項目" }] }],
        pagination: { break: true },
      },
      {
        type: "boxBlock",
        id: "box_break",
        styleId: "fancybox",
        blocks: [{ type: "paragraph", id: "box_p", children: [] }],
        pagination: { break: true },
      },
      {
        type: "layoutSection",
        id: "layout_break",
        layout: { columnCount: 2 },
        children: [{ type: "paragraph", id: "layout_p", children: [] }],
        pagination: { break: true },
      },
    ];

    // previousBlocks を渡さない = 貼り付けなどで新しく現れたブロックと同じ扱い。
    const restored = tiptapToTextFlow(textFlowToTiptap(blocks));

    expect(restored.map((block) => block.pagination)).toEqual([
      { break: true },
      { break: true },
      { break: true },
      { break: true },
      { break: true },
    ]);
  });

  it("treats a fresh leading break as a transfer from the surviving owner", () => {
    const previous: TextFlowBlock[] = [
      { type: "paragraph", id: "before", children: [{ type: "text", text: "前" }] },
      PARAGRAPH_WITH_BREAK,
      { type: "paragraph", id: "after", children: [{ type: "text", text: "後" }] },
    ];
    const pasted: TextFlowBlock = {
      type: "paragraph",
      id: "pasted",
      children: [{ type: "text", text: "貼付" }],
      pagination: { break: true },
    };
    const pastedSecond: TextFlowBlock = {
      type: "paragraph",
      id: "pasted_second",
      children: [{ type: "text", text: "貼付2" }],
    };
    const converted = tiptapToTextFlow(textFlowToTiptap([
      previous[0],
      pasted,
      pastedSecond,
      previous[1],
      previous[2],
    ]), previous);

    expect(converted.map((block) => [block.id, block.pagination?.break])).toEqual([
      ["before", undefined],
      ["pasted", true],
      ["pasted_second", undefined],
      ["p_break", undefined],
      ["after", undefined],
    ]);
  });

  it("keeps a manual page break inside a slice copied out of a real editor", () => {
    // PM のスキーマが pagination を宣言していないと attrs はここで落ちる。
    const editor = createEditor([
      { type: "paragraph", id: "p_first", children: [{ type: "text", text: "前" }] },
      PARAGRAPH_WITH_BREAK,
    ]);
    const blocks = sliceToTextFlowBlocks(editor.state.doc.slice(0, editor.state.doc.content.size));

    expect(blocks.find((block) => block.id === "p_break")?.pagination).toEqual({ break: true });
    editor.destroy();
  });

  it("lets SigmaDoc win over the node attribute for a block that already exists", () => {
    // 改ページの付け外しは SigmaDoc 側の操作。既存 id は必ずそちらへ従う
    // (従わないと、外したはずの改ページが古い attrs から生き返る)。
    const node = textFlowBlockToTiptapNode(PARAGRAPH_WITH_BREAK);
    const restored = tiptapToTextFlow({ type: "doc", content: [node] }, [
      { type: "paragraph", id: "p_break", children: [] },
    ]);

    expect(restored[0]?.pagination).toBeUndefined();
  });

  it("transfers a deleted block's manual break to the next surviving block", () => {
    const previous = [
      { type: "paragraph" as const, id: "before", children: [] },
      { type: "paragraph" as const, id: "deleted", children: [], pagination: { break: true as const } },
      { type: "paragraph" as const, id: "after", children: [] },
    ];
    const restored = tiptapToTextFlow(textFlowToTiptap([previous[0], previous[2]]), previous);

    expect(restored[1]?.pagination?.break).toBe(true);
  });

  it("does not duplicate a break when the block is split in two", () => {
    const editor = createEditor([PARAGRAPH_WITH_BREAK]);
    editor.commands.setTextSelection(1 + "改ページ".length);
    editor.commands.splitBlock();
    const blocks = tiptapToTextFlow(editor.getJSON() as Parameters<typeof tiptapToTextFlow>[0]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.pagination).toEqual({ break: true });
    expect(blocks[1]?.pagination).toBeUndefined();
    editor.destroy();
  });

  it("ignores a malformed pagination attribute instead of persisting it", () => {
    const restored = tiptapToTextFlow({
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { sigmaDocId: "p_bad", sigmaDocType: "paragraph", pagination: { break: "yes" } },
        content: [],
      }],
    });

    expect(restored[0]?.pagination).toBeUndefined();
  });
});

describe("block space after round trip", () => {
  const PARAGRAPH_WITH_SPACE: TextFlowBlock = {
    type: "paragraph",
    id: "p_space",
    children: [{ type: "text", text: "下に余白のある段落" }],
    spaceAfterPx: 24,
  };

  it("carries the space through the Tiptap node and back on every block family", () => {
    const blocks: TextFlowBlock[] = [
      PARAGRAPH_WITH_SPACE,
      { type: "heading", id: "h_space", level: 2, children: [], spaceAfterPx: 8 },
      { type: "section", id: "s_space", title: "節", spaceAfterPx: 9 },
      {
        type: "list",
        id: "list_space",
        listType: "bullet",
        items: [{ type: "listItem", id: "li_space", children: [{ type: "text", text: "項目" }], spaceAfterPx: 7 }],
        spaceAfterPx: 10,
      },
      { type: "divider", id: "divider_space", spaceAfterPx: 11 },
      { type: "quote", id: "quote_space", blocks: [{ type: "paragraph", id: "quote_p", children: [] }], spaceAfterPx: 12 },
      { type: "codeBlock", id: "code_space", children: [], spaceAfterPx: 13 },
      {
        type: "boxBlock",
        id: "box_space",
        styleId: "fancybox",
        blocks: [{ type: "paragraph", id: "box_p", children: [] }],
        spaceAfterPx: 14,
      },
      {
        type: "layoutSection",
        id: "layout_space",
        layout: { columnCount: 2 },
        children: [{ type: "paragraph", id: "layout_p", children: [] }],
        spaceAfterPx: 15,
      },
    ];

    const restored = tiptapToTextFlow(textFlowToTiptap(blocks));

    expect(restored.map((block) => block.spaceAfterPx)).toEqual([24, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("leaves an untouched block without the key", () => {
    const restored = tiptapToTextFlow(textFlowToTiptap([
      { type: "paragraph", id: "p_plain", children: [] },
    ]));

    expect("spaceAfterPx" in restored[0]).toBe(false);
  });

  it("keeps the space in a slice copied out of a real editor", () => {
    // 貼り付けで運ばれるかどうか。PM のスキーマが属性を宣言していないとここで落ちる。
    const editor = createEditor([
      { type: "paragraph", id: "p_first", children: [{ type: "text", text: "前" }] },
      PARAGRAPH_WITH_SPACE,
    ]);
    const blocks = sliceToTextFlowBlocks(editor.state.doc.slice(0, editor.state.doc.content.size));

    expect(blocks.find((block) => block.id === "p_space")?.spaceAfterPx).toBe(24);
    editor.destroy();
  });

  it("lets SigmaDoc win over the node attribute for a block that already exists", () => {
    const node = textFlowBlockToTiptapNode(PARAGRAPH_WITH_SPACE);
    const restored = tiptapToTextFlow({ type: "doc", content: [node] }, [
      { type: "paragraph", id: "p_space", children: [] },
    ]);

    expect(restored[0]?.spaceAfterPx).toBeUndefined();
  });

  it("leaves the space on the first half when the block is split in two", () => {
    const editor = createEditor([PARAGRAPH_WITH_SPACE]);
    editor.commands.setTextSelection(1 + "下に余白".length);
    editor.commands.splitBlock();
    const blocks = tiptapToTextFlow(editor.getJSON() as Parameters<typeof tiptapToTextFlow>[0]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.spaceAfterPx).toBe(24);
    expect(blocks[1]?.spaceAfterPx).toBeUndefined();
    editor.destroy();
  });

  it("ignores a malformed attribute instead of persisting it", () => {
    const restored = tiptapToTextFlow({
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { sigmaDocId: "p_bad", sigmaDocType: "paragraph", spaceAfterPx: "24px" },
        content: [],
      }],
    });

    expect(restored[0]?.spaceAfterPx).toBeUndefined();
  });

  it("clamps an out-of-range attribute instead of persisting it", () => {
    const restored = tiptapToTextFlow({
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { sigmaDocId: "p_big", sigmaDocType: "paragraph", spaceAfterPx: 10_000 },
        content: [],
      }],
    });

    expect(restored[0]?.spaceAfterPx).toBe(400);
  });

  it("renders the shared custom property on the blocks that draw it", () => {
    const editor = createEditor([
      PARAGRAPH_WITH_SPACE,
      { type: "divider", id: "divider_space", spaceAfterPx: 11 },
      { type: "quote", id: "quote_space", blocks: [{ type: "paragraph", id: "quote_p", children: [] }], spaceAfterPx: 12 },
    ]);
    const dom = editor.view.dom;

    expect(dom.querySelector<HTMLElement>('[data-sigma-doc-id="p_space"]')?.style
      .getPropertyValue("--sigma-doc-space-after")).toBe("24px");
    expect(dom.querySelector<HTMLElement>('[data-sigma-doc-id="divider_space"]')?.style
      .getPropertyValue("--sigma-doc-space-after")).toBe("11px");
    // 枠を持つ引用は今回は描かない (padding が枠の内側に入るため)。値は doc に残る。
    expect(dom.querySelector<HTMLElement>('[data-sigma-doc-id="quote_space"]')?.style
      .getPropertyValue("--sigma-doc-space-after")).toBe("");
    editor.destroy();
  });

  it("renders list-item spacing only on its dedicated internal-edge variable", () => {
    const editor = createEditor([{
      type: "list",
      id: "list",
      listType: "bullet",
      items: [{
        type: "listItem",
        id: "item",
        children: [{ type: "text", text: "item" }],
        spaceAfterPx: 18,
        continuations: [{ type: "paragraph", id: "continuation", children: [] }],
        nested: [{
          type: "list",
          id: "nested",
          listType: "bullet",
          items: [{ type: "listItem", id: "nested-item", children: [] }],
        }],
      }],
    }]);
    const item = editor.view.dom.querySelector<HTMLElement>("li");
    const leading = editor.view.dom.querySelector<HTMLElement>('[data-sigma-doc-id="item"]');

    expect(item?.style.getPropertyValue("--sigma-doc-list-item-space-after")).toBe("18px");
    expect(item?.style.getPropertyValue("--sigma-doc-space-after")).toBe("");
    expect(leading?.style.getPropertyValue("--sigma-doc-space-after")).toBe("");
    expect(tiptapToTextFlow(editor.getJSON())[0]).toMatchObject({
      type: "list",
      items: [{ id: "item", spaceAfterPx: 18 }],
    });
    editor.destroy();
  });

  /**
   * フォーカス中の面への同期は「PM のノード属性から作った署名」と「SigmaDoc から作った署名」の
   * 食い違いで起こす。**どれか 1 種別でも往復で食い違うと、その面への `setContent` が毎レンダー
   * 走り続ける** (キャレットが飛び続ける) ので、全種別を実物のスキーマで突き合わせる。
   */
  it("gives every block family the same attribute signature on both sides", () => {
    const blocks: TextFlowBlock[] = [
      PARAGRAPH_WITH_SPACE,
      { type: "heading", id: "h_space", level: 2, children: [], spaceAfterPx: 8 },
      { type: "section", id: "s_space", title: "節", spaceAfterPx: 9 },
      {
        type: "list",
        id: "list_space",
        listType: "bullet",
        items: [{
          type: "listItem",
          id: "li_space",
          children: [{ type: "text", text: "項目" }],
          spaceAfterPx: 7,
          continuations: [{ type: "paragraph", id: "li_cont", children: [], spaceAfterPx: 16 }],
        }],
        spaceAfterPx: 10,
      },
      { type: "divider", id: "divider_space", spaceAfterPx: 11 },
      { type: "quote", id: "quote_space", blocks: [{ type: "paragraph", id: "quote_p", children: [], spaceAfterPx: 17 }], spaceAfterPx: 12 },
      { type: "codeBlock", id: "code_space", children: [], spaceAfterPx: 13 },
      {
        type: "boxBlock",
        id: "box_space",
        styleId: "fancybox",
        blocks: [{ type: "paragraph", id: "box_p", children: [], spaceAfterPx: 18 }],
        spaceAfterPx: 14,
      },
      {
        type: "layoutSection",
        id: "layout_space",
        layout: { columnCount: 2 },
        children: [{ type: "paragraph", id: "layout_p", children: [], spaceAfterPx: 19 }],
        spaceAfterPx: 15,
      },
    ];
    const editor = createEditor(blocks);

    expect(hasTextFlowBlockAttributeChange(getEditorTextBlockAttributes(editor), blocks)).toBe(false);
    // 突き合わせが空振りしていない (どちらの写像にも実際に値が載っている) ことも見る。
    const editorAttributes = getEditorTextBlockAttributes(editor);
    for (const [id, signature] of getTextFlowBlockAttributes(blocks)) {
      expect(editorAttributes.get(id), `${id} の署名が PM 側に無い`).toBe(signature);
    }
    editor.destroy();
  });

  it("keeps text-align and line-height alongside the space on one element", () => {
    const editor = createEditor([{
      type: "paragraph",
      id: "p_mixed",
      align: "center",
      lineHeight: "1.2",
      children: [{ type: "text", text: "混在" }],
      spaceAfterPx: 6,
    }]);
    const element = editor.view.dom.querySelector<HTMLElement>('[data-sigma-doc-id="p_mixed"]');

    expect(element?.style.textAlign).toBe("center");
    expect(element?.style.lineHeight).toBe("1.2");
    expect(element?.style.getPropertyValue("--sigma-doc-space-after")).toBe("6px");
    editor.destroy();
  });
});

describe("layoutSection round trip", () => {
  it("updates output lines when rule attributes change without replacing editable content", () => {
    const section: TextFlowBlock = {
      type: "layoutSection", id: "rule-section", layout: { columnCount: 2, columnStartIds: ["rule-left", "rule-right"] },
      children: [
        { type: "paragraph", id: "rule-left", children: [{ type: "text", text: "left" }] },
        { type: "paragraph", id: "rule-right", children: [{ type: "text", text: "right" }] },
      ],
    };
    const editor = createEditor([section]);
    const content = editor.view.dom.querySelector(".sigma-doc-layout-section-body");
    const attrs = editor.state.doc.firstChild!.attrs;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, {
      ...attrs, columnRule: { style: "dotted", widthPx: 2, color: "#123456" },
    }));
    expect(editor.view.dom.querySelectorAll(".column-rule-separator")).toHaveLength(1);
    expect(editor.view.dom.querySelector(".sigma-doc-layout-section-body")).toBe(content);
    expect(editor.getHTML()).toMatch(/--column-rule-style:\s*dotted/);
    editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, {
      ...attrs, columnRule: { style: "none", widthPx: 2, color: "#123456" },
    }));
    expect(editor.view.dom.querySelectorAll(".column-rule-separator")).toHaveLength(0);
    expect(editor.state.doc.textContent).toBe("leftright");
    editor.destroy();
  });

  it("keeps a column section that was copied as part of a slice", () => {
    const section: TextFlowBlock = {
      type: "layoutSection",
      id: "layout_1",
      layout: {
        columnCount: 3,
        columnGapMm: 12,
        columnRule: { style: "double", widthPx: 3, color: "#123456" },
        columnStartIds: ["layout_p1", "layout_p2", "layout_p3"],
        columnWidths: [3000, 3000, 4000],
      },
      children: [
        { type: "paragraph", id: "layout_p1", children: [{ type: "text", text: "左" }], align: undefined, lineHeight: undefined },
        { type: "paragraph", id: "layout_p2", children: [{ type: "text", text: "中" }], align: undefined, lineHeight: undefined },
        { type: "paragraph", id: "layout_p3", children: [{ type: "text", text: "右" }], align: undefined, lineHeight: undefined },
      ],
    };
    const editor = createEditor([section]);
    const blocks = sliceToTextFlowBlocks(editor.state.doc.slice(0, editor.state.doc.content.size));

    expect(blocks).toEqual([section]);
    editor.destroy();
  });
});

/**
 * 入れ物 (箱・n 段組) の中で本文ブロックの種別を変えたときの往復。
 *
 * PM が持てる形を SigmaDoc へ戻せないと、**書いた文字ごと**空段落へ潰れる。実際に
 * 「箱の中で引用ボタンを押すと本文が消える」という形で出ていたので、受け取れる集合と
 * 落とし方の両方をここで固定する。
 */
describe("入れ物の中の本文ブロック", () => {
  it("keeps a quote, a code block and a divider that live inside a box", () => {
    const box: TextFlowBlock = {
      type: "boxBlock",
      id: "box_1",
      styleId: "fancybox",
      blocks: [
        {
          type: "quote",
          id: "box_quote",
          blocks: [{ type: "paragraph", id: "box_quote_p", children: [{ type: "text", text: "引用の中身" }] }],
        },
        { type: "codeBlock", id: "box_code", children: [{ type: "text", text: "const a = 1;" }], language: "javascript" },
        { type: "divider", id: "box_divider" },
      ],
    };
    const editor = createEditor([box]);

    expect(tiptapToTextFlow(editor.getJSON())).toEqual([box]);
    editor.destroy();
  });

  it("keeps a divider inside a column section", () => {
    const section: TextFlowBlock = {
      type: "layoutSection",
      id: "layout_1",
      layout: { columnCount: 2, columnGapMm: 8, columnStartIds: ["layout_p1", "layout_divider"], columnWidths: [6500, 3500] },
      children: [
        { type: "paragraph", id: "layout_p1", children: [{ type: "text", text: "左" }] },
        { type: "divider", id: "layout_divider" },
      ],
    };
    const editor = createEditor([section]);

    expect(tiptapToTextFlow(editor.getJSON())).toEqual([section]);
    editor.destroy();
  });

  it("repairs stale column starts after an Enter split instead of increasing the column count", () => {
    const section: TextFlowBlock = {
      type: "layoutSection",
      id: "layout_split",
      layout: {
        columnCount: 2,
        columnGapMm: 8,
        columnStartIds: ["left", "right"],
        columnWidths: [6000, 4000],
      },
      children: [
        { type: "paragraph", id: "split-head", children: [] },
        { type: "paragraph", id: "left", children: [{ type: "text", text: "left" }] },
        { type: "paragraph", id: "right", children: [{ type: "text", text: "right" }] },
      ],
    };
    const doc = textFlowToTiptap([section]);
    const restored = tiptapToTextFlow(doc);

    expect(restored[0]?.type).toBe("layoutSection");
    if (restored[0]?.type !== "layoutSection") return;
    expect(restored[0].layout.columnCount).toBe(2);
    expect(restored[0].layout.columnStartIds).toEqual(["split-head", "right"]);
    expect(restored[0].layout.columnWidths).toEqual([6000, 4000]);
  });

  it("retains pre-edit column ownership when a column-start block is deleted", () => {
    const section: TextFlowBlock = {
      type: "layoutSection",
      id: "layout_delete_start",
      layout: {
        columnCount: 2,
        columnGapMm: 8,
        columnStartIds: ["a", "c"],
        columnWidths: [6000, 4000],
      },
      children: [
        { type: "paragraph", id: "a", children: [] },
        { type: "paragraph", id: "b", children: [] },
        { type: "paragraph", id: "c", children: [] },
        { type: "paragraph", id: "d", children: [] },
      ],
    };
    const editor = createEditor([section]);
    editor.state.doc.descendants((node, pos) => {
      if (node.attrs.sigmaDocId === "c") {
        editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
        return false;
      }
    });
    const [restored] = tiptapToTextFlow(editor.getJSON(), [section]);
    editor.destroy();

    expect(restored?.type).toBe("layoutSection");
    if (restored?.type !== "layoutSection") return;
    expect(restored.layout.columnStartIds).toEqual(["a", "d"]);
    expect(getLayoutSectionColumns(restored).map((column) => column.map((block) => block.id)))
      .toEqual([["a", "b"], ["d"]]);
  });

  it("creates an empty owner when an edited column temporarily loses its last child", () => {
    const section: TextFlowBlock = {
      type: "layoutSection",
      id: "layout_missing_column",
      layout: { columnCount: 3, columnGapMm: 8, columnStartIds: ["left", "right", "gone"] },
      children: [
        { type: "paragraph", id: "left", children: [] },
        { type: "paragraph", id: "right", children: [] },
      ],
    };
    const restored = tiptapToTextFlow(textFlowToTiptap([section]));

    expect(restored[0]?.type).toBe("layoutSection");
    if (restored[0]?.type !== "layoutSection") return;
    expect(restored[0].layout.columnCount).toBe(3);
    expect(restored[0].layout.columnStartIds).toHaveLength(3);
    expect(restored[0].children).toHaveLength(3);
    expect(restored[0].layout.columnStartIds)
      .toEqual(restored[0].children.map((child) => child.id));
  });

  it("keeps quote and code blocks at mixed-type column boundaries", () => {
    const section: TextFlowBlock = {
      type: "layoutSection",
      id: "layout_mixed",
      layout: {
        columnCount: 2,
        columnGapMm: 8,
        columnStartIds: ["left", "layout_code"],
        columnWidths: [6000, 4000],
      },
      children: [
        { type: "paragraph", id: "left", children: [{ type: "text", text: "左" }] },
        {
          type: "quote",
          id: "layout_quote",
          blocks: [{ type: "paragraph", id: "layout_quote_p", children: [{ type: "text", text: "引用" }] }],
        },
        {
          type: "codeBlock",
          id: "layout_code",
          children: [{ type: "text", text: "const right = true;" }],
          language: "typescript",
        },
        { type: "paragraph", id: "right_tail", children: [{ type: "text", text: "右末尾" }] },
      ],
    };
    const editor = createEditor([section]);
    const [restored] = tiptapToTextFlow(editor.getJSON());

    expect(restored).toEqual(section);
    editor.destroy();
  });

  it("keeps megabyte paragraph text out of Tiptap and restores it from the previous block", () => {
    const huge = "A".repeat(MAX_TEXT_FLOW_EDITOR_LAYOUT_CHARS + 1);
    const block: TextFlowBlock = {
      type: "paragraph",
      id: "p_huge",
      children: [{ type: "text", text: huge }],
    };
    const neighbor: TextFlowBlock = {
      type: "paragraph",
      id: "p_ok",
      children: [{ type: "text", text: "朝" }],
    };
    const doc = textFlowToTiptap([block, neighbor]);
    const serialized = JSON.stringify(doc);
    expect(serialized.includes(huge.slice(0, 80))).toBe(false);
    expect(serialized.length).toBeLessThan(huge.length);
    expect(doc.content?.[0]).toMatchObject({
      type: "paragraph",
      attrs: { sigmaDocId: "p_huge", editorLayoutCapped: true },
    });

    const restored = tiptapToTextFlow(doc, [block, neighbor]);
    expect(restored[0]).toBe(block);
    expect(restored[1]).toEqual(neighbor);
    expect(tiptapToTextFlow({ type: "doc", content: [doc.content![1]] }, [block, neighbor])).toEqual([neighbor]);
  });
});
