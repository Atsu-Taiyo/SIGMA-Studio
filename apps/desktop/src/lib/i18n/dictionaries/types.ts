/**
 * 日本語辞書 (SSoT) の形を英語辞書へ課すための型。
 *
 * `Widen` は `as const` が付けた文字列リテラル型を `string` へ広げる。これが無いと
 * 英語辞書に「日本語の文言そのもの」しか代入できなくなる。
 */
export type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

/**
 * 英語辞書に課す型。`satisfies TranslationsOf<typeof ja>` と書くことで
 * **キー欠落は型エラー・キー余剰は余剰プロパティエラー**になる。
 * `as` で書くと両方すり抜けるので使わないこと。
 */
export type TranslationsOf<T> = Widen<T>;
