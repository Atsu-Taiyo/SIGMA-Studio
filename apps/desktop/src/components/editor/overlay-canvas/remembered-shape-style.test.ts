import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_OVERLAY_SHAPE_STYLE, type OverlayShapeStyleDefaults } from "@/features/drawing";

import {
  readRememberedShapeStyle,
  rememberShapeStyle,
  resetRememberedShapeStyleForTest,
} from "./remembered-shape-style";

/**
 * The style has to survive a tab switch and a restart, which is why it goes to `localStorage` and
 * not to React state. vitest runs without a DOM, so `window` is installed per test — that also
 * makes the "no storage at all" case (a locked-down embed, private mode) directly testable.
 */

const STORAGE_KEY = "sigma-studio:overlay-shape-style-defaults";

const REMEMBERED: OverlayShapeStyleDefaults = {
  color: "#dc2626",
  strokeOpacity: 0.6,
  dash: "dashed",
  size: "xl",
  arrowheadStart: "diamond",
  arrowheadEnd: "triangle",
  fill: "solid",
  fillColor: "#3366cc",
  fillOpacity: 0,
};

function installStorage(overrides: Partial<Storage> = {}): Map<string, string> {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
    ...overrides,
  } as Storage;
  vi.stubGlobal("window", { localStorage: storage });
  return entries;
}

afterEach(() => {
  resetRememberedShapeStyleForTest();
  vi.unstubAllGlobals();
  resetRememberedShapeStyleForTest();
});

describe("remembering the last shape style", () => {
  it("reads back what was written, including a fully transparent fill", () => {
    installStorage();

    rememberShapeStyle(REMEMBERED);
    resetInMemoryCopy();

    expect(readRememberedShapeStyle()).toEqual(REMEMBERED);
  });

  it("survives a fresh page, which is what a restart looks like from here", () => {
    const entries = installStorage();
    rememberShapeStyle(REMEMBERED);
    const persisted = entries.get(STORAGE_KEY);

    // A new page: the module-level copy is gone, storage is not.
    resetInMemoryCopy();
    vi.unstubAllGlobals();
    const reopened = installStorage();
    reopened.set(STORAGE_KEY, persisted!);

    expect(readRememberedShapeStyle()).toEqual(REMEMBERED);
  });

  it("falls back to the built-in style when the stored entry is broken", () => {
    const entries = installStorage();
    entries.set(STORAGE_KEY, "{not json");

    expect(readRememberedShapeStyle()).toEqual(DEFAULT_OVERLAY_SHAPE_STYLE);
  });

  it("repairs a stored entry that is missing fields", () => {
    const entries = installStorage();
    entries.set(STORAGE_KEY, JSON.stringify({ color: "#00ff00" }));

    expect(readRememberedShapeStyle()).toEqual({ ...DEFAULT_OVERLAY_SHAPE_STYLE, color: "#00ff00" });
  });

  it("keeps working for the rest of the session when storage refuses to write", () => {
    installStorage({
      setItem: () => {
        throw new Error("quota");
      },
    });

    expect(rememberShapeStyle(REMEMBERED)).toEqual(REMEMBERED);
    expect(readRememberedShapeStyle()).toEqual(REMEMBERED);
  });

  it("keeps working where there is no window at all", () => {
    expect(readRememberedShapeStyle()).toEqual(DEFAULT_OVERLAY_SHAPE_STYLE);
    expect(rememberShapeStyle(REMEMBERED)).toEqual(REMEMBERED);
    expect(readRememberedShapeStyle()).toEqual(REMEMBERED);
  });

  it("normalises on the way in, so a bad value cannot be stored", () => {
    installStorage();

    expect(rememberShapeStyle({ ...REMEMBERED, dash: "wavy" as never }).dash)
      .toBe(DEFAULT_OVERLAY_SHAPE_STYLE.dash);
  });
});

/** Drops only the module-level copy, leaving storage as it is. */
function resetInMemoryCopy(): void {
  const saved = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
  resetRememberedShapeStyleForTest();
  if (saved !== null) {
    window.localStorage.setItem(STORAGE_KEY, saved);
  }
}
