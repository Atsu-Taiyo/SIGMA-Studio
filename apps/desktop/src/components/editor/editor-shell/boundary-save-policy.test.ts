import { describe, expect, it } from "vitest";

import { classifyBoundarySaveSafety } from "./boundary-save-policy";

describe("classifyBoundarySaveSafety", () => {
  it.each([
    [{ saveOk: true, skipped: false, dirty: false }, "safe"],
    [{ saveOk: false, skipped: false, dirty: false }, "save-failed"],
    [{ saveOk: true, skipped: true, dirty: true }, "dirty-skipped"],
    [{ saveOk: true, skipped: false, dirty: true }, "dirty-unsaved"],
    [{ saveOk: false, skipped: false, dirty: true }, "dirty-unsaved"],
  ])("classifies %o as %s", (input, expected) => {
    expect(classifyBoundarySaveSafety(input)).toBe(expected);
  });
});
