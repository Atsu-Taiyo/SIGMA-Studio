import { describe, expect, it } from "vitest";

import {
  clampBoxedTextPaddingY,
  getFontFamilyLabel,
  normalizeBoxedTextVariant,
  normalizeToolbarFontFamily,
} from "@/components/editor/editor-shell/toolbar-formatting";
import {
  DEFAULT_FONT_FAMILY_VALUE,
  MAX_BOXED_TEXT_PADDING_Y,
  MIN_BOXED_TEXT_PADDING_Y,
} from "@/components/editor/editor-shell/constants";

describe("editor toolbar formatting", () => {
  it("normalizes absent font families without changing non-empty values", () => {
    expect(normalizeToolbarFontFamily(null)).toBe(DEFAULT_FONT_FAMILY_VALUE);
    expect(normalizeToolbarFontFamily("   ")).toBe(DEFAULT_FONT_FAMILY_VALUE);
    expect(normalizeToolbarFontFamily("Custom Sans")).toBe("Custom Sans");
  });

  it("labels built-in, custom, and arbitrary CSS font stacks", () => {
    expect(getFontFamilyLabel(DEFAULT_FONT_FAMILY_VALUE)).toBe("M PLUS 1p");
    expect(getFontFamilyLabel("custom-value", [{ label: "教材フォント", value: "custom-value" }])).toBe(
      "教材フォント",
    );
    expect(getFontFamilyLabel('"Foo, Bar", system-ui, serif')).toBe("Foo, Bar");
    // 混在選択はツールバーを空欄にする。ここで既定名が出ると「実際に描かれる書体」の嘘になる。
    expect(getFontFamilyLabel("")).toBe("");
    expect(getFontFamilyLabel("system-ui, serif")).toBe("system-ui");
  });

  it("rounds and clamps boxed-text vertical padding", () => {
    expect(clampBoxedTextPaddingY(Number.NaN)).toBe(MIN_BOXED_TEXT_PADDING_Y);
    expect(clampBoxedTextPaddingY(-2)).toBe(MIN_BOXED_TEXT_PADDING_Y);
    expect(clampBoxedTextPaddingY(3.6)).toBe(4);
    expect(clampBoxedTextPaddingY(99)).toBe(MAX_BOXED_TEXT_PADDING_Y);
  });

  it("accepts only the supported boxed-text variants", () => {
    expect(normalizeBoxedTextVariant("frame")).toBe("frame");
    expect(normalizeBoxedTextVariant("shade")).toBe("shade");
    expect(normalizeBoxedTextVariant("unknown")).toBeUndefined();
    expect(normalizeBoxedTextVariant(null)).toBeUndefined();
  });
});
