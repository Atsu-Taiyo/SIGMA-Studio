import { describe, expect, it } from "vitest";

import { i18n } from "./i18n";
import { createTranslator } from "./translator";

/** 辞書に無いキーを実行時だけ足して検証するためのゆるい `t`。 */
function loose(translate: unknown): (key: string, values?: Record<string, unknown>) => string {
  return translate as (key: string, values?: Record<string, unknown>) => string;
}

describe("interpolation safety", () => {
  it("never lets an interpolated value resolve another key", () => {
    // `escapeValue: false` なので値は HTML エスケープされない (React のテキスト子として
    // 描くのが前提)。**値の中の `$t(…)` が別のキーへ解決されない**ことは i18next の
    // `skipOnVariables` 既定が担保している。既定に寄りかかっているので実測で固定する。
    expect(i18n.options.interpolation?.skipOnVariables).not.toBe(false);
    const t = createTranslator("ja", "shape");
    const injected = t("adjustment.raw", { replace: { value: "$t(validation.unsafeFontFamily)" } });
    expect(injected).toBe("$t(validation.unsafeFontFamily)");
    expect(injected).not.toContain("フォント");
  });
});

describe("createTranslator", () => {
  it("resolves an English string", () => {
    expect(createTranslator("en", "common")("actions.cancel")).toBe("Cancel");
  });

  it("resolves a Japanese string", () => {
    expect(createTranslator("ja", "common")("actions.cancel")).toBe("キャンセル");
  });

  it("defaults to the common namespace", () => {
    expect(createTranslator("en")("actions.close")).toBe("Close");
  });

  it("resolves a non-default namespace", () => {
    expect(createTranslator("en", "settings")("language.title")).toBe("Language");
  });

  it("is independent of the currently selected app language", async () => {
    await i18n.changeLanguage("ja");
    expect(createTranslator("en", "common")("actions.save")).toBe("Save");
    await i18n.changeLanguage("en");
    expect(createTranslator("ja", "common")("actions.save")).toBe("保存");
    await i18n.changeLanguage("ja");
  });

  it("falls back to Japanese when an English string is missing", () => {
    i18n.addResourceBundle("ja", "common", { fallbackProbe: "日本語だけの文言" }, true, true);
    expect(loose(createTranslator("en", "common"))("fallbackProbe")).toBe("日本語だけの文言");
  });

  it("returns the key itself when neither locale defines it", () => {
    expect(loose(createTranslator("en", "common"))("totally.unknown.key")).toBe("totally.unknown.key");
  });

  it("interpolates {{name}} without HTML-escaping", () => {
    i18n.addResourceBundle("ja", "common", { greetProbe: "こんにちは {{name}} & {{other}}" }, true, true);
    i18n.addResourceBundle("en", "common", { greetProbe: "Hello {{name}} & {{other}}" }, true, true);
    expect(loose(createTranslator("en", "common"))("greetProbe", { name: "<b>Ada</b>", other: "R&D" }))
      .toBe("Hello <b>Ada</b> & R&D");
  });
});
