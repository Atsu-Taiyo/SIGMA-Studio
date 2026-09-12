import { describe, expect, it } from "vitest";

import { SIGMA_VALIDATION_CODES, SigmaValidationError } from "@/features/document";
import { formatInlineNodeRange } from "@/features/document/application/inline-format-operation";
import { getPageLayoutIssues } from "@/features/document/application/page-layout";
import { normalizePageLayout } from "@/lib/page-layout";
import { createTranslator } from "@/lib/i18n";

import { formatSigmaValidationCode, formatValidationError } from "./validation-text";

describe("validation code formatting", () => {
  it("turns a code into a sentence, in the requested language", () => {
    expect(formatSigmaValidationCode("pageMarginTooWide")).toBe("左右の余白が用紙幅以上になっています。");
    expect(formatSigmaValidationCode("pageMarginTooWide", {}, createTranslator("en", "shape")))
      .toBe("The left and right margins leave no room for the body.");
  });

  it("fills the interpolated value", () => {
    expect(formatSigmaValidationCode("pageMarginTooTall", { min: 30 })).toContain("30mm");
  });

  it("never leaks the developer-facing English message to a caller", () => {
    // `SigmaValidationError.message` は**ログ用の英語**。利用者にも AI にも
    // 見せるのは辞書から解決した文だけ。
    let thrown: unknown;
    try {
      formatInlineNodeRange([{ type: "text", text: "本文" }], 0, 2, { fontFamily: "serif;}html{display:none" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SigmaValidationError);
    expect((thrown as Error).message).toMatch(/^[\x20-\x7e]+$/u);
    expect(formatValidationError(thrown)).toBe("このフォント指定は使用できません。");
  });

  it("passes a non-validation error through untouched", () => {
    expect(formatValidationError(new Error("boom"))).toBe("boom");
  });

  it("resolves every declared code in both locales", () => {
    // **1 つの fixture が偶然出したコードだけ**を見ると、コードを足して辞書を忘れた
    // ときに素通りする。宣言の全件を回す (runtime 配列にしてあるのはこのため)。
    expect(SIGMA_VALIDATION_CODES.length).toBe(14);
    for (const locale of ["ja", "en"] as const) {
      const t = createTranslator(locale, "shape");
      for (const code of SIGMA_VALIDATION_CODES) {
        const text = formatSigmaValidationCode(code, { min: 30 }, t);
        expect(text, `${locale} / ${code}`).not.toBe(`validation.${code}`);
        expect(text, `${locale} / ${code}`).not.toMatch(/\{\{/u);
        expect(text.length, `${locale} / ${code}`).toBeGreaterThan(0);
      }
    }
  });

  it("never falls back to Japanese in English", () => {
    // `fallbackLng: "ja"` があるので、**英語のキーが抜けても「引ける」検査は緑のまま**
    // 日本語が返る (型の `satisfies TranslationsOf` は守るが、実行時の網は別に要る)。
    const japanese = /[\u3040-\u30ff\u4e00-\u9fff]/u;
    const t = createTranslator("en", "shape");
    const leaked = SIGMA_VALIDATION_CODES
      .filter((code) => japanese.test(formatSigmaValidationCode(code, { min: 30 }, t)));
    expect(leaked, "英語で引くと日本語が返るコード").toEqual([]);
  });

  it("covers what the page layout validator actually emits", () => {
    const layout = normalizePageLayout({
      preset: "custom",
      pageSize: { widthMm: 100, heightMm: 100 },
      marginsMm: { left: 60, right: 45, top: 60, bottom: 45 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 200 },
    });
    const codes = getPageLayoutIssues(layout);
    expect(codes).toContain("pageMarginTooWide");
    expect(codes.every((code) => SIGMA_VALIDATION_CODES.includes(code))).toBe(true);
  });
});
