import { afterEach, describe, expect, it, vi } from "vitest";

import { pickCanvasVideoFormat, recordCanvasVideo } from "./canvas-video";

function stubMediaRecorder(supported: readonly string[]): void {
  vi.stubGlobal("MediaRecorder", {
    isTypeSupported: (mimeType: string) => supported.includes(mimeType),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pickCanvasVideoFormat", () => {
  it("prefers MP4/H.264 — the file a teacher can drop straight into slides", () => {
    stubMediaRecorder(["video/mp4;codecs=avc1.42E01E", "video/webm;codecs=vp9"]);

    expect(pickCanvasVideoFormat()).toEqual({
      mimeType: "video/mp4;codecs=avc1.42E01E",
      extension: "mp4",
    });
  });

  it("falls back to WebM, and reports the extension that goes with it", () => {
    stubMediaRecorder(["video/webm;codecs=vp9", "video/webm"]);

    expect(pickCanvasVideoFormat()).toEqual({ mimeType: "video/webm;codecs=vp9", extension: "webm" });
  });

  it("has no format at all when nothing is supported", () => {
    stubMediaRecorder([]);

    expect(pickCanvasVideoFormat()).toBeNull();
  });

  it("has no format outside a browser", () => {
    expect(pickCanvasVideoFormat()).toBeNull();
  });
});

function recordingHarness(failure?: "constructor" | "start") {
  vi.useFakeTimers();
  let now = 0;
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const track = { requestFrame: vi.fn(), stop: vi.fn() };
  const stopRecording = vi.fn();
  class Recorder extends EventTarget {
    static isTypeSupported() { return true; }
    state = "inactive";
    constructor() {
      super();
      if (failure === "constructor") throw new Error("constructor failed");
    }
    start() {
      if (failure === "start") throw new Error("start failed");
      this.state = "recording";
    }
    stop() {
      stopRecording();
      this.state = "inactive";
      this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["encoded frames"]) }));
      this.dispatchEvent(new Event("stop"));
    }
  }
  vi.stubGlobal("MediaRecorder", Recorder);
  const canvas = { width: 1280, height: 960, captureStream: () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) } as unknown as HTMLCanvasElement;
  const tick = async (time: number) => {
    now = time;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(time));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { canvas, track, stopRecording, tick, frames };
}

describe("canvas recording lifecycle", () => {
  it("awaits asynchronous SVG painting before capturing a frame", async () => {
    const harness = recordingHarness();
    let finishPaint!: () => void;
    const painted = new Promise<void>((resolve) => { finishPaint = resolve; });
    const recording = recordCanvasVideo({ canvas: harness.canvas, durationMs: 100, drawFrame: () => painted });
    await harness.tick(100);
    expect(harness.track.requestFrame).not.toHaveBeenCalled();
    finishPaint();
    await vi.advanceTimersByTimeAsync(250);
    const result = await recording;
    expect(result.frameCount).toBe(1);
    expect(result.blob.size).toBeGreaterThan(0);
    expect(harness.track.requestFrame).toHaveBeenCalled();
    expect(harness.stopRecording).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("releases tracks and frame callbacks when aborted in a hidden tab", async () => {
    const harness = recordingHarness();
    const controller = new AbortController();
    const recording = recordCanvasVideo({ canvas: harness.canvas, durationMs: 1000, drawFrame: vi.fn(), signal: controller.signal });
    const rejected = expect(recording).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(harness.frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.stopRecording).toHaveBeenCalledOnce();
  });

  it("reports an asynchronous drawing failure and releases the recorder", async () => {
    const harness = recordingHarness();
    const recording = recordCanvasVideo({ canvas: harness.canvas, durationMs: 100, drawFrame: async () => { throw new Error("SVG failed"); } });
    const rejected = expect(recording).rejects.toThrow("SVG failed");
    await harness.tick(50);
    await rejected;
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.stopRecording).toHaveBeenCalledOnce();
  });

  it.each(["constructor", "start"] as const)("releases the stream if recorder %s fails", async (failure) => {
    const harness = recordingHarness(failure);
    await expect(recordCanvasVideo({ canvas: harness.canvas, durationMs: 100, drawFrame: vi.fn() })).rejects.toThrow(`${failure} failed`);
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.frames.size).toBe(0);
  });
});
