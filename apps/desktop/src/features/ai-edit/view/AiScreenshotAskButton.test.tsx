// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegionCaptureActionsContext, type RegionCaptureActionContext } from "@/components/editor/region-capture/RegionCaptureLayer";
import { createTranslator, setAppLocale } from "@/lib/i18n";

import { AI_SCREENSHOT_MAX_DIMENSION, AiScreenshotAskButton } from "./AiScreenshotAskButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

function context(overrides: Partial<RegionCaptureActionContext> = {}): RegionCaptureActionContext {
  return {
    rect: { left: 10, top: 20, width: 300, height: 200 },
    anchor: { left: 40, top: 240 },
    capture: vi.fn(async () => ({
      blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
      width: 600,
      height: 400,
      fileName: "screenshot-20261003-142530.png",
    })),
    reportFailure: vi.fn(),
    dismiss: vi.fn(),
    busy: false,
    ...overrides,
  };
}

function renderButton(value: RegionCaptureActionContext, onRequest: Parameters<typeof AiScreenshotAskButton>[0]["onRequest"]) {
  act(() => root.render(
    <RegionCaptureActionsContext.Provider value={value}>
      <AiScreenshotAskButton onRequest={onRequest} />
    </RegionCaptureActionsContext.Provider>,
  ));
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

beforeEach(() => {
  setAppLocale("ja");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("AiScreenshotAskButton", () => {
  it("is labelled 'Ask AI' in each language", () => {
    expect(createTranslator("ja", "ai")("screenshot.ask")).toBe("AIに聞く");
    expect(createTranslator("en", "ai")("screenshot.ask")).toBe("Ask AI");
  });

  it("hands the captured range to the AI as an image attachment and closes the range", async () => {
    const ctx = context();
    const onRequest = vi.fn();
    renderButton(ctx, onRequest);
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("AIに聞く");
    await click(button);

    // 細かい字が読める大きさに留めて撮る (取得側が縮める)。
    expect(ctx.capture).toHaveBeenCalledWith({ maxDimension: AI_SCREENSHOT_MAX_DIMENSION });
    expect(onRequest).toHaveBeenCalledTimes(1);
    const [attachment, anchor] = onRequest.mock.calls[0];
    expect(attachment).toMatchObject({
      name: "screenshot-20261003-142530.png",
      mimeType: "image/png",
      width: 600,
      height: 400,
      fileSize: 4,
    });
    expect(attachment.id).toMatch(/^media_/);
    expect(attachment.dataUrl).toMatch(/^data:image\/png;base64,/);
    // AI のパネルは操作バーの位置を基準に開く。
    expect(anchor).toEqual({ left: 40, top: 240 });
    expect(ctx.dismiss).toHaveBeenCalledTimes(1);
    expect(ctx.reportFailure).not.toHaveBeenCalled();
  });

  it("reports a failed capture and sends nothing", async () => {
    const ctx = context({ capture: vi.fn(async () => null) });
    const onRequest = vi.fn();
    renderButton(ctx, onRequest);
    await click(container.querySelector("button")!);

    expect(onRequest).not.toHaveBeenCalled();
    expect(ctx.reportFailure).toHaveBeenCalledTimes(1);
    expect(ctx.dismiss).not.toHaveBeenCalled();
  });

  it("cannot be pressed twice while a capture is in flight", () => {
    renderButton(context({ busy: true }), vi.fn());
    expect(container.querySelector("button")!.disabled).toBe(true);
  });
});
