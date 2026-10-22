/**
 * 全角の ASCII 範囲の文字を半角にする (フレームワークに依存しない純粋な関数)。
 *
 * 日本語 IME が開いたまま数式を打つと、`x+1` が `ｘ＋１` (全角) で確定する。数式の中では
 * 全角の英数・記号は意味を持たない (MathLive は演算子としても変数としても読めない) ので、確定した文字を
 * 入力欄へ渡す前に半角へ戻す。かな・漢字は `\text{…}` で使うのでそのまま残す。
 *
 * - U+FF01–U+FF5E (全角の `！`〜`～`) → U+0021–U+007E (半角の `!`〜`~`)
 * - U+3000 (全角スペース) → U+0020
 */
const FULL_WIDTH_ASCII_PATTERN = /[　！-～]/g;
const FULL_WIDTH_OFFSET = 0xfee0;

export function hasFullWidthAscii(text: string): boolean {
  return /[　！-～]/.test(text);
}

export function toHalfWidthAscii(text: string): string {
  return text.replace(FULL_WIDTH_ASCII_PATTERN, (character) => (
    character === "　" ? " " : String.fromCharCode(character.charCodeAt(0) - FULL_WIDTH_OFFSET)
  ));
}
