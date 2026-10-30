// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SigmaDocument } from "@/features/document";
import { buildPageWindows, readCanvasLayoutSignature, readPagedCanvasMetrics } from "./page-windows";

const canvasMockState = vi.hoisted(() => ({ showPendingImage: false }));

vi.mock("@/components/editor/PageCanvasEditor", () => ({
  PageCanvasEditor: () => (
    <div className="page-mode">
      <div className="page-canvas">
        {canvasMockState.showPendingImage && (
          // eslint-disable-next-line @next/next/no-img-element -- This test needs a native image that never settles.
          <img
            alt=""
            ref={(image) => {
              if (image) {
                Object.defineProperty(image, "complete", { configurable: true, value: false });
              }
            }}
          />
        )}
      </div>
    </div>
  ),
}));
vi.mock("@/components/print/paged-render/page-windows", () => ({
  buildPageWindows: vi.fn(),
  readCanvasLayoutSignature: vi.fn(() => ""),
  readPagedCanvasMetrics: vi.fn(() => null),
}));
vi.mock("@/lib/print-renderer", () => ({
  getPrintableDocument: (document: SigmaDocument) => document,
}));
vi.mock("@/lib/use-custom-fonts", () => ({ useCustomFonts: vi.fn() }));

let PagedRenderSurface: typeof import("./PagedRenderSurface").PagedRenderSurface;
let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  PagedRenderSurface = (await import("./PagedRenderSurface")).PagedRenderSurface;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(buildPageWindows).mockReset();
  vi.mocked(readCanvasLayoutSignature).mockReturnValue("");
  vi.mocked(readPagedCanvasMetrics).mockReturnValue(null);
  canvasMockState.showPendingImage = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(document, "fonts");
  vi.useRealTimers();
});

describe("PagedRenderSurface", () => {
  it("settles a measurement canvas without cloning the full document for every page", async () => {
    vi.mocked(readCanvasLayoutSignature).mockReturnValue("settled");
    vi.mocked(readPagedCanvasMetrics).mockReturnValue({pageCount:43,pageWidthPx:700,pageHeightPx:970,pageStridePx:1006});
    const onRenderStateChange = vi.fn();
    const value = {pageLayout:{paperSize:"a4",orientation:"portrait"},outputProfiles:{}} as unknown as SigmaDocument;
    await act(async () => {
      root.render(<PagedRenderSurface document={value} profile="teacher" measurementOnly onRenderStateChange={onRenderStateChange} />);
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(buildPageWindows).not.toHaveBeenCalled();
    expect(onRenderStateChange).toHaveBeenLastCalledWith(expect.objectContaining({state:"ready",pageCount:43,revision:1}));
  });
  it("shows a recoverable error after pagination stalls and returns to pending on retry", async () => {
    const onRenderStateChange = vi.fn();
    const document = {
      pageLayout: { paperSize: "a4", orientation: "portrait" },
      outputProfiles: {},
    } as unknown as SigmaDocument;

    await act(async () => {
      root.render(
        <PagedRenderSurface
          document={document}
          profile="teacher"
          onRenderStateChange={onRenderStateChange}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(container.querySelector('.paged-surface[data-paged-surface-state="stalled"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("プレビューを表示できませんでした");
    expect(onRenderStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "stalled",
      pageCount: 0,
      revision: 0,
      surfaceId: expect.any(String),
    }));

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".paged-surface-stalled button")?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('.paged-surface[data-paged-surface-state="pending"]')).not.toBeNull();
    expect(container.querySelector(".print-paper-shimmer")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onRenderStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "pending",
      pageCount: 0,
      revision: 0,
      surfaceId: expect.any(String),
    }));
  });

  it("bounds a font readiness promise that never resolves", async () => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: new Promise<void>(() => {}) },
    });
    const documentValue = {
      pageLayout: { paperSize: "a4", orientation: "portrait" },
      outputProfiles: {},
    } as unknown as SigmaDocument;

    await act(async () => {
      root.render(<PagedRenderSurface document={documentValue} profile="teacher" />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001);
      await Promise.resolve();
    });

    expect(container.querySelector('.paged-surface[data-paged-surface-state="stalled"]')).not.toBeNull();
  });

  it("bounds an image request that never emits load or error", async () => {
    canvasMockState.showPendingImage = true;
    const documentValue = {
      pageLayout: { paperSize: "a4", orientation: "portrait" },
      outputProfiles: {},
    } as unknown as SigmaDocument;

    await act(async () => {
      root.render(<PagedRenderSurface document={documentValue} profile="teacher" />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001);
      await Promise.resolve();
    });

    expect(container.querySelector('.paged-surface[data-paged-surface-state="stalled"]')).not.toBeNull();
  });
});
