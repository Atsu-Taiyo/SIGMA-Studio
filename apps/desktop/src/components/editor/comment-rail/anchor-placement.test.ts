import { describe, expect, it } from "vitest";

import { classifyAnchorPlacement, unionRect, type Rect } from "./anchor-placement";

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });
const viewport = rect(0, 100, 900, 800);

describe("classifyAnchorPlacement", () => {
  it("says where the anchor sits relative to the visible window", () => {
    expect(classifyAnchorPlacement(rect(100, 200, 300, 220), viewport)).toBe("visible");
    expect(classifyAnchorPlacement(rect(100, 20, 300, 60), viewport)).toBe("above");
    expect(classifyAnchorPlacement(rect(100, 900, 300, 920), viewport)).toBe("below");
    expect(classifyAnchorPlacement(null, viewport)).toBe("none");
  });

  it("still counts an anchor that is only partly inside as visible", () => {
    expect(classifyAnchorPlacement(rect(100, 60, 300, 140), viewport)).toBe("visible");
    expect(classifyAnchorPlacement(rect(100, 780, 300, 860), viewport)).toBe("visible");
  });
});

describe("unionRect", () => {
  it("bounds every piece of an anchor that wraps over several lines", () => {
    expect(unionRect([rect(100, 200, 300, 220), rect(80, 224, 180, 244)])).toEqual(rect(80, 200, 300, 244));
    expect(unionRect([])).toBeNull();
  });
});
