import type { PdfFontClass, PdfTextRun } from "./types";

/** 描画順に並んだ 1 文字。原点はベースライン上。 */
export interface PdfGlyph {
  text: string;
  x: number;
  y: number;
  /** 送り幅 (px)。ベースライン方向。 */
  advance: number;
  fontSizePx: number;
  angle: number;
  color: string;
  opacity?: number;
  font: PdfFontClass;
  bold?: boolean;
  italic?: boolean;
}

/** これより狭い隙間は同じ語の中とみなす (em 比)。 */
const SAME_WORD_GAP_EM = 0.12;
/** 欧文の語間として空白 1 つを補う上限 (em 比)。これを超えると別の図形に分ける。 */
const WORD_SPACE_MAX_EM = 1.2;
/** 和文は語間の空白を持たないので、字送りから少しでも離れたら分ける。 */
const CJK_SPLIT_GAP_EM = 0.45;
/** 前の文字へ重なってよい量 (em 比)。カーニング・合成文字を許し、行頭への戻りは分ける。 */
const OVERLAP_EM = 0.35;
/** ベースラインのずれの許容 (em 比)。 */
const BASELINE_EM = 0.18;

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/u;
const LIGATURES = /[ﬀ-ﬆ]/u;

function normalizeGlyphText(text: string): string {
  // 合字は検索・編集できる文字へ戻す。和文の互換文字 (全角英数など) は見た目を保つためそのまま。
  // 制御文字 (U+0000〜U+001F, U+007F) は描画に使えないので空白にする。
  const normalized = LIGATURES.test(text) ? text.normalize("NFKC") : text;
  return Array.from(normalized, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : char;
  }).join("");
}

function sameStyle(a: PdfGlyph, b: PdfGlyph): boolean {
  return a.font === b.font
    && Boolean(a.bold) === Boolean(b.bold)
    && Boolean(a.italic) === Boolean(b.italic)
    && a.color === b.color
    && (a.opacity ?? 1) === (b.opacity ?? 1)
    && Math.abs(a.fontSizePx - b.fontSizePx) <= Math.max(0.05, a.fontSizePx * 0.03)
    && Math.abs(a.angle - b.angle) < 0.01;
}

interface OpenRun {
  first: PdfGlyph;
  text: string;
  /** ベースライン方向の終端 (1 文字目の原点からの距離)。 */
  end: number;
  last: PdfGlyph;
}

function finishRun(run: OpenRun): PdfTextRun | null {
  const trimmedEnd = run.text.replace(/\s+$/u, "");
  const leading = trimmedEnd.length - trimmedEnd.replace(/^\s+/u, "").length;
  const text = trimmedEnd.slice(leading);
  if (!text) return null;
  const { first } = run;
  // 先頭の空白は位置をずらして落とす。末尾の空白は送り幅から外す。
  const leadingWidth = leading > 0 ? first.advance * leading : 0;
  const trailing = run.text.length - trimmedEnd.length;
  const trailingWidth = trailing > 0 ? run.last.advance * trailing : 0;
  const cos = Math.cos(first.angle);
  const sin = Math.sin(first.angle);
  return {
    text,
    x: first.x + cos * leadingWidth,
    y: first.y + sin * leadingWidth,
    width: Math.max(0, run.end - leadingWidth - trailingWidth),
    fontSizePx: first.fontSizePx,
    angle: first.angle,
    color: first.color,
    ...(first.opacity !== undefined && first.opacity < 1 ? { opacity: first.opacity } : {}),
    font: first.font,
    ...(first.bold ? { bold: true } : {}),
    ...(first.italic ? { italic: true } : {}),
  };
}

/**
 * 描画順の文字を、1 つのテキスト図形で再現できる並びへまとめる。
 * 書体・大きさ・色・向きが同じで、同じベースライン上を右へ続く文字だけをつなぐ。
 * 欧文の語間は空白 1 つで表し、それより広い隙間や和文の隙間では図形を分ける
 * (図形の中の字送りは取り込み先の書体で決まるので、広い隙間を空白で埋めると位置がずれる)。
 */
export function groupGlyphsIntoRuns(glyphs: readonly PdfGlyph[]): PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  let open: OpenRun | null = null;
  const flush = () => {
    if (open) {
      const run = finishRun(open);
      if (run) runs.push(run);
      open = null;
    }
  };

  for (const raw of glyphs) {
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y) || !(raw.fontSizePx > 0)) continue;
    const text = normalizeGlyphText(raw.text);
    if (!text) continue;
    const glyph = text === raw.text ? raw : { ...raw, text };
    if (open) {
      const current: OpenRun = open;
      const { first } = current;
      const cos = Math.cos(first.angle);
      const sin = Math.sin(first.angle);
      const dx = glyph.x - first.x;
      const dy = glyph.y - first.y;
      const along = dx * cos + dy * sin;
      const across = -dx * sin + dy * cos;
      const em = first.fontSizePx;
      const gap = along - current.end;
      const isSpace = /^\s+$/u.test(text);
      const prevChar = current.text.slice(-1);
      const cjkBoundary = CJK.test(prevChar) || CJK.test(text[0] ?? "");
      const compatible = sameStyle(first, glyph)
        && Math.abs(across) <= em * BASELINE_EM
        && gap >= -em * OVERLAP_EM;
      if (compatible && (isSpace || gap <= em * SAME_WORD_GAP_EM)) {
        current.text += text;
        current.end = Math.max(current.end, along + glyph.advance);
        current.last = glyph;
        continue;
      }
      if (compatible && !cjkBoundary && gap <= em * WORD_SPACE_MAX_EM && !/\s$/u.test(current.text)) {
        current.text += ` ${text}`;
        current.end = along + glyph.advance;
        current.last = glyph;
        continue;
      }
      if (compatible && cjkBoundary && gap <= em * CJK_SPLIT_GAP_EM) {
        current.text += text;
        current.end = along + glyph.advance;
        current.last = glyph;
        continue;
      }
      flush();
    }
    if (/^\s+$/u.test(text)) continue;
    open = { first: glyph, text, end: glyph.advance, last: glyph };
  }
  flush();
  return runs;
}
