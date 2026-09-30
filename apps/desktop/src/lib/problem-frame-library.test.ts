// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import { normalizeFrameSvg, type ProblemCustomFrame } from "@/features/document";
import {
  addProblemFrameToLibrary,
  findProblemFrameLibraryEntry,
  getProblemFrameLibrary,
  MAX_PROBLEM_FRAME_LIBRARY_ENTRIES,
  PROBLEM_FRAME_LIBRARY_STORAGE_KEY,
  removeProblemFrameFromLibrary,
  updateProblemFrameInLibrary,
} from "./problem-frame-library";

function frame(stroke = "#123456"): ProblemCustomFrame {
  const drawing = normalizeFrameSvg(`<svg viewBox="0 0 80 50"><rect x="1" y="1" width="78" height="48" fill="none" stroke="${stroke}"/></svg>`);
  if (!drawing.ok) throw new Error("fixture");
  return { svg: drawing.svg, width: 80, height: 50, slice: 12, borderPx: 16, paddingPx: 12 };
}

beforeEach(() => {
  window.localStorage.removeItem(PROBLEM_FRAME_LIBRARY_STORAGE_KEY);
  // The module caches by raw value, so a cleared key is seen on the next read.
});

describe("problem frame library", () => {
  it("keeps every frame the user adds, newest first, and survives a reload", () => {
    const first = addProblemFrameToLibrary(frame("#111111"), "一つ目");
    const second = addProblemFrameToLibrary(frame("#222222"), "二つ目");
    expect(first && second).toBeTruthy();
    expect(getProblemFrameLibrary().map((entry) => entry.name)).toEqual(["二つ目", "一つ目"]);

    const raw = window.localStorage.getItem(PROBLEM_FRAME_LIBRARY_STORAGE_KEY)!;
    expect(JSON.parse(raw)).toHaveLength(2);
  });

  it("renames and redraws one entry without touching the others", () => {
    const a = addProblemFrameToLibrary(frame("#111111"), "A")!;
    const b = addProblemFrameToLibrary(frame("#222222"), "B")!;
    expect(updateProblemFrameInLibrary(a.id, { name: "  新しい名前  ", custom: { ...a.custom, borderPx: 30 } })).toBe(true);

    const library = getProblemFrameLibrary();
    expect(library.find((entry) => entry.id === a.id)).toMatchObject({ name: "新しい名前", custom: { borderPx: 30 } });
    expect(library.find((entry) => entry.id === b.id)?.name).toBe("B");
    expect(updateProblemFrameInLibrary("missing", { name: "x" })).toBe(false);
  });

  it("keeps the old name when it is renamed to nothing", () => {
    const entry = addProblemFrameToLibrary(frame(), "名前")!;
    updateProblemFrameInLibrary(entry.id, { name: "   " });
    expect(getProblemFrameLibrary()[0].name).toBe("名前");
  });

  it("removes an entry", () => {
    const a = addProblemFrameToLibrary(frame("#111111"), "A")!;
    addProblemFrameToLibrary(frame("#222222"), "B");
    expect(removeProblemFrameFromLibrary(a.id)).toBe(true);
    expect(getProblemFrameLibrary().map((entry) => entry.name)).toEqual(["B"]);
    expect(removeProblemFrameFromLibrary(a.id)).toBe(false);
  });

  it("finds the entry a problem's own copy came from by its drawing", () => {
    const entry = addProblemFrameToLibrary(frame("#abcdef"), "探す")!;
    expect(findProblemFrameLibraryEntry({ ...entry.custom, borderPx: 40 })?.id).toBe(entry.id);
    expect(findProblemFrameLibraryEntry(frame("#000000"))).toBeUndefined();
    expect(findProblemFrameLibraryEntry(undefined)).toBeUndefined();
  });

  it("drops the oldest entries past the limit", () => {
    for (let index = 0; index <= MAX_PROBLEM_FRAME_LIBRARY_ENTRIES; index += 1) {
      addProblemFrameToLibrary(frame(`#${String(index).padStart(6, "0")}`), `枠 ${index}`);
    }
    const library = getProblemFrameLibrary();
    expect(library).toHaveLength(MAX_PROBLEM_FRAME_LIBRARY_ENTRIES);
    expect(library[0].name).toBe(`枠 ${MAX_PROBLEM_FRAME_LIBRARY_ENTRIES}`);
  });

  it("ignores stored entries that are not valid frames, and clamps the numbers of the rest", () => {
    const good = frame();
    window.localStorage.setItem(PROBLEM_FRAME_LIBRARY_STORAGE_KEY, JSON.stringify([
      { id: "ok", name: "ok", updatedAt: 1, custom: { ...good, borderPx: 9999, paddingPx: "1px;x" } },
      { id: "bad-svg", name: "bad", updatedAt: 1, custom: { ...good, svg: "<svg onload=\"x()\"></svg>" } },
      { id: "", name: "no id", updatedAt: 1, custom: good },
      "garbage",
    ]));
    const library = getProblemFrameLibrary();
    expect(library.map((entry) => entry.id)).toEqual(["ok"]);
    expect(library[0].custom).toMatchObject({ borderPx: 48, paddingPx: 12 });
  });

  it("reads an unparsable value as an empty shelf", () => {
    window.localStorage.setItem(PROBLEM_FRAME_LIBRARY_STORAGE_KEY, "{not json");
    expect(getProblemFrameLibrary()).toEqual([]);
  });
});
