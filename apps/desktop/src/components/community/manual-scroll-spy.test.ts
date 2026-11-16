import { describe, expect, it } from "vitest";
import { resolveManualHeading } from "./manual-scroll-spy";
const headings = [
  { id: "workspace", level: 2, top: 0 },
  { id: "create", level: 3, top: 80 },
  { id: "bookmarks", level: 3, top: 180 },
  { id: "editor", level: 2, top: 300 },
  { id: "tabs", level: 3, top: 380 },
];
describe("manual scroll spy", () => {
  it("tracks the finest current subsection and returns to the next parent", () => {
    expect(resolveManualHeading(headings, -20)).toBe("workspace");
    expect(resolveManualHeading(headings, 100)).toBe("create");
    expect(resolveManualHeading(headings, 220)).toBe("bookmarks");
    expect(resolveManualHeading(headings, 310)).toBe("editor");
    expect(resolveManualHeading(headings, 400)).toBe("tabs");
  });
  it("chooses the finest heading at a shared boundary", () => {
    expect(resolveManualHeading([{ id: "parent", level: 2, top: 0 }, { id: "child", level: 3, top: 0 }], 0)).toBe("child");
  });
  it("handles a short final section at the scroll limit and empty content", () => {
    expect(resolveManualHeading(headings, 310, true)).toBe("tabs");
    expect(resolveManualHeading([], 0)).toBeNull();
  });
});
