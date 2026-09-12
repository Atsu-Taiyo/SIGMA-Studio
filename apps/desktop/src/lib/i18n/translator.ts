import type { TFunction } from "i18next";

import { DEFAULT_NAMESPACE, i18n, type AppNamespace } from "./i18n";
import type { AppLocale } from "./locale";

export type Translate<Ns extends AppNamespace = typeof DEFAULT_NAMESPACE> = TFunction<Ns>;

/**
 * React に依存しない翻訳関数。`electron/*` や `lib/*` のように locale を
 * 引数で受け取れる層はこれを使う (React 層は `./react` の `useT`)。
 */
export function createTranslator<Ns extends AppNamespace = typeof DEFAULT_NAMESPACE>(
  locale: AppLocale,
  namespace: Ns = DEFAULT_NAMESPACE as Ns,
): Translate<Ns> {
  return i18n.getFixedT(locale, namespace);
}
