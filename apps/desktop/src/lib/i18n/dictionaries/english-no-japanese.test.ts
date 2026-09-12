import { describe, expect, it } from "vitest";

import { en } from "./en";

type DictionaryValue = string | { readonly [key: string]: DictionaryValue };

function flatten(
  node: DictionaryValue,
  prefix = "",
  out = new Map<string, string>(),
): Map<string, string> {
  if (typeof node === "string") {
    out.set(prefix, node);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    flatten(value as DictionaryValue, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

const INTENTIONAL_JAPANESE = new Set([
  // Locale endonyms are deliberately written in their own language.
  "settings.language.options.ja",
  // Search aliases stay bilingual so a language switch does not invalidate familiar queries.
  "editor.slash.block.quote.aliases",
  "editor.slash.block.codeBlock.aliases",
  "editor.slash.block.divider.aliases",
  "editor.slash.problem.aliases",
]);

describe("English dictionaries", () => {
  it("contain no accidental Japanese fallback in any namespace", () => {
    const japanese = [...flatten(en as unknown as DictionaryValue)]
      .filter(([key, value]) => /[぀-ヿ一-鿿]/u.test(value)
        && !key.startsWith("settings.catalog.keywords.")
        && !INTENTIONAL_JAPANESE.has(key))
      .map(([key]) => key);

    expect(japanese).toEqual([]);
  });
});
