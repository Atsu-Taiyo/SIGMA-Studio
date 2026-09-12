import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";
import { OVERLAY_MODE_STATUS_LABEL_IDS } from "@/components/editor/page-overlay-types";
import { INLINE_MATH_TEMPLATE_GROUPS } from "@/lib/inline-math-templates";

import { shape as ja } from "./ja/shape";

type DictionaryValue = string | { readonly [key: string]: DictionaryValue };

function flatten(node: DictionaryValue, prefix = "", out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(prefix);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    flatten(value as DictionaryValue, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

const KEYS = flatten(ja as unknown as DictionaryValue);
const LOCALES = ["ja", "en"] as const;
const JAPANESE = /[぀-ヿ一-鿿]/u;

describe("shape namespace resolution", () => {
  it("has a lot of keys (the scan is worthless if the dictionary is empty)", () => {
    expect(KEYS.length).toBeGreaterThan(250);
  });

  it("resolves every key through t() in both locales", () => {
    // **辞書オブジェクトを見るだけでは足りない。** i18next のキー解決はオブジェクトに
    // 当たると打ち切るので、「書いてあるのに引けない」キーが生まれる (WI-4 でコマンド
    // 11 件が実際にそうなった)。必ず `t()` を通す。
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "shape");
      const broken = KEYS.filter((key) => {
        const value = t(key as never) as unknown;
        return typeof value !== "string" || value.length === 0 || value === key;
      });
      expect(broken, `${locale} で引けないキー`).toEqual([]);
    }
  });

  it("never falls back to Japanese in English", () => {
    // `fallbackLng: "ja"` があるので、**英語のキーが抜けても「引ける」検査は緑のまま**
    // 日本語が返ってくる。型の `satisfies TranslationsOf` はキーの有無しか見ないので、
    // 「英語の値として日本語が入っている」はここでしか落ちない。
    const t = createTranslator("en", "shape");
    const japanese = KEYS.filter((key) => JAPANESE.test(t(key as never) as unknown as string));
    expect(japanese, "英語で引くと日本語が返るキー").toEqual([]);
  });

  it("fills every placeholder the string declares", () => {
    // 値バッグを固定で持つと文言を足すたびに保守が要るので、**その文言自身が
    // 宣言している名前**から作る。補間名の日英一致は `parity.test.ts` が見ている。
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "shape");
      for (const key of KEYS) {
        const raw = t(key as never) as unknown as string;
        const names = [...raw.matchAll(/\{\{([^{}]+?)\}\}/gu)].map((m) => (m[1] ?? "").split(",")[0]?.trim() ?? "");
        if (names.length === 0) {
          continue;
        }
        const values = Object.fromEntries(names.map((name) => [name, "1"]));
        expect(t(key as never, { replace: values }) as unknown as string, `${locale} / ${key}`).not.toMatch(/\{\{/u);
      }
    }
  });
});

describe("descriptors the shape namespace has to answer for", () => {
  it("names every math template group", () => {
    // `inline-math-templates.ts` は id しか持たないので、辞書が欠けると見出しが生キーになる。
    expect(INLINE_MATH_TEMPLATE_GROUPS.length).toBeGreaterThan(15);
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "shape");
      for (const { id } of INLINE_MATH_TEMPLATE_GROUPS) {
        const text = t(`mathTemplateGroup.${id}` as never) as unknown as string;
        expect(text, `${locale} / ${id}`).not.toBe(`mathTemplateGroup.${id}`);
        expect(text.length, `${locale} / ${id}`).toBeGreaterThan(0);
      }
    }
  });

  it("names every overlay mode status", () => {
    // `getModeStatus` は文言ではなく `labelId` を返す。id を足して辞書を忘れると
    // 画面に生キーが出るので、**宣言の全件**を回す (runtime 配列にしてあるのはこのため)。
    expect(OVERLAY_MODE_STATUS_LABEL_IDS.length).toBe(21);
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "shape");
      for (const id of OVERLAY_MODE_STATUS_LABEL_IDS) {
        const text = t(`mode.${id}` as never) as unknown as string;
        expect(text, `${locale} / ${id}`).not.toBe(`mode.${id}`);
        expect(text.length, `${locale} / ${id}`).toBeGreaterThan(0);
      }
    }
  });
});
