import { i18n, type AppNamespace } from "./i18n";
import { getAppLocale } from "./locale-store";
import type { AppLocale } from "./locale";
import type { Translate } from "./translator";

/**
 * **呼び出し時点**の表示言語で解決する `t`。
 *
 * 「`t` を省略できるヘルパ」の既定値に使う。既定を固定ロケールにすると、渡し忘れが
 * **静かに日本語で出る**バグになる (WI-7 で実際に 10 箇所以上そうなった)。呼び出し時に
 * 解決する形なら、渡し忘れても「そのとき表示している言語」に落ちるので害が無い。
 *
 * React の描画中に使うなら `useT` を使うこと。こちらはイベントハンドラ・非同期の完了・
 * 純粋関数など、フックを置けない場所のためのもの。`window` が無い環境 (Node / Electron
 * main / テスト) では `getAppLocale()` が既定ロケールを返すので、既存の期待値は変わらない。
 *
 * `TFunction` はキーごとに補間の型を推論するオーバーロードの塊で、可変長引数をそのまま
 * 通すと型が合わない。ここは同じ引数を素通しするだけなので二段キャストで包む
 * (キーと補間の検査は呼び出し側で効いたまま)。
 */
export function createCurrentLocaleTranslator<Ns extends AppNamespace>(namespace: Ns): Translate<Ns> {
  const cache: { locale: AppLocale | null; translate: Translate<Ns> | null } = {
    locale: null,
    translate: null,
  };
  return ((key: string, options?: Record<string, unknown>) => {
    const locale = getAppLocale();
    if (cache.locale !== locale || !cache.translate) {
      cache.locale = locale;
      cache.translate = i18n.getFixedT(locale, namespace) as unknown as Translate<Ns>;
    }
    return (cache.translate as unknown as (k: string, o?: Record<string, unknown>) => string)(key, options);
  }) as unknown as Translate<Ns>;
}
