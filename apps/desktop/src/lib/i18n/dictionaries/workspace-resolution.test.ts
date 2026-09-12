import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import { workspace as ja } from "./ja/workspace";

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

describe("workspace namespace resolution", () => {
  it("has a lot of keys (the scan is worthless if the dictionary is empty)", () => {
    expect(KEYS.length).toBeGreaterThan(200);
  });

  it("resolves every key through t() in both locales", () => {
    // 辞書オブジェクトを見るだけでは足りない。i18next のキー解決はオブジェクトに
    // 当たると打ち切るので「書いてあるのに引けない」キーが生まれる。必ず `t()` を通す。
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "workspace");
      const broken = KEYS.filter((key) => {
        const value = t(key as never) as unknown;
        return typeof value !== "string" || value.length === 0 || value === key;
      });
      expect(broken, `${locale} で引けないキー`).toEqual([]);
    }
  });

  it("never falls back to Japanese in English", () => {
    // `fallbackLng: "ja"` があるので、**英語のキーが抜けても「引ける」検査は緑のまま**
    // 日本語が返る。返り値そのものを見るのが唯一の網。
    const t = createTranslator("en", "workspace");
    const japanese = KEYS.filter((key) => JAPANESE.test(t(key as never) as unknown as string));
    expect(japanese, "英語で引くと日本語が返るキー").toEqual([]);
  });

  /**
   * **これは「補間名が ja/en で一致するか」の検査ではない。** 各文言が自分で
   * 宣言している名前を埋めて、`{{…}}` が残らないことだけを見る。
   * 言語間の補間名の一致は `parity.test.ts` が全 namespace 横断で見ている。
   */
  it("fills every placeholder the string declares", () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "workspace");
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

/**
 * **辞書側から見る検査では足りない** (WI-8b の教訓)。`t("...")` はキーを文字列で
 * 書くので、辞書を整理したときに参照だけが残る。引けなかったキーは例外にならず
 * **キー文字列そのものが画面に出る**ので、気付かないまま出荷できてしまう。
 * だからソース側の参照を数え直して突き合わせる。
 */
describe("every workspace key referenced from source exists", () => {
  const desktopRoot = fileURLToPath(new URL("../../../../", import.meta.url));

  const FILES = ["src", "electron", "mcp"]
    .flatMap((dir) => readdirSync(path.join(desktopRoot, dir), { recursive: true, encoding: "utf8" })
      .map((entry) => path.join(dir, entry)))
    .filter((file) => (file.endsWith(".ts") || file.endsWith(".tsx"))
      && !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
    // 翻訳器を**引数で受け取るだけ**のファイル (`Translate<"workspace">`) も対象。
    // 作る側だけ見ると、キーを持つのに `useT` を呼ばないファイルが検査から落ちる。
    .filter((file) => /useT\(\s*"workspace"\s*\)|createCurrentLocaleTranslator\(\s*"workspace"\s*\)|createTranslator\([^)]*,\s*"workspace"\s*\)|Translate<"workspace">/u
      .test(readFileSync(path.join(desktopRoot, file), "utf8")));

  it("finds the files that use the namespace", () => {
    expect(FILES.length, "workspace の t を作るファイルが見つからない = 走査が壊れている")
      .toBeGreaterThan(15);
  });

  it("has a dictionary entry for every referenced key", () => {
    const t = createTranslator("ja", "workspace");
    const referenced = new Set<string>();
    for (const file of FILES) {
      const source = readFileSync(path.join(desktopRoot, file), "utf8");
      // **この namespace の翻訳器に束縛された名前だけ**を拾う。
      // 1 つのファイルが `t` (editor) と `tWorkspace` (workspace) を両方持つので
      // (`EditorShell.tsx`)、呼び出し名を決め打ちすると他 namespace のキーを
      // 「workspace の辞書に無い」と誤検出する。
      // 素の文字列リテラルも拾わない ("library.json" のような、キーの形をして
      // いるだけの文字列を欠落として誤検出する)。定数表へ持たせたキーは
      // 下の orphan 検査が逆向きに見る。
      const binders = new Set<string>();
      for (const match of source.matchAll(
        /(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:useT|createCurrentLocaleTranslator)\(\s*"workspace"\s*\)/gu,
      )) {
        binders.add(match[1]!);
      }
      for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*createTranslator\([^)]*,\s*"workspace"\s*\)/gu)) {
        binders.add(match[1]!);
      }
      // 引数で受け取るだけのファイルは、その引数名。
      for (const match of source.matchAll(/(\w+)\s*:\s*Translate<"workspace">/gu)) {
        binders.add(match[1]!);
      }
      for (const binder of binders) {
        for (const match of source.matchAll(new RegExp(`\\b${binder}\\(\\s*"([a-zA-Z0-9_.]+)"`, "gu"))) {
          referenced.add(match[1]!);
        }
      }
    }

    expect(referenced.size, "参照が 1 つも取れない = 走査が壊れている").toBeGreaterThan(150);

    const missing = [...referenced]
      .filter((key) => {
        // 複数形キー (`foo_one` / `foo_other`) は `count` を渡さないと解決しない。
        // 素で引いて駄目なら数え上げとして引き直す — これを忘れると、正しく
        // 複数形にしたキーを「辞書に無い」と誤検出する (実際に一度出した)。
        const plain = t(key as never) as unknown;
        if (typeof plain === "string" && plain !== key) {
          return false;
        }
        const counted = t(key as never, { count: 1 }) as unknown;
        return typeof counted !== "string" || counted === key;
      })
      .sort();
    expect(missing, "参照されているのに辞書に無いキー").toEqual([]);
  });

  /**
   * 逆向き: **辞書にあるのにソースのどこからも参照されていないキー**。
   *
   * 前向きの検査 (`t("…")` の参照 → 辞書) は、キーを定数表へ持たせる書き方を
   * 取りこぼす。両方向を見て初めて「辞書とソースが一致している」と言える。
   * 死にキーの検出も兼ねる。
   */
  it("has no dictionary key that nothing references", () => {
    const literals = new Set<string>();
    for (const file of FILES) {
      const source = readFileSync(path.join(desktopRoot, file), "utf8");
      for (const match of source.matchAll(/"([a-zA-Z0-9_.]+)"/gu)) {
        literals.add(match[1]!);
      }
      // `` `tool.${command}` `` のように組み立てるキーは前置きだけ拾う。
      for (const match of source.matchAll(/`([a-zA-Z0-9_.]*?)\$\{/gu)) {
        literals.add(match[1]!);
      }
    }

    const orphans = KEYS.filter((key) => {
      const base = key.replace(/_(one|other)$/u, "");
      if (literals.has(key) || literals.has(base)) {
        return false;
      }
      // テンプレートで組むキー (`tool.` + command) は前置き一致で許す。
      return ![...literals].some((literal) => literal.endsWith(".") && base.startsWith(literal));
    }).sort();

    expect(orphans, "辞書にあるのに誰も参照していないキー").toEqual([]);
  });
});
