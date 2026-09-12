// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FloatingEditorToolbar } from "./floating-editor-toolbar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { vi.unstubAllGlobals(); });

describe("floating editor toolbar ownership", () => {
  it.each([false, true])("keeps the toolbar in its UI host and releases observers (modal: %s)", async (modal) => {
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect = disconnect;
    });
    const host = document.createElement("div");
    if (modal) host.setAttribute("data-modal-backdrop", "");
    const anchor = document.createElement("div");
    const mount = document.createElement("div");
    host.append(anchor, mount);
    document.body.append(host);
    const anchorRef = createRef<HTMLElement>();
    anchorRef.current = anchor;
    const root = createRoot(mount);
    try {
      await act(async () => root.render(
        <FloatingEditorToolbar anchorRef={anchorRef} position={{ x: -100, y: -100 }} className="test-floating-toolbar">
          <button>設定</button>
        </FloatingEditorToolbar>,
      ));
      const toolbar = document.querySelector<HTMLElement>(".test-floating-toolbar")!;
      expect(toolbar.parentElement).toBe(modal ? host : document.body);
      expect(anchor.contains(toolbar)).toBe(false);
      expect(toolbar.style.left).toBe("8px");
      expect(toolbar.style.top).toBe("8px");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
    expect(document.querySelector(".test-floating-toolbar")).toBeNull();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
