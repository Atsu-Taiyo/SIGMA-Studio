import { describe, expect, it } from "vitest";

import { en } from "./en";
import { ja } from "./ja";

type DictionaryValue = string | { readonly [key: string]: DictionaryValue };

function flatten(node: DictionaryValue, prefix = "", out = new Map<string, string>()): Map<string, string> {
  if (typeof node === "string") {
    out.set(prefix, node);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    flatten(value as DictionaryValue, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

/** `{{name}}` / `{{count, number}}` から変数名だけを取り出す。 */
function placeholdersOf(value: string): string[] {
  return [...value.matchAll(/\{\{([^{}]+?)\}\}/gu)]
    .map((match) => (match[1] ?? "").split(",")[0]?.trim() ?? "")
    .filter((name) => name.length > 0)
    .sort();
}

const jaLeaves = flatten(ja as unknown as DictionaryValue);
const enLeaves = flatten(en as unknown as DictionaryValue);

describe("dictionary parity", () => {
  it("declares the same namespaces in both locales", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });

  it("declares every namespace planned for the migration", () => {
    // 12 の移行 WI と 1:1。空でも先出ししておくことで、後続の子 PR が
    // index.ts を編集せずに自分の namespace ファイルだけを埋められる。
    expect(Object.keys(ja).sort()).toEqual([
      "ai",
      "chrome",
      "command",
      "common",
      "editor",
      "error",
      "print",
      "prompt",
      "settings",
      "shape",
      "tex",
      "workspace",
    ]);
  });

  it("has no English key that Japanese lacks", () => {
    expect([...enLeaves.keys()].filter((key) => !jaLeaves.has(key))).toEqual([]);
  });

  it("has no Japanese key that English lacks", () => {
    // 型 (`satisfies TranslationsOf<typeof ja>`) でも守られるが、動的に組み立てた
    // キー (tex の keywords など) は型では追い切れないので実行時にも固定する。
    expect([...jaLeaves.keys()].filter((key) => !enLeaves.has(key))).toEqual([]);
  });

  it("has a non-empty Japanese string for every leaf", () => {
    expect([...jaLeaves].filter(([, value]) => value.trim().length === 0).map(([key]) => key)).toEqual([]);
  });

  it("has a non-empty English string for every leaf", () => {
    expect([...enLeaves].filter(([, value]) => value.trim().length === 0).map(([key]) => key)).toEqual([]);
  });

  it("uses the same interpolation placeholders in both locales", () => {
    const mismatched = [...jaLeaves]
      .filter(([key, value]) => {
        const counterpart = enLeaves.get(key);
        return counterpart === undefined
          || placeholdersOf(value).join("|") !== placeholdersOf(counterpart).join("|");
      })
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });
});
