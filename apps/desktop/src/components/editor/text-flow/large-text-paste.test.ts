// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";

import {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { DocumentHistoryController } from "@/features/document/application/document-history";
import type { TextFlowBlock } from "@/features/text-editing";
import {
  createTextFlowClipboardPayload,
  getLocalEditorClipboardPayload,
  writeEditorPayloadToSystemClipboard,
} from "@/lib/editor-clipboard";

import {
  buildLargeTextPastePlan,
  commitLargeTextPastePlan,
  countPlainTextPasteBlocks,
  findLargeTextPasteBlockedBlockId,
  isLargeTextPasteSelectionAtTopLevel,
  largeLiteralTextPasteBlocks,
  largeTextPasteBlocks,
  localClipboardPayloadMatchesPlainText,
  mergeLargePasteDeferredBlockIds,
  shouldUseLargeTextPaste,
} from "./large-text-paste";
import { textFlowToTiptap, tiptapToTextFlow } from "./tiptap-document-adapter";

const INITIAL_BLOCKS: TextFlowBlock[] = [{
  type: "paragraph",
  id: "p1",
  children: [{ type: "text", text: "前半後半" }],
}];

function createEditor(blocks: TextFlowBlock[] = INITIAL_BLOCKS) {
  return new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({
      bodyBlocks: true,
      blockExtensions: [
        SigmaDocTextAttrs,
        BoxBlockExtension,
        BoxBlockTitleExtension,
        BoxBlockBodyExtension,
      ],
    }),
    content: textFlowToTiptap(blocks),
  });
}

function paragraph(id: string, text: string): Extract<TextFlowBlock, { type: "paragraph" }> {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function textPosition(editor: Editor, blockId: string, offset: number): number {
  let result: number | undefined;
  editor.state.doc.descendants((node, position) => {
    if (node.attrs.sigmaDocId === blockId) {
      result = position + 1 + offset;
      return false;
    }
    return true;
  });
  if (result === undefined) {
    throw new Error(`Block not found: ${blockId}`);
  }
  return result;
}

function blockTexts(blocks: readonly TextFlowBlock[]): string[] {
  return blocks.map((block) => (
    "children" in block
      ? block.children.map((child) => child.type === "text" ? child.text : "").join("")
      : ""
  ));
}

function blockTextAndFormatting(blocks: readonly TextFlowBlock[]) {
  return blocks.map((block) => ({
    type: block.type,
    characters: "children" in block
      ? block.children.flatMap((child) => child.type !== "text"
        ? []
        : Array.from(child.text, (character) => ({
          character,
          marks: child.marks,
          color: child.color,
          backgroundColor: child.backgroundColor,
          fontFamily: child.fontFamily,
          fontSize: child.fontSize,
        })))
      : [],
  }));
}

describe("large text paste", () => {
  it("carries only still-deferred blocks into a consecutive large paste", () => {
    const merged = mergeLargePasteDeferredBlockIds(
      {
        deferredBlockIds: new Set(["old-hydrated-1", "old-hydrated-2", "old-pending"]),
        hydratedUnitIds: new Set(["hydrated-unit"]),
      },
      [
        { id: "hydrated-unit", blockIds: ["old-hydrated-1", "old-hydrated-2"] },
        { id: "pending-unit", blockIds: ["old-pending"] },
      ],
      ["new-pending-1", "new-pending-2"],
    );

    expect(merged).toEqual(new Set(["old-pending", "new-pending-1", "new-pending-2"]));
  });

  it("branches at 200 collapsed newline-separated blocks", () => {
    expect(shouldUseLargeTextPaste(Array.from({ length: 199 }, (_, index) => `line-${index}`).join("\n"))).toBe(false);
    expect(shouldUseLargeTextPaste(Array.from({ length: 200 }, (_, index) => `line-${index}`).join("\n"))).toBe(true);
    expect(countPlainTextPasteBlocks("a\n\n\r\n\r\nb")).toBe(2);
  });

  it("collapses consecutive CR/LF boundaries into paragraphs", () => {
    expect(blockTexts(largeTextPasteBlocks("一行目\n\n二行目\r\n\r\n三行目")))
      .toEqual(["一行目", "二行目", "三行目"]);
  });

  it.each([
    {
      name: "list item",
      blocks: [{
        type: "list" as const,
        id: "list-1",
        listType: "bullet" as const,
        items: [{ type: "listItem" as const, id: "item-1", children: [{ type: "text" as const, text: "項目" }] }],
      }],
      blockId: "item-1",
    },
    {
      name: "quote",
      blocks: [{
        type: "quote" as const,
        id: "quote-1",
        blocks: [paragraph("quote-p", "引用")],
      }],
      blockId: "quote-p",
    },
    {
      name: "box body",
      blocks: [{
        type: "boxBlock" as const,
        id: "box-1",
        styleId: "fancybox",
        title: [{ type: "text" as const, text: "タイトル" }],
        blocks: [paragraph("box-p", "本文")],
      }],
      blockId: "box-p",
    },
  ])("falls back to native paste inside a $name container", ({ blocks, blockId }) => {
    const editor = createEditor(blocks);
    const position = textPosition(editor, blockId, 1);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)));

    expect(isLargeTextPasteSelectionAtTopLevel(editor.state)).toBe(false);
    expect(buildLargeTextPastePlan({
      state: editor.state,
      previousBlocks: blocks,
      pastedBlocks: largeTextPasteBlocks(Array.from({ length: 200 }, (_, index) => `貼付-${index}`).join("\n")),
      scopeId: "document",
      unitId: blocks[0]!.id,
    })).toBeNull();
    editor.destroy();
  });

  it.each([
    { name: "paragraph", blocks: [paragraph("p1", "本文")] },
    {
      name: "heading",
      blocks: [{
        type: "heading" as const,
        id: "h1",
        level: 2 as const,
        children: [{ type: "text" as const, text: "見出し" }],
      }],
    },
  ])("keeps the fast path available in a top-level $name", ({ blocks }) => {
    const editor = createEditor(blocks);
    const position = textPosition(editor, blocks[0]!.id, 1);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)));

    expect(isLargeTextPasteSelectionAtTopLevel(editor.state)).toBe(true);
    expect(buildLargeTextPastePlan({
      state: editor.state,
      previousBlocks: blocks,
      pastedBlocks: largeTextPasteBlocks(Array.from({ length: 200 }, (_, index) => `貼付-${index}`).join("\n")),
      scopeId: "document",
      unitId: blocks[0]!.id,
    })).not.toBeNull();
    editor.destroy();
  });

  it("matches native literal paste without interpreting Markdown, including insertion marks", () => {
    const markedBlocks: TextFlowBlock[] = [{
      type: "paragraph",
      id: "p1",
      children: [{ type: "text", text: "前半後半", marks: ["bold", "italic"], color: "#1d4ed8" }],
    }];
    const text = Array.from({ length: 200 }, (_, index) => `# literal-${index}`).join("\n");
    const nativeEditor = createEditor(markedBlocks);
    const plannedEditor = createEditor(markedBlocks);
    nativeEditor.view.dispatch(nativeEditor.state.tr.setSelection(TextSelection.create(nativeEditor.state.doc, 3)));
    plannedEditor.view.dispatch(plannedEditor.state.tr.setSelection(TextSelection.create(plannedEditor.state.doc, 3)));

    nativeEditor.view.pasteText(text);
    const nativeBlocks = tiptapToTextFlow(nativeEditor.getJSON(), markedBlocks);
    const plan = buildLargeTextPastePlan({
      state: plannedEditor.state,
      previousBlocks: markedBlocks,
      pastedBlocks: largeLiteralTextPasteBlocks(text, plannedEditor.state.selection.$from.marks()),
      scopeId: "document",
      unitId: "p1",
    });

    expect(plan).not.toBeNull();
    expect(blockTextAndFormatting(plan!.nextBlocks)).toEqual(blockTextAndFormatting(nativeBlocks));
    expect(plan!.nextBlocks.every((block) => block.type === "paragraph")).toBe(true);
    nativeEditor.destroy();
    plannedEditor.destroy();
  });

  it("keeps a large paste behind a manual break at the owner block start", () => {
    const blocks: TextFlowBlock[] = [
      paragraph("before", "前"),
      { ...paragraph("after", "後"), pagination: { break: true } },
    ];
    const editor = createEditor(blocks);
    const position = textPosition(editor, "after", 0);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)));

    const plan = buildLargeTextPastePlan({
      state: editor.state,
      previousBlocks: blocks,
      pastedBlocks: [paragraph("paste", "貼付")],
      scopeId: "document",
      unitId: "document",
    });

    expect(plan?.nextBlocks.map((block) => [block.id, block.pagination?.break, ...blockTexts([block])])).toEqual([
      ["before", undefined, "前"],
      ["after", true, "貼付後"],
    ]);
    editor.destroy();
  });

  it("commits a literal large paste as one undoable plan", () => {
    const history = new DocumentHistoryController<{ blocks: TextFlowBlock[] }, null>(10);
    const before = { blocks: INITIAL_BLOCKS };
    const editor = createEditor();
    const plan = buildLargeTextPastePlan({
      state: editor.state,
      previousBlocks: INITIAL_BLOCKS,
      pastedBlocks: largeLiteralTextPasteBlocks(
        Array.from({ length: 500 }, (_, index) => `# literal-${index}`).join("\n"),
      ),
      scopeId: "document",
      unitId: "p1",
    });
    expect(plan).not.toBeNull();

    const after = { blocks: plan!.nextBlocks };
    const commit = vi.fn(() => {
      history.record({ document: before, selection: null }, { coalescingKey: "literal-large-paste" });
    });
    commitLargeTextPastePlan(plan!, "literal-large-paste", commit);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(history.undoDepth).toBe(1);
    expect(history.undo({ document: after, selection: null })?.document).toBe(before);
    expect(history.undo({ document: before, selection: null })).toBeNull();
    editor.destroy();
  });

  it("ignores a stale app-copy cache when an external large plain-text paste arrives", async () => {
    const cachedPayload = createTextFlowClipboardPayload([paragraph("cached", "古いアプリ内コピー")]);
    const externalText = Array.from({ length: 200 }, (_, index) => `外部-${index}`).join("\n");
    await writeEditorPayloadToSystemClipboard(cachedPayload);
    const locallyCachedPayload = getLocalEditorClipboardPayload();

    expect(localClipboardPayloadMatchesPlainText(locallyCachedPayload, "古いアプリ内コピー")).toBe(true);
    expect(localClipboardPayloadMatchesPlainText(locallyCachedPayload, externalText)).toBe(false);
    expect(shouldUseLargeTextPaste(externalText)).toBe(true);
  });

  it.each([
    { name: "collapsed caret", from: 3, to: 3 },
    { name: "selection replacement", from: 3, to: 5 },
  ])("matches PM native plain-text content for $name", ({ from, to }) => {
    const text = Array.from({ length: 200 }, (_, index) => `貼付${index}`).join("\n\n");
    const nativeEditor = createEditor();
    const plannedEditor = createEditor();
    nativeEditor.view.dispatch(nativeEditor.state.tr.setSelection(TextSelection.create(nativeEditor.state.doc, from, to)));
    plannedEditor.view.dispatch(plannedEditor.state.tr.setSelection(TextSelection.create(plannedEditor.state.doc, from, to)));

    nativeEditor.view.pasteText(text);
    const nativeBlocks = tiptapToTextFlow(nativeEditor.getJSON(), INITIAL_BLOCKS);
    const plan = buildLargeTextPastePlan({
      state: plannedEditor.state,
      previousBlocks: INITIAL_BLOCKS,
      pastedBlocks: largeTextPasteBlocks(text),
      scopeId: "document",
      unitId: "p1",
    });

    expect(plan).not.toBeNull();
    expect(blockTexts(plan!.nextBlocks)).toEqual(blockTexts(nativeBlocks));
    expect(plan!.deferredBlockIds).toEqual(plan!.nextBlocks
      .slice(40)
      .filter((block) => !INITIAL_BLOCKS.some((previous) => previous.id === block.id))
      .filter((block) => block.id !== plan!.focusBlockId)
      .map((block) => block.id));
    nativeEditor.destroy();
    plannedEditor.destroy();
  });

  it("inherits the insertion context marks like PM native plain-text paste", () => {
    const markedBlocks: TextFlowBlock[] = [{
      type: "paragraph",
      id: "p1",
      children: [{
        type: "text",
        text: "前半後半",
        marks: ["bold", "italic", "underline"],
        color: "#1d4ed8",
        fontSize: 18,
      }],
    }];
    const text = Array.from({ length: 200 }, (_, index) => `貼付${index}`).join("\n");
    const nativeEditor = createEditor(markedBlocks);
    const plannedEditor = createEditor(markedBlocks);
    nativeEditor.view.dispatch(nativeEditor.state.tr.setSelection(TextSelection.create(nativeEditor.state.doc, 3)));
    plannedEditor.view.dispatch(plannedEditor.state.tr.setSelection(TextSelection.create(plannedEditor.state.doc, 3)));

    nativeEditor.view.pasteText(text);
    const nativeBlocks = tiptapToTextFlow(nativeEditor.getJSON(), markedBlocks);
    const plan = buildLargeTextPastePlan({
      state: plannedEditor.state,
      previousBlocks: markedBlocks,
      pastedBlocks: largeTextPasteBlocks(text, plannedEditor.state.selection.$from.marks()),
      scopeId: "document",
      unitId: "p1",
    });

    expect(plan).not.toBeNull();
    const pastedTextFormatting = (blocks: readonly TextFlowBlock[]) => blocks.flatMap((block) => (
      "children" in block
        ? block.children.flatMap((child) => child.type === "text" && child.text.includes("貼付")
          ? [{
              marks: child.marks,
              color: child.color,
              backgroundColor: child.backgroundColor,
              fontFamily: child.fontFamily,
              fontSize: child.fontSize,
            }]
          : [])
        : []
    ));
    expect(pastedTextFormatting(plan!.nextBlocks)).toEqual(pastedTextFormatting(nativeBlocks));
    nativeEditor.destroy();
    plannedEditor.destroy();
  });

  it.each([
    { name: "unit の先頭", blockIndex: 0, offset: 0 },
    { name: "unit の中間", blockIndex: 30, offset: 3 },
    { name: "unit の末尾", blockIndex: 59, offset: 5 },
  ])("keeps the native insertion-end caret at the $name", ({ blockIndex, offset }) => {
    const previousBlocks = Array.from({ length: 60 }, (_, index) => paragraph(`existing-${index}`, `既存-${index}`));
    const text = Array.from({ length: 200 }, (_, index) => `貼付-${index}`).join("\n");
    const nativeEditor = createEditor(previousBlocks);
    const plannedEditor = createEditor(previousBlocks);
    const targetId = previousBlocks[blockIndex]!.id;
    const nativePosition = textPosition(nativeEditor, targetId, offset);
    const plannedPosition = textPosition(plannedEditor, targetId, offset);
    nativeEditor.view.dispatch(nativeEditor.state.tr.setSelection(TextSelection.create(nativeEditor.state.doc, nativePosition)));
    plannedEditor.view.dispatch(plannedEditor.state.tr.setSelection(TextSelection.create(plannedEditor.state.doc, plannedPosition)));

    nativeEditor.view.pasteText(text);
    const plan = buildLargeTextPastePlan({
      state: plannedEditor.state,
      previousBlocks,
      pastedBlocks: largeTextPasteBlocks(text),
      scopeId: "document",
      unitId: previousBlocks[0]!.id,
    });

    expect(plan).not.toBeNull();
    const nativeBlockIndex = nativeEditor.state.selection.$head.index(0);
    const plannedBlockIndex = plan!.nextBlocks.findIndex((block) => block.id === plan!.focusBlockId);
    expect(plannedBlockIndex).toBe(nativeBlockIndex);
    expect(plan!.selection).toEqual({
      anchor: {
        affinity: "after",
        blockId: plan!.focusBlockId,
        kind: "text",
        offset: nativeEditor.state.selection.$head.parentOffset,
      },
      head: {
        affinity: "after",
        blockId: plan!.focusBlockId,
        kind: "text",
        offset: nativeEditor.state.selection.$head.parentOffset,
      },
      preferredX: null,
    });
    expect(plan!.deferredBlockIds).not.toContain(plan!.focusBlockId);
    nativeEditor.destroy();
    plannedEditor.destroy();
  });

  it("never defers blocks that existed before a large paste", () => {
    const previousBlocks = Array.from({ length: 60 }, (_, index) => paragraph(`existing-${index}`, `既存-${index}`));
    const editor = createEditor(previousBlocks);
    const targetId = previousBlocks[30]!.id;
    const position = textPosition(editor, targetId, 3);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)));
    const plan = buildLargeTextPastePlan({
      state: editor.state,
      previousBlocks,
      pastedBlocks: largeTextPasteBlocks(Array.from({ length: 200 }, (_, index) => `貼付-${index}`).join("\n")),
      scopeId: "document",
      unitId: previousBlocks[0]!.id,
    });

    expect(plan).not.toBeNull();
    expect(plan!.deferredBlockIds).not.toEqual([]);
    expect(plan!.deferredBlockIds).toEqual(expect.not.arrayContaining(previousBlocks.map((block) => block.id)));
    editor.destroy();
  });

  it("rejects a large paste before commit when its edited block has an AI guard", () => {
    const editor = createEditor();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)));
    const plan = buildLargeTextPastePlan({
      state: editor.state,
      previousBlocks: INITIAL_BLOCKS,
      pastedBlocks: largeTextPasteBlocks(Array.from({ length: 200 }, (_, index) => `AI-${index}`).join("\n")),
      scopeId: "document",
      unitId: "p1",
    });

    expect(plan).not.toBeNull();
    expect(findLargeTextPasteBlockedBlockId(plan!, INITIAL_BLOCKS, new Set(["p1"]))).toBe("p1");
    expect(findLargeTextPasteBlockedBlockId(plan!, INITIAL_BLOCKS, new Set(["unlocked"]))).toBeNull();
    editor.destroy();
  });

  it("rejects a large paste before commit when the document-wide guard covers its block", () => {
    const previousBlocks = [paragraph("p1", "前半後半"), paragraph("p2", "別の本文")];
    const editor = createEditor(previousBlocks);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)));
    const plan = buildLargeTextPastePlan({
      state: editor.state,
      previousBlocks,
      pastedBlocks: largeTextPasteBlocks(Array.from({ length: 200 }, (_, index) => `WRITE-${index}`).join("\n")),
      scopeId: "document",
      unitId: "p1",
    });

    expect(plan).not.toBeNull();
    expect(findLargeTextPasteBlockedBlockId(
      plan!,
      previousBlocks,
      new Set(previousBlocks.map((block) => block.id)),
    )).toBe("p1");
    editor.destroy();
  });

  it("records the bulk replacement once and restores all rows with one undo", () => {
    const history = new DocumentHistoryController<{ blocks: TextFlowBlock[] }, null>(10);
    const before = { blocks: INITIAL_BLOCKS };
    const after = { blocks: largeTextPasteBlocks(Array.from({ length: 500 }, (_, index) => `line-${index}`).join("\n")) };

    const commit = vi.fn(() => {
      history.record({ document: before, selection: null }, { coalescingKey: "large-paste" });
    });
    const editor = createEditor();
    const plan = buildLargeTextPastePlan({
      state: editor.state,
      previousBlocks: INITIAL_BLOCKS,
      pastedBlocks: after.blocks,
      scopeId: "document",
      unitId: "p1",
    });
    expect(plan).not.toBeNull();

    commitLargeTextPastePlan(plan!, "large-paste", commit);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(history.undoDepth).toBe(1);
    expect(history.undo({ document: after, selection: null })?.document).toBe(before);
    expect(history.undo({ document: before, selection: null })).toBeNull();
    editor.destroy();
  });

  it("connects the committed insertion-end selection to caret restoration", () => {
    const editor = createEditor();
    const plan = buildLargeTextPastePlan({
      state: editor.state,
      previousBlocks: INITIAL_BLOCKS,
      pastedBlocks: largeTextPasteBlocks(
        Array.from({ length: 500 }, (_, index) => `line-${index}`).join("\n"),
      ),
      scopeId: "document",
      unitId: "p1",
    });
    expect(plan?.selection).toBeDefined();

    const calls: string[] = [];
    const commit = vi.fn(() => calls.push("commit"));
    const restoreCaret = vi.fn(() => calls.push("restore"));
    commitLargeTextPastePlan(plan!, "large-paste", commit, restoreCaret);

    expect(calls).toEqual(["commit", "restore"]);
    expect(restoreCaret).toHaveBeenCalledTimes(1);
    expect(restoreCaret).toHaveBeenCalledWith(plan!.selection);
    editor.destroy();
  });
});
