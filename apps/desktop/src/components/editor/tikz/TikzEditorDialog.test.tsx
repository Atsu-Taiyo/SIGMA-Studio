// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TIKZ_ENVIRONMENT, type TikzImageSource } from "@/features/document";
import type { TikzRenderResponse, TikzRenderResult } from "@/lib/tikz-contract";
import { TikzEditorDialog } from "./TikzEditorDialog";

const renderImage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/desktop-bridge", () => ({ getDesktopBridge: () => ({ tikz: { render: renderImage } }) }));
// Placement and real pointer/focus behavior are verified in Electron.
vi.mock("../GraphSettingsPanel", () => ({ GraphSettingsPanelFrame: ({ children, headerActions }: { children: ReactNode; headerActions: ReactNode }) =>
  <div role="dialog">{headerActions}{children}</div> }));

let container: HTMLDivElement;
let root: Root;
const initial: TikzImageSource = { source: "initial", environment: EMPTY_TIKZ_ENVIRONMENT };
const initialImage: TikzRenderResult = { src: "initial.svg", width: 100, height: 100 };
const preview = vi.fn();
const apply = vi.fn(() => true);
const close = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});
async function mount(autoInsert = false) {
  await act(async () => root.render(<TikzEditorDialog initial={initial} initialImage={autoInsert ? undefined : initialImage}
    autoInsert={autoInsert} onPreview={preview} onApply={apply} onClose={close} />));
}
async function type(source: string) {
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, source);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); }
function button(text: string) { return [...container.querySelectorAll("button")].find((item) => item.textContent === text)!; }
function deferred() {
  let resolve!: (value: TikzRenderResponse) => void;
  const promise = new Promise<TikzRenderResponse>((done) => { resolve = done; });
  return { promise, resolve };
}
const success = (src: string): Extract<TikzRenderResponse, { ok: true }> => ({ ok: true, image: { src, width: 100, height: 50 } });

describe("TikZ canvas preview lifecycle", () => {
  it("debounces input and previews without applying or disabling typing", async () => {
    renderImage.mockResolvedValue(success("latest.svg"));
    await mount();
    await type("intermediate");
    await type("latest");
    expect(renderImage).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")!.disabled).toBe(false);
    expect(button("適用").disabled).toBe(true);
    await tick();
    expect(renderImage).toHaveBeenCalledTimes(1);
    expect(renderImage).toHaveBeenCalledWith({ ...initial, source: "latest" });
    expect(preview).toHaveBeenLastCalledWith(success("latest.svg").image);
    expect(apply).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    expect(button("適用").disabled).toBe(false);
    await act(async () => button("適用").click());
    expect(apply).toHaveBeenCalledWith({ ...initial, source: "latest" }, success("latest.svg").image);
    expect(close).toHaveBeenCalledOnce();
  });

  it("serializes slow compiles and ignores obsolete results and errors", async () => {
    const first = deferred();
    const second = deferred();
    renderImage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await mount();
    await type("first");
    await tick();
    await type("second");
    await tick();
    expect(renderImage).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve({ ok: false, error: "! obsolete error" }));
    expect(renderImage).toHaveBeenCalledTimes(2);
    expect(preview).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => second.resolve(success("second.svg")));
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenLastCalledWith(success("second.svg").image);
    renderImage.mockResolvedValue({ ok: false, error: "! invalid" });
    await type("invalid");
    await tick();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(button("適用").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("! invalid");
    expect(apply).not.toHaveBeenCalled();
  });

  it("never inserts or publishes a compile result after closing", async () => {
    const pending = deferred();
    renderImage.mockReturnValue(pending.promise);
    await mount(true);
    await tick();
    await act(async () => root.render(null));
    await act(async () => pending.resolve(success("closed.svg")));
    expect(apply).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps unchanged storage images and restores them when the draft is reverted", async () => {
    renderImage.mockResolvedValue(success("changed.svg"));
    await mount();
    await type("changed");
    await tick();
    await type(initial.source);
    await tick();
    expect(preview).toHaveBeenLastCalledWith(initialImage);
    expect(renderImage).toHaveBeenCalledTimes(1);
    await act(async () => button("適用").click());
    expect(apply).toHaveBeenCalledWith(initial, initialImage);
  });
});
