import { describe, expect, it } from "vitest";

import { isCanonicalFrameSvg, type CustomFrame } from "@/features/document";

import {
  applyCustomFrameDrawing,
  getCustomFrameStyle,
  isCustomFrameImageValue,
  normalizeCustomFrameInput,
  updateCustomFrameGeometry,
} from "./custom-frame";

const CUSTOM: CustomFrame = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40" viewBox="0 0 60 40"><rect width="60" height="40" fill="none" stroke="#000"/></svg>',
  width: 60,
  height: 40,
  slice: 10,
  borderPx: 18,
  paddingPx: 12,
};

describe("getCustomFrameStyle", () => {
  it("hands the stylesheet the same drawing in px for the editor and mm for print", () => {
    const editor = getCustomFrameStyle(CUSTOM, "px");
    const print = getCustomFrameStyle(CUSTOM, "mm");
    expect(editor["--custom-frame-border"]).toBe("18px");
    expect(editor["--custom-frame-padding"]).toBe("12px");
    expect(print["--custom-frame-border"]).toBe("4.763mm");
    expect(print["--custom-frame-slice"]).toBe("10");
  });

  it("gives a piece open at the top and bottom a cropped drawing, so the sides run straight on", () => {
    const style = getCustomFrameStyle(CUSTOM, "px");
    expect(decodeURIComponent(style["--custom-frame-image-closed"])).toContain('viewBox="0 0 60 40"');
    expect(decodeURIComponent(style["--custom-frame-image-open-bottom"])).toContain('viewBox="0 0 60 30"');
    expect(decodeURIComponent(style["--custom-frame-image-open-top"])).toContain('viewBox="0 10 60 30"');
    expect(decodeURIComponent(style["--custom-frame-image-open-both"])).toContain('viewBox="0 10 60 20"');
    // The payload is fully percent-encoded, so it cannot end the `url("…")` or the declaration.
    for (const name of ["closed", "open-bottom", "open-top", "open-both"]) {
      const value = style[`--custom-frame-image-${name}`];
      expect(value).toMatch(/^url\("data:image\/svg\+xml,[^"';]*"\)$/);
      expect(isCustomFrameImageValue(value)).toBe(true);
    }
  });

  it("hands over only the whole drawing to a surface that clips the frame at the break itself", () => {
    const style = getCustomFrameStyle(CUSTOM, "px", "closed");
    expect(Object.keys(style).filter((name) => name.startsWith("--custom-frame-image"))).toEqual(["--custom-frame-image-closed"]);
  });

  it("never writes an untrusted value into a style, however the document was made", () => {
    const hostile = {
      ...CUSTOM,
      borderPx: "1px;position:fixed;inset:0" as unknown as number,
      paddingPx: Number.NaN,
      slice: 1e9,
    };
    const style = getCustomFrameStyle(hostile, "px");
    expect(style["--custom-frame-border"]).toBe("16px");
    expect(style["--custom-frame-padding"]).toBe("12px");
    expect(style["--custom-frame-slice"]).toBe("19");
    for (const value of Object.values(style)) {
      expect(value).not.toMatch(/position|inset/);
    }
  });
});

describe("isCustomFrameImageValue", () => {
  it("lets through only a percent-encoded SVG data URL", () => {
    expect(isCustomFrameImageValue('url("data:image/svg+xml,%3Csvg%3E")')).toBe(true);
    expect(isCustomFrameImageValue('url("data:image/svg+xml,a");color:red')).toBe(false);
    expect(isCustomFrameImageValue('url("https://example.com/a.svg")')).toBe(false);
    expect(isCustomFrameImageValue('url("data:image/svg+xml,a"b")')).toBe(false);
  });
});

describe("applyCustomFrameDrawing", () => {
  const drawing = { svg: CUSTOM.svg, width: 60, height: 40 };

  it("keeps the thickness and padding the user chose, and the corner size while the shape stays", () => {
    const next = applyCustomFrameDrawing({ ...CUSTOM, borderPx: 30, paddingPx: 20, slice: 12 }, drawing);
    expect(next).toMatchObject({ borderPx: 30, paddingPx: 20, slice: 12 });
    const other = applyCustomFrameDrawing(CUSTOM, { ...drawing, width: 160, height: 100 });
    expect(other.slice).toBe(25);
  });

  it("starts from the defaults without a previous frame, and keeps the TikZ source it was given", () => {
    const tikz = { source: "\\draw (0,0) rectangle (1,1);", environment: { packages: "", libraries: "", preamble: "" } };
    expect(applyCustomFrameDrawing(undefined, drawing, { slice: 8, tikz })).toMatchObject({ borderPx: 16, paddingPx: 12, slice: 8, tikz });
  });

  it("changes only the geometry when the sliders move, keeping the drawing and its TikZ source", () => {
    const tikz = { source: "x", environment: { packages: "", libraries: "", preamble: "" } };
    expect(updateCustomFrameGeometry({ ...CUSTOM, tikz }, { borderPx: 24 })).toMatchObject({ svg: CUSTOM.svg, borderPx: 24, tikz });
  });
});

describe("normalizeCustomFrameInput", () => {
  it("stores a loosely written drawing in the canonical form the schema accepts", () => {
    const custom = normalizeCustomFrameInput({ svg: '<svg viewBox="0 0 100 60"><rect width="100" height="60" fill="none" stroke="#000"/></svg>', borderPx: 20 });
    expect(custom).toMatchObject({ width: 100, height: 60, slice: 15, borderPx: 20 });
    expect(isCanonicalFrameSvg(custom!.svg)).toBe(true);
  });

  it("returns nothing without a drawing and refuses a drawing that cannot be used", () => {
    expect(normalizeCustomFrameInput("nope")).toBeUndefined();
    expect(() => normalizeCustomFrameInput({ svg: "<svg><rect/></svg>" }, "frame.custom")).toThrow(/frame\.custom\.svg.*noViewBox/);
  });
});
