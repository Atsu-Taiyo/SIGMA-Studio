import { readStylesheet as readFileSync } from "../../../tests/helpers/read-stylesheet";

import { describe, expect, it } from "vitest";

import  {
  DEFAULT_BODY_FONT_FAMILY,
  DEFAULT_SERIF_BODY_FONT_FAMILY,
  LEGACY_STANDARD_SERIF_FONT_FAMILY,
  resolveDocumentFontFamily,
} from "./body-font";

/**
 * The toolbar shows the font a caret position is actually drawn with, resolving to this constant
 * wherever nothing overrides it. That is only honest while the constant matches the stylesheet
 * that does the drawing.
 */
describe("default body font", () => {
  it("matches --editor-body-font-family in globals.css", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    const declaration = /--editor-body-font-family:([^;]*);/.exec(css)?.[1];
    expect(declaration).toBeDefined();

    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    expect(normalize(declaration!)).toBe(normalize(DEFAULT_BODY_FONT_FAMILY));
  });

  it("uses the bundled M PLUS face instead of an OS-dependent system font", () => {
    expect(DEFAULT_BODY_FONT_FAMILY)
      .toBe('"M PLUS 1p", "Noto Sans Symbols", "STIX Two Math", sans-serif');
    expect(DEFAULT_BODY_FONT_FAMILY).not.toMatch(/system-ui|Segoe UI|Hiragino|Yu Gothic|Meiryo/);

    const layout = readFileSync(new URL("../../app/layout.tsx", import.meta.url), "utf8");
    for (const weight of [400, 500, 700]) {
      expect(layout).toContain(`@fontsource/m-plus-1p/${weight}.css`);
    }
  });

  it("maps the legacy cross-OS Mincho stack to bundled Noto Serif JP", () => {
    expect(DEFAULT_SERIF_BODY_FONT_FAMILY)
      .toBe('"Noto Serif JP", "Noto Sans Symbols", "STIX Two Math", serif');
    expect(resolveDocumentFontFamily(LEGACY_STANDARD_SERIF_FONT_FAMILY))
      .toBe(DEFAULT_SERIF_BODY_FONT_FAMILY);
    expect(resolveDocumentFontFamily("  'Yu Mincho', serif  ")).toBe("'Yu Mincho', serif");

    const layout = readFileSync(new URL("../../app/layout.tsx", import.meta.url), "utf8");
    expect(layout).toContain("@fontsource/noto-sans-symbols/symbols-400.css");
    expect(layout).toContain("@fontsource/stix-two-math/latin-400.css");
    for (const weight of [400, 500, 700]) {
      expect(layout).toContain(`@fontsource/noto-serif-jp/japanese-${weight}.css`);
    }
  });

  it("keeps application chrome on the platform UI font while document surfaces stay fixed", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/body\s*\{[\s\S]*?font-family:\s*var\(--app-ui-font-family\)/);
    expect(css).toMatch(/\.document-paper\s*\{[\s\S]*?font-family:\s*var\(--editor-body-font-family\)/);
    expect(css).toMatch(/\.page-canvas\s*\{[\s\S]*?font-family:\s*var\(--editor-body-font-family\)/);
  });
});
