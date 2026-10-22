// @vitest-environment happy-dom
import { act, useLayoutEffect, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";

import type { SigmaCommentAnchor } from "@/features/document";
import type { OverlayShape } from "@/components/editor/overlay-canvas/types";
import type { OverlayModeStatus, OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import { createBlankDocument } from "@/lib/blank-document";

import { registerCaretSurface, type CaretSurfaceHandle } from "../text-flow/caret-router";
import type { PageCanvasSelectionExtension } from "./editor-extension";
import { usePageCanvasSelectionActions } from "./use-page-canvas-selection";

const shape = { id: "shape-1", type: "geo", x: 300, y: 400, props: { w: 100, h: 50, geo: "rectangle" } } as unknown as OverlayShape;
const selection = { selectedCount: 1, selectedShapeIds: ["shape-1"], selectedShapes: [shape] } as unknown as OverlaySelectionSummary;
const extension: PageCanvasSelectionExtension = { createAction: () => ({ key: "ai", render: () => null }) };
const document_ = createBlankDocument();

let root: Root;
let owner: ReturnType<typeof usePageCanvasSelectionActions>;
const canvas = document.createElement("div");
canvas.getBoundingClientRect = () => new DOMRect(0, 0, 2000, 4000);
const canvasRef: RefObject<HTMLDivElement | null> = { current: canvas };

function Probe({ suppressed, status = null, widthPx, selected = selection, math = null, layoutRevision = 1, selectionExtension = extension, comments = false, selectedId = null, overlayEditing = !math, blockHandleSelected, onCandidate, sigmaDocument = document_ }: {
  sigmaDocument?: typeof document_;
  suppressed: boolean;
  selectedId?: string | null;
  overlayEditing?: boolean;
  blockHandleSelected?: boolean;
  onCandidate?: (anchor: SigmaCommentAnchor | null) => void;
  status?: OverlayModeStatus | null;
  widthPx?: number;
  selected?: OverlaySelectionSummary;
  math?: { id: string; tex: string; blockId: string; getCanonicalTex?: () => string } | null;
  selectionExtension?: PageCanvasSelectionExtension;
  comments?: boolean;
  layoutRevision?: number;
}) {
  const current = usePageCanvasSelectionActions({
    overlaySelection: selected,
    suppressSelectionActions: suppressed,
    pageOverlayEditing: overlayEditing,
    selectionExtension,
    selectedId,
    document: sigmaDocument,
    bodyOverlayModeStatus: status,
    overlayCommentAnchor: null,
    canvasRef,
    zoom: 100,
    isWhiteboard: true,
    whiteboardPanX: 0,
    whiteboardPanY: 0,
    onCommentAnchorCandidateChange: onCandidate,
    isOverlayEditing: overlayEditing,
    onCommentAnchorRequest: comments ? () => {} : undefined,
    renderSelectionActions: undefined,
    selectedInlineMath: math,
    totalHeight: 4000,
    layoutRevision,
    overlayPopoverWidthPx: widthPx,
    blockHandleSelected,
  });
  useLayoutEffect(() => { owner = current; });
  return null;
}

async function render(props: Parameters<typeof Probe>[0]) {
  await act(async () => {
    root.render(<Probe {...props} />);
    // ポップオーバーの位置は次のフレームで測る。
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
});
afterEach(async () => { await act(async () => root.unmount()); });

it("gives floating content the shape popover's area only while the popover is shown", async () => {
  await render({ suppressed: false });
  expect(owner.selectionActionPopover).not.toBeNull();
  expect(owner.selectionControlsRect).toMatchObject({ y: 400 - 80, h: 80 });

  // ⌘K を開いている間 (ポップオーバーを出さない) は、見えない帯を避けない。
  await render({ suppressed: true });
  expect(owner.selectionActionPopover).toBeNull();
  expect(owner.selectionControlsRect).toBeNull();

  // 画像の切り抜き中もポップオーバーは出ない。
  await render({ suppressed: false, status: { id: "overlay.imageCropping" } as OverlayModeStatus });
  expect(owner.selectionControlsRect).toBeNull();
});

it("spans the shape popover's measured width and keeps the same rect while nothing moves", async () => {
  await render({ suppressed: false, widthPx: 480 });
  const first = owner.selectionControlsRect;
  expect(first).toMatchObject({ x: 350 - 240, w: 480 });

  // 選択の要約が作り直されても (同じ図形・同じ位置)、同じ矩形を渡す。
  await render({ suppressed: false, widthPx: 480, selected: { ...selection } });
  expect(owner.selectionControlsRect).toBe(first);
});

it("reanchors selected math after a committed layout changes position without changing height", async () => {
  const node = document.createElement("span");
  node.className = "inline-math-node";
  node.dataset.id = "m1";
  let top = 220;
  node.getBoundingClientRect = () => new DOMRect(400, top, 40, 25);
  canvas.append(node);
  const math = { id: "m1", tex: "x", blockId: "p1" };
  try {
    await render({ suppressed: false, math, layoutRevision: 1 });
    expect(owner.selectionActionPopover?.position.top).toBe(174);
    top = 360;
    await render({ suppressed: false, math, layoutRevision: 2 });
    expect(owner.selectionActionPopover?.position.top).toBe(314);
    top = 440;
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(owner.selectionActionPopover?.position.top).toBe(394);
    top = 520;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(owner.selectionActionPopover?.position.top).toBe(474);
  } finally {
    node.remove();
  }
});

it("hands a retained range back to the editing math's current draft", async () => {
  const block = document.createElement("p");
  block.dataset.sigmaDocId = "p1";
  const node = document.createElement("span");
  node.className = "inline-math-node";
  node.dataset.id = "m1";
  node.dataset.sigmaDocMathInline = "";
  node.dataset.tex = "old";
  node.textContent = "old";
  node.getBoundingClientRect = () => new DOMRect(400, 220, 40, 25);
  block.append(node); canvas.append(block); document.body.append(canvas);
  let draft = "old";
  const math = { id: "m1", tex: "old", blockId: "p1", getCanonicalTex: () => draft };
  const selectionExtension: PageCanvasSelectionExtension = {
    createAction: (source) => ({ key: source.kind, render: () => null }),
  };
  try {
    await render({ suppressed: false, math, selectionExtension, comments: true });
    const range = document.createRange();
    range.selectNode(node);
    range.getClientRects = () => [node.getBoundingClientRect()] as unknown as DOMRectList;
    range.getBoundingClientRect = () => node.getBoundingClientRect();
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(owner.selectionActionPopover?.extensionAction?.key).toBe("textRange");
    node.classList.add("editing");
    draft = String.raw`\boldsymbol{new}`;
    await render({ suppressed: false, math: { ...math, tex: "new" }, selectionExtension, comments: true });
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await render({ suppressed: false, math: { ...math, tex: "new" }, selectionExtension, comments: true });
    expect(owner.selectionActionPopover?.extensionAction?.key).toBe("inlineMath");
    expect(owner.selectionActionPopover?.commentAnchor).toMatchObject({ type: "inlineMath", tex: draft, quote: `$${draft}$` });
  } finally {
    window.getSelection()!.removeAllRanges(); block.remove(); canvas.remove();
  }
});

// カーソルを置いただけでは何も浮かべない。画像などを丸ごと選んだとき・つまみで選んだブロックは今までどおり。
const bodySchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", attrs: { sigmaDocId: { default: "" } } },
    figure: { group: "block", atom: true, selectable: true, attrs: { sigmaDocId: { default: "" } } },
    text: {},
  },
});
const bodyState = () => EditorState.create({
  doc: bodySchema.node("doc", null, [
    bodySchema.node("paragraph", { sigmaDocId: "p1" }, [bodySchema.text("hello world")]),
    bodySchema.node("figure", { sigmaDocId: "fig1" }),
    bodySchema.node("paragraph", { sigmaDocId: "p2" }, [bodySchema.text("second")]),
  ]),
});
const trailingAnchor = () => (owner.selectionActionPopover?.position as { trailing?: unknown } | undefined)?.trailing;
const caretAt = (position: number) => {
  const state = bodyState();
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, position)));
};
const nodeSelected = () => {
  const state = bodyState();
  return state.apply(state.tr.setSelection(NodeSelection.create(state.doc, state.doc.child(0).nodeSize)));
};

async function withBodyBlocks(run: (editor: { state: EditorState }) => Promise<void>, state: EditorState) {
  const paragraph = document.createElement("p");
  paragraph.dataset.sigmaDocId = "p1";
  paragraph.getBoundingClientRect = () => new DOMRect(100, 200, 400, 24);
  const figure = document.createElement("div");
  figure.dataset.sigmaDocId = "fig1";
  figure.getBoundingClientRect = () => new DOMRect(100, 300, 200, 100);
  const view = document.createElement("div");
  view.append(paragraph, figure);
  canvas.append(view);
  document.body.append(canvas);
  const editor = { isDestroyed: false, isFocused: true, state, view: { dom: view, hasFocus: () => true } };
  const unregister = registerCaretSurface({ editor: editor as unknown as Editor, addressAt: () => null } as unknown as CaretSurfaceHandle);
  try {
    await run(editor);
  } finally {
    unregister();
    view.remove();
    canvas.remove();
  }
}

const bodyDocument = { ...document_, content: [
  { type: "paragraph", id: "p1", children: [{ type: "text", text: "hello world" }] },
  { type: "paragraph", id: "fig1", children: [{ type: "text", text: "" }] },
  { type: "paragraph", id: "p2", children: [{ type: "text", text: "second" }] },
] } as typeof document_;

it("floats no AI/comment chip for a caret alone, but still offers the block as the comment candidate", async () => {
  const candidates: Array<SigmaCommentAnchor | null> = [];
  await withBodyBlocks(async () => {
    const props = { suppressed: false, sigmaDocument: bodyDocument, selectedId: "p1", overlayEditing: false, comments: true, onCandidate: (anchor: SigmaCommentAnchor | null) => candidates.push(anchor) };
    await render(props);
    expect(owner.selectionActionPopover).toBeNull();
    // コメント欄の「コメントを追加」は、カーソルのあるブロックを付け先にする (浮かぶ操作だけを消す)。
    expect(candidates.at(-1)).toMatchObject({ type: "block", blockId: "p1" });
  }, caretAt(3));
});

it("keeps the trailing chip for a whole-block (node) selection and for a block picked with the handle", async () => {
  await withBodyBlocks(async () => {
    await render({ suppressed: false, sigmaDocument: bodyDocument, selectedId: "fig1", overlayEditing: false, comments: true });
    expect(owner.selectionActionPopover?.extensionAction?.key).toBe("ai");
    expect(trailingAnchor()).toBeDefined();
    expect(owner.selectionActionPopover?.commentAnchor).toMatchObject({ type: "block", blockId: "fig1" });
  }, nodeSelected());

  // つまみで選ぶとフォーカスは外れるが、編集面の選択はカーソルのまま残る。それでもチップは出す。
  await withBodyBlocks(async () => {
    await render({ suppressed: false, sigmaDocument: bodyDocument, selectedId: "p1", overlayEditing: false, comments: true });
    expect(owner.selectionActionPopover).toBeNull();
    await render({ suppressed: false, sigmaDocument: bodyDocument, selectedId: "p1", overlayEditing: false, comments: true, blockHandleSelected: true });
    expect(trailingAnchor()).toBeDefined();
    await render({ suppressed: false, sigmaDocument: bodyDocument, selectedId: "p1", overlayEditing: false, comments: true, blockHandleSelected: false });
    expect(owner.selectionActionPopover).toBeNull();
  }, caretAt(3));
});

it("re-reads the editor selection when it moves without the selected block changing", async () => {
  await withBodyBlocks(async (editor) => {
    await render({ suppressed: false, sigmaDocument: bodyDocument, selectedId: "p1", overlayEditing: false, comments: true });
    expect(owner.selectionActionPopover).toBeNull();
    // 同じ p1 を選んだまま、カーソルが別のブロックへ移った (選んだブロックはカーソルのあるブロックではなくなる)。
    editor.state = caretAt(20);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(trailingAnchor()).toBeDefined();
    // カーソルが p1 へ戻れば、また浮かべない。
    editor.state = caretAt(2);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(owner.selectionActionPopover).toBeNull();
  }, caretAt(3));
});
