// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAppLocale } from "@/lib/i18n";

import { RegionCaptureLayer, useRegionCaptureActions } from "./RegionCaptureLayer";
import { REGION_CAPTURE_ARM_EVENT } from "./region-capture-events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST_BOX = { left: 100, top: 50, width: 600, height: 400 };

let root: Root;
let container: HTMLDivElement;
let host: HTMLElement;
let captureRegion: ReturnType<typeof vi.fn>;
let clipboardWrite: ReturnType<typeof vi.fn>;
let hiddenAtCapture: string[];

class FakeClipboardItem {
  constructor(public readonly items: Record<string, Blob>) {}
}

function pointer(
  type: string,
  target: Element | Window,
  init: { x: number; y: number; alt?: boolean; shift?: boolean; button?: number },
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    isPrimary: true,
    button: init.button ?? 0,
    clientX: init.x,
    clientY: init.y,
    altKey: init.alt ?? false,
    shiftKey: init.shift ?? false,
  });
  target.dispatchEvent(event);
  return event;
}

function drag(from: [number, number], to: [number, number], chord = true): PointerEvent {
  let down!: PointerEvent;
  act(() => {
    down = pointer("pointerdown", host, { x: from[0], y: from[1], alt: chord, shift: chord });
  });
  act(() => {
    pointer("pointermove", window, { x: to[0], y: to[1], alt: chord, shift: chord });
  });
  act(() => {
    pointer("pointerup", window, { x: to[0], y: to[1], alt: chord, shift: chord });
  });
  return down;
}

function toolbar(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="toolbar"]');
}

function button(label: string): HTMLButtonElement {
  const found = toolbar()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

beforeEach(() => {
  setAppLocale("ja");
  hiddenAtCapture = [];
  captureRegion = vi.fn(async () => {
    hiddenAtCapture.push((document.querySelector(".region-capture-root") as HTMLElement | null)?.style.visibility ?? "");
    return { png: new Uint8Array([137, 80, 78, 71]), width: 400, height: 200 };
  });
  clipboardWrite = vi.fn(async () => undefined);
  (window as unknown as { desktopAPI: unknown }).desktopAPI = {
    isDesktop: true,
    app: { captureRegion },
    file: { saveToDownloads: vi.fn(async () => ({ filePath: "/tmp/screenshot.png" })) },
  };
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  // 2 フレーム待ちを時間に頼らず進める。
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  Object.defineProperty(navigator, "clipboard", { value: { write: clipboardWrite }, configurable: true });

  host = document.createElement("section");
  host.className = "editor-canvas";
  host.getBoundingClientRect = () => ({
    ...HOST_BOX,
    right: HOST_BOX.left + HOST_BOX.width,
    bottom: HOST_BOX.top + HOST_BOX.height,
    x: HOST_BOX.left,
    y: HOST_BOX.top,
    toJSON: () => ({}),
  });
  Object.defineProperty(host, "clientWidth", { value: HOST_BOX.width });
  Object.defineProperty(host, "clientHeight", { value: HOST_BOX.height });
  document.body.append(host);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  host.remove();
  delete (window as { desktopAPI?: unknown }).desktopAPI;
  vi.unstubAllGlobals();
});

function render(props: Parameters<typeof RegionCaptureLayer>[0] = {}) {
  act(() => root.render(<RegionCaptureLayer {...props} />));
}

describe("RegionCaptureLayer", () => {
  it("does nothing outside the desktop app", () => {
    delete (window as { desktopAPI?: unknown }).desktopAPI;
    render();
    const down = pointer("pointerdown", host, { x: 200, y: 100, alt: true, shift: true });
    expect(down.defaultPrevented).toBe(false);
    expect(document.querySelector(".region-capture-root")).toBeNull();
  });

  it("takes over an Option+Shift drag inside the page area and offers copy and save", () => {
    render();
    const down = drag([200, 100], [400, 260]);
    expect(down.defaultPrevented).toBe(true);
    expect(toolbar()).not.toBeNull();
    expect(button("スクリーンショットをコピー")).toBeTruthy();
    expect(button("画像として保存")).toBeTruthy();
    const frame = document.querySelector<HTMLElement>(".region-capture-frame");
    expect(frame?.style.left).toBe("200px");
    expect(frame?.style.width).toBe("200px");
    expect(frame?.style.height).toBe("160px");
  });

  it("leaves an ordinary drag, and drags that start outside the page area, alone", () => {
    render();
    const plain = pointer("pointerdown", host, { x: 200, y: 100 });
    expect(plain.defaultPrevented).toBe(false);
    pointer("pointerup", window, { x: 200, y: 100 });

    const outside = pointer("pointerdown", document.body, { x: 20, y: 20, alt: true, shift: true });
    expect(outside.defaultPrevented).toBe(false);
    // 紙面のスクロールバーの上 (内容領域の外) も始点にしない。
    const onScrollbar = pointer("pointerdown", host, { x: HOST_BOX.left + HOST_BOX.width + 4, y: 100, alt: true, shift: true });
    expect(onScrollbar.defaultPrevented).toBe(false);
    expect(toolbar()).toBeNull();
  });

  it("starts through a transparent scrim laid over the page, but not through other floating UI", () => {
    render();
    const scrim = document.createElement("div");
    scrim.setAttribute("data-region-capture-passthrough", "true");
    const panel = document.createElement("aside");
    document.body.append(scrim, panel);
    try {
      const blocked = pointer("pointerdown", panel, { x: 200, y: 100, alt: true, shift: true });
      expect(blocked.defaultPrevented).toBe(false);
      const passed = pointer("pointerdown", scrim, { x: 200, y: 100, alt: true, shift: true });
      expect(passed.defaultPrevented).toBe(true);
    } finally {
      scrim.remove();
      panel.remove();
    }
  });

  it("treats a tiny drag as a click and offers nothing", () => {
    render();
    drag([200, 100], [203, 102]);
    expect(toolbar()).toBeNull();
    expect(document.querySelector(".region-capture-frame")).toBeNull();
  });

  it("keeps the range inside the page area", () => {
    render();
    drag([600, 400], [2000, 2000]);
    const frame = document.querySelector<HTMLElement>(".region-capture-frame");
    expect(frame?.style.width).toBe("100px");
    expect(frame?.style.height).toBe("50px");
  });

  it("copies the range as a PNG with the frame and bar hidden while it is captured", async () => {
    render();
    drag([200, 100], [400, 260]);
    act(() => button("スクリーンショットをコピー").click());
    await flush();

    expect(captureRegion).toHaveBeenCalledTimes(1);
    expect(captureRegion.mock.calls[0][0]).toEqual({ x: 200, y: 100, width: 200, height: 160 });
    expect(hiddenAtCapture).toEqual(["hidden"]);
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const item = clipboardWrite.mock.calls[0][0][0] as FakeClipboardItem;
    expect(item.items["image/png"].type).toBe("image/png");
    // 撮り終えたら隠していた層は元に戻る (結果を見せてから閉じる)。
    expect((document.querySelector(".region-capture-root") as HTMLElement).style.visibility).toBe("");
    expect(document.documentElement.hasAttribute("data-region-capturing")).toBe(false);
  });

  it("saves the range to the downloads folder", async () => {
    render();
    drag([200, 100], [400, 260]);
    act(() => button("画像として保存").click());
    await flush();

    const saveToDownloads = (window as unknown as {
      desktopAPI: { file: { saveToDownloads: ReturnType<typeof vi.fn> } };
    }).desktopAPI.file.saveToDownloads;
    expect(saveToDownloads).toHaveBeenCalledTimes(1);
    expect(saveToDownloads.mock.calls[0][0].fileName).toMatch(/^screenshot-\d{8}-\d{6}\.png$/);
  });

  it("reports a failed capture instead of closing silently", async () => {
    captureRegion.mockResolvedValueOnce(null);
    render();
    drag([200, 100], [400, 260]);
    act(() => button("スクリーンショットをコピー").click());
    await flush();

    expect(toolbar()?.textContent).toContain("撮影できませんでした");
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it("closes on Escape and on an ordinary press elsewhere", () => {
    render();
    drag([200, 100], [400, 260]);
    expect(toolbar()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(toolbar()).toBeNull();

    drag([200, 100], [400, 260]);
    expect(toolbar()).not.toBeNull();
    act(() => {
      pointer("pointerdown", host, { x: 300, y: 200 });
    });
    expect(toolbar()).toBeNull();
  });

  it("closes when the page scrolls, but not for scrolling elsewhere", () => {
    render();
    drag([200, 100], [400, 260]);
    act(() => {
      document.body.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
    expect(toolbar()).not.toBeNull();
    act(() => {
      host.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
    expect(toolbar()).toBeNull();
  });

  it("can be armed without the keys for one drag", () => {
    render();
    act(() => {
      window.dispatchEvent(new Event(REGION_CAPTURE_ARM_EVENT));
    });
    expect(document.querySelector(".region-capture-hint")).not.toBeNull();
    expect(document.documentElement.hasAttribute("data-region-capture-ready")).toBe(true);
    drag([200, 100], [400, 260], false);
    expect(toolbar()).not.toBeNull();
    expect(document.querySelector(".region-capture-hint")).toBeNull();
    // 1 回撮ったら通常の操作へ戻る。
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    const next = pointer("pointerdown", host, { x: 200, y: 100 });
    expect(next.defaultPrevented).toBe(false);
  });

  it("renders injected actions with the capture context", async () => {
    const onAsk = vi.fn();
    function Ask() {
      const context = useRegionCaptureActions();
      return (
        <button
          type="button"
          aria-label="ask"
          onClick={() => {
            void context.capture({ maxDimension: 2048 }).then((image) => {
              onAsk(image?.width, context.anchor);
              context.dismiss();
            });
          }}
        />
      );
    }
    render({ actions: <Ask /> });
    drag([200, 100], [400, 260]);
    act(() => button("ask").click());
    await flush();

    expect(captureRegion.mock.calls[0][0]).toEqual({ x: 200, y: 100, width: 200, height: 160, maxDimension: 2048 });
    expect(onAsk).toHaveBeenCalledWith(400, expect.objectContaining({ left: expect.any(Number), top: expect.any(Number) }));
    expect(toolbar()).toBeNull();
  });
});
