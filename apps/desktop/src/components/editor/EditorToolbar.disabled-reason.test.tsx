// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorToolbarColorButton, EditorToolbarIconButton, EditorToolbarMenuButton } from "./EditorToolbar";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("disabled text format tooltips", () => {
  it.each([EditorToolbarIconButton, EditorToolbarMenuButton, EditorToolbarColorButton])("keeps a hoverable reason around a disabled control", (Button) => {
    const onClick = vi.fn();
    act(() => root.render(<Button disabled disabledReason="AIが編集中の部分です" tooltip={{ label: "選択範囲を太字に", shortcut: "⌘B" }} onClick={onClick}>B</Button>));
    expect(host.querySelector("button")!.disabled).toBe(true);
    const trigger = host.querySelector("[data-tooltip-trigger]")!;
    act(() => trigger.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    act(() => vi.advanceTimersByTime(500));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("AIが編集中の部分です");
    act(() => host.querySelector("button")!.click());
    expect(onClick).not.toHaveBeenCalled();
  });
  it("preserves the normal tooltip and shortcut when formatting is enabled", () => {
    act(() => root.render(<EditorToolbarIconButton disabledReason="閲覧のみの文書です" tooltip={{ label: "選択範囲を太字に", shortcut: "⌘B" }}>B</EditorToolbarIconButton>));
    act(() => host.querySelector("[data-tooltip-trigger]")!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    act(() => vi.advanceTimersByTime(500));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("選択範囲を太字に⌘B");
  });
});
