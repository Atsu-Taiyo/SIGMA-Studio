// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as desktop from "@/lib/desktop-bridge";
import type { DesktopAPI } from "@/types/desktop";
import { useDesktopMenuActions, type DesktopMenuActionOptions } from "./use-desktop-menu-actions";

let root: Root;
let container: HTMLDivElement;
let menuListener: Parameters<DesktopAPI["onMenuAction"]>[0];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "execCommand");
});

function Probe({ options }: { options: DesktopMenuActionOptions }) {
  useDesktopMenuActions(options);
  return null;
}

function render(options: DesktopMenuActionOptions) {
  act(() => root.render(<Probe options={options} />));
}

function fixture() {
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((listener: typeof menuListener) => { menuListener = listener; return unsubscribe; });
  vi.spyOn(desktop, "getDesktopBridge").mockReturnValue({ onMenuAction: subscribe } as unknown as DesktopAPI);
  const options: DesktopMenuActionOptions = {
    isDesktopApp: true, isModalSurfaceOpen: false, isImeCompositionActive: vi.fn(() => false),
    runShortcutCommandRef: { current: vi.fn() },
    createDocumentTab: vi.fn(), openDocumentViaDesktop: vi.fn(), exportJson: vi.fn(), openPrintPreview: vi.fn(),
    setDesktopSettingsUpdateCheckRequest: vi.fn(), setDesktopSettingsOpen: vi.fn(),
  };
  return { options, subscribe, unsubscribe };
}

describe("desktop menu action subscription", () => {
  it("keeps one subscription across rerenders while delivering the latest completed actions", () => {
    const f = fixture();
    render(f.options);
    const newCreate = vi.fn();
    const newOpen = vi.fn();
    render({ ...f.options, createDocumentTab: newCreate, openDocumentViaDesktop: newOpen });
    act(() => {
      menuListener("new-document");
      menuListener("open-document");
      menuListener("save-document");
      menuListener("print-document");
    });
    expect(f.subscribe).toHaveBeenCalledOnce();
    expect(f.options.createDocumentTab).not.toHaveBeenCalled();
    expect(f.options.openDocumentViaDesktop).not.toHaveBeenCalled();
    expect(newCreate).toHaveBeenCalledOnce();
    expect(newOpen).toHaveBeenCalledOnce();
    expect(f.options.exportJson).toHaveBeenCalledOnce();
    expect(f.options.openPrintPreview).toHaveBeenCalledOnce();
    render({ ...f.options, isDesktopApp: false });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not subscribe in the browser and installs handlers before the desktop subscription can emit", () => {
    const f = fixture();
    render({ ...f.options, isDesktopApp: false });
    expect(f.subscribe).not.toHaveBeenCalled();
    f.subscribe.mockImplementation((listener) => { listener("new-document"); return f.unsubscribe; });
    render(f.options);
    expect(f.options.createDocumentTab).toHaveBeenCalledOnce();
  });

  it("uses the current history ref and preserves modal and IME suppression", () => {
    const f = fixture();
    render(f.options);
    const latestHistory = vi.fn();
    f.options.runShortcutCommandRef.current = latestHistory;
    act(() => { menuListener("undo"); menuListener("redo"); });
    expect(latestHistory.mock.calls).toEqual([["edit.undo"], ["edit.redo"]]);

    render({ ...f.options, isModalSurfaceOpen: true });
    act(() => menuListener("undo"));
    render({ ...f.options, isImeCompositionActive: () => true });
    act(() => menuListener("redo"));
    expect(latestHistory).toHaveBeenCalledTimes(2);
  });

  it("delivers focused field undo inside a modal without changing document history", () => {
    const f = fixture();
    render({ ...f.options, isModalSurfaceOpen: true });
    const input = document.createElement("textarea");
    container.appendChild(input);
    input.focus();
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    act(() => { menuListener("undo"); menuListener("redo"); });
    expect(execCommand.mock.calls).toEqual([["undo"], ["redo"]]);
    expect(f.options.runShortcutCommandRef.current).not.toHaveBeenCalled();
  });

  it("opens settings with a reset request and increments explicit update-check requests", () => {
    const f = fixture();
    render(f.options);
    act(() => { menuListener("open-settings"); menuListener("check-updates"); });
    const requests = vi.mocked(f.options.setDesktopSettingsUpdateCheckRequest).mock.calls;
    expect(requests[0][0]).toBe(0);
    const increment = requests[1][0];
    expect(typeof increment).toBe("function");
    if (typeof increment !== "function") throw new Error("Expected an update callback");
    expect(increment(5)).toBe(6);
    expect(f.options.setDesktopSettingsOpen).toHaveBeenNthCalledWith(1, true);
    expect(f.options.setDesktopSettingsOpen).toHaveBeenNthCalledWith(2, true);
  });
});
