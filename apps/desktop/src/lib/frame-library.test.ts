// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import { normalizeFrameSvg, type CustomFrame } from "@/features/document";
import {
  addFrameToLibrary,
  findFrameLibraryEntry,
  getFrameLibrary,
  MAX_FRAME_LIBRARY_ENTRIES,
  FRAME_LIBRARY_STORAGE_KEY,
  removeFrameFromLibrary,
  updateFrameInLibrary,
} from "./frame-library";

function frame(stroke = "#123456"): CustomFrame {
  const drawing = normalizeFrameSvg(`<svg viewBox="0 0 80 50"><rect x="1" y="1" width="78" height="48" fill="none" stroke="${stroke}"/></svg>`);
  if (!drawing.ok) throw new Error("fixture");
  return { svg: drawing.svg, width: 80, height: 50, slice: 12, borderPx: 16, paddingPx: 12 };
}

beforeEach(() => {
  window.localStorage.removeItem(FRAME_LIBRARY_STORAGE_KEY);
  // The module caches by raw value, so a cleared key is seen on the next read.
});

describe("frame library", () => {
  it("keeps reading the shelf people filled before boxes could use it", () => {
    // Renaming this key would leave every frame made so far behind, invisible.
    expect(FRAME_LIBRARY_STORAGE_KEY).toBe("sigma-studio:problem-frame-library");
  });

  it("keeps every frame the user adds, newest first, and survives a reload", () => {
    const first = addFrameToLibrary(frame("#111111"), "一つ目");
    const second = addFrameToLibrary(frame("#222222"), "二つ目");
    expect(first && second).toBeTruthy();
    expect(getFrameLibrary().map((entry) => entry.name)).toEqual(["二つ目", "一つ目"]);

    const raw = window.localStorage.getItem(FRAME_LIBRARY_STORAGE_KEY)!;
    expect(JSON.parse(raw)).toHaveLength(2);
  });

  it("renames and redraws one entry without touching the others", () => {
    const a = addFrameToLibrary(frame("#111111"), "A")!;
    const b = addFrameToLibrary(frame("#222222"), "B")!;
    expect(updateFrameInLibrary(a.id, { name: "  新しい名前  ", custom: { ...a.custom, borderPx: 30 } })).toBe(true);

    const library = getFrameLibrary();
    expect(library.find((entry) => entry.id === a.id)).toMatchObject({ name: "新しい名前", custom: { borderPx: 30 } });
    expect(library.find((entry) => entry.id === b.id)?.name).toBe("B");
    expect(updateFrameInLibrary("missing", { name: "x" })).toBe(false);
  });

  it("keeps the old name when it is renamed to nothing", () => {
    const entry = addFrameToLibrary(frame(), "名前")!;
    updateFrameInLibrary(entry.id, { name: "   " });
    expect(getFrameLibrary()[0].name).toBe("名前");
  });

  it("removes an entry", () => {
    const a = addFrameToLibrary(frame("#111111"), "A")!;
    addFrameToLibrary(frame("#222222"), "B");
    expect(removeFrameFromLibrary(a.id)).toBe(true);
    expect(getFrameLibrary().map((entry) => entry.name)).toEqual(["B"]);
    expect(removeFrameFromLibrary(a.id)).toBe(false);
  });

  it("finds the entry a problem's own copy came from by its drawing", () => {
    const entry = addFrameToLibrary(frame("#abcdef"), "探す")!;
    expect(findFrameLibraryEntry({ ...entry.custom, borderPx: 40 })?.id).toBe(entry.id);
    expect(findFrameLibraryEntry(frame("#000000"))).toBeUndefined();
    expect(findFrameLibraryEntry(undefined)).toBeUndefined();
  });

  it("drops the oldest entries past the limit", () => {
    for (let index = 0; index <= MAX_FRAME_LIBRARY_ENTRIES; index += 1) {
      addFrameToLibrary(frame(`#${String(index).padStart(6, "0")}`), `枠 ${index}`);
    }
    const library = getFrameLibrary();
    expect(library).toHaveLength(MAX_FRAME_LIBRARY_ENTRIES);
    expect(library[0].name).toBe(`枠 ${MAX_FRAME_LIBRARY_ENTRIES}`);
  });

  it("ignores stored entries that are not valid frames, and clamps the numbers of the rest", () => {
    const good = frame();
    window.localStorage.setItem(FRAME_LIBRARY_STORAGE_KEY, JSON.stringify([
      { id: "ok", name: "ok", updatedAt: 1, custom: { ...good, borderPx: 9999, paddingPx: "1px;x" } },
      { id: "bad-svg", name: "bad", updatedAt: 1, custom: { ...good, svg: "<svg onload=\"x()\"></svg>" } },
      { id: "", name: "no id", updatedAt: 1, custom: good },
      "garbage",
    ]));
    const library = getFrameLibrary();
    expect(library.map((entry) => entry.id)).toEqual(["ok"]);
    expect(library[0].custom).toMatchObject({ borderPx: 48, paddingPx: 12 });
  });

  it("reads an unparsable value as an empty shelf", () => {
    window.localStorage.setItem(FRAME_LIBRARY_STORAGE_KEY, "{not json");
    expect(getFrameLibrary()).toEqual([]);
  });
});
