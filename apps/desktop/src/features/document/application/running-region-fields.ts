/**
 * ヘッダー/フッターの差し込み (`{title}` `{page}` `{total}`、および `/title` などの短縮形)。
 *
 * 本文には書いたとおりの文字 (`{page}`) を残し、描くときだけページごとの値に置き換える。
 * 紙面のヘッダー (本文と同じエディタに値を重ねる装飾) と、エディタを持たない静的な描画
 * (埋め込みビューア・サムネイル) が同じ見つけ方・同じ値を使うよう、ここ 1 か所で決める。
 */

export type RunningRegionFieldName = "title" | "page" | "total";

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
