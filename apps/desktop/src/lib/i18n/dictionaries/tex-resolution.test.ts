import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";
import { TEX_COMMAND_REFERENCE_IDS } from "@/lib/tex-command-reference";

import { tex as ja } from "./ja/tex";

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

describe("tex namespace resolution", () => {
  it("covers every stable command-reference id", () => {
    expect(TEX_COMMAND_REFERENCE_IDS).toHaveLength(334);
    expect(Object.keys(ja.reference).sort()).toEqual([...TEX_COMMAND_REFERENCE_IDS].sort());
  });

  it("resolves every key in Japanese and English", () => {
    expect(KEYS.length).toBeGreaterThan(1_000);
    for (const locale of ["ja", "en"] as const) {
      const t = createTranslator(locale, "tex");
      const broken = KEYS.filter((key) => {
        const value = t(key as never, {
          aliases: "x",
          count: 2,
          label: "x",
          max: 100,
          name: "x",
        } as never) as unknown;
        return typeof value !== "string" || value.length === 0 || value === key || value.includes("{{");
      });
      expect(broken, `${locale} で解決できないキー`).toEqual([]);
    }
  });

  it("does not fall back to Japanese in English UI copy or reference metadata", () => {
    const t = createTranslator("en", "tex");
    const japanese = KEYS.filter((key) => /[぀-ヿ一-鿿]/u.test(t(key as never) as unknown as string));
    expect(japanese).toEqual([]);
  });
});
