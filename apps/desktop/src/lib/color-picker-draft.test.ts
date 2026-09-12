import { describe, expect, it } from "vitest";

import {
  createColorDraft,
  draftColor,
  draftHex8,
  draftOpacity,
  draftRgb,
  setDraftAlphaPercent,
  setDraftChannel,
  setDraftHexText,
  setDraftHue,
  setDraftSaturationValue,
} from "./color-picker-draft";
import { percentToFillOpacity } from "./fill-opacity";

describe("createColorDraft", () => {
  it("opens on the colour and transparency it was given", () => {
    const draft = createColorDraft({ color: "#cc0000", opacity: 0.4 });

    expect(draft.alphaPercent).toBe(40);
    expect(draft.touched).toBe(false);
    expect(draftColor(draft)).toBe("#cc0000");
  });

  it("treats a fully transparent fill as 0%, not as unset", () => {
    const draft = createColorDraft({ color: "#000000", opacity: 0 });

    expect(draft.alphaPercent).toBe(0);
    expect(draftOpacity(draft)).toBe(0);
  });

  it("falls back to a default colour when the selection has none", () => {
    // "no fill" and "the selection disagrees" both arrive as a null colour; the dialog still has
    // to show something, but it must not count as an edit.
    const draft = createColorDraft({ color: null, opacity: 1 });

    expect(draft.touched).toBe(false);
    expect(draftColor(draft)).toBe("#000000");
    expect(draft.alphaPercent).toBe(100);
  });

  it("shows a colour it cannot parse instead of quietly turning it black", () => {
    const draft = createColorDraft({ color: "red", opacity: 0.5 });

    expect(draft.hexText).toBe("red");
    expect(draft.touched).toBe(false);
    expect(draft.alphaPercent).toBe(50);
  });

  it("spells the hex out with an alpha only when the caller edits one", () => {
    expect(createColorDraft({ color: "#33cc66", opacity: 0.35 }).hexText).toBe("#33cc6659");
    expect(createColorDraft({ color: "#33cc66", opacity: undefined }).hexText).toBe("#33cc66");
  });

  it("reads an omitted opacity as fully opaque", () => {
    const draft = createColorDraft({ color: "#123456", opacity: undefined });

    expect(draft.alphaPercent).toBe(100);
    expect(draft.alphaEnabled).toBe(false);
  });
});

describe("editing the draft", () => {
  const base = createColorDraft({ color: "#3366cc", opacity: 0.4 });

  it("keeps the hue while the colour is dragged through black and white", () => {
    // Black and white have no hue of their own; recomputing it from RGB would snap the 2D area's
    // handle back to red every time the author dragged into a corner.
    const dark = setDraftSaturationValue(base, 0.6, 0);
    const light = setDraftSaturationValue(dark, 0.6, 1);

    expect(base.hsv.h).toBe(220);
    expect(dark.hsv.h).toBe(220);
    expect(light.hsv.h).toBe(220);
  });

  it("keeps the hue when the RGB boxes make the colour grey", () => {
    const evened = setDraftChannel(base, "r", 102);
    const grey = setDraftChannel(evened, "b", 102);

    expect(evened.hsv.h).toBe(240);
    expect(grey.hsv.s).toBe(0);
    expect(grey.hsv.h).toBe(240);
  });

  it("applies a channel and re-spells the hex", () => {
    const next = setDraftChannel(base, "g", 128);

    expect(draftRgb(next)).toEqual({ r: 51, g: 128, b: 204 });
    expect(next.hexText).toBe("#3380cc66");
    expect(next.touched).toBe(true);
  });

  it("clamps channels and percents instead of storing impossible values", () => {
    expect(draftRgb(setDraftChannel(base, "r", -5)).r).toBe(0);
    expect(draftRgb(setDraftChannel(base, "r", 300)).r).toBe(255);
    expect(setDraftAlphaPercent(base, -5).alphaPercent).toBe(0);
    expect(setDraftAlphaPercent(base, 300).alphaPercent).toBe(100);
    expect(setDraftHue(base, 400).hsv.h).toBe(360);
    expect(setDraftSaturationValue(base, 2, -1).hsv).toMatchObject({ s: 1, v: 0 });
  });

  it("reads an 8-digit hex as colour and transparency together", () => {
    const next = setDraftHexText(base, "#ff0000ff");

    expect(draftRgb(next)).toEqual({ r: 255, g: 0, b: 0 });
    expect(next.alphaPercent).toBe(100);
    expect(next.touched).toBe(true);
  });

  it("reads the 4-digit short form", () => {
    const next = setDraftHexText(base, "#ff00");

    expect(draftRgb(next)).toEqual({ r: 255, g: 255, b: 0 });
    expect(next.alphaPercent).toBe(0);
  });

  it("leaves the transparency alone when the typed hex has no alpha", () => {
    const next = setDraftHexText(base, "#00ff00");

    expect(draftRgb(next)).toEqual({ r: 0, g: 255, b: 0 });
    expect(next.alphaPercent).toBe(40);
  });

  it("keeps the text when the author retypes the colour that is already shown", () => {
    // The box is controlled on `hexText`. Collapsing "same colour" to the same draft would drop
    // the keystroke and snap the field back a character, with no way to type it again.
    const shortened = setDraftHexText(base, "#3366c");
    const retyped = setDraftHexText(shortened, "#3366cc66");

    expect(retyped.hexText).toBe("#3366cc66");
    expect(draftRgb(retyped)).toEqual(draftRgb(base));
    expect(setDraftHexText(base, "#3366CC66").hexText).toBe("#3366CC66");
  });

  it("keeps half-typed text on screen without changing the colour", () => {
    const next = setDraftHexText(base, "zz");

    expect(next.hexText).toBe("zz");
    expect(next.hsv).toEqual(base.hsv);
    expect(next.alphaPercent).toBe(base.alphaPercent);
    expect(next.touched).toBe(false);
  });

  it("returns the same draft when nothing actually changes", () => {
    // Pointer moves fire every frame. Identical values have to be identical objects or React
    // re-renders (and re-previews) the whole palette for a drag that stood still.
    expect(setDraftHue(base, base.hsv.h)).toBe(base);
    expect(setDraftSaturationValue(base, base.hsv.s, base.hsv.v)).toBe(base);
    expect(setDraftAlphaPercent(base, base.alphaPercent)).toBe(base);
    expect(setDraftChannel(base, "r", draftRgb(base).r)).toBe(base);
    expect(setDraftHexText(base, base.hexText)).toBe(base);
  });

  it("does not resurrect an unparseable colour by re-spelling it", () => {
    const unparseable = createColorDraft({ color: "red", opacity: 0.5 });

    expect(setDraftHexText(unparseable, "red")).toBe(unparseable);
    expect(unparseable.hexText).toBe("red");
  });
});

describe("reading the draft back out", () => {
  it("converts the percent through the one fill-opacity conversion", () => {
    for (const percent of [0, 1, 35, 50, 99, 100]) {
      const draft = setDraftAlphaPercent(createColorDraft({ color: "#123456", opacity: 1 }), percent);
      expect(draftOpacity(draft), String(percent)).toBe(percentToFillOpacity(percent));
    }
  });

  it("always produces a six-digit colour, so nothing stores an eight-digit one", () => {
    const draft = setDraftAlphaPercent(createColorDraft({ color: "#33cc66", opacity: 1 }), 35);

    expect(draftColor(draft)).toBe("#33cc66");
    expect(draftHex8(draft)).toBe("#33cc6659");
  });
});
