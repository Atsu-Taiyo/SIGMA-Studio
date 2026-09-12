import { describe, expect, it } from "vitest";

import {
  isSafeCssColor,
  isSafeCssDeclarationValue,
  isSafeCssFontFamily,
  isSafeCssScalar,
  SAFE_FALLBACK_COLOR,
} from "./css-safety";

const SCREEN_COVERING_COLOR =
  "red;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:2147483647";

describe("css safety primitives", () => {
  describe("isSafeCssScalar", () => {
    it("rejects a value that closes the declaration and appends more", () => {
      expect(isSafeCssScalar(SCREEN_COVERING_COLOR)).toBe(false);
    });

    it("rejects values carrying a rule block, a comment, or a fetch", () => {
      expect(isSafeCssScalar("serif}html{display:none")).toBe(false);
      expect(isSafeCssScalar("red/*")).toBe(false);
      expect(isSafeCssScalar("url(https://example.com/x.png)")).toBe(false);
      expect(isSafeCssScalar("\\0000red")).toBe(false);
      expect(isSafeCssScalar("re\nd")).toBe(false);
      expect(isSafeCssScalar("")).toBe(false);
      expect(isSafeCssScalar(`#${"a".repeat(600)}`)).toBe(false);
    });

    it("accepts ordinary scalar values", () => {
      expect(isSafeCssScalar("#1f2937")).toBe(true);
      expect(isSafeCssScalar("rgba(0, 0, 0, 0.5)")).toBe(true);
    });
  });

  describe("isSafeCssColor", () => {
    it("rejects an injected declaration list", () => {
      expect(isSafeCssColor(SCREEN_COVERING_COLOR)).toBe(false);
    });

    it("rejects a url() color", () => {
      expect(isSafeCssColor("url(javascript:alert(1))")).toBe(false);
    });

    it("rejects a color function with an unexpected token", () => {
      expect(isSafeCssColor("rgb(var(--x))")).toBe(false);
    });

    it("accepts every color notation the app itself writes", () => {
      expect(isSafeCssColor("#1f2937")).toBe(true);
      expect(isSafeCssColor("#fff")).toBe(true);
      expect(isSafeCssColor("rgb(255, 0, 0)")).toBe(true);
      expect(isSafeCssColor("rgba(0, 0, 0, 0.5)")).toBe(true);
      expect(isSafeCssColor("hsl(210, 50%, 40%)")).toBe(true);
      expect(isSafeCssColor("black")).toBe(true);
      expect(isSafeCssColor("transparent")).toBe(true);
    });

    it("accepts the fallback the sanitizer substitutes", () => {
      expect(isSafeCssColor(SAFE_FALLBACK_COLOR)).toBe(true);
    });
  });

  describe("isSafeCssFontFamily", () => {
    it("rejects a family list that closes the rule", () => {
      expect(isSafeCssFontFamily("serif;}html{display:none")).toBe(false);
    });

    it("accepts the font stacks the settings UI produces", () => {
      expect(isSafeCssFontFamily("KaTeX_Main, \"M PLUS 1p\", serif")).toBe(true);
      expect(isSafeCssFontFamily("'Hiragino Kaku Gothic ProN', Meiryo, sans-serif")).toBe(true);
      expect(isSafeCssFontFamily("游明朝, YuMincho, serif")).toBe(true);
    });
  });

  describe("isSafeCssDeclarationValue", () => {
    it("rejects values that could add declarations or a rule block", () => {
      expect(isSafeCssDeclarationValue("red;position:fixed")).toBe(false);
      expect(isSafeCssDeclarationValue("1px solid red;z-index:9999")).toBe(false);
      expect(isSafeCssDeclarationValue("red}html{display:none")).toBe(false);
      expect(isSafeCssDeclarationValue("red\\3b position:fixed")).toBe(false);
      expect(isSafeCssDeclarationValue("")).toBe(false);
    });

    it("rejects values that fetch or swallow the declarations after them", () => {
      // An unterminated comment silently eats every following declaration in the same attribute.
      expect(isSafeCssDeclarationValue("red/*")).toBe(false);
      expect(isSafeCssDeclarationValue("url(https://example.com/beacon.png)")).toBe(false);
      expect(isSafeCssDeclarationValue("expression(alert(1))")).toBe(false);
    });

    it("keeps the composite and calc() values the renderers actually produce", () => {
      // `boxed-inline-dom.ts` boxedTextPaddingVars
      expect(isSafeCssDeclarationValue("calc(1.78em + 6px)")).toBe(true);
      // `overlay-table-read-model.ts` getTableRenderedLineStyleModel
      expect(isSafeCssDeclarationValue("1px solid #1f2937")).toBe(true);
      expect(isSafeCssDeclarationValue("KaTeX_Main, \"M PLUS 1p\", serif")).toBe(true);
      expect(isSafeCssDeclarationValue("10.5pt")).toBe(true);
      expect(isSafeCssDeclarationValue("rgba(0, 0, 0, 0.5)")).toBe(true);
    });
  });
});
