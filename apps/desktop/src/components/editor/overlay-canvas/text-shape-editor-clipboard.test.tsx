// @vitest-environment happy-dom

import { act } from "react";
import type { Editor } from "@tiptap/core";
import { DOMSerializer, Fragment } from "@tiptap/pm/model";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InlineNode, OverlayShape, OverlayTextBlock } from "@/features/document";
import { textFlowBlockToTiptapNode } from "@/components/editor/text-flow/tiptap-document-adapter";
import {
  createTextFlowClipboardPayload,
  readEditorClipboardPayload,
  writeEditorClipboardData,
} from "@/lib/editor-clipboard";

import { OverlayTextShapeEditor } from "./text-shape-editor";

/**
 * 図中テキストのコピー・貼り付けは本文と同じ関数を通る。本文でコピーした枠付きの数式が、貼り付け先が
 * 図中テキストでも数式のまま戻ること、図中テキストでコピーしたものが本文と同じ payload になることを固定する。
 */
let container: HTMLDivElement;
let root: Root;
let editor: Editor;
let lastBlocks: OverlayTextBlock[];

const BOXED_MATH: InlineNode = {
  type: "mathInline",
  id: "m_source",
  tex: "0<|x|<1",
  display: "inline",
  marks: ["boxed"],
  semanticRole: "expression",
};
const COPIED_BLOCKS = [{
  type: "paragraph" as const,
  id: "p_source",
  children: [
    { type: "text", text: "は明らか. " },
    BOXED_MATH,
    { type: "text", text: "となる", marks: ["boxed"] },
  ] as InlineNode[],
}];

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  lastBlocks = [];

  const shape: Extract<OverlayShape, { type: "text" }> = {
    id: "text_clipboard",
    type: "text",
    x: 0,
    y: 0,
    props: {
      w: 320,
      h: 32,
      color: "#111827",
      size: "m",
      blocks: [{ type: "paragraph", id: "p_target", children: [{ type: "text", text: "図" }] }],
    },
  };
  await act(async () => {
    root.render(
      <OverlayTextShapeEditor
        shape={shape}
        externalRevision={0}
        editing={false}
        onFocus={vi.fn()}
        onCancel={vi.fn()}
        onMeasuredHeight={vi.fn()}
        onChange={(_shapeId, blocks) => { lastBlocks = blocks; }}
      />,
    );
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  });
  // Tiptap は編集面の DOM に自分自身を載せる。happy-dom は焦点イベントを出さないので onFocus では拾えない。
  editor = (container.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null)?.editor as Editor;
  expect(editor).toBeDefined();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/** 本文のコピーと同じ形: SigmaDoc ブロックの payload に、選択範囲を直列化した HTML を添える。 */
function bodyCopy(): DataTransfer {
  const paragraph = editor.schema.nodeFromJSON(textFlowBlockToTiptapNode(COPIED_BLOCKS[0]));
  const wrapper = document.createElement("div");
  wrapper.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(Fragment.from(paragraph)));
  const clipboardData = new DataTransfer();
  writeEditorClipboardData(clipboardData, createTextFlowClipboardPayload(COPIED_BLOCKS), { html: wrapper.innerHTML });
  return clipboardData;
}

function paste(clipboardData: DataTransfer): void {
  act(() => {
    editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  });
}

function pastedChildren(): InlineNode[] {
  const [first] = lastBlocks;
  return first && "children" in first ? first.children as InlineNode[] : [];
}

function boxedMathNodes(children: InlineNode[]) {
  return children.filter((child) => child.type === "mathInline" && child.marks?.includes("boxed"));
}

describe("OverlayTextShapeEditor clipboard", () => {
  it("pastes a body copy as boxed math, not as its rendered glyphs", () => {
    editor.commands.focus("end");

    paste(bodyCopy());

    const children = pastedChildren();
    expect(boxedMathNodes(children)).toMatchObject([{ tex: "0<|x|<1" }]);
    expect(children.map((child) => child.type === "text" ? child.text : `$${(child as { tex: string }).tex}$`).join(""))
      .toBe("図は明らか. $0<|x|<1$となる");
  });

  it("pastes the HTML alone (a cut, or another surface's copy) as boxed math too", () => {
    editor.commands.focus("end");
    const source = editor.schema.nodes.paragraph.create(null, [
      editor.schema.text("は明らか. "),
      editor.schema.nodes.mathInline.create(
        { id: "m_html", tex: "0<|x|<1" },
        null,
        [editor.schema.mark("boxed", { math: true })],
      ),
    ]);
    const wrapper = document.createElement("div");
    wrapper.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(Fragment.from(source)));
    // ProseMirror の copy / cut は先頭の要素に `data-pm-slice` を付ける。
    wrapper.firstElementChild?.setAttribute("data-pm-slice", "1 1 []");
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/html", wrapper.innerHTML);
    clipboardData.setData("text/plain", "は明らか. $0<|x|<1$");

    paste(clipboardData);

    expect(boxedMathNodes(pastedChildren())).toMatchObject([{ tex: "0<|x|<1" }]);
  });

  it("keeps a plain-text paste literal on Cmd+Shift+V", () => {
    editor.commands.focus("end");
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "v", metaKey: true, shiftKey: true, bubbles: true }));

    paste(bodyCopy());

    const children = pastedChildren();
    expect(boxedMathNodes(children)).toEqual([]);
  });

  it("copies a selection as the same SigmaDoc payload the body writes", () => {
    editor.commands.setContent({
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { sigmaDocId: "p_copy", sigmaDocType: "paragraph" },
        content: [
          { type: "text", text: "は明らか. " },
          { type: "mathInline", attrs: { id: "m_copy", tex: "0<|x|<1" }, marks: [{ type: "boxed", attrs: { math: true } }] },
        ],
      }],
    });
    editor.commands.selectAll();
    const clipboardData = new DataTransfer();

    editor.view.dom.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));

    const payload = readEditorClipboardPayload(clipboardData);
    expect(payload?.kind).toBe("textFlowBlocks");
    const [block] = payload?.kind === "textFlowBlocks" ? payload.blocks : [];
    expect(block && "children" in block ? boxedMathNodes(block.children as InlineNode[]) : []).toMatchObject([{ tex: "0<|x|<1" }]);
    expect(clipboardData.getData("text/plain")).toBe("は明らか. $0<|x|<1$");
  });
});
