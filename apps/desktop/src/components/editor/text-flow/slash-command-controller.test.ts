// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { BoxBlockBodyExtension, BoxBlockExtension, BoxBlockTitleExtension, LayoutSectionExtension } from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import type { ParagraphNode } from "@/features/document";
import type { TextFlowBlock } from "@/features/text-editing";
import { createBoxBlock } from "@/lib/box-blocks";
import { createTranslator, getAppLocale, setAppLocale } from "@/lib/i18n";
import type { MaterialItem } from "@/types/material";

import { getActiveSlashCommandQuery, handleSlashCommandQueryKeyDown, insertSlashCommandFromQuery } from "./slash-command-controller";
import { filterSlashCommandCandidates, type ActiveSlashCommandQuery, type SlashCommandCandidate } from "./slash-command-model";
import { textFlowToTiptap, tiptapToTextFlow } from "./tiptap-document-adapter";
import type { TextFlowEditorProps } from "./types";

const editors: Editor[] = [];
const originalLocale = getAppLocale();
const t = createTranslator("en", "editor");

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
  vi.restoreAllMocks();
  setAppLocale(originalLocale);
});

function paragraph(text: string): ParagraphNode {
  return { type: "paragraph", id: "trigger", children: [{ type: "text", text }] };
}

function createEditor(blocks: TextFlowBlock[] = [paragraph("/quote")]): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({
      blockExtensions: [SigmaDocTextAttrs, BoxBlockExtension, BoxBlockTitleExtension, BoxBlockBodyExtension, LayoutSectionExtension],
      bodyBlocks: true,
      listMarkerTypography: true,
      orderedListMarkerStyles: true,
    }),
    content: textFlowToTiptap(blocks),
  });
  editors.push(editor);
  let caret = 1;
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent.startsWith("/")) caret = pos + 1 + node.content.size;
  });
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, caret)));
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 24, right: 24, top: 40, bottom: 60 });
  return editor;
}

type Handlers = Pick<TextFlowEditorProps, "onMaterialInsert" | "onBoxCommand" | "onProblemCommand" | "onBodyBlockCommand" | "onHeadingCommand">;

function commandHarness(editor: Editor, handlers: Handlers = {}) {
  const view = editor.view;
  const order: string[] = [];
  const query = { current: getActiveSlashCommandQuery(view) };
  let visibleQuery = query.current;
  const candidates = { current: filterSlashCommandCandidates([], "", true, t, ["itembox"], true, ["insert.quote", "insert.codeBlock", "insert.divider"], true) };
  const index = { current: 0 };
  const material = { current: handlers.onMaterialInsert };
  const box = { current: handlers.onBoxCommand };
  const problem = { current: handlers.onProblemCommand };
  const body = { current: handlers.onBodyBlockCommand };
  const heading = { current: handlers.onHeadingCommand };
  const editorRef = { current: editor as Editor | null };
  const setQuery = (value: ActiveSlashCommandQuery | null) => {
    visibleQuery = value;
    order.push("close");
  };
  editor.on("transaction", ({ transaction }) => {
    if (transaction.docChanged) order.push("document");
  });
  vi.spyOn(view, "focus").mockImplementation(() => { order.push("focus"); });
  return {
    order, query, candidates, index, material, editorRef,
    visibleQuery: () => visibleQuery,
    insert(candidate: SlashCommandCandidate) {
      insertSlashCommandFromQuery(view, candidate, query, material, box, problem, body, editorRef, heading, setQuery);
    },
    key(key: string, options: KeyboardEventInit = {}) {
      const event = new KeyboardEvent("keydown", { key, cancelable: true, ...options });
      const handled = handleSlashCommandQueryKeyDown(
        view, event, query, candidates, index, (update) => { index.current = update(index.current); },
        material, box, problem, body, editorRef, heading, setQuery,
      );
      return { handled, prevented: event.defaultPrevented };
    },
  };
}

function candidate(kind: SlashCommandCandidate["kind"], commandId?: string): SlashCommandCandidate {
  const found = filterSlashCommandCandidates([], "", true, t, ["itembox"], true, ["insert.quote", "insert.codeBlock", "insert.divider"], true)
    .find((item) => item.kind === kind && (!commandId || (item.kind === "block" && item.block.id === commandId)));
  if (!found) throw new Error(`Missing test command: ${kind} ${commandId}`);
  return found;
}

describe("slash command query context", () => {
  it.each(["box", "problem", "block"] as const)("inserts a nested %s in the box body and preserves it through the actual schema", (kind) => {
    const editor = createEditor([{ ...createBoxBlock("itembox"), id: "outer", blocks: [paragraph("/command")] }]);
    const host = vi.fn(() => true);
    const harness = commandHarness(editor, { onProblemCommand: host });
    expect(harness.query.current?.canInsertBox).toBe(true);
    harness.insert(candidate(kind, kind === "block" ? "insert.divider" : undefined));
    const restored = tiptapToTextFlow(editor.getJSON());
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ type: "boxBlock", id: "outer", blocks: expect.arrayContaining([
      expect.objectContaining({ type: kind === "box" ? "boxBlock" : kind === "problem" ? "problem" : "divider" }),
    ]) });
    if (kind === "problem") expect(host).not.toHaveBeenCalled();
  });

  it("uses the text block ID, trigger range, and current screen position", () => {
    const editor = createEditor([paragraph("/quote")]);

    expect(getActiveSlashCommandQuery(editor.view)).toEqual({
      blockId: "trigger", from: 1, to: 7, query: "quote", canInsertBox: true,
      availableBlockCommandIds: ["insert.quote", "insert.codeBlock", "insert.divider"],
      rect: { bottom: 60, left: 24 }, screenPoint: { x: 24, y: 40 },
    });
    expect(editor.state.doc.textContent).toBe("/quote");
  });

  it("does not offer structural commands when text remains after the caret", () => {
    const editor = createEditor([paragraph("/quote remaining")]);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7)));

    expect(getActiveSlashCommandQuery(editor.view)).toMatchObject({ canInsertBox: false, availableBlockCommandIds: [] });
  });

  it("rejects ranges, commands after body text, and unavailable DOM coordinates", () => {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 1, to: 7 });
    expect(getActiveSlashCommandQuery(editor.view)).toBeNull();
    editor.commands.setContent(textFlowToTiptap([paragraph("body /quote")]));
    editor.commands.setTextSelection(12);
    expect(getActiveSlashCommandQuery(editor.view)).toBeNull();
    editor.commands.setContent(textFlowToTiptap([paragraph("/quote")]));
    editor.commands.setTextSelection(7);
    vi.mocked(editor.view.coordsAtPos).mockImplementation(() => { throw new Error("unmounted"); });
    expect(getActiveSlashCommandQuery(editor.view)).toBeNull();
  });

  it("excludes nesting the current quote or code block and excludes commands in box titles", () => {
    const quote = createEditor([{ type: "quote", id: "quote", blocks: [paragraph("/quote")] }]);
    expect(getActiveSlashCommandQuery(quote.view)?.availableBlockCommandIds).toEqual(["insert.codeBlock", "insert.divider"]);
    const code = createEditor([{ type: "codeBlock", id: "code", children: [{ type: "text", text: "/code" }] }]);
    expect(getActiveSlashCommandQuery(code.view)?.availableBlockCommandIds).toEqual(["insert.quote", "insert.divider"]);
    const box = createEditor([{ ...createBoxBlock("itembox"), title: [{ type: "text", text: "/quote" }] }]);
    expect(getActiveSlashCommandQuery(box.view)).toBeNull();
  });
});

describe("slash command execution", () => {
  it.each(["quote", "codeBlock", "divider"] as const)("uses the real Tiptap %s command after consuming the trigger", (kind) => {
    const editor = createEditor();
    const harness = commandHarness(editor);
    harness.insert(candidate("block", `insert.${kind}`));

    const blocks = tiptapToTextFlow(editor.getJSON());
    expect(blocks.some((block) => block.type === kind)).toBe(true);
    expect(editor.state.doc.textContent).toBe("");
    expect(harness.order.slice(0, 3)).toEqual(["close", "document", "focus"]);
  });

  it("lets the host own a structural block change after trigger deletion", () => {
    const editor = createEditor();
    const onBodyBlockCommand = vi.fn(() => {
      expect(editor.state.doc.textContent).toBe("");
      return true;
    });
    const harness = commandHarness(editor, { onBodyBlockCommand });
    harness.insert(candidate("block", "insert.quote"));

    expect(onBodyBlockCommand).toHaveBeenCalledWith({ kind: "quote", triggerBlockId: "trigger" });
    expect(tiptapToTextFlow(editor.getJSON())).toMatchObject([{ type: "paragraph", id: "trigger" }]);
    expect(harness.order).toEqual(["close", "document", "focus"]);
  });

  it("closes a stale body command without touching a destroyed editor", () => {
    const editor = createEditor();
    const harness = commandHarness(editor);
    editor.destroy();
    harness.insert(candidate("block", "insert.quote"));
    expect(harness.order).toEqual(["close"]);
  });

  it.each([true, false])("respects a problem host decision before changing the trigger: %s", (accepted) => {
    const editor = createEditor([paragraph("/problem")]);
    const onProblemCommand = vi.fn(() => {
      expect(editor.state.doc.textContent).toBe("/problem");
      return accepted;
    });
    const harness = commandHarness(editor, { onProblemCommand });
    harness.insert(candidate("problem"));

    expect(onProblemCommand).toHaveBeenCalledWith({ triggerBlockId: "trigger" });
    expect(editor.state.doc.textContent).toBe(accepted ? "" : "/problem");
    expect(harness.order).toEqual(accepted ? ["document", "focus", "close"] : ["close"]);
  });

  it("preserves heading identity, formatting, and the manual break in one document transaction", () => {
    const editor = createEditor([{ ...paragraph("/heading1"), align: "center", lineHeight: "1.8", pagination: { break: true } }]);
    const onHeadingCommand = vi.fn(() => true);
    const harness = commandHarness(editor, { onHeadingCommand });
    harness.insert(candidate("heading"));

    expect(tiptapToTextFlow(editor.getJSON())).toMatchObject([
      { type: "heading", id: "trigger", level: 1, align: "center", lineHeight: "1.8", pagination: { break: true }, children: [] },
    ]);
    expect(onHeadingCommand).toHaveBeenCalledWith({ triggerBlockId: "trigger", level: 1 });
    expect(editor.state.selection.from).toBe(1);
    expect(harness.order).toEqual(["document", "focus", "close"]);
  });

  it("retains the trigger when the heading host refuses the operation", () => {
    const editor = createEditor([paragraph("/heading1")]);
    const harness = commandHarness(editor, { onHeadingCommand: () => false });
    harness.insert(candidate("heading"));
    expect(editor.state.doc.textContent).toBe("/heading1");
    expect(harness.order).toEqual(["close"]);
  });

  it("hands a box command to the host before deleting the trigger", () => {
    const editor = createEditor([paragraph("/itembox")]);
    const onBoxCommand = vi.fn(() => {
      expect(editor.state.doc.textContent).toBe("/itembox");
      return true;
    });
    const harness = commandHarness(editor, { onBoxCommand });
    harness.insert(candidate("box"));

    expect(onBoxCommand).toHaveBeenCalledWith(expect.objectContaining({ styleId: "itembox", triggerBlockId: "trigger" }));
    expect(tiptapToTextFlow(editor.getJSON())).toMatchObject([{ type: "paragraph", id: "trigger", children: [] }]);
    expect(harness.order).toEqual(["document", "focus", "close"]);
  });

  it("builds a fallback box with the locale at insertion time", () => {
    const editor = createEditor([paragraph("/itembox")]);
    const harness = commandHarness(editor, { onBoxCommand: () => false });
    setAppLocale("ja");
    const boxCandidate = candidate("box");
    setAppLocale("en");
    harness.insert(boxCandidate);

    expect(tiptapToTextFlow(editor.getJSON())).toMatchObject([
      { type: "boxBlock", styleId: "itembox", title: [{ type: "text", text: "Key point" }] },
    ]);
    expect(editor.state.doc.textContent).not.toContain("/itembox");
    expect(harness.order).toEqual(["document", "focus", "close"]);
  });

  it("calls the latest material handler after closing, deleting, and focusing", () => {
    const editor = createEditor([paragraph("/material")]);
    const material: MaterialItem = {
      version: 1, id: "material", name: "material", createdAt: "", updatedAt: "",
      content: { blocks: [], overlaySnapshot: { version: 1, shapes: [], assets: {} } },
    };
    const staleHandler = vi.fn();
    const harness = commandHarness(editor, { onMaterialInsert: staleHandler });
    const latestHandler = vi.fn(() => {
      expect(harness.order).toEqual(["close", "document", "focus"]);
      expect(editor.state.doc.textContent).toBe("");
    });
    harness.material.current = latestHandler;
    harness.insert({ kind: "material", material });

    expect(staleHandler).not.toHaveBeenCalled();
    expect(latestHandler).toHaveBeenCalledWith({ material, triggerBlockId: "trigger", screenPoint: { x: 24, y: 40 } });
  });
});

describe("slash command key ownership", () => {
  it("wraps candidate navigation and closes on Escape without changing the document", () => {
    const editor = createEditor();
    const harness = commandHarness(editor);
    expect(harness.key("ArrowUp")).toEqual({ handled: true, prevented: true });
    expect(harness.index.current).toBe(harness.candidates.current.length - 1);
    expect(harness.key("ArrowDown")).toEqual({ handled: true, prevented: true });
    expect(harness.index.current).toBe(0);
    expect(harness.key("Escape")).toEqual({ handled: true, prevented: true });
    expect(harness.visibleQuery()).toBeNull();
    expect(editor.state.doc.textContent).toBe("/quote");
  });

  it.each(["Enter", "Tab"])("accepts %s while leaving Cmd/Ctrl combinations to other handlers", (key) => {
    const editor = createEditor([paragraph("/heading1")]);
    const harness = commandHarness(editor);
    harness.candidates.current = [candidate("heading")];
    expect(harness.key(key, { metaKey: true })).toEqual({ handled: false, prevented: false });
    expect(harness.key(key, { ctrlKey: true })).toEqual({ handled: false, prevented: false });
    expect(editor.state.doc.textContent).toBe("/heading1");
    harness.index.current = 20; // A filtered list may have changed before the next ref synchronization.
    expect(harness.key(key)).toEqual({ handled: true, prevented: true });
    expect(tiptapToTextFlow(editor.getJSON())[0]).toMatchObject({ type: "heading", level: 1 });
  });

  it("does not consume keys without a query or candidates, except Escape closes an empty menu", () => {
    const harness = commandHarness(createEditor());
    harness.candidates.current = [];
    expect(harness.key("Enter")).toEqual({ handled: false, prevented: false });
    expect(harness.key("ArrowDown")).toEqual({ handled: false, prevented: false });
    expect(harness.key("Escape")).toEqual({ handled: true, prevented: true });
    harness.query.current = null;
    expect(harness.key("Escape")).toEqual({ handled: false, prevented: false });
  });
});
