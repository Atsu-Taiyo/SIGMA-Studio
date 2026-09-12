import { describe, expect, it } from "vitest";

import {
  alphaByteToPercent,
  formatHex6,
  formatHex8,
  hsvToRgb,
  parseHexColor,
  percentToAlphaByte,
  rgbToHsv,
} from "./color";

describe("parseHexColor", () => {
  it("reads every hex spelling of the same colour as the same colour", () => {
    const red = { r: 255, g: 0, b: 0 };
    for (const input of ["#f00", "f00", "#FF0000", " #ff0000 ", "#ff0000ff", "#f00f", "FF0000FF"]) {
      expect(parseHexColor(input)?.rgb, input).toEqual(red);
    }
  });

  it("reports a fully transparent colour as alpha 0 rather than as unparseable", () => {
    // `0` is falsy, so an implementation that tests the alpha for truthiness reports this as
    // "no alpha given" and silently repaints a transparent colour as opaque.
    const parsed = parseHexColor("#ff000000");

    expect(parsed).not.toBeNull();
    expect(parsed?.alpha).toBe(0);
    expect(parsed?.hasAlpha).toBe(true);
  });

  it("says whether the text carried an alpha at all", () => {
    expect(parseHexColor("#ff0000")?.hasAlpha).toBe(false);
    expect(parseHexColor("#ff0000")?.alpha).toBe(255);
    expect(parseHexColor("#f00")?.hasAlpha).toBe(false);
    expect(parseHexColor("#f00f")?.hasAlpha).toBe(true);
  });

  it("refuses everything that is not a hex colour", () => {
    // Named and functional CSS colours stay unparsed on purpose: the palette stores what it can
    // round-trip, and a colour it cannot round-trip must be shown rather than rewritten.
    for (const input of ["", "   ", "#", "#12", "#12345", "#1234567", "#gg0000", "rgb(255,0,0)", "red", "#ff0000f"]) {
      expect(parseHexColor(input), input).toBeNull();
    }
  });
});

describe("formatHex6 / formatHex8", () => {
  it("zero-pads and lowercases", () => {
    expect(formatHex6({ r: 0, g: 0, b: 255 })).toBe("#0000ff");
    expect(formatHex8({ r: 0, g: 0, b: 0 }, 0)).toBe("#00000000");
    expect(formatHex8({ r: 255, g: 255, b: 255 }, 255)).toBe("#ffffffff");
    expect(formatHex8({ r: 51, g: 204, b: 102 }, 89)).toBe("#33cc6659");
  });

  it("clamps and rounds out-of-range channels instead of emitting broken hex", () => {
    expect(formatHex6({ r: -5, g: 300, b: 12.4 })).toBe("#00ff0c");
    expect(formatHex8({ r: 0, g: 0, b: 0 }, 400)).toBe("#000000ff");
  });
});

describe("rgbToHsv / hsvToRgb", () => {
  it("round-trips every colour it is given", () => {
    const steps = [0, 36, 73, 109, 146, 182, 219, 255];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const rgb = { r, g, b };
          expect(hsvToRgb(rgbToHsv(rgb)), `${r},${g},${b}`).toEqual(rgb);
        }
      }
    }
  });

  it("round-trips the channel extremes", () => {
    for (const rgb of [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
      { r: 1, g: 0, b: 0 },
      { r: 254, g: 255, b: 253 },
      { r: 128, g: 128, b: 129 },
    ]) {
      expect(hsvToRgb(rgbToHsv(rgb))).toEqual(rgb);
    }
  });

  it("reports greys as having no saturation", () => {
    for (const grey of ["#000000", "#ffffff", "#808080"]) {
      const rgb = parseHexColor(grey)!.rgb;
      expect(rgbToHsv(rgb).s, grey).toBe(0);
      expect(rgbToHsv(rgb).h, grey).toBe(0);
    }
  });

  it("keeps the hue inside 0..360 whatever it is handed", () => {
    expect(hsvToRgb({ h: 360, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb({ h: -120, s: 1, v: 1 })).toEqual({ r: 0, g: 0, b: 255 });
    expect(hsvToRgb({ h: 480, s: 1, v: 1 })).toEqual({ r: 0, g: 255, b: 0 });
  });
});

describe("alphaByteToPercent / percentToAlphaByte", () => {
  it("round-trips every whole percent", () => {
    // The dialog shows percents and the hex field shows bytes; a single lossy step here would let
    // the two disagree and make an untouched value drift on every reopen.
    for (let percent = 0; percent <= 100; percent += 1) {
      expect(alphaByteToPercent(percentToAlphaByte(percent)), String(percent)).toBe(percent);
    }
  });

  it("keeps the endpoints exact", () => {
    expect(percentToAlphaByte(0)).toBe(0);
    expect(percentToAlphaByte(100)).toBe(255);
    expect(alphaByteToPercent(0)).toBe(0);
    expect(alphaByteToPercent(255)).toBe(100);
  });

  it("clamps rather than producing an impossible byte", () => {
    expect(percentToAlphaByte(-5)).toBe(0);
    expect(percentToAlphaByte(300)).toBe(255);
    expect(alphaByteToPercent(-5)).toBe(0);
    expect(alphaByteToPercent(900)).toBe(100);
  });
});
