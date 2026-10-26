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
