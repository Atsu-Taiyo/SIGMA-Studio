import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import { print as ja } from "./ja/print";

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

describe("print namespace resolution", () => {
  it("resolves every key in Japanese and English", () => {
    expect(KEYS.length).toBeGreaterThan(30);
    for (const locale of ["ja", "en"] as const) {
      const t = createTranslator(locale, "print");
      const broken = KEYS.filter((key) => {
        const value = t(key as never, {
          count: 2,
          number: 2,
          page: 1,
          path: "/tmp/material.pdf",
          title: "Material",
          total: 2,
        } as never) as unknown;
        return typeof value !== "string" || value.length === 0 || value === key || value.includes("{{");
      });
      expect(broken, `${locale} で解決できないキー`).toEqual([]);
    }
  });

  it("does not fall back to Japanese in English", () => {
    const t = createTranslator("en", "print");
    const japanese = KEYS.filter((key) => /[぀-ヿ一-鿿]/u.test(t(key as never) as unknown as string));
    expect(japanese).toEqual([]);
  });
});
