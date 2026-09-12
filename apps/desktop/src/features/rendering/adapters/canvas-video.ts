import { createCurrentLocaleTranslator } from "@/lib/i18n";

const tShape = createCurrentLocaleTranslator("shape");

/**
 * Records a canvas that is redrawn frame by frame into a video file.
 *
 * The frame clock is wall-clock, not a frame counter: `drawFrame` is asked for "the picture at
 * t milliseconds", and the recorder timestamps it when it is actually pushed. A scene that is
 * expensive to build therefore yields a *choppier* video, never a slow-motion one — the export
 * always lasts exactly as long as the author's animation says it should.
 */

export interface CanvasVideoFormat {
  mimeType: string;
  /** File extension, without the dot. */
  extension: string;
}

/**
 * MP4/H.264 first: it is the only format that a worksheet's audience can drop straight into
 * slides, and Chromium has been able to write it since 126. WebM is the fallback, never the
 * preference.
 */
const CANDIDATE_FORMATS: CanvasVideoFormat[] = [
  { mimeType: "video/mp4;codecs=avc1.42E01E", extension: "mp4" },
  { mimeType: "video/mp4", extension: "mp4" },
  { mimeType: "video/webm;codecs=vp9", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
];

export function pickCanvasVideoFormat(): CanvasVideoFormat | null {
  if (typeof MediaRecorder === "undefined") return null;
  return CANDIDATE_FORMATS.find((format) => MediaRecorder.isTypeSupported(format.mimeType)) ?? null;
}

/** How long the last frame is held before the recorder is stopped. */
const TAIL_HOLD_MS = 250;
const TARGET_LONG_EDGE_PX = 1_280;
const MAX_VIDEO_SCALE = 4;

export interface CanvasVideoPixelSize {
  pixelWidth: number;
  pixelHeight: number;
  /** Encoded pixels per document pixel; labels must be rasterized at this density. */
  scale: number;
}

/** H.264 requires even dimensions, so both sides are rounded to an even number of pixels. */
export function canvasVideoPixelSize(width: number, height: number): CanvasVideoPixelSize {
  const documentWidth = Math.max(1, Math.round(width));
  const documentHeight = Math.max(1, Math.round(height));
  const scale = Math.min(
    MAX_VIDEO_SCALE,
    Math.max(1, TARGET_LONG_EDGE_PX / Math.max(documentWidth, documentHeight)),
  );
  return {
    scale,
    pixelWidth: Math.max(2, Math.round(documentWidth * scale / 2) * 2),
    pixelHeight: Math.max(2, Math.round(documentHeight * scale / 2) * 2),
  };
}



/** ~0.12 bit per pixel per second, held inside a range that is neither muddy nor unusably large. */
function videoBitsPerSecond(width: number, height: number, fps: number): number {
  const estimate = width * height * fps * 0.12;
  return Math.round(Math.min(24_000_000, Math.max(2_500_000, estimate)));
}

export interface RecordCanvasVideoOptions {
  canvas: HTMLCanvasElement;
  /** Length of the finished video. */
  durationMs: number;
  /** Upper bound on how often a frame is drawn; slower scenes simply produce fewer. */
  fps?: number;
  /** Paints the canvas for the given instant. Return false to stop the recording early. */
  drawFrame: (timeMs: number) => void | boolean | Promise<void | boolean>;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export interface CanvasVideoRecording extends CanvasVideoFormat {
  blob: Blob;
  frameCount: number;
}

export async function recordCanvasVideo(
  options: RecordCanvasVideoOptions,
): Promise<CanvasVideoRecording> {
  const { canvas, durationMs, drawFrame, onProgress, signal } = options;
  const fps = Math.min(60, Math.max(1, Math.round(options.fps ?? 30)));
  const format = pickCanvasVideoFormat();
  if (!format) throw new Error(tShape("graph3d.videoUnavailable"));
  signal?.throwIfAborted();

  const stream = canvas.captureStream(0);
  try {
    const [track] = stream.getVideoTracks();
    if (!track) throw new Error(tShape("graph3d.videoTrackFailed"));
    const requestFrame = (track as CanvasCaptureMediaStreamTrack).requestFrame?.bind(track);

    const recorder = new MediaRecorder(stream, {
      mimeType: format.mimeType,
      videoBitsPerSecond: videoBitsPerSecond(canvas.width, canvas.height, fps),
    });
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    const stopped = new Promise<void>((resolve, reject) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.addEventListener("error", () => reject(new Error(tShape("graph3d.recordingFailed"))), { once: true });
    });
    // The encoder may fail while an asynchronous SVG frame is still being painted.
    void stopped.catch(() => undefined);

    // A hidden window may stop firing animation frames. Bound the wait and fail cleanly rather
    // than silently save an incomplete video.
    const deadline = performance.now() + durationMs * 4 + 10_000;
    let frameCount = 0;
    let started = false;

    try {
      recorder.start();
      started = true;
      const startedAt = performance.now();
      let nextFrameAt = startedAt;
      while (true) {
        await nextVideoFrame(signal, deadline);
        const now = performance.now();
        if (recorder.state === "inactive") {
          await stopped;
          throw new Error(tShape("graph3d.recordingFailed"));
        }
        if (now >= nextFrameAt) {
          const elapsed = Math.min(durationMs, now - startedAt);
          const wanted = await drawFrame(elapsed) !== false;
          signal?.throwIfAborted();
          requestFrame?.();
          frameCount += 1;
          onProgress?.(durationMs > 0 ? Math.min(1, elapsed / durationMs) : 1);
          nextFrameAt = Math.max(now, nextFrameAt + 1000 / fps);
          if (!wanted || now - startedAt >= durationMs) {
            break;
          }
        }
      }
      // The closing frame is pushed once more and held. A frame's duration is the gap to the next
      // one, so without this the loop would end one frame short of where it closes — and on a slow
      // machine the encoder still has frames in flight when the loop stops feeding it.
      requestFrame?.();
      await new Promise((resolve) => { setTimeout(resolve, TAIL_HOLD_MS); });
    } finally {
      if (started) {
        if (recorder.state !== "inactive") recorder.stop();
        await stopped;
      }
    }

    if (signal?.aborted) throw new DOMException(tShape("graph3d.exportCancelled"), "AbortError");
    const blob = new Blob(chunks, { type: format.mimeType });
    if (blob.size === 0) throw new Error(tShape("graph3d.videoEmpty"));
    return { ...format, blob, frameCount };
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

/** A hidden tab must still release the recorder on cancellation or timeout. */
function nextVideoFrame(signal: AbortSignal | undefined, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException(tShape("graph3d.exportCancelled"), "AbortError"));
    };
    const frame = requestAnimationFrame(() => { cleanup(); resolve(); });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(tShape("graph3d.recordingFailed")));
    }, Math.max(0, deadline - performance.now()));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
