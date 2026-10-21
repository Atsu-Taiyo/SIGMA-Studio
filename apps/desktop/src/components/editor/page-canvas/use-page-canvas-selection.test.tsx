// @vitest-environment happy-dom
import { act, useLayoutEffect, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { OverlayShape } from "@/components/editor/overlay-canvas/types";
import type { OverlayModeStatus, OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import { createBlankDocument } from "@/lib/blank-document";

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

function Probe({ suppressed, status = null, widthPx, selected = selection, math = null, layoutRevision = 1, selectionExtension = extension, comments = false }: {
  suppressed: boolean;
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
    pageOverlayEditing: !math,
    selectionExtension,
    selectedId: null,
    document: document_,
    bodyOverlayModeStatus: status,
    overlayCommentAnchor: null,
    canvasRef,
    zoom: 100,
    isWhiteboard: true,
    whiteboardPanX: 0,
    whiteboardPanY: 0,
    onCommentAnchorCandidateChange: undefined,
    isOverlayEditing: !math,
    onCommentAnchorRequest: comments ? () => {} : undefined,
    renderSelectionActions: undefined,
    selectedInlineMath: math,
    totalHeight: 4000,
    layoutRevision,
    overlayPopoverWidthPx: widthPx,
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
