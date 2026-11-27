import {
  DEFAULT_BODY_FONT_FAMILY,
  DEFAULT_SERIF_BODY_FONT_FAMILY,
  fontSizeToOverlaySize,
  getPageMetrics,
  PAGE_GAP_PX,
  type OverlayAsset,
  type OverlayShape,
  type PageLayout,
  type SigmaDocument,
  type TextMark,
} from "@/features/document";
import { getRotatedShapeVisualBounds } from "@/features/drawing";
import type { PdfFontClass, PdfImportResult, PdfTextRun } from "./types";

const PX_PER_PT = 96 / 72;
const MM_PER_PX = 25.4 / 96;
const MONO_FONT_FAMILY = '"Noto Sans Mono", "Menlo", "Consolas", monospace';

export interface PdfTextFace {
  font: PdfFontClass;
  bold: boolean;
  italic: boolean;
}

/**
 * 取り込み先の書体で文字を測る。描画側では canvas の measureText、テストでは固定値を渡す。
 * 幅は fontSizePx の文字列を 1 行に並べたときの送り幅 (px)。
 * ascent / descent は em 比 (行高 1 の行で、ベースラインを上下どこに置くかを決める)。
 */
export interface PdfTextMeasurer {
  width(text: string, face: PdfTextFace, fontSizePx: number): number;
  metrics(face: PdfTextFace): { ascent: number; descent: number };
}

export interface PdfDocumentBuildOptions {
  filename: string;
  importedAt: string;
  measurer: PdfTextMeasurer;
  /** 図形・素材 id の接頭辞。同じ PDF を 2 回取り込んでも id が衝突しないようにする。 */
  idPrefix: string;
}

export const PDF_IMPORT_ACCEPT = ".pdf,application/pdf";
export const PDF_OVERLAY_EXTENSION = "sigma.pdf";

export function isPdfFilename(filename: string): boolean {
  return /\.pdf$/iu.test(filename.trim());
}

export function pdfFontFamily(font: PdfFontClass): string {
  return font === "serif" ? DEFAULT_SERIF_BODY_FONT_FAMILY : font === "mono" ? MONO_FONT_FAMILY : DEFAULT_BODY_FONT_FAMILY;
}

const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 紙面の境界を内側へ丸め、端数で空白ページが増えるのを防ぐ。 */
function roundDown(value: number): number {
  return Math.floor(value * 1000) / 1000;
}

/** 最も多いページ寸法を教材の用紙にする (SigmaDoc の用紙は 1 種類)。 */
function dominantPageSize(result: PdfImportResult): { widthPx: number; heightPx: number } {
  const counts = new Map<string, { widthPx: number; heightPx: number; count: number }>();
  for (const page of result.pages) {
    const key = `${Math.round(page.widthPx)}x${Math.round(page.heightPx)}`;
    const entry = counts.get(key) ?? { widthPx: page.widthPx, heightPx: page.heightPx, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  let best: { widthPx: number; heightPx: number; count: number } | undefined;
  for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
  return best ?? { widthPx: 794, heightPx: 1123 };
}

function buildPageLayout(widthPx: number, heightPx: number, shapes: OverlayShape[], assets: Record<string, OverlayAsset>): PageLayout {
  const widthMm = round(widthPx * MM_PER_PX, 4);
  const heightMm = round(heightPx * MM_PER_PX, 4);
  return {
    preset: "custom",
    orientation: widthMm >= heightMm ? "landscape" : "portrait",
    pageSize: { widthMm, heightMm },
    marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
    header: {
      enabled: false, heightMm: 8, offsetMm: 0, showOnFirstPage: true,
      blocks: [{ type: "paragraph", id: "pdf_page_header_empty", children: [] }],
    },
    footer: {
      enabled: false, heightMm: 8, offsetMm: 0, showOnFirstPage: true,
      blocks: [{ type: "paragraph", id: "pdf_page_footer_empty", children: [] }],
    },
    overlay: { overlaySnapshot: { version: 1, shapes, assets } },
  };
}

function encodeSvgDataUrl(svg: string): string {
  // base64 にすると埋め込み画像の base64 をさらに 4/3 倍にする。SVG の文字のまま URL 符号化する。
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function runToTextShape(
  run: PdfTextRun,
  id: string,
  pageOffsetY: number,
  measurer: PdfTextMeasurer,
): OverlayShape {
  const face: PdfTextFace = { font: run.font, bold: Boolean(run.bold), italic: Boolean(run.italic) };
  const { ascent, descent } = measurer.metrics(face);
  // 行高 1 の行の中で、ベースラインは上端から 0.5em + (ascent - descent) / 2 の位置に来る。
  const baselineFromTop = run.fontSizePx * (0.5 + (ascent - descent) / 2);
  const measured = measurer.width(run.text, face, run.fontSizePx);
  // 取り込み先の書体で幅が変わる分は、図形の横倍率で PDF の幅へ合わせる (折り返しはしない)。
  const textScaleX = measured > 0 && run.width > 0
    ? Math.min(3, Math.max(0.33, run.width / measured))
    : 1;
  const width = Math.max(1, run.width > 0 ? run.width : measured);
  const marks: TextMark[] = [
    ...(face.bold ? ["bold" as const] : []),
    ...(face.italic ? ["italic" as const] : []),
  ];
  const fontSizePt = round(run.fontSizePx / PX_PER_PT, 2);
  const height = Math.max(1, run.fontSizePx);
  // 回転は図形の中心で掛かる。回転後にベースラインの始点 (図形内の (0, baseline)) が
  // PDF の原点へ来るよう、中心から左上を逆算する。
  const rotated = Math.abs(run.angle) > 0.0005;
  let x = run.x;
  let y = run.y - baselineFromTop;
  if (rotated) {
    const sin = Math.sin(run.angle);
    const cos = Math.cos(run.angle);
    const vx = -width / 2;
    const vy = baselineFromTop - height / 2;
    const centerX = run.x - (vx * cos - vy * sin);
    const centerY = run.y - (vx * sin + vy * cos);
    x = centerX - width / 2;
    y = centerY - height / 2;
  }
  return {
    id,
    type: "text",
    x: round(x),
    y: round(pageOffsetY + y),
    ...(rotated ? { rotation: round(run.angle, 5) } : {}),
    ...(run.opacity !== undefined ? { opacity: round(run.opacity) } : {}),
    anchor: { type: "page" },
    props: {
      w: round(width),
      h: round(height),
      blocks: [{
        type: "paragraph",
        id: `${id}_p`,
        children: [{
          type: "text",
          text: run.text,
          fontFamily: pdfFontFamily(run.font),
          ...(marks.length ? { marks } : {}),
        }],
      }],
      color: run.color,
      fontSize: fontSizePt,
      size: fontSizeToOverlaySize(fontSizePt),
      textWrap: "none",
      ...(Math.abs(textScaleX - 1) > 0.005 ? { textScaleX: round(textScaleX, 4) } : {}),
    },
  };
}

/**
 * 抽出結果を、ページ固定の SigmaDoc にする。PowerPoint 取り込みと同じく、各ページは
 * ページ絶対座標の図形だけで描き、本文は空の段落 1 つだけにする (本文の流し込みでページを動かさない)。
 * 文字は編集できるテキスト図形、線・塗り・画像はページごとの背景 SVG 画像になる。
 */
export function buildPdfImportDocument(result: PdfImportResult, options: PdfDocumentBuildOptions): SigmaDocument {
  const { widthPx, heightPx } = dominantPageSize(result);
  // ページ送りは教材の用紙設定から読み戻す。mm への丸めで 1 ページあたりの端数が積もるのを防ぐ。
  const metrics = getPageMetrics(buildPageLayout(widthPx, heightPx, [], {}));
  const stride = metrics.page.heightPx + PAGE_GAP_PX;
  const shapes: OverlayShape[] = [];
  const assets: Record<string, OverlayAsset> = {};
  const prefix = options.idPrefix;

  result.pages.forEach((page, pageIndex) => {
    const pageOffsetY = pageIndex * stride;
    const pageBottom = roundDown(pageOffsetY + metrics.page.heightPx);
    const pageNo = pageIndex + 1;
    // 用紙に収まらないページだけ縮める。背景と文字に同じ倍率を使い、紙面内の位置を揃える。
    const scale = Math.min(1, metrics.page.widthPx / page.widthPx, metrics.page.heightPx / page.heightPx);
    if (page.graphicsSvg) {
      const assetId = `${prefix}_p${pageNo}_graphics_asset`;
      const src = encodeSvgDataUrl(page.graphicsSvg);
      assets[assetId] = {
        id: assetId,
        type: "image",
        props: {
          w: round(page.widthPx), h: round(page.heightPx),
          name: `page-${pageNo}.svg`, isAnimated: false, mimeType: "image/svg+xml", src, fileSize: src.length,
        },
      };
      shapes.push({
        id: `${prefix}_p${pageNo}_graphics`,
        type: "image",
        x: 0,
        y: pageOffsetY,
        stackLayer: "background",
        locked: true,
        anchor: { type: "page" },
        props: {
          assetId,
          w: Math.min(round(page.widthPx * scale), metrics.page.widthPx),
          h: Math.min(roundDown(pageOffsetY + page.heightPx * scale), pageBottom) - pageOffsetY,
        },
      });
    }
    page.runs.forEach((run, runIndex) => {
      const fitted = scale === 1 ? run : {
        ...run,
        x: run.x * scale,
        y: run.y * scale,
        width: run.width * scale,
        fontSizePx: run.fontSizePx * scale,
      };
      const shape = runToTextShape(fitted, `${prefix}_p${pageNo}_t${runIndex + 1}`, pageOffsetY, options.measurer);
      if (scale < 1) {
        // ページ数の計算が読む描画上の高さを使う。文字の行高の切り上げ分を紙面に収める。
        const bounds = getRotatedShapeVisualBounds(shape);
        const overflow = bounds.y + bounds.h - pageBottom;
        if (overflow > 0 && bounds.h <= metrics.page.heightPx) shape.y = roundDown(shape.y - overflow);
      }
      shapes.push(shape);
    });
  });

  // 教材のページ数は図形の広がりで決まる。末尾が白紙だとそのページが消えるので、透明な枠で残す。
  const lastIndex = result.pages.length - 1;
  const last = result.pages[lastIndex];
  if (last && !last.graphicsSvg && last.runs.length === 0) {
    const pageOffsetY = lastIndex * stride;
    shapes.push({
      id: `${prefix}_p${lastIndex + 1}_blank`,
      type: "geo",
      x: 0,
      y: pageOffsetY,
      stackLayer: "background",
      locked: true,
      anchor: { type: "page" },
      props: {
        w: metrics.page.widthPx, h: roundDown(pageOffsetY + metrics.page.heightPx) - pageOffsetY, geo: "rectangle",
        fill: "none", color: "#ffffff", strokeOpacity: 0, labelColor: "#111111", dash: "solid", size: "s",
      },
    } as OverlayShape);
  }

  const layout = buildPageLayout(widthPx, heightPx, shapes, assets);
  return {
    version: "2.0",
    docId: `${prefix}_document`,
    metadata: {
      title: options.filename.replace(/\.pdf$/iu, "") || "PDF",
      source: {
        format: "pdf",
        layoutMode: "fixedOverlay",
        printFlowContent: false,
        originalFileName: options.filename,
        importedAt: options.importedAt,
        slideCount: result.pageCount,
        pageSize: {
          widthPx: round(widthPx), heightPx: round(heightPx),
          widthMm: layout.pageSize.widthMm, heightMm: layout.pageSize.heightMm,
        },
      },
      // 図形の fontSize は pt で書く。宣言しないと px とみなされ 0.75 倍に縮む。
      styleUnits: { fontSize: "pt" },
    },
    content: [{ type: "paragraph", id: `${prefix}_anchor`, children: [] }],
    outputProfiles: {
      student: { includeAnswers: false, showHints: false, showSolutions: false },
      teacher: { includeAnswers: true, showHints: true, showSolutions: true },
      answerBook: { includeAnswers: true, onlySolutions: true, showSolutions: true },
    },
    pageLayout: layout,
    updatedAt: options.importedAt,
  };
}
