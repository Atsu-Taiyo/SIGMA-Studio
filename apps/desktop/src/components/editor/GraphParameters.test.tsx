// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphParameter } from "@/features/document";
import { setAppLocale } from "@/lib/i18n";
import { GraphParameters } from "./GraphParameters";

let container: HTMLDivElement;
let root: Root;
let now = 0;
let id = 0;
const frames = new Map<number, FrameRequestCallback>();
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setAppLocale("ja");
  now = 0;
  frames.clear();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const parameter = (name: string, min = 0, max = 10): GraphParameter => ({ id: name, name, value: min, min, max, animation: { durationMs: 1000, loop: "repeat" } });
async function tick(time: number) {
  await act(async () => {
    now = time;
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(time);
  });
}
async function click(label: string, index = 0) {
  const button = container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)[index];
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function mount(initial: GraphParameter[]) {
  let saved = initial;
  let rerender: () => void = () => undefined;
  const commits = vi.fn();
  const preview = vi.fn();
  function Harness() {
    const [parameters, setParameters] = useState(initial);
    const [, redraw] = useState(0);
    rerender = () => redraw((value) => value + 1);
    return <GraphParameters parameters={parameters} onPreview={preview} onChange={(update) => {
      saved = update(saved);
      commits(saved);
      setParameters(saved);
    }} />;
  }
  await act(async () => root.render(<Harness />));
  return { saved: () => saved, commits, preview, rerender: async () => act(async () => rerender()) };
}

describe("graph parameter playback", () => {
  it("keeps the displayed value through parent rerenders without saving frames", async () => {
    const harness = await mount([parameter("s")]);
    await click("再生");
    await tick(250);
    await harness.rerender();
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe("2.5");
    expect(container.querySelector("output")!.textContent).toBe("2.50");
    expect(harness.commits).not.toHaveBeenCalled();
    await click("停止");
    expect(harness.saved()[0].value).toBe(2.5);
    expect(harness.commits).toHaveBeenCalledTimes(1);
    await tick(500);
    expect(harness.saved()[0].value).toBe(2.5);
  });

  it("holds the stopped frame while canonical selection notifications are delayed", async () => {
    const source = [parameter("s")];
    let saved = source;
    const onChange = (update: (current: GraphParameter[]) => GraphParameter[]) => { saved = update(saved); };
    const onPreview = vi.fn();
    await act(async () => root.render(<GraphParameters parameters={source} onChange={onChange} onPreview={onPreview} />));
    await click("再生");
    await tick(250);
    await click("停止");
    expect(saved[0].value).toBe(2.5);
    expect(source[0].value).toBe(0);
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe("2.5");
    expect(container.querySelector("output")!.textContent).toBe("2.50");
    await act(async () => root.render(<GraphParameters parameters={saved} onChange={onChange} onPreview={onPreview} />));
    expect(container.querySelector("output")!.textContent).toBe("2.50");
  });

  it("keeps the current pose when playback is stopped by editing its settings", async () => {
    const harness = await mount([parameter("s")]);
    await click("再生");
    await tick(250);
    await click("s の詳細設定");
    const input = document.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(input).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(harness.saved()[0].animation?.durationMs).toBe(2000);
    expect(harness.saved()[0].value).toBe(2.5);
    expect(container.querySelector("output")!.textContent).toBe("2.50");
  });

  it("switches parameters without committing the next parameter's start value to the old one", async () => {
    const harness = await mount([parameter("s"), parameter("a", 20, 30)]);
    await click("再生", 0);
    await tick(250);
    await click("再生", 0);
    expect(harness.saved()[0].value).toBe(2.5);
    expect(harness.saved()[1].value).toBe(20);
    await tick(750);
    await click("停止");
    expect(harness.saved().map((item) => item.value)).toEqual([2.5, 25]);
  });

  it("saves the last value and cancels callbacks when the panel unmounts", async () => {
    const harness = await mount([parameter("s")]);
    await click("再生");
    await tick(400);
    await act(async () => root.render(null));
    expect(harness.saved()[0].value).toBe(4);
    expect(harness.commits).toHaveBeenCalledTimes(1);
    expect(harness.preview).toHaveBeenLastCalledWith({ s: 4 }, false);
    const count = harness.preview.mock.calls.length;
    await tick(800);
    expect(harness.preview).toHaveBeenCalledTimes(count);
  });

  it("finishes a single pass once, preserving the maximum", async () => {
    const source = parameter("s");
    source.animation!.loop = "once";
    const harness = await mount([source]);
    await click("再生");
    await tick(1100);
    expect(harness.saved()[0].value).toBe(10);
    expect(harness.commits).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="停止"]')).toBeNull();
  });
});
