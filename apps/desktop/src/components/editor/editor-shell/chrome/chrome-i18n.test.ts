import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { chrome as jaChrome } from "@/lib/i18n/dictionaries/ja/chrome";

/**
 * `chrome` namespace と、それを使う面のソースを突き合わせる ratchet。
 *
 * 辞書に足したのに使っていないキー (訳し忘れの残骸) と、使っているのに辞書に無いキー
 * (実行時に生キーが画面へ出る) の**両方**を落とす。ESLint の未翻訳検出は「日本語が
 * 残っていないか」しか見ないので、この2つはここでしか捕まらない。
 */

const desktopRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

/** `chrome` namespace を引いている面。ここに無いファイルが t("chrome…") を使うと未使用扱いになる。 */
const CHROME_SOURCES = [
  "src/components/editor/editor-shell/chrome/editor-chrome.tsx",
  "src/components/editor/editor-shell/chrome/chrome-composition.tsx",
  "src/components/editor/editor-shell/formatting-icons.tsx",
  "src/components/editor/overlay-line-style-menus.tsx",
  "src/components/editor/EditorShell.tsx",
  // shell から移した処理も chrome の翻訳関数を受け取るため、使用・未定義の両検査に含める。
  "src/components/editor/editor-shell/use-workspace-document-commands.ts",
  "src/components/editor/editor-shell/use-document-save-boundary.ts",
  "src/features/ai-edit/application/use-ai-proposal-actions.ts",
  "src/components/editor/VersionHistoryPanel.tsx",
  // クロームと語彙を共有する面。線種・文字揃えの語は `chrome.format.*` が唯一の出典なので、
  // ここを入れておかないと「使っているのに辞書に無い」も「誰も使っていない」も見逃す。
  "src/components/editor/EditorSettings.tsx",
  "src/components/editor/overlay-canvas/table-shape-editor.tsx",
];

type DictionaryValue = string | { readonly [key: string]: DictionaryValue };

function flattenKeys(node: DictionaryValue, prefix = "", out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(prefix);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    flattenKeys(value as DictionaryValue, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

const source = CHROME_SOURCES.map((file) => readFileSync(path.join(desktopRoot, file), "utf8")).join("\n");

/** `t("a.b.c")` の完全なキー。 */
const staticKeys = new Set(
  [...source.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/gu)].map((match) => match[1] ?? ""),
);
/** `t(`a.b.${x}`)` の前半。動的キーはここまでしか静的に分からない。 */
const dynamicPrefixes = [
  ...source.matchAll(/\bt\(\s*`([a-zA-Z0-9_.]*?)\$\{/gu),
].map((match) => match[1] ?? "");

const dictionaryKeys = flattenKeys(jaChrome as unknown as DictionaryValue);

function isUsed(key: string): boolean {
  return staticKeys.has(key) || dynamicPrefixes.some((prefix) => prefix.length > 0 && key.startsWith(prefix));
}

describe("chrome namespace usage", () => {
  it("finds the chrome sources", () => {
    // パスがずれて空文字を突き合わせても «全部未使用» にはならず «全部未定義» になるので、
    // 取り違えに気づけるよう最低限の分量を先に固定する。
    expect(source.length).toBeGreaterThan(50_000);
    expect(staticKeys.size).toBeGreaterThan(80);
  });

  it("has no dictionary key that no chrome surface uses", () => {
    expect(dictionaryKeys.filter((key) => !isUsed(key))).toEqual([]);
  });

  it("has no statically referenced key that the dictionary lacks", () => {
    const known = new Set(dictionaryKeys);
    // 他の namespace のキー (settings.* 等) は対象外。chrome の面が引くのは chrome だけ。
    expect([...staticKeys].filter((key) => !known.has(key)).sort()).toEqual([]);
  });
});
