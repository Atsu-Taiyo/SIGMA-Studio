/**
 * `features/document` から投げる検証エラー。
 *
 * **文言ではなくコードを運ぶ。** この層は文書モデルの最下層で、
 * `architecture.test.ts` の依存境界により `@/lib/*` (= i18n) を持ち込まない方針
 * (`@/lib` は現状禁止されていないが、「document は最下層」という原則を守る)。
 * 表示する側が `shape.validation.<code>` を引いて文言にする。
 *
 * `message` には**開発者向けの英語**を入れる。ログや `console` に出たときに
 * 読めるようにするためで、利用者へはこれを見せない。
 */
/**
 * **実行時に列挙できる形で持つ。** 型だけの union にすると「全コードが辞書にあるか」を
 * テストが数え上げられず、網羅のつもりが 1 つの fixture が偶然出したコードしか
 * 見ていない検査になる。
 */
export const SIGMA_VALIDATION_CODES = [
  "inlineFormatRange",
  "inlineReplaceRange",
  "inlineMathPartialRange",
  "unsafeFontFamily",
  "fontSizeRange",
  "boxedPaddingRange",
  "emptyFormatPatch",
  "pageSizeRange",
  "pageMarginRange",
  "pageMarginTooWide",
  "pageMarginTooTall",
  "pageColumnCountRange",
  "pageColumnGapRange",
  "pageColumnGapTooWide",
] as const;

export type SigmaValidationCode = (typeof SIGMA_VALIDATION_CODES)[number];

export class SigmaValidationError extends Error {
  readonly code: SigmaValidationCode;
  /**
   * 文言の補間に使う値。キー名は辞書側の `{{name}}` と一致させる。
   *
   * **数値だけを許す。** ここは AI へ返る文面にもログにも流れるので、文書の中身や
   * ファイルパスを載せられる型にしない (現状の全投げ元も数値しか渡していない)。
   */
  readonly values: Readonly<Record<string, number>>;

  constructor(
    code: SigmaValidationCode,
    developerMessage: string,
    values: Readonly<Record<string, number>> = {},
  ) {
    super(developerMessage);
    this.name = "SigmaValidationError";
    this.code = code;
    this.values = values;
  }
}

export function isSigmaValidationError(error: unknown): error is SigmaValidationError {
  return error instanceof SigmaValidationError;
}
