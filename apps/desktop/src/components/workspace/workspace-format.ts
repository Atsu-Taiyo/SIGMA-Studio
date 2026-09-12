import type { AppLocale } from "@/lib/i18n";
import type { Translate } from "@/lib/i18n/translator";

/**
 * 更新日時の表示。**UI 言語で組む** — 日付の並び (月/日 vs 日/月) と時刻表記は
 * 言語ごとに違うので、`"ja-JP"` 決め打ちだと英語 UI に日本式の並びが残る。
 *
 * `locale` は省略可能にしない。省略できると呼び出し側が黙って落として、
 * 画面のここだけ元の言語で出る (WI-8 の教訓)。
 */
export function formatDateTime(value: string, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * 題名の無い教材の表示名。**表示専用**で、保存される題名ではない
 * (保存側の既定は `lib/blank-document.ts` / `lib/storage.ts` が持つ)。
 */
export function resolveFileDisplayName(file: { title: string }, t: Translate<"workspace">): string {
  return file.title || t("untitledMaterial");
}

export function resolveFolderDisplayName(folder: { name: string }): string {
  return folder.name;
}
