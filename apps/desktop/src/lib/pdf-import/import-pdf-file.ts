import type { SigmaDocument } from "@/features/document";
import { buildPdfImportDocument, pdfFontFamily, type PdfTextFace, type PdfTextMeasurer } from "./build-document";
import type { PdfFontClass, PdfImportPage, PdfImportProgress, PdfImportResult, PdfTextRun } from "./types";

/** 和文の縦寸法と書体の読み込みを確かめる見本の仮名 (表示しない)。 */
const KANA_SAMPLE = String.fromCharCode(0x3042);
const FONT_CLASSES = new Set<PdfFontClass>(["sans", "serif", "mono"]);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function readRun(value: unknown): PdfTextRun | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Record<string, unknown>;
  if (typeof run.text !== "string" || !run.text || !finite(run.x) || !finite(run.y) || !finite(run.width)
    || !finite(run.fontSizePx) || !(run.fontSizePx > 0) || !finite(run.angle) || typeof run.color !== "string"
    || !/^#[0-9a-f]{6}$/iu.test(run.color) || !FONT_CLASSES.has(run.font as PdfFontClass)) return null;
  return {
    text: run.text,
    x: run.x,
    y: run.y,
    width: Math.max(0, run.width),
    fontSizePx: run.fontSizePx,
    angle: run.angle,
    color: run.color.toLowerCase(),
    ...(finite(run.opacity) && run.opacity >= 0 && run.opacity < 1 ? { opacity: run.opacity } : {}),
    font: run.font as PdfFontClass,
    ...(run.bold === true ? { bold: true } : {}),
    ...(run.italic === true ? { italic: true } : {}),
  };
}

/** 主プロセスから届いた抽出結果の形を確かめる。壊れた要素は捨て、ページ自体が壊れていれば失敗にする。 */
export function readPdfImportResult(value: unknown): PdfImportResult {
  if (!value || typeof value !== "object") throw new Error("invalid PDF import result");
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.pages) || result.pages.length === 0) throw new Error("invalid PDF import result");
  const pages: PdfImportPage[] = result.pages.map((raw) => {
    const page = (raw ?? {}) as Record<string, unknown>;
    if (!finite(page.widthPx) || !finite(page.heightPx) || page.widthPx <= 0 || page.heightPx <= 0) {
      throw new Error("invalid PDF import page");
    }
    const svg = typeof page.graphicsSvg === "string" && page.graphicsSvg.startsWith("<svg ") ? page.graphicsSvg : null;
    return {
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      runs: Array.isArray(page.runs) ? page.runs.map(readRun).filter((run): run is PdfTextRun => run !== null) : [],
      graphicsSvg: svg,
    };
  });
  return {
    pageCount: pages.length,
    pages,
    issues: Array.isArray(result.issues) ? result.issues.filter((issue): issue is string => typeof issue === "string") : [],
  };
}

const cssFont = (face: PdfTextFace, sizePx: number) =>
  `${face.italic ? "italic " : ""}${face.bold ? "bold " : ""}${sizePx}px ${pdfFontFamily(face.font)}`;

/**
 * 描画側の canvas で、取り込み先の書体 (同梱フォント) の幅と縦の寸法を測る。
 * 同じ文字列は何度も現れる (柱・ノンブル) ので、幅は 100px で測って比例させ、結果を覚える。
 */
export async function createCanvasTextMeasurer(faces: Iterable<PdfTextFace>): Promise<PdfTextMeasurer> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 2d context unavailable");
  const unique = new Map<string, PdfTextFace>();
  for (const face of faces) unique.set(`${face.font}${face.bold ? "b" : ""}${face.italic ? "i" : ""}`, face);
  // 未読み込みの書体で測ると代替書体の幅になる。使う書体を先に読み込む。
  await Promise.all([...unique.values()].map((face) =>
    document.fonts?.load(cssFont(face, 16), `${KANA_SAMPLE}A1`).catch(() => undefined)));
  const BASE = 100;
  const widths = new Map<string, number>();
  const metrics = new Map<string, { ascent: number; descent: number }>();
  return {
    width(text, face, fontSizePx) {
      const key = `${face.font}${face.bold ? "b" : ""}${face.italic ? "i" : ""}\u0000${text}`;
      let width = widths.get(key);
      if (width === undefined) {
        context.font = cssFont(face, BASE);
        width = context.measureText(text).width;
        if (widths.size < 50_000) widths.set(key, width);
      }
      return width * fontSizePx / BASE;
    },
    metrics(face) {
      const key = `${face.font}${face.bold ? "b" : ""}${face.italic ? "i" : ""}`;
      let value = metrics.get(key);
      if (!value) {
        context.font = cssFont(face, BASE);
        const measured = context.measureText(`${KANA_SAMPLE}Agy`);
        const ascent = measured.fontBoundingBoxAscent;
        const descent = measured.fontBoundingBoxDescent;
        value = finite(ascent) && finite(descent) && ascent + descent > 0
          ? { ascent: ascent / BASE, descent: descent / BASE }
          : { ascent: 0.88, descent: 0.12 };
        metrics.set(key, value);
      }
      return value;
    },
  };
}

export interface DesktopPdfImporter {
  importPdf(bytes: Uint8Array, onProgress?: (progress: PdfImportProgress) => void): Promise<unknown>;
}

/** PDF ファイルを主プロセスで読み、描画側の書体で測って SigmaDoc にする。 */
export async function importPdfFile(
  file: File,
  importer: DesktopPdfImporter,
  options: { onProgress?: (progress: PdfImportProgress) => void; idPrefix: string; importedAt?: string },
): Promise<{ document: SigmaDocument; issues: string[] }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = readPdfImportResult(await importer.importPdf(bytes, options.onProgress));
  const faces: PdfTextFace[] = [];
  for (const page of result.pages) {
    for (const run of page.runs) faces.push({ font: run.font, bold: Boolean(run.bold), italic: Boolean(run.italic) });
  }
  const measurer = await createCanvasTextMeasurer(faces);
  const document = buildPdfImportDocument(result, {
    filename: file.name,
    importedAt: options.importedAt ?? new Date().toISOString(),
    measurer,
    idPrefix: options.idPrefix,
  });
  return { document, issues: result.issues };
}
