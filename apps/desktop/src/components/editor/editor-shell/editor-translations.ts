"use client";

import { createCurrentLocaleTranslator,createTranslator,getAppLocale,type AppLocale,type Translate } from "@/lib/i18n";
import { isPersistentRuntime } from "@/lib/runtime";

const editorTextCache: { locale: AppLocale | null; translate: Translate<"editor"> | null } = {
  locale: null,
  translate: null,
};

function resolveEditorTranslate(): Translate<"editor"> {
  const locale = getAppLocale();
  if (editorTextCache.locale !== locale || !editorTextCache.translate) {
    editorTextCache.locale = locale;
    editorTextCache.translate = createTranslator(locale, "editor");
  }
  return editorTextCache.translate;
}

// `TFunction` は補間の型を鍵ごとに推論するオーバーロードの塊で、可変長引数を
// そのまま通すと型が合わない。ここは「同じ引数をそのまま渡す」だけなので
// 二段キャストで包む (キーと補間の検査は呼び出し側で効いたままになる)。
export const tEditor = ((key: string, options?: Record<string, unknown>) =>
  resolveEditorTranslate()(key as never, options as never)) as unknown as Translate<"editor">;

/** ワークスペース / 素材面の文言 (`workspace` namespace)。解決の仕方は `tEditor` と同じ。 */
export const tWorkspace = createCurrentLocaleTranslator("workspace");

/**
 * 起動時の状態表示。**保存先がこのセッション限りのときは、その事実を先に出す。**
 * ブラウザがサイトデータを拒む (プライベートウィンドウ等) と編集自体はできてしまうので、
 * 「準備完了」とだけ出すとタブを閉じた時に黙って消える。
 */
export const storageWarningOrStatus = (status: string): string =>
  isPersistentRuntime() ? status : tWorkspace("error.browserStorageUnavailable");

/** 図形 / グラフ面の文言 (`shape` namespace)。解決の仕方は `tEditor` と同じ。 */
const shapeTextCache: { locale: AppLocale | null; translate: Translate<"shape"> | null } = {
  locale: null,
  translate: null,
};

export const tShape = ((key: string, options?: Record<string, unknown>) => {
  const locale = getAppLocale();
  if (shapeTextCache.locale !== locale || !shapeTextCache.translate) {
    shapeTextCache.locale = locale;
    shapeTextCache.translate = createTranslator(locale, "shape");
  }
  return shapeTextCache.translate(key as never, options as never);
}) as unknown as Translate<"shape">;
/**
 * AI 編集面の文言 (`ai` namespace)。**フックではなく module 直下**なのは、ここから
 * 呼ぶ AI ヘルパが `useMemo` / `useCallback` の中にいて、フック値を足すと依存配列が
 * 軒並み動くため (`tEditor` / `tShape` と同じ理由)。解決は呼び出し時のロケール。
 */
export const tAi = createCurrentLocaleTranslator("ai");

