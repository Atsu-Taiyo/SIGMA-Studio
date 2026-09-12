import { describe, expect, it } from "vitest";

import {
  idPrefixForTextNode,
  normalizeLayoutSectionColumnCount,
  normalizeNonnegativeNumber,
  normalizeTextAlign,
} from "./normalization";

describe("text-editing normalization", () => {
  it("accepts only canonical text alignments", () => {
    expect(["left", "center", "right", "justify"].map(normalizeTextAlign))
      .toEqual(["left", "center", "right", "justify"]);
    expect(normalizeTextAlign("start")).toBeUndefined();
    expect(normalizeTextAlign(null)).toBeUndefined();
  });

  it("normalizes layout columns into the supported range", () => {
    expect(normalizeLayoutSectionColumnCount("3")).toBe(3);
    expect(normalizeLayoutSectionColumnCount(0)).toBe(1);
    expect(normalizeLayoutSectionColumnCount(9)).toBe(4);
    expect(normalizeLayoutSectionColumnCount("invalid")).toBe(2);
  });

  it("normalizes numeric attributes and node id prefixes", () => {
    expect(normalizeNonnegativeNumber("8.5")).toBe(8.5);
    expect(normalizeNonnegativeNumber(-1)).toBeUndefined();
    expect(normalizeNonnegativeNumber("invalid")).toBeUndefined();
    expect(idPrefixForTextNode("section", "heading")).toBe("section");
    expect(idPrefixForTextNode("listItem", "paragraph")).toBe("li");
    expect(idPrefixForTextNode("paragraph", "heading")).toBe("heading");
    expect(idPrefixForTextNode("paragraph", "paragraph")).toBe("p");
  });
});
