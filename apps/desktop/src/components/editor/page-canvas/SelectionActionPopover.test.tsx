// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SelectionActionPopover } from "./SelectionActionPopover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
it("keeps selection tools inside the editor viewport when the pocket opens above it", async () => {
  const viewport = document.createElement("div");
  viewport.className = "editor-canvas";
  document.body.append(viewport);
  let viewportTop = 200;
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, viewportTop, 900, 600));
  const root = createRoot(viewport);
  const render = (top: number) => <SelectionActionPopover popover={{
    position: { left: 40, top }, commentAnchor: null,
    extensionAction: { key: "format", renderTools: () => <button>Bold</button> },
  }} />;
  try {
    await act(async () => root.render(render(180)));
    const toolbar = viewport.querySelector<HTMLElement>(".selection-action-popover")!;
    expect(toolbar.style.top).toBe("212px");
    viewportTop = 288;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(toolbar.style.top).toBe("300px");
    await act(async () => root.render(render(400)));
    expect(toolbar.style.top).toBe("400px");
  } finally { await act(async () => root.unmount()); }
});

it("places the text formatting card below the selected text and flips above only near the viewport bottom", async () => {
  const viewport = document.createElement("div");
  viewport.className = "editor-canvas";
  document.body.append(viewport);
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 900, 600));
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
  const root = createRoot(viewport);
  const render = (selectionTop: number, selectionBottom: number) => <SelectionActionPopover popover={{
    position: {
      left: 40,
      top: selectionTop - 46,
      anchor: { top: selectionTop, bottom: selectionBottom, clearance: 8 },
      trailing: { right: 300, bottom: selectionBottom, top: selectionTop, limitRight: 800, limitBottom: 588 },
    },
    commentAnchor: null,
    extensionAction: { key: "format", renderTools: () => <button>Bold</button> },
  }} />;
  try {
    await act(async () => root.render(render(200, 220)));
    const toolbar = viewport.querySelector<HTMLElement>(".selection-action-popover")!;
    expect(toolbar.style.top).toBe("228px");
    await act(async () => root.render(render(500, 520)));
    expect(toolbar.style.top).toBe("392px");
  } finally { await act(async () => root.unmount()); }
});

it("places the shape card at the bottom-right of the pointer and flips near the viewport edges", async () => {
  const viewport = document.createElement("div");
  viewport.className = "editor-canvas";
  document.body.append(viewport);
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 900, 600));
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(900);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
  const root = createRoot(viewport);
  const reportBounds = vi.fn();
  const render = (x: number, y: number) => <SelectionActionPopover popover={{
    // 図形の上下 (anchor) は画面の外にあっても、マウスの近くに出す。
    position: { left: x + 12, top: y + 16, pointer: { x, y }, anchor: { top: -2000, bottom: 3000, clearance: 42 } },
    commentAnchor: null,
    extensionAction: { key: "shape", renderTools: () => <button>Fill</button> },
  }} onBoundsChange={reportBounds} />;
  try {
    await act(async () => root.render(render(300, 200)));
    const card = viewport.querySelector<HTMLElement>(".selection-action-popover")!;
    expect([card.style.left, card.style.top]).toEqual(["312px", "216px"]);
    await act(async () => root.render(render(800, 550)));
    expect([card.style.left, card.style.top]).toEqual(["588px", "434px"]);
    expect(reportBounds).toHaveBeenLastCalledWith({ left: 588, top: 434, width: 200, height: 100 });
  } finally { await act(async () => root.unmount()); }
});

it.each([true, false])("keeps the card visible when neither side has room (preferBelow=%s)", async (preferBelow) => {
  const viewport = document.createElement("div");
  viewport.className = "editor-canvas";
  document.body.append(viewport);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 900, 400));
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
  const root = createRoot(viewport);
  try {
    await act(async () => root.render(<SelectionActionPopover popover={{
      position: { left: 40, top: 80, anchor: { top: 126, bottom: 470, clearance: 8 } },
      preferBelow,
      commentAnchor: null,
      extensionAction: { key: "format", renderTools: () => <button>Bold</button> },
    }} />));
    const card = viewport.querySelector<HTMLElement>(".selection-action-popover")!;
    expect(card.style.top).toBe("388px");
  } finally { await act(async () => root.unmount()); }
});

it("reports the visible rotate-handle clearance when a keyboard shape card is shifted up", async () => {
  const viewport = document.createElement("div");
  viewport.className = "editor-canvas";
  document.body.append(viewport);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 900, 400));
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
  const root = createRoot(viewport);
  const reportBounds = vi.fn();
  try {
    await act(async () => root.render(<SelectionActionPopover popover={{
      position: { left: 40, top: 450, anchor: { top: 538, bottom: 600, clearance: 42 } },
      commentAnchor: null,
      extensionAction: { key: "shape", renderTools: () => <button>Fill</button> },
    }} onBoundsChange={reportBounds} />));
    expect(reportBounds).toHaveBeenLastCalledWith({ left: 40, top: 388, width: 200, height: 112 });
  } finally { await act(async () => root.unmount()); }
});
