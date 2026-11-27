/**
 * PDF 取り込みの中間形式。主プロセスが PDF を読んで作り、描画側が SigmaDoc へ組み立てる。
 * 座標はすべて CSS px (96dpi)、原点はページ左上、y は下向き。
 */

export type PdfFontClass = "sans" | "serif" | "mono";

/** 同じ書体・大きさ・色で、同じベースライン上に続く文字の並び。1 つのテキスト図形になる。 */
export interface PdfTextRun {
  text: string;
  /** 1 文字目の原点 (ベースライン上)。 */
  x: number;
  y: number;
  /** 原点から最後の文字の送り幅の終わりまで。ベースライン方向に測る。 */
  width: number;
  fontSizePx: number;
  /** ベースラインの向き (ラジアン、時計回りが正)。 */
  angle: number;
  color: string;
  opacity?: number;
  font: PdfFontClass;
  bold?: boolean;
  italic?: boolean;
}

export interface PdfImportPage {
  widthPx: number;
  heightPx: number;
  runs: PdfTextRun[];
  /** 文字以外 (線・塗り・画像) を描いた自己完結の SVG。何も描かれないページは null。 */
  graphicsSvg: string | null;
}

export interface PdfImportResult {
  pageCount: number;
  pages: PdfImportPage[];
  /** 再現できなかった点 (未対応の描画など)。重複は除いてある。 */
  issues: string[];
}

export interface PdfImportProgress {
  page: number;
  pageCount: number;
}
