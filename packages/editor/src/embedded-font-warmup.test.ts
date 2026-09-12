import { afterEach, describe, expect, it, vi } from "vitest";

import { warmEmbeddedEditorFonts } from "./embedded-font-warmup";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

afterEach(() => {
  if (originalFonts) {
    Object.defineProperty(document, "fonts", originalFonts);
  } else {
    delete (document as { fonts?: unknown }).fonts;
  }
  vi.restoreAllMocks();
});

function stubFontSet(overrides: Partial<FontFaceSet>) {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: overrides,
  });
}

describe("warmEmbeddedEditorFonts", () => {
  it("resolves without touching document.fonts when the Font Loading API is unavailable (SSR / older browsers)", async () => {
    // happy-dom doesn't implement document.fonts at all, which already exercises
    // this branch, but assert it explicitly since it's the compatibility
    // guarantee docs/embedding-guide.md promises.
    delete (document as { fonts?: unknown }).fonts;
    await expect(warmEmbeddedEditorFonts()).resolves.toBeUndefined();
  });

  it("loads every KaTeX math face and M PLUS 1p body face, then waits for fonts.ready", async () => {
    const load = vi.fn().mockResolvedValue([]);
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<FontFaceSet>((resolve) => {
      readyResolve = () => resolve([] as unknown as FontFaceSet);
    });
    stubFontSet({ load, ready });

    const warmup = warmEmbeddedEditorFonts();
    // Let the queued `load` calls flush before asserting on them.
    await Promise.resolve();
    await Promise.resolve();

    expect(load).toHaveBeenCalled();
    const specs = load.mock.calls.map(([spec]) => spec as string);
    expect(specs.some((spec) => spec.includes("KaTeX_Main"))).toBe(true);
    expect(specs.some((spec) => spec.includes("KaTeX_Size4"))).toBe(true);
    expect(specs.some((spec) => spec.includes('"M PLUS 1p"'))).toBe(true);
    expect(specs.some((spec) => spec.startsWith("italic 700"))).toBe(true);

    readyResolve?.();
    await expect(warmup).resolves.toBeUndefined();
  });

  it("never hangs behind a font that fails to load or a fonts.ready that never resolves", async () => {
    vi.useFakeTimers();
    stubFontSet({
      load: vi.fn().mockRejectedValue(new Error("network error")),
      ready: new Promise<FontFaceSet>(() => {}),
    });

    const warmup = warmEmbeddedEditorFonts();
    let settled = false;
    warmup.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(warmup).resolves.toBeUndefined();

    vi.useRealTimers();
  });
});
