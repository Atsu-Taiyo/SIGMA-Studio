// @vitest-environment happy-dom

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { applyEditorDocumentProjection } from "@/components/tiptap/document-projection";
import type { TextFormatStateDetail } from "@/components/tiptap/text-format-controller";
import { DEFAULT_FONT_FAMILY_VALUE, TEXT_FORMAT_STATE_EVENT } from "./editor-shell/constants";
import { resolveEditorHistoryShortcutTarget } from "./editor-shell/command-shortcut-targets";

import {
  TextFlowEditor,
  textFlowToTiptap,
  type TextFlowChangeContext,
} from "@/components/editor/TextFlowEditor";
import {
  clearTextRunSpan,
  getActiveTextRunSpan,
  getTextRunEditors,
  handleTextRunSpanKeyDown,
  handleTextRunSpanTextInput,
  selectEntireTextRun,
} from "@/components/editor/text-flow/text-run-span";
import {
  replaceTopLevelTextFlowBlocks,
  type TextFlowBlock,
} from "@/features/text-editing";
import {
  createTextFlowClipboardPayload,
  writeEditorClipboardData,
} from "@/lib/editor-clipboard";
import { setAppLocale } from "@/lib/i18n/react";

const INITIAL_BLOCKS: TextFlowBlock[] = [
  paragraph("p_before", "前の段落テキストです。"),
  { ...paragraph("p_break", "改ページ後の段落テキストです。"), pagination: { break: true } },
  paragraph("p_after", "後ろの段落テキストです。"),
];

function paragraph(id: string, text: string): TextFlowBlock {
  return {
    type: "paragraph",
    id,
    children: text ? [{ type: "text", text }] : [],
  };
}

function textOf(block: TextFlowBlock): string {
  return "children" in block
    ? block.children.map((child) => child.type === "text" ? child.text : "").join("")
    : "";
}

interface ChangeCall {
  context?: TextFlowChangeContext;
  nextBlocks: TextFlowBlock[];
  previousIds: string[];
}

let container: HTMLDivElement;
let root: Root;
let savedBlocks: TextFlowBlock[] = [];
let changes: ChangeCall[] = [];

function Harness({ initialBlocks = INITIAL_BLOCKS, selectedId = null, historyRestore }: {
  initialBlocks?: TextFlowBlock[];
  selectedId?: string | null;
  historyRestore?: { blocks: TextFlowBlock[]; revision: number };
}): React.JSX.Element {
  const [blocks, setBlocks] = useState<TextFlowBlock[]>(initialBlocks);
  const displayedBlocks = historyRestore?.blocks ?? blocks;
  useEffect(() => {
    savedBlocks = displayedBlocks;
  }, [displayedBlocks]);
  const apply = (
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    _activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => {
    changes.push({ previousIds, nextBlocks, context });
    setBlocks((current) => replaceTopLevelTextFlowBlocks(
      current,
      previousIds,
      nextBlocks,
    ) as TextFlowBlock[]);
  };
  const before = displayedBlocks.filter((block) => block.id === "p_before");
  const after = displayedBlocks.filter((block) => block.id !== "p_before");

  return <>
    <TextFlowEditor
      blocks={before}
      selectedId={selectedId}
      historyRevision={historyRestore?.revision ?? 0}
      onSelect={() => {}}
      onChange={apply}
      textRunGroupId="integration-document"
      textRunOrder={0}
      textRunUnitId="unit-before"
      textRunScopeId="document"
    />
    <TextFlowEditor
      blocks={after}
      selectedId={selectedId}
      historyRevision={historyRestore?.revision ?? 0}
      paginationBeforeIds={after.filter((block) => block.pagination?.break).map((block) => block.id)}
      onSelect={() => {}}
      onChange={apply}
      textRunGroupId="integration-document"
      textRunOrder={1}
      textRunUnitId="unit-break"
      textRunScopeId="document"
    />
  </>;
}

beforeEach(() => {
  setAppLocale("ja");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  savedBlocks = [];
  changes = [];
});

afterEach(() => {
  clearTextRunSpan();
  act(() => root.unmount());
  container.remove();
});

async function renderHarness(props: Parameters<typeof Harness>[0] = {}): Promise<ReturnType<typeof getTextRunEditors>> {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
  const editors = getTextRunEditors("integration-document");
  expect(editors).toHaveLength(2);
  return editors;
}

function textRangeForBlock(editor: Editor, blockId: string): { from: number; to: number } {
  let range: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.attrs.sigmaDocId === blockId) {
      range = { from: pos + 1, to: pos + 1 + node.content.size };
      return false;
    }
    return true;
  });
  if (!range) {
    throw new Error(`missing text block: ${blockId}`);
  }
  return range;
}

function copySelection(editor: Editor): DataTransfer {
  const clipboardData = new DataTransfer();
  const event = new ClipboardEvent("copy", {
    bubbles: true,
    cancelable: true,
    clipboardData,
  });
  editor.view.dom.dispatchEvent(event);
  return clipboardData;
}

async function pasteClipboard(editor: Editor, clipboardData: DataTransfer): Promise<void> {
  await act(async () => {
    editor.view.dom.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }));
  });
}

function clipboardWith(types: { html?: string; text?: string }): DataTransfer {
  const clipboardData = new DataTransfer();
  if (types.html !== undefined) {
    clipboardData.setData("text/html", types.html);
  }
  if (types.text !== undefined) {
    clipboardData.setData("text/plain", types.text);
  }
  return clipboardData;
}

describe("TextFlowEditor toolbar range retention", () => {
  async function selectForToolbar() {
    const [{ editor }] = await renderHarness({
      initialBlocks: [paragraph("p_before", "abcdefgh"), paragraph("p_after", "ijklmnop")],
      selectedId: "p_before",
    });
    const input = document.createElement("input");
    input.setAttribute("data-toolbar-popover", "");
    container.append(input);
    await act(async () => {
      editor.view.focus();
      editor.commands.setTextSelection({ from: 2, to: 5 });
      input.focus();
    });
    expect(editor.isFocused).toBe(false);
    expect(document.activeElement).toBe(input);
    return { editor, input };
  }

  async function format(command: string, value?: string, options?: { restoreFocus?: boolean }) {
    await act(async () => {
      window.dispatchEvent(new CustomEvent("sigma-studio:format-text", { detail: { command, value, target: "document", ...options } }));
    });
  }

  it.each([
    { value: "bad", focusOnly: true },
    { value: "", focusOnly: true },
    { value: "12", focusOnly: true },
    { value: "18", focusOnly: false },
  ])("does not resume an idle tab without a saved range ($value, focusOnly=$focusOnly)", async ({ value, focusOnly }) => {
    const [{ editor }] = await renderHarness({
      initialBlocks: [
        { type: "paragraph", id: "p_before", children: [{ type: "text", text: "abcdefgh", fontSize: 12 }] },
        paragraph("p_after", "ijklmnop"),
      ],
      // A selected block alone must not restore its caret or select its whole text.
      selectedId: "p_before",
    });
    const input = document.createElement("input");
    container.append(input);
    await act(async () => { input.focus(); });
    const focus = vi.spyOn(editor.view, "focus");
    const publish = vi.fn();
    const doc = editor.state.doc;
    const selection = editor.state.selection;
    const saved = structuredClone(savedBlocks);
    const detail = { command: "fontSize", value, target: "document", focusOnly, restoreFocus: true, focusBlockId: null };
    window.addEventListener(TEXT_FORMAT_STATE_EVENT, publish);
    try {
      await act(async () => {
        window.dispatchEvent(new CustomEvent("sigma-studio:format-text", { detail }));
      });
      expect(focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
      expect(publish).not.toHaveBeenCalled();
      expect(detail.focusBlockId).toBeNull();
      expect(editor.state.doc).toBe(doc);
      expect(editor.state.selection).toBe(selection);
      expect(savedBlocks).toEqual(saved);
      expect(changes).toHaveLength(0);
    } finally {
      window.removeEventListener(TEXT_FORMAT_STATE_EVENT, publish);
      focus.mockRestore();
    }
  });

  it("returns focus and the saved range from font search after committing a font size", async () => {
    const { editor, input } = await selectForToolbar();
    await format("fontSize", "15", { restoreFocus: true });
    expect(document.activeElement).toBe(editor.view.dom);
    await act(async () => {
      input.type = "search";
      input.focus();
      input.value = "Hiragino Mincho";
      editor.commands.setTextSelection(2); // Exercise the range saved before search took focus.
    });
    await format("fontFamily", "Hiragino Mincho ProN");

    expect(document.activeElement).toBe(editor.view.dom);
    expect(window.getSelection()?.toString()).toBe("bcd");
    expect(savedBlocks[0]).toMatchObject({ children: [
      { text: "a" }, { text: "bcd", fontSize: 15, fontFamily: "Hiragino Mincho ProN" }, { text: "efgh" },
    ] });

    // The focus handoff must retain a valid target for the next toolbar command.
    await act(async () => { input.focus(); });
    await format("bold");
    expect(savedBlocks[0]).toMatchObject({ children: [
      { text: "a" }, { text: "bcd", fontSize: 15, fontFamily: "Hiragino Mincho ProN", marks: ["bold"] }, { text: "efgh" },
    ] });
  });

  it("routes history to the document after font search and republishes the restored font", async () => {
    const { editor, input } = await selectForToolbar();
    const originalBlocks = structuredClone(savedBlocks);
    const reports: TextFormatStateDetail[] = [];
    const collect = (event: Event) => reports.push((event as CustomEvent<TextFormatStateDetail>).detail);
    window.addEventListener(TEXT_FORMAT_STATE_EVENT, collect);
    try {
      await act(async () => {
        input.type = "search";
        input.value = "Hiragino Mincho";
      });
      await format("fontFamily", "Hiragino Mincho ProN");
      expect(reports.at(-1)?.fontFamily).toBe("Hiragino Mincho ProN");
      expect(resolveEditorHistoryShortcutTarget({
        target: document.activeElement, direction: "undo", isComposing: false,
      }).kind).toBe("document");

      // The shell owns SigmaDoc undo; deliver its restored blocks/revision to the same editor.
      const changeCount = changes.length;
      await act(async () => root.render(<Harness
        selectedId="p_before"
        historyRestore={{ blocks: originalBlocks, revision: 1 }}
      />));
      expect(document.activeElement).toBe(editor.view.dom);
      expect(editor.state.selection.empty).toBe(false);
      expect(editor.getJSON().content![0].content).toEqual([{ type: "text", text: "abcdefgh" }]);
      expect(reports.at(-1)?.fontFamily).toBe(DEFAULT_FONT_FAMILY_VALUE);
      expect(savedBlocks).toEqual(originalBlocks);
      expect(changes).toHaveLength(changeCount);
    } finally {
      window.removeEventListener(TEXT_FORMAT_STATE_EVENT, collect);
    }
  });

  it("does not format stale offsets or the entire block after an insertion projection", async () => {
    const { editor, input } = await selectForToolbar();
    await act(async () => {
      applyEditorDocumentProjection(editor, textFlowToTiptap([paragraph("p_before", "XXabcdefgh")]));
    });
    for (const collapsed of [false, true]) {
      await act(async () => {
        // A projected selection must not be saved again while toolbar focus is held.
        editor.commands.setTextSelection(collapsed ? 2 : { from: 2, to: 5 });
      });
      await format("fontSize", "18");
      await format("bold");
      await format("fontFamily", "Hiragino Mincho ProN");
      expect(editor.getJSON().content![0].content).toEqual([{ type: "text", text: "XXabcdefgh" }]);
      expect(document.activeElement).toBe(input);
    }
    expect(changes).toHaveLength(0);

    await act(async () => {
      editor.view.focus();
      editor.commands.setTextSelection({ from: 4, to: 7 });
      input.focus();
    });
    await format("fontSize", "20");
    expect(savedBlocks[0]).toMatchObject({ children: [
      { text: "XXa" }, { text: "bcd", fontSize: 20 }, { text: "efgh" },
    ] });
  });

  it("reuses the saved range for repeated formatting after a mark-only projection", async () => {
    const { editor, input } = await selectForToolbar();
    await act(async () => {
      const marked = editor.state.tr.addMark(2, 5, editor.schema.marks.bold.create()).doc;
      applyEditorDocumentProjection(editor, marked.toJSON());
      editor.commands.setTextSelection(2); // Force the saved-range fallback.
    });
    for (const size of [18, 18, 20]) {
      await format("fontSize", String(size));
      expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe("bcd");
      expect(savedBlocks[0]).toMatchObject({ children: [
        { text: "a" }, { text: "bcd", marks: ["bold"], fontSize: size }, { text: "efgh" },
      ] });
      expect(document.activeElement).toBe(input);
    }
  });

  it("restores the saved range on unchanged-size Enter without changing the document", async () => {
    const { editor, input } = await selectForToolbar();
    await act(async () => {
      editor.commands.setTextSelection(2);
    });
    expect(editor.state.selection.empty).toBe(true);
    const doc = editor.state.doc;
    const saved = structuredClone(savedBlocks);

    const detail = { command: "fontSize", value: "10.5", target: "document", focusOnly: true, restoreFocus: true, focusBlockId: null };
    await act(async () => {
      window.dispatchEvent(new CustomEvent("sigma-studio:format-text", {
        detail,
      }));
    });

    expect(detail.focusBlockId).toBe("p_before");
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.selection.to).toBe(5);
    expect(editor.state.doc).toBe(doc);
    expect(savedBlocks).toEqual(saved);
    expect(changes).toHaveLength(0);

    // Returning to the toolbar must still allow the same range to be formatted.
    await act(async () => { input.focus(); });
    await format("fontSize", "20");
    expect(savedBlocks[0]).toMatchObject({ children: [
      { text: "a" }, { text: "bcd", fontSize: 20 }, { text: "efgh" },
    ] });
  });

  it("does not resume a saved range whose document fingerprint changed", async () => {
    const { editor, input } = await selectForToolbar();
    await act(async () => {
      applyEditorDocumentProjection(editor, textFlowToTiptap([paragraph("p_before", "replacement")]));
    });
    const doc = editor.state.doc;
    const publish = vi.fn();
    window.addEventListener(TEXT_FORMAT_STATE_EVENT, publish);
    try {
      await act(async () => {
        window.dispatchEvent(new CustomEvent("sigma-studio:format-text", {
          detail: { command: "fontSize", value: "10.5", target: "document", focusOnly: true, restoreFocus: true },
        }));
      });
      expect(document.activeElement).toBe(input);
      expect(editor.state.doc).toBe(doc);
      expect(publish).not.toHaveBeenCalled();
      expect(changes).toHaveLength(0);
    } finally {
      window.removeEventListener(TEXT_FORMAT_STATE_EVENT, publish);
    }
  });

  it("acknowledges unchanged-size Enter for a live cross-editor span", async () => {
    const [{ editor }] = await renderHarness();
    const input = document.createElement("input");
    container.append(input);
    await act(async () => {
      selectEntireTextRun(editor);
      input.focus();
    });
    const span = structuredClone(getActiveTextRunSpan());
    const saved = structuredClone(savedBlocks);
    const detail = { command: "fontSize", value: "10.5", target: "document", focusOnly: true, restoreFocus: true, focusBlockId: null };
    await act(async () => {
      window.dispatchEvent(new CustomEvent("sigma-studio:format-text", { detail }));
    });
    expect(detail.focusBlockId).toBe("p_before");
    expect(document.activeElement).toBe(editor.view.dom);
    expect(getActiveTextRunSpan()).toEqual(span);
    expect(savedBlocks).toEqual(saved);
    expect(changes).toHaveLength(0);
  });

  it("keeps a whole-run selection ending in a divider through repeated font sizes", async () => {
    const editors = await renderHarness({ initialBlocks: [
      paragraph("p_before", "abcdefgh"),
      paragraph("p_after", "ijklmnop"),
      { type: "divider", id: "divider_end" },
    ] });
    await act(async () => {
      expect(selectEntireTextRun(editors[0].editor)).toBe(true);
    });
    expect(getActiveTextRunSpan()).not.toBeNull();

    for (const size of [18, 20]) {
      await format("fontSize", String(size));
      expect(getActiveTextRunSpan()).not.toBeNull();
      for (const { editor } of editors) {
        expect(editor.state.selection.empty).toBe(false);
        editor.state.doc.descendants(node => {
          if (node.isText) expect(node.marks.find(mark => mark.type.name === "styledText")?.attrs.fontSize).toBe(size);
        });
      }
      expect(savedBlocks).toMatchObject([
        { id: "p_before", children: [{ text: "abcdefgh", fontSize: size }] },
        { id: "p_after", children: [{ text: "ijklmnop", fontSize: size }] },
        { type: "divider", id: "divider_end" },
      ]);
    }
  });

  it("returns from font search without losing a cross-editor range or its next formatting target", async () => {
    const { editor, input } = await selectForToolbar();
    await act(async () => {
      editor.view.focus();
      expect(selectEntireTextRun(editor)).toBe(true);
      input.type = "search";
      input.focus();
      input.value = "Hiragino Mincho";
    });
    const span = getActiveTextRunSpan();
    expect(span).not.toBeNull();
    const selectedTexts = () => getTextRunEditors("integration-document").map(({ editor: surface }) => (
      surface.state.doc.textBetween(surface.state.selection.from, surface.state.selection.to)
    ));
    expect(selectedTexts()).toEqual(["abcdefgh", "ijklmnop"]);

    await format("fontFamily", "Hiragino Mincho ProN");
    expect(document.activeElement).toBe(editor.view.dom);
    // Formatting normalizes document boundaries to valid text positions; the text stays selected.
    expect(getActiveTextRunSpan()).toMatchObject({
      groupId: span!.groupId, anchor: { unitId: span!.anchor.unitId }, head: { unitId: span!.head.unitId },
    });
    expect(selectedTexts()).toEqual(["abcdefgh", "ijklmnop"]);
    const formattedSpan = getActiveTextRunSpan();
    await act(async () => { input.focus(); });
    await format("fontSize", "20");
    expect(document.activeElement).toBe(input);
    expect(getActiveTextRunSpan()).toEqual(formattedSpan);
    expect(selectedTexts()).toEqual(["abcdefgh", "ijklmnop"]);
    expect(savedBlocks).toMatchObject([
      { id: "p_before", children: [{ text: "abcdefgh", fontFamily: "Hiragino Mincho ProN", fontSize: 20 }] },
      { id: "p_after", children: [{ text: "ijklmnop", fontFamily: "Hiragino Mincho ProN", fontSize: 20 }] },
    ]);
    for (const { editor: surface } of getTextRunEditors("integration-document")) {
      expect(surface.state.selection.empty).toBe(false);
    }
  });

  it("invalidates saved offsets in unchanged surfaces when another selected surface changes text", async () => {
    const { editor, input } = await selectForToolbar();
    const other = getTextRunEditors("integration-document")[1].editor;
    await act(async () => {
      editor.view.focus();
      expect(selectEntireTextRun(editor)).toBe(true);
      input.focus();
    });
    expect(getActiveTextRunSpan()).not.toBeNull();
    await act(async () => {
      applyEditorDocumentProjection(other, textFlowToTiptap([paragraph("p_after", "XXijklmnop")]));
    });
    expect(getActiveTextRunSpan()).toBeNull();
    await format("bold");
    await format("fontSize", "18");
    expect(editor.getJSON().content![0].content).toEqual([{ type: "text", text: "abcdefgh" }]);
    expect(other.getJSON().content![0].content).toEqual([{ type: "text", text: "XXijklmnop" }]);
    expect(changes).toHaveLength(0);
  });
});

describe("TextFlowEditor manual page-break integration", () => {
  it("keeps an ordinary partial-text paste inline at a block end", async () => {
    const [first, second] = await renderHarness();
    const source = textRangeForBlock(second.editor, "p_after");
    second.editor.commands.setTextSelection({ from: source.from, to: source.from + "後ろの段".length });
    const clipboardData = copySelection(second.editor);
    const destination = textRangeForBlock(first.editor, "p_before");
    first.editor.commands.setTextSelection(destination.to);

    await pasteClipboard(first.editor, clipboardData);

    expect(savedBlocks.map((block) => [block.id, textOf(block), block.pagination?.break])).toEqual([
      ["p_before", "前の段落テキストです。後ろの段", undefined],
      ["p_break", "改ページ後の段落テキストです。", true],
      ["p_after", "後ろの段落テキストです。", undefined],
    ]);
  });

  it("keeps a partial-text paste inline at a manual-break owner start", async () => {
    const [, second] = await renderHarness();
    const source = textRangeForBlock(second.editor, "p_after");
    second.editor.commands.setTextSelection({ from: source.from, to: source.from + "後ろの段".length });
    const clipboardData = copySelection(second.editor);
    const destination = textRangeForBlock(second.editor, "p_break");
    second.editor.commands.setTextSelection(destination.from);

    await pasteClipboard(second.editor, clipboardData);

    expect(savedBlocks.map((block) => [block.id, textOf(block), block.pagination?.break])).toEqual([
      ["p_before", "前の段落テキストです。", undefined],
      ["p_break", "後ろの段改ページ後の段落テキストです。", true],
      ["p_after", "後ろの段落テキストです。", undefined],
    ]);
  });

  it.each([
    { name: "HTML only", clipboard: () => clipboardWith({ html: "<p>HTML貼付</p>" }), text: "HTML貼付" },
    { name: "plain text only", clipboard: () => clipboardWith({ text: "plain貼付" }), text: "plain貼付" },
    { name: "Markdown", clipboard: () => clipboardWith({ text: "**Markdown貼付**" }), text: "Markdown貼付" },
  ])("keeps $name inline at an ordinary block end", async ({ clipboard, text }) => {
    const [first] = await renderHarness();
    const destination = textRangeForBlock(first.editor, "p_before");
    first.editor.commands.setTextSelection(destination.to);

    await pasteClipboard(first.editor, clipboard());

    expect(textOf(savedBlocks[0])).toBe(`前の段落テキストです。${text}`);
    expect(savedBlocks.map((block) => block.id)).toEqual(["p_before", "p_break", "p_after"]);
  });

  it("keeps literal paste inline at an ordinary block end", async () => {
    const [first] = await renderHarness();
    const destination = textRangeForBlock(first.editor, "p_before");
    first.editor.commands.setTextSelection(destination.to);
    const shortcut = new KeyboardEvent("keydown", {
      key: "v",
      metaKey: true,
      shiftKey: true,
    });
    first.editor.view.props.handleKeyDown?.(first.editor.view, shortcut);

    await pasteClipboard(first.editor, clipboardWith({ text: "literal 貼付" }));

    expect(textOf(savedBlocks[0])).toBe("前の段落テキストです。literal 貼付");
    expect(savedBlocks.map((block) => block.id)).toEqual(["p_before", "p_break", "p_after"]);
  });

  it("preserves ordinary block structure for a two-paragraph private payload paste at a block end", async () => {
    const [first] = await renderHarness();
    const destination = textRangeForBlock(first.editor, "p_before");
    first.editor.commands.setTextSelection(destination.to);
    const clipboardData = new DataTransfer();
    writeEditorClipboardData(clipboardData, createTextFlowClipboardPayload([
      paragraph("copied_1", "貼付一"),
      paragraph("copied_2", "貼付二"),
    ]), { html: "<p>貼付一</p><p>貼付二</p>" });

    await pasteClipboard(first.editor, clipboardData);

    expect(savedBlocks.map((block) => textOf(block))).toEqual([
      "前の段落テキストです。",
      "貼付一",
      "貼付二",
      "改ページ後の段落テキストです。",
      "後ろの段落テキストです。",
    ]);
    expect(savedBlocks.find((block) => block.id === "p_break")?.pagination?.break).toBe(true);
  });

  it("keeps the large plain-text path working at an ordinary block end", async () => {
    const [first] = await renderHarness();
    const destination = textRangeForBlock(first.editor, "p_before");
    first.editor.commands.setTextSelection(destination.to);
    const text = Array.from({ length: 200 }, (_, index) => `大量貼付-${index}`).join("\n");

    await pasteClipboard(first.editor, clipboardWith({ text }));

    expect(textOf(savedBlocks[0])).toBe("前の段落テキストです。大量貼付-0");
    expect(savedBlocks.some((block) => textOf(block) === "大量貼付-199")).toBe(true);
    expect(savedBlocks.find((block) => block.id === "p_break")?.pagination?.break).toBe(true);
  });

  it("keeps a complete one-paragraph copy inline at a manual-break owner start", async () => {
    const [, second] = await renderHarness();
    const source = textRangeForBlock(second.editor, "p_after");
    second.editor.commands.setTextSelection(source);
    const clipboardData = copySelection(second.editor);
    const destination = textRangeForBlock(second.editor, "p_break");
    second.editor.commands.setTextSelection(destination.from);

    await pasteClipboard(second.editor, clipboardData);

    expect(textOf(savedBlocks.find((block) => block.id === "p_break")!))
      .toBe("後ろの段落テキストです。改ページ後の段落テキストです。");
    expect(savedBlocks.find((block) => block.id === "p_break")?.pagination?.break).toBe(true);
  });

  it.each([
    { operation: "Backspace", replacement: "" },
    { operation: "Delete", replacement: "" },
    { operation: "text input", replacement: "入" },
    { operation: "paste", replacement: "貼付一貼付二" },
    { operation: "Cut", replacement: "" },
  ])("applies both public span mutations for $operation without losing unselected text", async ({
    operation,
    replacement,
  }) => {
    const [first] = await renderHarness();
    first.editor.commands.setTextSelection({
      from: 1 + "前の".length,
      to: first.editor.state.doc.content.size - 1,
    });

    const extendRight = () => handleTextRunSpanKeyDown(
      new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true }),
      first.editor.view.dom,
    );
    // 1 回目で次ユニット先頭へ移り、続く 5 回で「改ページ後」を選ぶ。
    for (let index = 0; index < 6; index += 1) {
      expect(extendRight()).toBe(true);
    }

    await act(async () => {
      if (operation === "text input") {
        expect(handleTextRunSpanTextInput(first.editor.view.dom, replacement)).toBe(true);
      } else if (operation === "paste") {
        const clipboardData = new DataTransfer();
        writeEditorClipboardData(clipboardData, createTextFlowClipboardPayload([
          paragraph("span_paste_1", "貼付一"),
          paragraph("span_paste_2", "貼付二"),
        ]));
        const event = new ClipboardEvent("paste", { clipboardData, cancelable: true });
        expect(first.editor.view.someProp("handlePaste", (handler) => (
          handler(first.editor.view, event, first.editor.state.doc.slice(0, 0))
        ))).toBe(true);
      } else if (operation === "Cut") {
        const event = new ClipboardEvent("cut", {
          bubbles: true,
          cancelable: true,
          clipboardData: new DataTransfer(),
        });
        expect(first.editor.view.dom.dispatchEvent(event)).toBe(false);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      } else {
        expect(handleTextRunSpanKeyDown(
          new KeyboardEvent("keydown", { key: operation }),
          first.editor.view.dom,
        )).toBe(true);
      }
    });

    expect(changes.map((change) => change.previousIds)).toEqual([
      ["p_before"],
      ["p_break", "p_after"],
    ]);
    expect(changes[0].context?.historyGroup).toBe(changes[1].context?.historyGroup);
    expect(savedBlocks.map((block) => [block.id, textOf(block), block.pagination?.break])).toEqual([
      ["p_before", `前の${replacement.startsWith("貼付") ? "貼付一" : replacement}`, undefined],
      ...(replacement.startsWith("貼付")
        ? [[expect.any(String), "貼付二", undefined]]
        : []),
      ["p_break", "の段落テキストです。", true],
      ["p_after", "後ろの段落テキストです。", undefined],
    ]);
    const rendered = Array.from(container.querySelectorAll<HTMLElement>(".ProseMirror [data-sigma-doc-id]"))
      .map((node) => [node.dataset.sigmaDocId, node.textContent]);
    expect(new Set(rendered.map(([id]) => id)).size).toBe(rendered.length);
  });

  it("moves an owner-start block paste behind the break through the real handlePaste path", async () => {
    const [, second] = await renderHarness();
    second.editor.commands.setTextSelection(1);
    const clipboardData = new DataTransfer();
    writeEditorClipboardData(clipboardData, createTextFlowClipboardPayload([
      paragraph("copied_1", "貼付一"),
      paragraph("copied_2", "貼付二"),
    ]));
    const event = new ClipboardEvent("paste", { clipboardData, cancelable: true });
    const slice = second.editor.state.doc.slice(0, 0);

    await act(async () => {
      const handled = second.editor.view.someProp("handlePaste", (handler) => (
        handler(second.editor.view, event, slice)
      ));
      expect(handled).toBe(true);
    });

    expect(savedBlocks.map((block) => [block.id, textOf(block), block.pagination?.break])).toMatchObject([
      ["p_before", "前の段落テキストです。", undefined],
      [expect.any(String), "貼付一", true],
      [expect.any(String), "貼付二", undefined],
      ["p_break", "改ページ後の段落テキストです。", undefined],
      ["p_after", "後ろの段落テキストです。", undefined],
    ]);
  });

  it("removes a marker on mousedown and does not let the immediate PM round trip restore it", async () => {
    await renderHarness();
    const button = container.querySelector<HTMLButtonElement>(".page-break-marker-remove");
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        cancelable: true,
        detail: 1,
      }));
    });

    expect(savedBlocks.find((block) => block.id === "p_break")?.pagination?.break).not.toBe(true);
    expect(container.querySelector(".page-break-marker-remove")).toBeNull();
  });
});
