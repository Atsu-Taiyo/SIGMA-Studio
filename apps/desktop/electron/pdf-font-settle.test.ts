import { describe, expect, it, vi } from "vitest";

import {
  SETTLE_DOCUMENT_FONTS_MAX_ROUNDS,
  SETTLE_DOCUMENT_FONTS_SOURCE,
  SETTLE_DOCUMENT_FONTS_TIMEOUT_MS,
} from "./pdf-font-settle";

const settleDocumentFontsSource = new Function(`return ${SETTLE_DOCUMENT_FONTS_SOURCE};`)() as (
  doc: unknown,
  maxRounds: number,
  timeoutMs: number,
  timeoutMessage: string,
) => Promise<number>;

const settleDocumentFonts = (doc: unknown, maxRounds: number, timeoutMs = SETTLE_DOCUMENT_FONTS_TIMEOUT_MS) => (
  settleDocumentFontsSource(doc, maxRounds, timeoutMs, "fonts not ready")
);

/**
 * `fonts.ready` がレイアウト前に解決してしまう文書。レイアウト (`getBoundingClientRect`) で初めて
 * 数式のフォントが読み込みを始め、`settleAfterFrames` フレーム後に読み終わる。
 */
function fakeDocument(settleAfterFrames: number, ready: Promise<unknown> = Promise.resolve()) {
  const face = { status: "unloaded" as "unloaded" | "loading" | "loaded" };
  let frames = 0;
  let laidOut = false;
  const doc = {
    body: {
      getBoundingClientRect: () => {
        if (!laidOut) {
          laidOut = true;
          face.status = "loading";
        }
        return {};
      },
    },
    fonts: {
      ready,
      [Symbol.iterator]: function* () {
        yield face;
      },
    },
    defaultView: {
      requestAnimationFrame: (callback: () => void) => {
        frames += 1;
        if (frames >= settleAfterFrames) face.status = "loaded";
        setTimeout(callback, 0);
      },
    },
  };
  return { doc, face, frames: () => frames };
}

describe("SETTLE_DOCUMENT_FONTS_SOURCE", () => {
  it("lays the page out first and waits until no font is still loading", async () => {
    const { doc, face, frames } = fakeDocument(3);
    await settleDocumentFonts(doc, SETTLE_DOCUMENT_FONTS_MAX_ROUNDS);
    expect(face.status).toBe("loaded");
    expect(frames()).toBe(3);
  });

  it("gives up after the round limit instead of holding the export forever", async () => {
    const { doc } = fakeDocument(Number.POSITIVE_INFINITY);
    await expect(settleDocumentFonts(doc, 4)).resolves.toBe(4);
  });

  it("stops the export when a font load never finishes", async () => {
    vi.useFakeTimers();
    try {
      const { doc } = fakeDocument(Number.POSITIVE_INFINITY, new Promise(() => {}));
      const settled = settleDocumentFonts(doc, SETTLE_DOCUMENT_FONTS_MAX_ROUNDS, 5_000);
      const outcome = expect(settled).rejects.toThrow("fonts not ready");
      await vi.advanceTimersByTimeAsync(5_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns at once when the document has no font set", async () => {
    await expect(settleDocumentFonts({ body: null }, 4)).resolves.toBe(0);
  });
});
