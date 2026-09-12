// @vitest-environment happy-dom

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/core";

import {
  TextFlowEditor,
  type TextFlowChangeContext,
} from "@/components/editor/TextFlowEditor";
import {
  clearTextRunSpan,
  getTextRunEditors,
  handleTextRunSpanKeyDown,
  handleTextRunSpanTextInput,
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

function Harness(): React.JSX.Element {
  const [blocks, setBlocks] = useState<TextFlowBlock[]>(INITIAL_BLOCKS);
  useEffect(() => {
    savedBlocks = blocks;
  }, [blocks]);
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
  const before = blocks.filter((block) => block.id === "p_before");
  const after = blocks.filter((block) => block.id !== "p_before");

  return <>
    <TextFlowEditor
      blocks={before}
      selectedId={null}
      historyRevision={0}
      onSelect={() => {}}
      onChange={apply}
      textRunGroupId="integration-document"
      textRunOrder={0}
      textRunUnitId="unit-before"
      textRunScopeId="document"
    />
    <TextFlowEditor
      blocks={after}
      selectedId={null}
      historyRevision={0}
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

async function renderHarness(): Promise<ReturnType<typeof getTextRunEditors>> {
  await act(async () => {
    root.render(<Harness />);
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
