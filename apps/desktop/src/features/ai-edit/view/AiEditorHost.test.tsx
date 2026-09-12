// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAiSurface } from "@/lib/ai/ai-surface";
import { AiEditorHost, type AiEditorHostProps } from "./AiEditorHost";

let root: Root;
let container: HTMLDivElement;
let scroller: HTMLDivElement;
let props: Omit<AiEditorHostProps, "children">;
let mounts: number;
let unmounts: number;

function PanelProbe() {
  useEffect(() => { mounts += 1; return () => { unmounts += 1; }; }, []);
  return <div data-panel=""><textarea /><button type="button">control</button><span data-chrome="">chrome</span></div>;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mounts = 0;
  unmounts = 0;
  container = document.createElement("div");
  scroller = document.createElement("div");
  document.body.append(container, scroller);
  root = createRoot(container);
  scroller.scrollBy = vi.fn();
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
  props = {
    enabled: true,
    displayMode: "inline",
    surface: resolveAiSurface({ displayMode: "inline", aiInlineOpen: true, aiSidebarOpen: false }),
    inlineOpen: true,
    inlineClosing: false,
    inlineAnchor: { left: 100, top: 160 },
    inlineRunAnchor: null,
    inlineSessionId: 1,
    editorCanvasRef: { current: scroller },
    closeLabel: "AIチャットを閉じる",
    onClose: vi.fn(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  scroller.remove();
  document.body.style.cursor = "";
  vi.restoreAllMocks();
});

function render(next: Partial<Omit<AiEditorHostProps, "children">> = {}) {
  props = { ...props, ...next };
  act(() => root.render(<AiEditorHost {...props}><PanelProbe /></AiEditorHost>));
}

function host() { return document.querySelector<HTMLElement>(".ai-sidebar-panel")!; }

function geometry(element = host()) {
  const captured = new Set<number>();
  element.setPointerCapture = vi.fn((id: number) => { captured.add(id); });
  element.hasPointerCapture = vi.fn((id: number) => captured.has(id));
  element.releasePointerCapture = vi.fn((id: number) => { captured.delete(id); });
  Object.defineProperty(element, "offsetWidth", { configurable: true, value: 440 });
  element.getBoundingClientRect = () => ({ left: parseFloat(element.style.left), top: parseFloat(element.style.top) }) as DOMRect;
  return { element, captured };
}

function pointer(target: Element, type: string, { x = 100, y = 200, id = 1, button = 0 } = {}) {
  act(() => target.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, pointerId: id, button, bubbles: true, cancelable: true,
  })));
}

describe("AI editor host lifecycle", () => {
  it("keeps the inline panel in a body portal and forwards wheel units to the editor canvas", () => {
    render();
    expect(host().parentElement).toBe(document.body);
    expect(container.querySelector(".ai-sidebar-panel")).toBeNull();
    expect(host().style.left).toBe("100px");
    expect(host().style.top).toBe("206px");
    expect(host().getAttribute("aria-hidden")).toBe("false");
    const catcher = document.querySelector(".ai-inline-catcher")!;
    for (const deltaMode of [0, 1, 2]) {
      act(() => catcher.dispatchEvent(new WheelEvent("wheel", { deltaX: 2, deltaY: 3, deltaMode, bubbles: true })));
    }
    expect(scroller.scrollBy).toHaveBeenNthCalledWith(1, { left: 2, top: 3 });
    expect(scroller.scrollBy).toHaveBeenNthCalledWith(2, { left: 32, top: 48 });
    expect(scroller.scrollBy).toHaveBeenNthCalledWith(3, { left: 1200, top: 1800 });
    act(() => catcher.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("retains a dropped position on rerender and reanchors a new session without remounting its panel", () => {
    render();
    const { element } = geometry();
    const textarea = element.querySelector("textarea")!;
    textarea.focus();
    pointer(textarea, "pointerdown");
    pointer(element, "pointermove", { x: 102, y: 201 });
    expect(element.setPointerCapture).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textarea);
    pointer(element, "pointermove", { x: 160, y: 230 });
    expect(element.setPointerCapture).toHaveBeenCalledWith(1);
    expect(document.activeElement).not.toBe(textarea);
    expect(element.style.left).toBe("160px");
    expect(element.style.top).toBe("236px");
    expect(document.body.style.cursor).toBe("grabbing");
    pointer(element, "pointerup", { x: 160, y: 230 });
    expect(element.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(document.activeElement).toBe(textarea);
    expect(document.body.style.cursor).toBe("");

    textarea.value = "入力中の指示";
    render({ inlineAnchor: { left: 220, top: 300 } });
    expect(host()).toBe(element);
    expect(element.style.left).toBe("160px");
    expect(element.style.top).toBe("236px");
    expect(element.querySelector("textarea")).toBe(textarea);
    render({ inlineSessionId: 2 });
    expect(host()).toBe(element);
    expect(element.style.left).toBe("220px");
    expect(element.style.top).toBe("346px");
    expect(textarea.value).toBe("入力中の指示");
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it("leaves controls, nonempty text, other pointers and right clicks to their own interactions", () => {
    render();
    const { element } = geometry();
    const textarea = element.querySelector("textarea")!;
    textarea.value = "選択する文章";
    for (const target of [element.querySelector("button")!, textarea]) {
      pointer(target, "pointerdown");
      pointer(element, "pointermove", { x: 400, y: 400 });
      pointer(element, "pointerup");
    }
    pointer(element, "pointerdown", { button: 2 });
    pointer(element, "pointermove", { x: 400, y: 400 });
    expect(element.setPointerCapture).not.toHaveBeenCalled();
    pointer(element, "pointerdown");
    pointer(element, "pointermove", { x: 400, y: 400, id: 2 });
    expect(element.setPointerCapture).not.toHaveBeenCalled();
    pointer(element, "pointerup", { id: 1 });
    expect(element.style.left).toBe("100px");
  });

  it("clamps dragged coordinates and releases capture on matching pointerup or pointercancel", () => {
    render();
    const { element, captured } = geometry();
    document.body.style.cursor = "crosshair";
    pointer(element, "pointerdown");
    pointer(element, "pointermove", { x: -2000, y: -2000 });
    expect(element.style.left).toBe("12px");
    expect(element.style.top).toBe("12px");
    pointer(element, "pointerup", { id: 2 });
    expect(captured.size).toBe(1);
    expect(document.body.style.cursor).toBe("grabbing");
    pointer(element, "pointerup");
    expect(captured.size).toBe(0);
    expect(document.body.style.cursor).toBe("");
    pointer(element, "pointermove", { x: 600, y: 500 });
    expect(element.style.left).toBe("12px");

    pointer(element, "pointerdown");
    pointer(element, "pointermove", { x: 4000, y: 4000 });
    expect(parseFloat(element.style.left)).toBe(window.innerWidth - 440 - 12);
    expect(parseFloat(element.style.top)).toBe(window.innerHeight - 80);
    pointer(element, "pointercancel");
    expect(captured.size).toBe(0);
    expect(document.body.style.cursor).toBe("");
  });

  it("preserves panel identity through closing, hidden and run-anchor presentation states", () => {
    render();
    const element = host();
    render({ inlineOpen: false, inlineClosing: true, surface: resolveAiSurface({ displayMode: "inline", aiInlineOpen: false, aiSidebarOpen: false }) });
    expect(host()).toBe(element);
    expect(element.classList.contains("ai-chat-host--closing")).toBe(true);
    expect(document.querySelector(".ai-inline-catcher--closing")).not.toBeNull();
    render({ inlineClosing: false });
    expect(host()).toBe(element);
    expect(element.getAttribute("aria-hidden")).toBe("true");
    render({ inlineRunAnchor: { left: 240, top: 260 } });
    expect(host()).toBe(element);
    expect(element.getAttribute("aria-hidden")).toBe("false");
    expect(element.style.left).toBe("240px");
    expect(element.style.top).toBe("306px");
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it("docks the panel in the workspace grid with the existing portal-to-grid mount behavior", () => {
    render();
    const { element, captured } = geometry();
    pointer(element, "pointerdown");
    pointer(element, "pointermove", { x: 160, y: 230 });
    pointer(element, "pointerup");
    render({ displayMode: "sidebar", inlineOpen: false, surface: resolveAiSurface({ displayMode: "sidebar", aiInlineOpen: false, aiSidebarOpen: true }) });
    expect(captured.size).toBe(0);
    expect(document.body.style.cursor).toBe("");
    expect(host().parentElement).toBe(container);
    expect(host().style.left).toBe("");
    expect(host().classList.contains("ai-chat-host--sidebar")).toBe(true);
    expect(document.querySelector(".ai-inline-catcher")).toBeNull();
    // As before extraction, changing between a portal and the grid reparents the panel.
    expect(mounts).toBe(2);
    expect(unmounts).toBe(1);
    const close = host().querySelector<HTMLButtonElement>(".sidebar-close-button")!;
    expect(close.getAttribute("aria-label")).toBe(props.closeLabel);
    act(() => close.click());
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("does not mount panel children while disabled and returns focus on pointercancel before unmount", () => {
    render({ enabled: false });
    expect(host()).toBeNull();
    expect(mounts).toBe(0);
    render({ enabled: true });
    const { element, captured } = geometry();
    const textarea = element.querySelector("textarea")!;
    textarea.focus();
    pointer(textarea, "pointerdown");
    pointer(element, "pointermove", { x: 160, y: 230 });
    expect(document.activeElement).not.toBe(textarea);
    pointer(element, "pointercancel");
    expect(document.activeElement).toBe(textarea);
    expect(captured.size).toBe(0);
    expect(document.body.style.cursor).toBe("");
    act(() => root.render(null));
    expect(host()).toBeNull();
    expect(unmounts).toBe(1);
  });
});
