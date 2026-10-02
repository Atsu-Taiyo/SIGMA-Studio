import { createTranslator, getAppLocale, type Translate } from "@/lib/i18n";

function createNowTranslator<Ns extends "ai" | "editor">(namespace: Ns): Translate<Ns> {
  const cache: { locale: string | null; translate: Translate<Ns> | null } = { locale: null, translate: null };
  // `TFunction` はキーごとに補間の型を推論するオーバーロードの塊なので、可変長引数を
  // 素通しするだけのここは二段キャストで包む (呼び出し側の検査は効いたまま)。
  return ((key: string, options?: Record<string, unknown>) => {
    const locale = getAppLocale();
    if (cache.locale !== locale || !cache.translate) {
      cache.locale = locale;
      cache.translate = createTranslator(locale, namespace);
    }
    return (cache.translate as unknown as (k: string, o?: Record<string, unknown>) => string)(key, options);
  }) as unknown as Translate<Ns>;
}

export const tAiNow = createNowTranslator("ai");
export const tEditorNow = createNowTranslator("editor");

