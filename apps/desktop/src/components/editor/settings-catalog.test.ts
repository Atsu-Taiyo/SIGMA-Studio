import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { settings as jaSettings } from "@/lib/i18n/dictionaries/ja/settings";

import {
  SETTINGS_ENTRIES,
  SETTINGS_SURFACE_SOURCES,
  findSettingsEntry,
  getSettingsEntriesForSurface,
} from "./settings-catalog";

/**
 * 設定カタログの契約を固定する。**WI-4 のコマンドパレットはこれを唯一の索引源にする**ので、
 * 「anchorId が実在する」「labelKey が辞書に在る」「id が一意」の3つが崩れると、パレットは
 * 黙って «開くけれど何も選ばれていない» / «生キーが並ぶ» 状態になる。
 *
 * 目印には **`id` 属性**を使う (`arrowhead-parity.test.ts` と同じソース走査方式)。日本語
 * リテラルを目印にすると、その面を i18n 化した WI が文言を差し替えた瞬間に壊れる —
 * WI-2 で `line-height-menu.test.ts` が実際にそうなった。
 *
 * **限界**: ソース走査で分かるのは「その id がファイルに書いてある」ことまでで、折りたたみや
 * タブの裏に居て**実際には描かれない** anchor は素通りする。実描画の到達性は
 * `settings-entry-focus.test.tsx` が本当にマウントして確かめている (ブリッジ不要の面のみ)。
 */

const desktopRoot = fileURLToPath(new URL("../../../", import.meta.url));

const sourceCache = new Map<string, string>();
function readSurfaceSource(relativePath: string): string {
  const cached = sourceCache.get(relativePath);
  if (cached !== undefined) {
    return cached;
  }
  const source = readFileSync(path.join(desktopRoot, relativePath), "utf8");
  sourceCache.set(relativePath, source);
  return source;
}

type DictionaryValue = string | { readonly [key: string]: DictionaryValue };

function resolveKey(key: string): DictionaryValue | undefined {
  let node: DictionaryValue | undefined = jaSettings as unknown as DictionaryValue;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    node = node[segment];
  }
  return node;
}

/**
 * `anchorId` はソースに **リテラルで** 現れること。テンプレートで組み立てた id は
 * ここから追えないので、そういう面は呼び出し側からリテラルの `sectionId` を渡す形にしてある。
 */
function declaresId(source: string, anchorId: string): boolean {
  return source.includes(`id="${anchorId}"`) || source.includes(`sectionId="${anchorId}"`);
}

describe("settings catalog", () => {
  it("gives every entry a unique id", () => {
    const ids = SETTINGS_ENTRIES.map((entry) => entry.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it("uses the settings namespace for every label key", () => {
    const missing = SETTINGS_ENTRIES
      .filter((entry) => typeof resolveKey(entry.labelKey) !== "string")
      .map((entry) => `${entry.id} -> ${entry.labelKey}`);
    expect(missing).toEqual([]);
  });

  it("uses the settings namespace for every description key", () => {
    const missing = SETTINGS_ENTRIES
      .filter((entry) => entry.descriptionKey !== undefined && typeof resolveKey(entry.descriptionKey) !== "string")
      .map((entry) => `${entry.id} -> ${entry.descriptionKey ?? ""}`);
    expect(missing).toEqual([]);
  });

  it("uses the settings namespace for every keywords key", () => {
    const missing = SETTINGS_ENTRIES
      .filter((entry) => entry.keywordsKey !== undefined && typeof resolveKey(entry.keywordsKey) !== "string")
      .map((entry) => `${entry.id} -> ${entry.keywordsKey ?? ""}`);
    expect(missing).toEqual([]);
  });

  it("anchors every entry to an id that really exists in its surface", () => {
    const missing = SETTINGS_ENTRIES
      .filter((entry) => entry.anchorId !== undefined)
      .filter((entry) => !declaresId(readSurfaceSource(SETTINGS_SURFACE_SOURCES[entry.surface]), entry.anchorId ?? ""))
      .map((entry) => `${entry.id} -> ${entry.anchorId ?? ""} (${SETTINGS_SURFACE_SOURCES[entry.surface]})`);
    expect(missing).toEqual([]);
  });

  it("keeps every surface source readable", () => {
    // パスがずれると「anchorId が全部無い」ではなく「読めない」で落ちてほしい。
    for (const relativePath of Object.values(SETTINGS_SURFACE_SOURCES)) {
      expect(readSurfaceSource(relativePath).length).toBeGreaterThan(1_000);
    }
  });

  it("indexes at least as many entries as the desktop settings modal has rows", () => {
    // 索引漏れの検出。設定行を足したのにカタログへ入れ忘れると、その項目は
    // パレットから永久に見つからない。
    const source = readSurfaceSource(SETTINGS_SURFACE_SOURCES.desktopApp);
    const rowCount = (source.match(/<SettingsRow\b/gu) ?? []).length;
    const indexed = getSettingsEntriesForSurface("desktopApp").length
      + getSettingsEntriesForSurface("desktopAi").length;
    expect(indexed).toBeGreaterThanOrEqual(rowCount);
  });

  it("covers every surface", () => {
    const surfaces = new Set(SETTINGS_ENTRIES.map((entry) => entry.surface));
    expect([...surfaces].sort()).toEqual(Object.keys(SETTINGS_SURFACE_SOURCES).sort());
  });

  it("finds an entry by id", () => {
    expect(findSettingsEntry("settings.app.language")?.anchorId).toBe("desktop-settings-language-row");
    expect(findSettingsEntry("settings.app.nope")).toBeUndefined();
  });
});
