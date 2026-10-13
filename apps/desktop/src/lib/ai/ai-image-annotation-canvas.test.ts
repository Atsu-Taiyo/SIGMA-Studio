// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { runAiEditViaDesktopRuntime } from "./codex-ai-edit-client";
import { paintAiImageAnnotations, renderAnnotatedAttachmentsForAi } from "./ai-image-annotation-canvas";
import { DEFAULT_AI_EDIT_MODEL } from "./sigma-doc-edit-schema";
import type { AiEditAttachment } from "./sigma-doc-agent-tools";
import { createBlankDocument } from "@/lib/blank-document";

const ORIGINAL = "data:image/png;base64,T1JJR0lOQUw=";
const COMPOSITE = "data:image/png;base64,Q09NUE9TSVRF";

interface RecordedContext {
  calls: string[];
  texts: Array<{ text: string; x: number; y: number }>;
  rects: Array<[number, number, number, number]>;
}

function recordingContext(): CanvasRenderingContext2D & RecordedContext {
  const recorded: RecordedContext = { calls: [], texts: [], rects: [] };
  const context = {
    ...recorded,
    save: () => recorded.calls.push("save"),
    restore: () => recorded.calls.push("restore"),
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => recorded.calls.push("stroke"),
    arc: () => recorded.calls.push("arc"),
    fill: () => recorded.calls.push("fill"),
    fillRect: (x: number, y: number, w: number, h: number) => recorded.rects.push([x, y, w, h]),
    strokeRect: () => recorded.calls.push("strokeRect"),
    drawImage: () => recorded.calls.push("drawImage"),
    fillText: (text: string, x: number, y: number) => recorded.texts.push({ text, x, y }),
  };
  return Object.assign(context, recorded) as unknown as CanvasRenderingContext2D & RecordedContext;
}

function stubImageLoading(width = 400, height = 200) {
  class LoadedImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = width;
    naturalHeight = height;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", LoadedImage);
}

function annotatedAttachment(): AiEditAttachment {
  return {
    id: "media_1",
    name: "screenshot.png",
    mimeType: "image/png",
    dataUrl: ORIGINAL,
    width: 400,
    height: 200,
    annotations: [
      { id: "a", x: 0.5, y: 0.5, comment: "ここ" },
      { id: "b", x: 0.1, y: 0.1, width: 0.2, height: 0.3, comment: "この範囲" },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("paintAiImageAnnotations", () => {
  it("draws one numbered badge per comment and the frame of each region", () => {
    const context = recordingContext();
    paintAiImageAnnotations(context, annotatedAttachment().annotations!, { width: 400, height: 200 });
    expect(context.texts.map((item) => item.text)).toEqual(["1", "2"]);
    // 範囲は塗り (薄い青) と枠 (白い縁 + 青) で描く。
    expect(context.rects).toContainEqual([40, 20, 80, 60]);
    expect(context.calls.filter((call) => call === "strokeRect")).toHaveLength(2);
    // 点は中を塗らない輪 (白い縁 + 青) で囲み、番号はその右上へ離して置く (点そのものを隠さない)。
    expect(context.texts[0]!.x).toBeGreaterThan(200 + 10);
    expect(context.texts[0]!.y).toBeLessThan(100 - 10);
    expect(context.calls.filter((call) => call === "stroke")).toHaveLength(2);
  });
});

describe("renderAnnotatedAttachmentsForAi", () => {
  it("replaces only annotated images with the marked-up copy and keeps the comments for the prompt", async () => {
    stubImageLoading();
    const context = recordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(COMPOSITE);
    const plain: AiEditAttachment = { id: "plain", name: "plain.png", mimeType: "image/png", dataUrl: ORIGINAL };

    const [annotated, unmarked, untouched] = await renderAnnotatedAttachmentsForAi([annotatedAttachment(), plain]);

    expect(annotated).toMatchObject({ id: "media_1", dataUrl: COMPOSITE, mimeType: "image/png", width: 400, height: 200 });
    expect(annotated?.annotations).toHaveLength(2);
    expect(context.calls).toContain("drawImage");
    // 印で隠れた細かな文字を読めるよう、印なしの元画像を直後に添える (注記は持たない)。
    expect(unmarked).toEqual({
      id: "media_1_unmarked",
      name: "screenshot（印なし）.png",
      mimeType: "image/png",
      dataUrl: ORIGINAL,
      width: 400,
      height: 200,
    });
    expect(untouched).toBe(plain);
  });

  it("does not add the unmarked copy when it would push the images over the per-turn limit", async () => {
    stubImageLoading();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(recordingContext() as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(COMPOSITE);
    const plain = (id: string): AiEditAttachment => ({ id, name: `${id}.png`, mimeType: "image/png", dataUrl: ORIGINAL });

    const result = await renderAnnotatedAttachmentsForAi([annotatedAttachment(), plain("b"), plain("c"), plain("d")]);

    expect(result.map((attachment) => attachment.id)).toEqual(["media_1", "b", "c", "d"]);
    expect(result[0]?.dataUrl).toBe(COMPOSITE);
  });

  it("sends the original image (with the comments as text) when it cannot be drawn", async () => {
    stubImageLoading();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const result = await renderAnnotatedAttachmentsForAi([annotatedAttachment()]);
    expect(result).toHaveLength(1);
    expect(result[0]?.dataUrl).toBe(ORIGINAL);
    expect(result[0]?.annotations).toHaveLength(2);
  });
});

describe("runAiEditViaDesktopRuntime with image comments", () => {
  it("sends the marked-up image over IPC without changing the caller's attachment (history keeps the original)", async () => {
    stubImageLoading();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(recordingContext() as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(COMPOSITE);
    const run = vi.fn(async () => ({}));
    (window as unknown as { desktopAPI: unknown }).desktopAPI = { aiEdit: { run } };
    const attachment = annotatedAttachment();

    await runAiEditViaDesktopRuntime({
      model: DEFAULT_AI_EDIT_MODEL,
      instruction: "画像に付けたコメントに沿って対応して。",
      document: createBlankDocument(),
      selectedId: null,
      attachments: [attachment],
    });

    const payload = (run.mock.calls[0] as unknown as [{ attachments: AiEditAttachment[] }])[0];
    expect(payload.attachments[0]?.dataUrl).toBe(COMPOSITE);
    expect(payload.attachments[0]?.annotations).toEqual(attachment.annotations);
    expect(payload.attachments[1]).toMatchObject({ dataUrl: ORIGINAL, name: "screenshot（印なし）.png" });
    expect(attachment.dataUrl).toBe(ORIGINAL);
    delete (window as unknown as { desktopAPI?: unknown }).desktopAPI;
  });

  it("does not call the AI when the run was stopped while the images were being prepared", async () => {
    stubImageLoading();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(recordingContext() as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(COMPOSITE);
    const run = vi.fn(async () => ({}));
    (window as unknown as { desktopAPI: unknown }).desktopAPI = { aiEdit: { run } };
    const stop = new AbortController();
    const started = runAiEditViaDesktopRuntime({
      model: DEFAULT_AI_EDIT_MODEL,
      instruction: "画像に付けたコメントに沿って対応して。",
      document: createBlankDocument(),
      selectedId: null,
      attachments: [annotatedAttachment()],
      signal: stop.signal,
    });
    stop.abort();

    await expect(started).rejects.toThrow("送る画像の準備中に中断しました。");
    expect(run).not.toHaveBeenCalled();
    delete (window as unknown as { desktopAPI?: unknown }).desktopAPI;
  });
});
