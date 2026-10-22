/**
 * ヘッダー/フッターの差し込み (`{title}` `{page}` `{total}`、および `/title` などの短縮形)。
 *
 * 本文には書いたとおりの文字 (`{page}`) を残し、描くときだけページごとの値に置き換える。
 * 紙面のヘッダー (本文と同じエディタに値を重ねる装飾) と、エディタを持たない静的な描画
 * (埋め込みビューア・サムネイル) が同じ見つけ方・同じ値を使うよう、ここ 1 か所で決める。
 */

export type RunningRegionFieldName = "title" | "page" | "total";

/** `{page}` の数え始め。表紙を 0 ページにしたいときは `pageLayout.pageNumberStart` に 0 を入れる。 */
export const DEFAULT_PAGE_NUMBER_START = 1;
export const MAX_PAGE_NUMBER_START = 9999;

/**
 * 保存された「ページ番号の開始」を読み直す。0 以上 9999 以下の整数だけを受け、
 * それ以外 (負・小数・文字・欠け) は既定の 1 に倒す。
 */
export function normalizePageNumberStart(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_PAGE_NUMBER_START
    ? value
    : DEFAULT_PAGE_NUMBER_START;
}

export interface RunningRegionFieldValues {
  title: string;
  page: number;
  total: number;
}

export interface RunningRegionFieldMatch {
  /** 文字列の中の開始位置 (UTF-16 の単位)。 */
  start: number;
  end: number;
  field: RunningRegionFieldName;
}

const FIELD_PATTERN = /\{title\}|\{page\}|\{total\}|\/\s*title|\/\s*page|\/\s*total/g;

export function findRunningRegionFields(text: string): RunningRegionFieldMatch[] {
  const matches: RunningRegionFieldMatch[] = [];
  for (const match of text.matchAll(FIELD_PATTERN)) {
    const normalized = match[0].replace(/[\s{}/]+/g, "");
    if (normalized === "title" || normalized === "page" || normalized === "total") {
      matches.push({ start: match.index, end: match.index + match[0].length, field: normalized });
    }
  }
  return matches;
}

/** 本文へ書く差し込みの文字 (`{page}` など)。描くときだけ、そのページの値に置き換わる。 */
export function runningRegionFieldToken(field: RunningRegionFieldName): string {
  return `{${field}}`;
}

/**
 * 組版上のページ (1 始まり・全体のページ数) から、紙面に出す `{page}` と `{total}` を決める。
 *
 * `{total}` は最後のページに出る番号と同じにする (開始 0 で 5 ページなら、最後のページは 4、
 * `{total}` も 4。「4/4」と読める)。表示する/しない・ページ専用の文字・移動・PDF のページ位置は
 * 組版上のページのまま扱い、番号を替えるのはこの 2 つの差し込みだけ。
 */
export function getRunningRegionPageNumbers(
  pageNumber: number,
  pageCount: number,
  pageNumberStart?: number,
): { page: number; total: number } {
  const offset = normalizePageNumberStart(pageNumberStart) - DEFAULT_PAGE_NUMBER_START;
  return { page: pageNumber + offset, total: pageCount + offset };
}

/** 描くときに使う差し込みの値 (`title` と、開始番号を反映した `page` / `total`)。 */
export function createRunningRegionFieldValues(
  title: string,
  pageNumber: number,
  pageCount: number,
  pageNumberStart?: number,
): RunningRegionFieldValues {
  return { title, ...getRunningRegionPageNumbers(pageNumber, pageCount, pageNumberStart) };
}

export function resolveRunningRegionField(field: RunningRegionFieldName, values: RunningRegionFieldValues): string {
  if (field === "title") {
    return values.title;
  }
  return String(field === "page" ? values.page : values.total);
}

/** 差し込みを値へ置き換えた文字列。 */
export function renderRunningRegionTemplateText(text: string, values: RunningRegionFieldValues): string {
  let rendered = "";
  let cursor = 0;
  for (const match of findRunningRegionFields(text)) {
    rendered += text.slice(cursor, match.start) + resolveRunningRegionField(match.field, values);
    cursor = match.end;
  }
  return rendered + text.slice(cursor);
}
