import { describe, expect, it } from "vitest";

import { normalizedFamily, selectLocalFontFaces, type LocalFontFace } from "./font-selection";

const face = (family: string, style: string, postscriptName = `${family.replace(/\s/g, "")}-${style}`): LocalFontFace => ({
  family, fullName: `${family} ${style}`, postscriptName, style,
});

describe("selectLocalFontFaces", () => {
  const faces = [
    face("MS Mincho", "Regular"), face("Yu Gothic", "Regular"), face("Yu Gothic", "Bold"),
    face("Yu Gothic", "Italic"), face("Yu Gothic", "Bold Italic"), face("Times New Roman", "Regular"),
  ];

  it("normalizes width, case, spaces and common Japanese family names", () => {
    expect(normalizedFamily("ＭＳ　明朝")).toBe(normalizedFamily("ms mincho"));
    expect(normalizedFamily("HG 創英 角ポップ体")).toContain("soei");
  });

  it("picks the four weights of an exact family and a close family for a missing one", () => {
    const exact = selectLocalFontFaces(faces, ["Yu Gothic"]);
    expect(exact.map((item) => item.style).sort()).toEqual(["Bold", "Bold Italic", "Italic", "Regular"]);
    const fallback = selectLocalFontFaces(faces, ["HG Mincho Unknown"]);
    expect(new Set(fallback.map((item) => item.family))).toEqual(new Set(["MS Mincho"]));
  });

  it("never reads a family the extension already bundles", () => {
    expect(selectLocalFontFaces(faces, ["Yu Gothic"], new Set(["yu gothic"]))).toEqual([]);
  });

  it("bounds the number of faces", () => {
    const many = Array.from({ length: 40 }, (_, index) => face(`Family ${index}`, "Regular"));
    expect(selectLocalFontFaces(many, many.map((item) => item.family)).length).toBeLessThanOrEqual(32);
  });
});
