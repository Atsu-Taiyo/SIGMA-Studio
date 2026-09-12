/**
 * アプリ表示言語の値域と検出。i18next も React も import しない最下層なので、
 * Electron main / MCP / 純粋ロジック層からも安全に読める。
 */

export const SUPPORTED_LOCALES = ["ja", "en"] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * 既定は日本語。ロケールを決められない環境 (Node / Vitest / OS ロケール不明) は
 * 必ずここへ落ちる。英語へ倒すと日本語を前提にした既存 UI テストが一斉に壊れる。
 */
export const DEFAULT_LOCALE: AppLocale = "ja";

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * BCP 47 タグ (`ja-JP` / `en_GB` / `EN`) を対応ロケールへ畳む。
 * 判定できないときは `null` を返し、既定値の決定は呼び出し側に委ねる。
 */
export function normalizeLocale(tag: string | null | undefined): AppLocale | null {
  if (typeof tag !== "string") {
    return null;
  }
  // 先頭一致ではなく primary subtag の完全一致で判定する。`startsWith("ja")` だと
  // `jam` (Jamaican Creole) のような別言語まで日本語として拾ってしまう。
  const primary = tag.trim().toLowerCase().split(/[-_]/u)[0];
  return isAppLocale(primary) ? primary : null;
}

/**
 * ブラウザ / Electron レンダラが申告する言語タグ。`navigator` が無い実行環境
 * (Node・Vitest の既定 environment・Electron main) では空配列を返す。
 */
export function readNavigatorLanguages(): readonly string[] {
  if (typeof navigator === "undefined" || navigator === null) {
    return [];
  }
  const { languages, language } = navigator;
  if (Array.isArray(languages) && languages.length > 0) {
    return languages;
  }
  return typeof language === "string" && language.length > 0 ? [language] : [];
}

/**
 * OS / ブラウザのロケール。判定できないときは `null`
 * (呼び出し側が {@link DEFAULT_LOCALE} に落とす)。
 */
export function detectLocale(
  tags: readonly string[] = readNavigatorLanguages(),
): AppLocale | null {
  for (const tag of tags) {
    const locale = normalizeLocale(tag);
    if (locale) {
      return locale;
    }
  }
  return null;
}
