import { isSigmaValidationError, type SigmaValidationCode } from "@/features/document";
import { createTranslator, DEFAULT_LOCALE, type Translate } from "@/lib/i18n";

/** 既定ロケールの解決器。呼ぶたびに `getFixedT` を作らない。 */
const DEFAULT_SHAPE_TRANSLATE = createTranslator(DEFAULT_LOCALE, "shape");

/**
 * `features/document` が投げるコードを人間が読める一文にする。
 *
 * あの層は最下層で文言を持たない (`SigmaValidationError` はコードと開発者向けの
 * 英語 message だけを運ぶ)。**利用者にも AI にも見せるのはここで解決した文**で、
 * 開発者向け message はログ用。`t` の既定が日本語なのは、既存の呼び出しと
 * AI へ返す文面を変えないため。
 */
export function formatSigmaValidationCode(
  code: SigmaValidationCode,
  values: Readonly<Record<string, number>> = {},
  t: Translate<"shape"> = DEFAULT_SHAPE_TRANSLATE,
): string {
  // `replace` に入れる。options へ直接広げると `lng` / `ns` / `count` / `context` が
  // i18next の予約キーと衝突し、**表示言語や複数形の解決を値が乗っ取れる**
  // (`as never` で型検査も効かないので、構造で塞いでおく)。
  return t(`validation.${code}` as never, { replace: values } as never) as unknown as string;
}

/**
 * 例外を人間が読める一文にする。`SigmaValidationError` でなければ素の message を返す
 * (呼び出し側が `instanceof` で分岐しなくて済む)。
 */
export function formatValidationError(
  error: unknown,
  t: Translate<"shape"> = DEFAULT_SHAPE_TRANSLATE,
): string {
  if (isSigmaValidationError(error)) {
    return formatSigmaValidationCode(error.code, error.values, t);
  }
  return error instanceof Error ? error.message : String(error);
}
