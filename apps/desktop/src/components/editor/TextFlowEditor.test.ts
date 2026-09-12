// @vitest-environment happy-dom

import { readStylesheet as readFileSync } from "../../../tests/helpers/read-stylesheet";

import { Editor, getSchema, type Editor as TiptapEditor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";

import {
  SigmaDocTextIdentity,
} from "@/components/tiptap/sigma-doc-text-identity";
import {
  applyTextFlowSelectionBookmark,
  focusTextFlowSurface,
  getTextFlowSelectionBookmark,
  resolveManualTextPageBreakBlocks,
  resolveTextFlowFormatCommandOptions,
  resolveTextFormatStateContext,
  setTextFlowContentPreservingSelection,
  shouldHandleTextPageBreakRequest,
  shouldSyncFocusedTextFlowContent,
  shouldUseDocumentNextBlockForPageBreak,
  textFlowToTiptap,
  tiptapToTextFlow,
  type TextFlowBlock,
} from "@/components/editor/TextFlowEditor";
import {
  getTextBlockBoundaryInsertPosition,
  isLiteralPasteShortcut,
  textFlowBlocksForSelectionClipboard,
  writeTextFlowSelectionClipboard,
} from "./text-flow/clipboard-transactions";
import {
  consumeRejectedManualBreakPaste,
  deleteManualBreakSpanningSelection,
  pasteHasUsableContent,
  resolveManualBreakBoundaryNavigation,
  resolveManualBreakPasteContent,
  selectionCrossesManualBreak,
  transferManualBreakToPastedBlocksAtOwnerStart,
  transferManualBreakToPastedSliceAtOwnerStart,
} from "./text-flow/manual-break-transactions";
import {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { findTouchedGuardedBlockIds } from "@/components/tiptap/edit-guard-extension";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { applyTextFormatCommand, createTextFormatStateDetail } from "@/components/tiptap/text-format-controller";
import { createTextFlowClipboardPayload, readEditorClipboardPayload, writeEditorClipboardData } from "@/lib/editor-clipboard";
import type { TiptapDoc } from "@/lib/tiptap-adapter";

/**
 * 箱ブロックのスタイルは 2 ファイルに分かれている: 紙面に出る見た目は共有の
 * `document-surface.css` (埋め込みビューアも import する)、空タイトルのプレースホルダなど
 * 編集専用のアフォーダンスは `globals.css`。どちらに書かれていても拾えるよう両方読む。
 */
function readBoxStylesheets(): string {
  return ["../../app/globals.css", "../../app/document-surface.css"]
    .map((relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8"))
    .join("\n");
}

describe("SigmaDoc text identity", () => {

  it("keeps font formatting after the real Enter shortcut", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createRichTextEngineExtensions({
        blockExtensions: [SigmaDocTextAttrs, SigmaDocTextIdentity],
      }),
      content: {
        type: "doc",
        content: [{
          type: "paragraph",
          attrs: { sigmaDocId: "p_original", sigmaDocType: "paragraph" },
          content: [{
            type: "text",
            marks: [{
              type: "styledText",
              attrs: {
                color: "#1d4ed8",
                fontFamily: '"Yu Mincho", serif',
                fontSize: 18,
              },
            }],
            text: "本文",
          }],
        }],
      },
    });

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(editor.view.someProp("handleKeyDown", (handler) => (
      handler(editor.view, keyEvent({ key: "Enter" }) as KeyboardEvent)
    ))).toBe(true);
    setTextFlowContentPreservingSelection(
      editor,
      tiptapToTextFlow(editor.getJSON() as TiptapDoc, []),
    );
    const nextBlockId = editor.getJSON().content?.[1]?.attrs?.sigmaDocId;
    expect(typeof nextBlockId).toBe("string");
    const restored = applyTextFlowSelectionBookmark(
      editor,
      caretBookmark(nextBlockId as string, 0),
    );
    expect(restored.applied).toBe(true);
    focusTextFlowSurface(editor, restored.activeMarks);
    editor.commands.insertContent("次の行");

    expect(editor.getJSON()).toMatchObject({
      content: [
        { content: [{ marks: [{ attrs: { fontFamily: '"Yu Mincho", serif', fontSize: 18 } }] }] },
        { content: [{ marks: [{ attrs: { fontFamily: '"Yu Mincho", serif', fontSize: 18 } }], text: "次の行" }] },
      ],
    });
    editor.destroy();
  });
});

describe("resolveManualTextPageBreakBlocks", () => {
  it("puts break on the next paragraph when the cursor is at the end of a paragraph", () => {
    const blocks = [
      paragraph("p_first", "first"),
      paragraph("p_second", "second"),
    ];

    const result = resolveManualTextPageBreakBlocks(blocks, "p_first", true, {
      blockId: "p_first",
      offset: 5,
    });

    expect(result?.blocks).toHaveLength(2);
    expect(result?.blocks[0].pagination).toBeUndefined();
    expect(result?.blocks[1].pagination?.break).toBe(true);
    expect(result?.focusBlockId).toBe("p_second");
  });

  it("puts break on the next paragraph when the cursor is at the start of a paragraph", () => {
    const blocks = [
      paragraph("p_first", "first"),
      paragraph("p_second", "second"),
    ];

    const result = resolveManualTextPageBreakBlocks(blocks, "p_first", true, {
      blockId: "p_first",
      offset: 0,
    });

    expect(result?.blocks).toHaveLength(2);
    expect(result?.blocks[0].pagination).toBeUndefined();
    expect(result?.blocks[1].pagination?.break).toBe(true);
    expect(result?.focusBlockId).toBe("p_second");
  });

  it("splits a paragraph at the cursor and puts break on the following paragraph", () => {
    const blocks = [paragraph("p_first", "abcdef")];

    const result = resolveManualTextPageBreakBlocks(blocks, "p_first", true, {
      blockId: "p_first",
      offset: 3,
    });

    expect(result?.blocks).toHaveLength(2);
    expect(getText(result!.blocks[0])).toBe("abc");
    expect(getText(result!.blocks[1])).toBe("def");
    expect(result?.blocks[1].id).not.toBe("p_first");
    expect(result?.blocks[1].pagination?.break).toBe(true);
    expect(result?.focusBlockId).toBe(result?.blocks[1].id);
  });

  it("creates an empty following paragraph when there is no next paragraph", () => {
    const blocks = [paragraph("p_first", "first")];

    const result = resolveManualTextPageBreakBlocks(blocks, "p_first", true, {
      blockId: "p_first",
      offset: 5,
    });

    expect(result?.blocks).toHaveLength(2);
    expect(getText(result!.blocks[0])).toBe("first");
    expect(getText(result!.blocks[1])).toBe("");
    expect(result?.blocks[1].pagination?.break).toBe(true);
    expect(result?.focusBlockId).toBe(result?.blocks[1].id);
  });

  it("splits a box body without mixing its title into the editable body", () => {
    const blocks: TextFlowBlock[] = [{
      type: "boxBlock",
      id: "box_manual_break",
      styleId: "itembox",
      title: [{ type: "text", text: "定理" }],
      blocks: [{
        type: "paragraph",
        id: "box_manual_break_body",
        children: [{ type: "text", text: "abcdef" }],
      }],
    }];

    const result = resolveManualTextPageBreakBlocks(blocks, "box_manual_break", true, {
      blockId: "box_manual_break",
      offset: 3,
    }, {
      createId: (prefix) => `${prefix}_after_break`,
    });

    expect(result?.blocks).toMatchObject([
      {
        type: "boxBlock",
        title: [{ type: "text", text: "定理" }],
        blocks: [{ children: [{ type: "text", text: "abc" }] }],
      },
      {
        type: "boxBlock",
        title: [{ type: "text", text: "定理" }],
        pagination: { break: true },
        blocks: [{ children: [{ type: "text", text: "def" }] }],
      },
    ]);
  });
});

describe("shouldUseDocumentNextBlockForPageBreak", () => {
  it("defers a page break at a chunk boundary to the document-level next block", () => {
    const blocks = [
      paragraph("p_first", "first"),
      paragraph("p_boundary", "boundary"),
    ];

    expect(shouldUseDocumentNextBlockForPageBreak(blocks, {
      blockId: "p_boundary",
      enabled: true,
      documentNextBlockId: "p_next_chunk",
    }, {
      blockId: "p_boundary",
      offset: "boundary".length,
    })).toBe(true);
  });

  it("keeps page breaks inside the current editor when the next block is in the same chunk", () => {
    const blocks = [
      paragraph("p_first", "first"),
      paragraph("p_middle", "middle"),
      paragraph("p_last", "last"),
    ];

    expect(shouldUseDocumentNextBlockForPageBreak(blocks, {
      blockId: "p_middle",
      enabled: true,
      documentNextBlockId: "p_last",
    }, {
      blockId: "p_middle",
      offset: "middle".length,
    })).toBe(false);
  });
});

describe("resolveManualBreakBoundaryNavigation", () => {
  const blocksWithBreak = [
    paragraph("before_break", "前"),
    {
      ...paragraph("after_break", "後"),
      pagination: { break: true as const },
    },
  ];

  it("moves Backspace from the break block start to the previous block end without changing the document", () => {
    const state = createParagraphBoundaryState(blocksWithBreak, "after_break", "start");
    const navigation = resolveManualBreakBoundaryNavigation(state, "backward", blocksWithBreak);

    expect(navigation?.blockId).toBe("after_break");
    expect(textBlockAtPosition(state, navigation?.position ?? -1)).toMatchObject({
      id: "before_break",
      text: "前",
    });
  });

  it("moves Delete from the previous block end to the break block start", () => {
    const state = createParagraphBoundaryState(blocksWithBreak, "before_break", "end");
    const navigation = resolveManualBreakBoundaryNavigation(state, "forward", blocksWithBreak);

    expect(navigation?.blockId).toBe("after_break");
    expect(textBlockAtPosition(state, navigation?.position ?? -1)).toMatchObject({
      id: "after_break",
      text: "後",
    });
  });

  it.each([
    { altKey: true },
    { metaKey: true },
    { ctrlKey: true },
  ])("also protects a manual-break boundary for modified deletion (%o)", (modifiers) => {
    const state = createParagraphBoundaryState(blocksWithBreak, "after_break", "start");

    expect(resolveManualBreakBoundaryNavigation(
      state,
      "backward",
      blocksWithBreak,
      { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...modifiers },
    )).not.toBeNull();
  });

  it("does not intercept an ordinary boundary", () => {
    const blocks = [
      paragraph("ordinary_first", "前"),
      paragraph("ordinary_second", "後"),
    ];
    const state = createParagraphBoundaryState(blocks, "ordinary_second", "start");

    expect(resolveManualBreakBoundaryNavigation(state, "backward", blocks)).toBeNull();
  });

  it.each([
    {
      name: "list",
      block: {
        type: "list" as const,
        id: "nested_owner",
        listType: "bullet" as const,
        items: [{ type: "listItem" as const, id: "nested_leaf", children: [{ type: "text" as const, text: "後" }] }],
        pagination: { break: true as const },
      },
    },
    {
      name: "quote",
      block: {
        type: "quote" as const,
        id: "nested_owner",
        blocks: [paragraph("nested_leaf", "後")],
        pagination: { break: true as const },
      },
    },
    {
      name: "code",
      block: {
        type: "codeBlock" as const,
        id: "nested_leaf",
        children: [{ type: "text" as const, text: "後" }],
        pagination: { break: true as const },
      },
    },
    {
      name: "box title",
      targetId: "nested_owner",
      block: {
        type: "boxBlock" as const,
        id: "nested_owner",
        styleId: "fancybox",
        blocks: [paragraph("nested_leaf", "後")],
        pagination: { break: true as const },
      },
    },
  ])("protects Backspace at the first text position of a $name block", ({ block, targetId }) => {
    const blocks: TextFlowBlock[] = [paragraph("before_nested", "前"), block as TextFlowBlock];
    const state = createParagraphBoundaryState(blocks, targetId ?? "nested_leaf", "start");

    expect(resolveManualBreakBoundaryNavigation(state, "backward", blocks)).not.toBeNull();
  });
});

describe("manual-break selection and paste boundaries", () => {
  it("lets only the canonical editor claim a shared break-removal event", () => {
    const detail = { blockId: "break_owner", enabled: false, handled: false };
    let mutations = 0;
    // Replicas may have registered before the source, but they never claim the command.
    for (const isReplica of [true, true, false, true]) {
      if (shouldHandleTextPageBreakRequest(detail, isReplica)) {
        detail.handled = true;
        mutations += 1;
      }
    }

    expect(mutations).toBe(1);
    expect(shouldHandleTextPageBreakRequest(detail, false)).toBe(false);
  });

  it("recognizes a range that crosses a break but not a range contained after it", () => {
    const blocks: TextFlowBlock[] = [
      paragraph("before_range", "前側"),
      { ...paragraph("after_range", "後側"), pagination: { break: true } },
    ];
    const crossing = createTextRangeState(blocks, "before_range", 1, "after_range", 1);
    const afterOnly = createTextRangeState(blocks, "after_range", 0, "after_range", 1);

    expect(selectionCrossesManualBreak(crossing)).toBe(true);
    expect(selectionCrossesManualBreak(afterOnly)).toBe(false);
  });

  it("marks a block paste at the break-owner start so the adapter can transfer the break", () => {
    const previousBlocks: TextFlowBlock[] = [
      paragraph("before_paste", "前"),
      { ...paragraph("after_paste", "後"), pagination: { break: true } },
    ];
    const breakStart = createParagraphBoundaryState(previousBlocks, "after_paste", "start");
    const ordinaryStart = createParagraphBoundaryState([
      paragraph("ordinary_before", "前"),
      paragraph("ordinary_after", "後"),
    ], "ordinary_after", "start");

    expect(getTextBlockBoundaryInsertPosition(breakStart)).not.toBeNull();
    expect(getTextBlockBoundaryInsertPosition(ordinaryStart)).not.toBeNull();

    const pasted = [paragraph("pasted_first", "貼付1"), paragraph("pasted_second", "貼付2")];
    expect(transferManualBreakToPastedBlocksAtOwnerStart(breakStart, pasted)
      .map((block) => block.pagination?.break)).toEqual([true, undefined]);
    expect(transferManualBreakToPastedBlocksAtOwnerStart(ordinaryStart, pasted)).toBe(pasted);

    const schema = breakStart.schema;
    const pastedDoc = textFlowToTiptap(pasted);
    const slice = new Slice(Fragment.fromArray([
      schema.nodeFromJSON(pastedDoc.content![0]),
      schema.nodeFromJSON(pastedDoc.content![1]),
    ]), 0, 0);
    const transferred = transferManualBreakToPastedSliceAtOwnerStart(breakStart, slice);
    expect(transferred.content.child(0).attrs.pagination).toEqual({ break: true });
    expect(transferred.content.child(1).attrs.pagination?.break).not.toBe(true);

    const insertPos = getTextBlockBoundaryInsertPosition(breakStart);
    expect(insertPos).not.toBeNull();
    const transaction = breakStart.tr.insert(insertPos!, transferred.content);
    expect(tiptapToTextFlow(transaction.doc.toJSON() as TiptapDoc, previousBlocks)
      .map((block) => [block.id, block.pagination?.break])).toEqual([
      ["before_paste", undefined],
      ["pasted_first", true],
      ["pasted_second", undefined],
      ["after_paste", undefined],
    ]);
  });

  it("deletes text on both sides without merging the break owner and inserts at the leading side", () => {
    const blocks: TextFlowBlock[] = [
      paragraph("before_replace", "AB"),
      { ...paragraph("after_replace", "YZ"), pagination: { break: true } },
    ];
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }),
      content: textFlowToTiptap(blocks),
    });
    const selected = createTextRangeState(blocks, "before_replace", 1, "after_replace", 1).selection;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(
      editor.state.doc,
      selected.from,
      selected.to,
    )));

    expect(deleteManualBreakSpanningSelection(editor.view, "X")).toBe(true);
    expect(tiptapToTextFlow(editor.getJSON() as TiptapDoc, blocks)).toEqual([
      paragraph("before_replace", "AX"),
      { ...paragraph("after_replace", "Z"), pagination: { break: true } },
    ]);
    editor.destroy();
  });

  it("writes a cross-break cut to the clipboard before the custom deletion runs", () => {
    const blocks: TextFlowBlock[] = [
      paragraph("cut_before", "AB"),
      { ...paragraph("cut_after", "YZ"), pagination: { break: true } },
    ];
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }),
      content: textFlowToTiptap(blocks),
    });
    const selected = createTextRangeState(blocks, "cut_before", 1, "cut_after", 1).selection;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(
      editor.state.doc,
      selected.from,
      selected.to,
    )));
    const clipboardData = new DataTransfer();

    expect(writeTextFlowSelectionClipboard(editor.view, clipboardData, blocks)).toBe(true);
    expect(clipboardData.getData("text/plain")).toBe("B\nY");
    const payload = readEditorClipboardPayload(clipboardData);
    expect(payload?.kind).toBe("textFlowBlocks");
    expect(payload?.kind === "textFlowBlocks"
      ? payload.blocks.map((block) => block.pagination?.break)
      : null).toEqual([undefined, true]);
    editor.destroy();
  });

  it("builds and dispatches a cross-break paste as one atomic transaction", () => {
    const blocks: TextFlowBlock[] = [
      paragraph("atomic_before", "AB"),
      { ...paragraph("atomic_after", "YZ"), pagination: { break: true } },
    ];
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }),
      content: textFlowToTiptap(blocks),
    });
    const selected = createTextRangeState(blocks, "atomic_before", 1, "atomic_after", 1).selection;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(
      editor.state.doc,
      selected.from,
      selected.to,
    )));
    const dispatch = vi.spyOn(editor.view, "dispatch");

    expect(deleteManualBreakSpanningSelection(editor.view, [paragraph("paste_new", "X")])).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(tiptapToTextFlow(editor.getJSON() as TiptapDoc, blocks)).toEqual([
      paragraph("atomic_before", "AX"),
      { ...paragraph("atomic_after", "Z"), pagination: { break: true } },
    ]);
    editor.destroy();
  });

  it("rejects an incompatible custom payload without changing the document or selection", () => {
    const blocks: TextFlowBlock[] = [
      paragraph("reject_before", "AB"),
      { ...paragraph("reject_after", "YZ"), pagination: { break: true } },
    ];
    const editor = new Editor({
      element: document.createElement("div"),
      // This surface intentionally accepts only ordinary rich-text blocks.
      extensions: createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }),
      content: textFlowToTiptap(blocks),
    });
    const selected = createTextRangeState(blocks, "reject_before", 1, "reject_after", 1).selection;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(
      editor.state.doc,
      selected.from,
      selected.to,
    )));
    const state = editor.state;
    const beforeDoc = state.doc.toJSON();
    const beforeSelection = state.selection.toJSON();
    const clipboardData = new DataTransfer();
    writeEditorClipboardData(clipboardData, createTextFlowClipboardPayload([
      { type: "divider", id: "unsupported_divider" },
    ]));
    const event = new ClipboardEvent("paste", { clipboardData });
    const preventDefault = vi.spyOn(event, "preventDefault");

    // PM が通常貼り付けに使える non-empty slice も渡しておく。custom payload が不適合なら
    // native replaceSelection へ落とさず、この選択と break をそのまま保つ。
    expect(resolveManualBreakPasteContent(
      state,
      event,
      state.doc.slice(0, state.doc.content.size),
      false,
    )).toBeNull();
    expect(consumeRejectedManualBreakPaste(event)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(state.doc.toJSON()).toEqual(beforeDoc);
    expect(state.selection.toJSON()).toEqual(beforeSelection);
    editor.destroy();
  });

  it("normalizes HTML-only rich text and pastes it on the leading side without removing the break", () => {
    const blocks: TextFlowBlock[] = [
      paragraph("rich_before", "AB"),
      { ...paragraph("rich_after", "YZ"), pagination: { break: true } },
    ];
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }),
      content: textFlowToTiptap(blocks),
    });
    const sourceBlocks: TextFlowBlock[] = [{
      type: "paragraph",
      id: "rich_source",
      children: [{ type: "text", text: "太字", marks: ["bold"] }],
    }];
    const source = new Editor({
      element: document.createElement("div"),
      extensions: createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }),
      content: textFlowToTiptap(sourceBlocks),
    });
    const selected = createTextRangeState(blocks, "rich_before", 1, "rich_after", 1).selection;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(
      editor.state.doc,
      selected.from,
      selected.to,
    )));
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/html", "<p><strong>太字</strong></p>");
    const event = new ClipboardEvent("paste", { clipboardData });
    const slice = source.state.doc.slice(0, source.state.doc.content.size);

    const replacement = resolveManualBreakPasteContent(editor.state, event, slice, false);
    expect(replacement).not.toBeNull();
    const pasted = replacement?.blocks[0];
    expect(pasted && "children" in pasted ? pasted.children : null).toEqual([
      { type: "text", text: "太字", marks: ["bold"] },
    ]);
    expect(deleteManualBreakSpanningSelection(editor.view, replacement?.blocks ?? [])).toBe(true);
    expect(tiptapToTextFlow(editor.getJSON() as TiptapDoc, blocks)).toEqual([
      {
        ...paragraph("rich_before", "A太字"),
        children: [
          { type: "text", text: "A" },
          { type: "text", text: "太字", marks: ["bold"] },
        ],
      },
      { ...paragraph("rich_after", "Z"), pagination: { break: true } },
    ]);
    source.destroy();
    editor.destroy();
  });

  it("removes fully selected intermediate headings instead of leaving empty shells", () => {
    const blocks: TextFlowBlock[] = [
      paragraph("before_structural", "AB"),
      { type: "heading", id: "selected_heading", level: 2, children: [{ type: "text", text: "見出し" }] },
      { ...paragraph("after_structural", "YZ"), pagination: { break: true } },
    ];
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }),
      content: textFlowToTiptap(blocks),
    });
    const selected = createTextRangeState(blocks, "before_structural", 1, "after_structural", 1).selection;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(
      editor.state.doc,
      selected.from,
      selected.to,
    )));

    expect(deleteManualBreakSpanningSelection(editor.view)).toBe(true);
    const next = tiptapToTextFlow(editor.getJSON() as TiptapDoc, blocks);
    expect(next.map((block) => block.id)).toEqual(["before_structural", "after_structural"]);
    expect(next.map((block) => block.pagination?.break)).toEqual([undefined, true]);
    editor.destroy();
  });

  it("does not consider an empty or file-only clipboard usable for cross-break replacement", () => {
    const state = createTextRangeState([
      paragraph("before_unsupported", "AB"),
      { ...paragraph("after_unsupported", "YZ"), pagination: { break: true } },
    ], "before_unsupported", 1, "after_unsupported", 1);
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File(["image"], "image.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", { clipboardData });

    expect(pasteHasUsableContent(state, event, state.doc.slice(0, 0), false)).toBe(false);
  });

  it("copies internal breaks but excludes the break before the selection's first block", () => {
    const blocks: TextFlowBlock[] = [
      { ...paragraph("copy_first", "AB"), pagination: { break: true } },
      { ...paragraph("copy_second", "YZ"), pagination: { break: true } },
    ];
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }),
      content: textFlowToTiptap(blocks),
    });
    const selected = createTextRangeState(blocks, "copy_first", 1, "copy_second", 1).selection;
    const slice = editor.state.doc.slice(selected.from, selected.to);

    expect(textFlowBlocksForSelectionClipboard(slice, blocks).map((block) => block.pagination?.break))
      .toEqual([undefined, true]);
    editor.destroy();
  });
});

describe("TextFlowEditor list conversion", () => {
  it("converts Tiptap bullet lists created by markdown input into SigmaDoc lists", () => {
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          attrs: { sigmaDocId: "list_bullet", sigmaDocType: "list" },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  attrs: { sigmaDocId: "li_first", sigmaDocType: "listItem" },
                  content: [{ type: "text", text: "first" }],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(tiptapToTextFlow(doc)).toEqual([
      {
        type: "list",
        id: "list_bullet",
        listType: "bullet",
        items: [
          {
            type: "listItem",
            id: "li_first",
            children: [{ type: "text", text: "first" }],
          },
        ],
      },
    ]);
  });

  it("keeps ordered nested lists and inline formatting through a round trip", () => {
    const blocks: TextFlowBlock[] = [
      {
        type: "list",
        id: "list_ordered",
        listType: "ordered",
        start: 3,
        items: [
          {
            type: "listItem",
            id: "li_parent",
            children: [
              { type: "text", text: "parent ", marks: ["bold"] },
              { type: "mathInline", id: "m_inline", tex: "x^2", display: "inline", semanticRole: "expression" },
            ],
            nested: [
              {
                type: "list",
                id: "list_nested",
                listType: "bullet",
                items: [
                  {
                    type: "listItem",
                    id: "li_child",
                    children: [{ type: "text", text: "child", marks: ["underline"] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const [list] = tiptapToTextFlow(textFlowToTiptap(blocks), blocks);

    expect(list).toMatchObject({
      type: "list",
      id: "list_ordered",
      listType: "ordered",
      start: 3,
      items: [
        {
          type: "listItem",
          id: "li_parent",
          children: [
            { type: "text", text: "parent ", marks: ["bold"] },
            { type: "mathInline", id: "m_inline", tex: "x^2" },
          ],
          nested: [
            {
              type: "list",
              id: "list_nested",
              listType: "bullet",
              items: [
                {
                  type: "listItem",
                  id: "li_child",
                  children: [{ type: "text", text: "child", marks: ["underline"] }],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("keeps the (1) marker style of an ordered list through a round trip", () => {
    const blocks: TextFlowBlock[] = [
      {
        type: "list",
        id: "list_paren",
        listType: "ordered",
        markerStyle: "paren",
        items: [
          {
            type: "listItem",
            id: "li_paren",
            children: [{ type: "text", text: "括弧付き番号" }],
            nested: [
              {
                type: "list",
                id: "list_paren_nested",
                listType: "ordered",
                markerStyle: "paren",
                items: [{ type: "listItem", id: "li_paren_child", children: [{ type: "text", text: "子" }] }],
              },
            ],
          },
        ],
      },
    ];

    expect(tiptapToTextFlow(textFlowToTiptap(blocks), blocks)).toMatchObject([
      {
        type: "list",
        markerStyle: "paren",
        items: [{ nested: [{ type: "list", markerStyle: "paren" }] }],
      },
    ]);
  });

  it("keeps alignment on parenthesized and nested list items through a round trip", () => {
    const blocks: TextFlowBlock[] = [{
      type: "list",
      id: "list_aligned",
      listType: "ordered",
      markerStyle: "paren",
      items: [{
        type: "listItem",
        id: "li_aligned",
        children: [{ type: "text", text: "中央" }],
        align: "center",
        continuations: [
          {
            type: "paragraph",
            id: "li_aligned_second",
            children: [{ type: "text", text: "左" }],
            align: "left",
          },
          {
            type: "paragraph",
            id: "li_aligned_third",
            children: [{ type: "text", text: "右" }],
            align: "right",
          },
        ],
        nested: [{
          type: "list",
          id: "list_nested_aligned",
          listType: "ordered",
          items: [{
            type: "listItem",
            id: "li_nested_aligned",
            children: [{ type: "text", text: "右" }],
            align: "right",
          }],
        }],
      }],
    }];

    const tiptap = textFlowToTiptap(blocks);
    expect(tiptap.content?.[0]?.content?.[0]?.content?.[0]?.attrs?.textAlign).toBe("center");
    expect(tiptap.content?.[0]?.content?.[0]?.content?.[1]?.attrs).toMatchObject({
      sigmaDocId: "li_aligned_second",
      textAlign: "left",
    });
    expect(tiptapToTextFlow(tiptap, blocks)).toMatchObject([{
      items: [{
        align: "center",
        continuations: [
          { id: "li_aligned_second", align: "left" },
          { id: "li_aligned_third", align: "right" },
        ],
        nested: [{ items: [{ align: "right" }] }],
      }],
    }]);
  });

  it("does not invent a marker style for plain decimal lists", () => {
    const blocks: TextFlowBlock[] = [
      {
        type: "list",
        id: "list_decimal",
        listType: "ordered",
        items: [{ type: "listItem", id: "li_decimal", children: [{ type: "text", text: "1つめ" }] }],
      },
    ];

    expect(tiptapToTextFlow(textFlowToTiptap(blocks), blocks)[0]).not.toHaveProperty("markerStyle");
  });

  it("round-trips SigmaDoc box blocks with rich editable titles and body blocks", () => {
    const blocks: TextFlowBlock[] = [
      {
        type: "boxBlock",
        id: "box_fancybox",
        styleId: "fancybox",
        title: [
          {
            type: "text",
            text: "定理 ",
            marks: ["bold"],
            color: "#1d4ed8",
            fontSize: 18,
          },
          {
            type: "mathInline",
            id: "box_title_math",
            tex: String.raw`a^2+b^2=c^2`,
            display: "inline",
            color: "#dc2626",
            fontSize: 16,
            semanticRole: "expression",
          },
        ],
        frame: {
          borderWidthPx: 1.4,
          borderColor: "#111111",
          paddingPx: { top: 12, right: 14, bottom: 12, left: 14 },
        },
        blocks: [
          {
            type: "paragraph",
            id: "box_body",
            children: [
              { type: "text", text: "ここに", marks: ["bold"] },
              { type: "text", text: "本文を書く", marks: ["italic"], color: "#15803d" },
            ],
          },
        ],
      },
    ];

    const tiptap = textFlowToTiptap(blocks);
    expect(tiptap.content?.[0]).toMatchObject({
      type: "boxBlock",
      attrs: {
        sigmaDocId: "box_fancybox",
        styleId: "fancybox",
      },
      content: [
        {
          type: "boxBlockTitle",
          content: [
            {
              type: "text",
              text: "定理 ",
              marks: [
                { type: "bold" },
                {
                  type: "styledText",
                  attrs: {
                    color: "#1d4ed8",
                    fontSize: 18,
                  },
                },
              ],
            },
            {
              type: "mathInline",
              attrs: {
                id: "box_title_math",
                tex: String.raw`a^2+b^2=c^2`,
              },
            },
          ],
        },
        {
          type: "boxBlockBody",
          content: [
            {
              type: "paragraph",
              attrs: { sigmaDocId: "box_body" },
              content: [
                { type: "text", text: "ここに", marks: [{ type: "bold" }] },
                {
                  type: "text",
                  text: "本文を書く",
                  marks: [
                    { type: "italic" },
                    { type: "styledText", attrs: { color: "#15803d" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const schema = getSchema(createRichTextEngineExtensions({
      blockExtensions: [
        SigmaDocTextAttrs,
        BoxBlockExtension,
        BoxBlockTitleExtension,
        BoxBlockBodyExtension,
      ],
    }));
    const boxNode = schema.nodeFromJSON(tiptap.content?.[0]);
    expect(boxNode.type.name).toBe("boxBlock");
    expect(boxNode.child(0).type.name).toBe("boxBlockTitle");
    expect(boxNode.child(1).type.name).toBe("boxBlockBody");
    const richBoxBlock = blocks[0];
    if (richBoxBlock.type !== "boxBlock") {
      throw new Error("Expected a box block fixture");
    }
    const changedTitleTiptap = textFlowToTiptap([{
      ...richBoxBlock,
      title: [{ type: "text", text: "変更後" }],
    }]);
    expect(findTouchedGuardedBlockIds(
      schema.node("doc", null, [boxNode]),
      schema.node("doc", null, [schema.nodeFromJSON(changedTitleTiptap.content?.[0])]),
      new Set(["box_fancybox"]),
    )).toEqual(["box_fancybox"]);

    const [box] = tiptapToTextFlow(tiptap, blocks);

    expect(box).toMatchObject({
      type: "boxBlock",
      id: "box_fancybox",
      styleId: "fancybox",
      title: [
        {
          type: "text",
          text: "定理 ",
          marks: ["bold"],
          color: "#1d4ed8",
          fontSize: 18,
        },
        {
          type: "mathInline",
          id: "box_title_math",
          tex: String.raw`a^2+b^2=c^2`,
          color: "#dc2626",
          fontSize: 16,
        },
      ],
      blocks: [
        {
          type: "paragraph",
          id: "box_body",
          children: [
            { type: "text", text: "ここに", marks: ["bold"] },
            { type: "text", text: "本文を書く", marks: ["italic"], color: "#15803d" },
          ],
        },
      ],
    });
  });

  it("does not resync focused content while editing inside a box block", () => {
    const blocks: TextFlowBlock[] = [
      {
        type: "boxBlock",
        id: "box_corner",
        styleId: "cornerbox",
        blocks: [
          {
            type: "paragraph",
            id: "box_corner_body",
            children: [{ type: "text", text: "入力中" }],
          },
        ],
      },
    ];

    expect(shouldSyncFocusedTextFlowContent(["box_corner", "box_corner_body"], blocks)).toBe(false);
    expect(shouldSyncFocusedTextFlowContent(["box_corner_body"], blocks)).toBe(true);
  });

  it("reports a box title selection as an enabled document text target", () => {
    const { state } = createBoxTitleSelectionState();
    const context = resolveTextFormatStateContext(state);
    const editor = {
      isActive: (name: string) => name === "bold",
      getAttributes: () => ({}),
    } as Pick<TiptapEditor, "getAttributes" | "isActive">;

    expect(createTextFormatStateDetail(editor, "document", context)).toMatchObject({
      target: "document",
      enabled: true,
      nodeType: "boxBlockTitle",
      blockId: "box_title_format",
      bold: true,
    });
  });

  it("reports code as the same enabled text-format target used by rich body blocks", () => {
    const schema = getSchema(createRichTextEngineExtensions({
      blockExtensions: [SigmaDocTextAttrs],
      bodyBlocks: true,
    }));
    const doc = schema.nodeFromJSON(textFlowToTiptap([{
      type: "codeBlock",
      id: "code_format",
      children: [{ type: "text", text: "answer = 42", marks: ["bold"] }],
    }]));
    const initial = EditorState.create({ schema, doc });
    const state = initial.apply(initial.tr.setSelection(TextSelection.create(doc, 2)));

    expect(resolveTextFormatStateContext(state)).toEqual({
      enabled: true,
      nodeType: "codeBlock",
      blockId: "code_format",
    });
  });

  it("keeps paragraph formatting enabled inside a nested list item", () => {
    const schema = getSchema(createRichTextEngineExtensions({
      blockExtensions: [SigmaDocTextAttrs],
      textBlockStyle: true,
    }));
    const doc = schema.nodeFromJSON(textFlowToTiptap([{
      type: "list",
      id: "outer_list",
      listType: "ordered",
      items: [{
        type: "listItem",
        id: "outer_item",
        children: [{ type: "text", text: "親" }],
        nested: [{
          type: "list",
          id: "nested_list",
          listType: "ordered",
          items: [{
            type: "listItem",
            id: "nested_item",
            children: [{ type: "text", text: "子" }],
          }],
        }],
      }],
    }]));
    let nestedTextPos = -1;
    doc.descendants((node, pos) => {
      if (node.isText && node.text === "子") {
        nestedTextPos = pos;
        return false;
      }
      return true;
    });
    const initial = EditorState.create({ schema, doc });
    const state = initial.apply(initial.tr.setSelection(TextSelection.create(doc, nestedTextPos)));

    expect(resolveTextFormatStateContext(state)).toEqual({
      enabled: true,
      nodeType: "paragraph",
      blockId: "nested_item",
    });
  });

  it("applies bold to the live selection in a box title without enabling block style", () => {
    const { state } = createBoxTitleSelectionState();
    const calls: unknown[][] = [];
    const chain = new Proxy({}, {
      get(_target, property) {
        return (...args: unknown[]) => {
          calls.push([String(property), ...args]);
          return chain;
        };
      },
    });
    const editor = {
      state,
      isFocused: false,
      chain: () => chain,
    } as unknown as TiptapEditor;
    const options = resolveTextFlowFormatCommandOptions(
      editor,
      "box_title_format",
      null,
    );

    expect(options).toMatchObject({
      selection: {
        from: state.selection.from,
        to: state.selection.to,
      },
      blockNodeType: "paragraph",
      allowBlockStyle: false,
    });
    expect(applyTextFormatCommand(editor, { command: "bold" }, options)).toBe(true);
    expect(calls).toEqual([
      ["focus"],
      ["setTextSelection", {
        from: state.selection.from,
        to: state.selection.to,
      }],
      ["toggleBold"],
      ["setTextSelection", {
        from: state.selection.from,
        to: state.selection.to,
      }],
      ["run"],
    ]);
  });
});

describe("empty box title editing structure", () => {
  it("keeps a real boxBlockTitle node after all title content is removed", () => {
    const tiptap = textFlowToTiptap([{
      type: "boxBlock",
      id: "empty_title_box",
      styleId: "itembox",
      title: [],
      blocks: [paragraph("empty_title_body", "本文")],
    }]);
    const boxNode = tiptap.content?.[0];

    expect(boxNode?.type).toBe("boxBlock");
    expect(boxNode?.content?.[0]).toEqual({
      type: "boxBlockTitle",
      content: [],
    });
    expect(boxNode?.content?.[1]?.type).toBe("boxBlockBody");
  });

  it("keeps the empty-title hit target out of normal flow with a real clickable area", () => {
    const css = readBoxStylesheets();
    const emptyTitleRule = css.match(
      /\.sigma-doc-box-title:empty,\s*\.sigma-doc-box-title:has\(> br\.ProseMirror-trailingBreak:only-child\) \{([^}]+)\}/,
    )?.[1];

    expect(emptyTitleRule).toBeDefined();
    expect(emptyTitleRule).toMatch(/position:\s*absolute/);
    expect(emptyTitleRule).toMatch(/min-width:\s*4em/);
    expect(emptyTitleRule).toMatch(/min-height:\s*18px/);
    expect(emptyTitleRule).toMatch(/pointer-events:\s*auto/);
  });

  it("keeps title plates on the box background without an opaque focused placeholder chip", () => {
    const css = readBoxStylesheets();
    const titlePlateRule = css.match(
      /\.box-frame--title-plate \.sigma-doc-box-title,\s*\.box-frame--title-plate \.print-box-title \{([^}]+)\}/,
    )?.[1];
    const focusedPlaceholderRule = css.match(
      /\.sigma-doc-box-title:empty:focus::before,\s*\.sigma-doc-box-title:has\(> br\.ProseMirror-trailingBreak:only-child\):focus::before \{([^}]+)\}/,
    )?.[1];
    const titleBandRule = css.match(
      /\.box-frame--title-band \.sigma-doc-box-title,\s*\.box-frame--title-band \.print-box-title \{([^}]+)\}/,
    )?.[1];

    expect(titlePlateRule).toMatch(/background:\s*var\(--sigma-doc-box-background,\s*#ffffff\)/);
    expect(focusedPlaceholderRule).toBeDefined();
    expect(focusedPlaceholderRule).not.toMatch(/background\s*:/);
    expect(titleBandRule).toMatch(/background:\s*var\(--sigma-doc-box-title-background,\s*#e2e8f0\)/);
  });
});

describe("キャレット復元のフォーカス所有権", () => {
  it("applyTextFlowSelectionBookmark は view.focus() を呼ばない", () => {
    const editor = createCaretOwnershipEditor();
    const focusSpy = vi.spyOn(editor.view, "focus");

    const restored = applyTextFlowSelectionBookmark(editor, caretBookmark("p_1", 2));

    expect(restored.applied).toBe(true);
    expect(editor.state.selection.head).toBe(3);
    expect(focusSpy).toHaveBeenCalledTimes(0);
    editor.destroy();
  });

  it("解決できない blockId では false を返し、選択も変えない", () => {
    const editor = createCaretOwnershipEditor();
    editor.commands.setTextSelection(2);
    const before = editor.state.selection;
    const focusSpy = vi.spyOn(editor.view, "focus");

    const restored = applyTextFlowSelectionBookmark(editor, caretBookmark("missing", 0));

    expect(restored.applied).toBe(false);
    expect(editor.state.selection.eq(before)).toBe(true);
    expect(focusSpy).toHaveBeenCalledTimes(0);
    editor.destroy();
  });

  it("focusTextFlowSurface は focus が storedMarks を落としても張り直す", () => {
    const editor = createCaretOwnershipEditor();
    const marks = [editor.schema.marks.styledText.create({ color: "#1d4ed8" })];
    editor.commands.setTextSelection(3);
    editor.view.dispatch(editor.state.tr.setStoredMarks(marks));
    // 実機の `view.focus()` は DOM 選択の同期を通じて storedMarks を落としうる。
    vi.spyOn(editor.view, "focus").mockImplementation(() => {
      editor.view.dispatch(editor.state.tr.setStoredMarks(null));
    });

    focusTextFlowSurface(editor, marks);

    expect(editor.state.storedMarks).toEqual(marks);
    editor.destroy();
  });

  it("focusTextFlowSurface は DOM を preventScroll 付きでフォーカスする", () => {
    const editor = createCaretOwnershipEditor();
    const domFocusSpy = vi.spyOn(editor.view.dom, "focus");
    const viewFocusSpy = vi.spyOn(editor.view, "focus").mockImplementation(() => undefined);

    focusTextFlowSurface(editor, null);

    expect(domFocusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(domFocusSpy.mock.invocationCallOrder[0]).toBeLessThan(viewFocusSpy.mock.invocationCallOrder[0]);
    editor.destroy();
  });

  it("選択が空でないときは storedMarks を張り直さない", () => {
    const editor = createCaretOwnershipEditor();
    const marks = [editor.schema.marks.styledText.create({ color: "#1d4ed8" })];
    editor.commands.setTextSelection({ from: 1, to: 4 });
    vi.spyOn(editor.view, "focus").mockImplementation(() => undefined);

    focusTextFlowSurface(editor, marks);

    expect(editor.state.storedMarks).toBeNull();
    editor.destroy();
  });
});

describe("キャレット位置の正規化", () => {
  it("トップレベルの区切り線を選んでも bookmark が null にならない", () => {
    const editor = createBodyBlockEditor();
    const position = nodePositionOf(editor, "d_1");
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)),
    );

    expect(getTextFlowSelectionBookmark(editor, null)).toMatchObject({
      anchor: { blockId: "d_1", kind: "node" },
      head: { blockId: "d_1", kind: "node" },
    });
    editor.destroy();
  });

  it("区切り線の bookmark を復元すると NodeSelection に戻る", () => {
    const editor = createBodyBlockEditor();
    editor.commands.setTextSelection(2);

    const restored = applyTextFlowSelectionBookmark(editor, {
      anchor: { affinity: "after", blockId: "d_1", kind: "node", offset: 0 },
      head: { affinity: "after", blockId: "d_1", kind: "node", offset: 0 },
      preferredX: null,
    });

    expect(restored.applied).toBe(true);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.attrs.sigmaDocId).toBe("d_1");
    editor.destroy();
  });

  it("コンテナ id を渡しても例外を投げず葉へ落ちる", () => {
    const editor = createBodyBlockEditor();

    const restored = applyTextFlowSelectionBookmark(editor, caretBookmark("box_1", 0));

    expect(restored.applied).toBe(true);
    // 箱の中の position は子の番号であって文字位置ではない。文字を持つブロックまで落ちる。
    expect(editor.state.selection.$head.parent.isTextblock).toBe(true);
    editor.destroy();
  });

  it("片側だけノードを指す bookmark は NodeSelection にしない", () => {
    const editor = createBodyBlockEditor();
    editor.commands.setTextSelection(2);

    const restored = applyTextFlowSelectionBookmark(editor, {
      anchor: { affinity: "after", blockId: "d_1", kind: "node", offset: 0 },
      head: { affinity: "after", blockId: "box_p", kind: "text", offset: 1 },
      preferredX: null,
    });

    expect(restored.applied).toBe(true);
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);
    editor.destroy();
  });

  it("ブロックとブロックの隙間からは位置を作り出さない", () => {
    const editor = createBodyBlockEditor();
    // 文書全体の選択は両端が文書直下 (どの本文ブロックにも載っていない) 位置になる。
    // ここで隣のブロックを拾うと「最後のブロックの先頭」のような別物の選択が生まれる。
    editor.commands.selectAll();

    expect(getTextFlowSelectionBookmark(editor, null)).toBeNull();
    editor.destroy();
  });

  it("preferredX が bookmark に載る (上下移動での消費は後続作業)", () => {
    const editor = createCaretOwnershipEditor();
    editor.commands.setTextSelection(3);

    const bookmark = getTextFlowSelectionBookmark(editor, 123.5);

    expect(bookmark).toMatchObject({
      head: { affinity: "after", blockId: "p_1", kind: "text", offset: 2 },
      preferredX: 123.5,
    });
    expect(applyTextFlowSelectionBookmark(editor, bookmark!).applied).toBe(true);
    expect(bookmark?.preferredX).toBe(123.5);
    editor.destroy();
  });
});

describe("isLiteralPasteShortcut", () => {
  it("accepts Command-Shift-V and Control-Shift-V", () => {
    expect(isLiteralPasteShortcut(keyEvent({ metaKey: true, shiftKey: true }))).toBe(true);
    expect(isLiteralPasteShortcut(keyEvent({ ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("does not change the normal paste shortcut", () => {
    expect(isLiteralPasteShortcut(keyEvent({ metaKey: true }))).toBe(false);
    expect(isLiteralPasteShortcut(keyEvent({ metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isLiteralPasteShortcut(keyEvent({ metaKey: true, shiftKey: true, key: "c" }))).toBe(false);
  });
});

function caretBookmark(blockId: string, offset: number) {
  const address = { affinity: "after" as const, blockId, kind: "text" as const, offset };
  return { anchor: address, head: address, preferredX: null };
}

/** 区切り線と箱を含む本文。トップレベル atom とコンテナ id の両方を試すための土台。 */
function createBodyBlockEditor(): TiptapEditor {
  return new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({
      blockExtensions: [
        SigmaDocTextAttrs,
        SigmaDocTextIdentity,
        BoxBlockExtension,
        BoxBlockTitleExtension,
        BoxBlockBodyExtension,
      ],
      bodyBlocks: true,
    }),
    content: textFlowToTiptap([
      { type: "paragraph", id: "p_before", children: [{ type: "text", text: "前" }] },
      { type: "divider", id: "d_1" },
      {
        type: "boxBlock",
        id: "box_1",
        styleId: "fancybox",
        blocks: [{ type: "paragraph", id: "box_p", children: [{ type: "text", text: "箱の中" }] }],
      },
    ]),
  });
}

function nodePositionOf(editor: TiptapEditor, blockId: string): number {
  let position = -1;
  editor.state.doc.descendants((node, nodePosition) => {
    if (position >= 0) {
      return false;
    }
    if (node.attrs.sigmaDocId === blockId) {
      position = nodePosition;
      return false;
    }
    return true;
  });
  if (position < 0) {
    throw new Error(`node not found: ${blockId}`);
  }
  return position;
}

function createCaretOwnershipEditor(): TiptapEditor {
  return new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({
      blockExtensions: [SigmaDocTextAttrs, SigmaDocTextIdentity],
    }),
    content: {
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { sigmaDocId: "p_1", sigmaDocType: "paragraph" },
        content: [{ type: "text", text: "本文テキスト" }],
      }],
    },
  });
}

function createBoxTitleSelectionState(): { state: EditorState } {
  const schema = getSchema(createRichTextEngineExtensions({
    blockExtensions: [
      SigmaDocTextAttrs,
      BoxBlockExtension,
      BoxBlockTitleExtension,
      BoxBlockBodyExtension,
    ],
  }));
  const doc = schema.nodeFromJSON(textFlowToTiptap([{
    type: "boxBlock",
    id: "box_title_format",
    styleId: "itembox",
    title: [{ type: "text", text: "定理" }],
    blocks: [{
      type: "paragraph",
      id: "box_title_format_body",
      children: [{ type: "text", text: "本文" }],
    }],
  }]));
  let from = -1;
  let to = -1;
  doc.descendants((node, pos) => {
    if (node.type.name === "boxBlockTitle") {
      from = pos + 1;
      to = pos + node.nodeSize - 1;
      return false;
    }
    return undefined;
  });
  if (from < 0 || to <= from) {
    throw new Error("Expected a non-empty box title range");
  }

  return {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, from, to),
    }),
  };
}

function createParagraphBoundaryState(
  blocks: TextFlowBlock[],
  blockId: string,
  boundary: "start" | "end",
): EditorState {
  const schema = getSchema(createRichTextEngineExtensions({
    blockExtensions: [
      SigmaDocTextAttrs,
      BoxBlockExtension,
      BoxBlockTitleExtension,
      BoxBlockBodyExtension,
    ],
    bodyBlocks: true,
  }));
  const doc = schema.nodeFromJSON(textFlowToTiptap(blocks));
  let position = -1;
  doc.descendants((node, pos) => {
    if (node.attrs.sigmaDocId !== blockId) {
      return undefined;
    }
    if (node.isTextblock) {
      position = boundary === "start" ? pos + 1 : pos + node.nodeSize - 1;
    } else {
      const found = TextSelection.findFrom(doc.resolve(pos + 1), boundary === "start" ? 1 : -1, true);
      position = found?.from ?? -1;
    }
    return false;
  });
  if (position < 0) {
    throw new Error(`Text block ${blockId} was not found`);
  }
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, position),
  });
}

function createTextRangeState(
  blocks: TextFlowBlock[],
  fromBlockId: string,
  fromOffset: number,
  toBlockId: string,
  toOffset: number,
): EditorState {
  const schema = getSchema(createRichTextEngineExtensions({
    blockExtensions: [SigmaDocTextAttrs, BoxBlockExtension, BoxBlockTitleExtension, BoxBlockBodyExtension],
    bodyBlocks: true,
  }));
  const doc = schema.nodeFromJSON(textFlowToTiptap(blocks));
  const positions = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (typeof node.attrs.sigmaDocId === "string") {
      positions.set(node.attrs.sigmaDocId, pos + 1);
    }
    return undefined;
  });
  const from = (positions.get(fromBlockId) ?? 0) + fromOffset;
  const to = (positions.get(toBlockId) ?? 0) + toOffset;
  return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
}

function textBlockAtPosition(
  state: EditorState,
  position: number,
): { id: string; text: string } | null {
  if (position < 0) {
    return null;
  }
  const resolved = state.doc.resolve(position);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth);
    if (
      (node.type.name === "paragraph" || node.type.name === "heading")
      && typeof node.attrs.sigmaDocId === "string"
    ) {
      return { id: node.attrs.sigmaDocId, text: node.textContent };
    }
  }
  return null;
}

function paragraph(id: string, text: string): TextFlowBlock {
  return {
    type: "paragraph",
    id,
    children: text ? [{ type: "text", text }] : [],
  };
}

function keyEvent(
  overrides: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">>,
): Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"> {
  return {
    altKey: false,
    ctrlKey: false,
    key: "v",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function getText(block: TextFlowBlock): string {
  if (block.type === "problem") return [...block.lead, ...block.prompt, ...block.hints, ...block.solution].map(getText).join("\n");
  if (block.type === "section") {
    return block.title;
  }
  if (block.type === "list") {
    return block.items.map((item) => getText({
      type: "paragraph",
      id: item.id,
      children: item.children,
    })).join("\n");
  }
  if (block.type === "boxBlock") {
    return [
      ...(block.title ?? []).map((child) => child.type === "text" ? child.text : `$${child.tex}$`),
      ...block.blocks.map(getText),
    ].join("\n");
  }
  if (block.type === "layoutSection") {
    return block.children.map(getText).join("\n");
  }
  if (block.type === "divider") {
    return "";
  }
  if (block.type === "quote") {
    return block.blocks.map(getText).join("\n");
  }
  return block.children.map((child) => child.type === "text" ? child.text : `$${child.tex}$`).join("");
}
