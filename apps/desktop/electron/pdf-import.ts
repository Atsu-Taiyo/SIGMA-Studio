import path from "node:path";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { buildPdfGraphicsSvg, type PdfClip, type PdfDraw, type PdfMatrix } from "@/lib/pdf-import/graphics-svg";
import { groupGlyphsIntoRuns, type PdfGlyph } from "@/lib/pdf-import/text-runs";
import type { PdfFontClass, PdfImportPage, PdfImportProgress, PdfImportResult, PdfTextRun } from "@/lib/pdf-import/types";

const te = createCurrentLocaleTranslator("error");

/** CSS px / PDF pt。PDF の 1pt は 1/72 inch、CSS の 1px は 1/96 inch。 */
const PX_PER_PT = 96 / 72;
/**
 * 記録する座標の倍率 (CSS px に対して)。pdf.js は画像を描画先の画素数まで間引くので、
 * 2 倍の面へ描かせて画像を約 200dpi に保ち、SVG の viewBox で原寸へ戻す。
 * 未対応の描画があるページを画像で描くときも同じ倍率を使う。
 */
const RECORD_SCALE = 2;
/** 文言 (electron.pdfImport.tooManyPages) と同じ値にする。 */
export const PDF_IMPORT_MAX_PAGES = 2000;

type NapiCanvasModule = typeof import("@napi-rs/canvas");
type NapiCanvas = import("@napi-rs/canvas").Canvas;
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfPageProxy = import("pdfjs-dist/types/src/display/api").PDFPageProxy;

interface PdfFontObject {
  loadedName?: string;
  name?: string;
  bold?: boolean;
  black?: boolean;
  italic?: boolean;
  isSerifFont?: boolean;
  isMonospace?: boolean;
  fontMatrix?: number[];
  getPathGenerator?: (objs: unknown, character: string) => unknown;
}

interface GlyphInfo { unicode: string; width: number }

/** pdf.js がグリフを描くのに使う Path2D と、その文字の対応。グリフと図形の塗りを見分ける。 */
const glyphPaths = new WeakMap<object, { font: PdfFontObject; character: string }>();
const PATCHED = Symbol.for("sigma.pdfImport.glyphPathPatch");

function patchGlyphPathGenerator(font: PdfFontObject) {
  const proto = Object.getPrototypeOf(font) as PdfFontObject & { [PATCHED]?: boolean };
  if (!proto || proto[PATCHED] || typeof proto.getPathGenerator !== "function") return;
  const original = proto.getPathGenerator;
  proto.getPathGenerator = function patched(this: PdfFontObject, objs: unknown, character: string) {
    const generated = original.call(this, objs, character);
    if (generated && typeof generated === "object") glyphPaths.set(generated, { font: this, character });
    return generated;
  };
  proto[PATCHED] = true;
}

const multiply = (m: PdfMatrix, n: PdfMatrix): PdfMatrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

function stripSubsetPrefix(name: string): string {
  return name.replace(/^[A-Z]{6}\+/u, "");
}

export function classifyPdfFont(font: Pick<PdfFontObject, "name" | "bold" | "black" | "italic" | "isSerifFont" | "isMonospace">): {
  font: PdfFontClass; bold: boolean; italic: boolean;
} {
  const name = stripSubsetPrefix(font.name ?? "");
  const mono = font.isMonospace === true || /courier|mono|cmtt|consol|menlo/iu.test(name);
  const sans = /gothic|sans|arial|helvetica|meiryo|kaku|verdana|tahoma|segoe|calibri|ゴシック|ud.?shin.?go|shingo|midashi.?go|jun\d|maru/iu.test(name);
  const serif = /mincho|ryumin|serif|times|century|roman|garamond|georgia|cambria|palatino|bookman|song|ming|明朝|^cm(?:r|mi|bx|ti|sl|sy|ex)\d|^lm(?:roman|math)|stix|minion|futo.?min|midashi.?min|kozmin|heisei.?min/iu.test(name);
  const fontClass: PdfFontClass = mono ? "mono" : sans ? "sans" : serif || font.isSerifFont ? "serif" : "sans";
  const bold = font.bold === true || font.black === true
    || /bold|black|heavy|semibold|demi|extrabold|ultra|cmbx|-w[6-9]\b|[^a-z]w[6-9]$|-(?:b|eb|h|u)$/iu.test(name);
  const italic = font.italic === true || /italic|oblique|^cm(?:mi|ti|sl)\d/iu.test(name);
  return { font: fontClass, bold, italic };
}

interface RecorderState {
  matrix: PdfMatrix;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  dash: number[];
  dashOffset: number;
  globalAlpha: number;
  globalCompositeOperation: string;
  font: string;
  filter: string;
  clip: PdfClip | null;
}

/**
 * pdf.js の CanvasGraphics から見て CanvasRenderingContext2D として振る舞い、描画を記録する。
 * 座標計算 (テキスト行列・フォーム XObject・クリップ) は pdf.js に任せ、ここは結果を受け取るだけ。
 * 記録できない描画 (パターン・グラデーション・合成モード等) は `unsupported` に残し、
 * そのページは画像で描き直す。
 */
class RecordingContext {
  readonly canvas: { width: number; height: number };
  readonly draws: PdfDraw[] = [];
  readonly glyphs: Array<{ font: PdfFontObject; character: string; matrix: PdfMatrix; color: unknown; alpha: number }> = [];
  readonly unsupported = new Set<string>();
  imageSmoothingEnabled = true;
  imageSmoothingQuality = "low";
  private state: RecorderState;
  private readonly stack: RecorderState[] = [];
  private lastGlyph: { path: object; matrix: PdfMatrix } | null = null;

  constructor(width: number, height: number, private readonly napi: NapiCanvasModule) {
    // pdf.js は描いた直後に一時 canvas を解放する (幅 0 にする) ので、画像は drawImage の中で符号化する。
    this.canvas = { width, height };
    this.state = {
      matrix: [1, 0, 0, 1, 0, 0], fillStyle: "#000000", strokeStyle: "#000000", lineWidth: 1, lineCap: "butt",
      lineJoin: "miter", miterLimit: 10, dash: [], dashOffset: 0, globalAlpha: 1, globalCompositeOperation: "source-over",
      font: "10px sans-serif", filter: "none", clip: null,
    };
  }

  get fillStyle() { return this.state.fillStyle; } set fillStyle(value: unknown) { this.state.fillStyle = value; }
  get strokeStyle() { return this.state.strokeStyle; } set strokeStyle(value: unknown) { this.state.strokeStyle = value; }
  get lineWidth() { return this.state.lineWidth; } set lineWidth(value: number) { this.state.lineWidth = value; }
  get lineCap() { return this.state.lineCap; } set lineCap(value: string) { this.state.lineCap = value; }
  get lineJoin() { return this.state.lineJoin; } set lineJoin(value: string) { this.state.lineJoin = value; }
  get miterLimit() { return this.state.miterLimit; } set miterLimit(value: number) { this.state.miterLimit = value; }
  get lineDashOffset() { return this.state.dashOffset; } set lineDashOffset(value: number) { this.state.dashOffset = value; }
  get globalAlpha() { return this.state.globalAlpha; } set globalAlpha(value: number) { this.state.globalAlpha = value; }
  get globalCompositeOperation() { return this.state.globalCompositeOperation; }
  set globalCompositeOperation(value: string) { this.state.globalCompositeOperation = value; }
  get font() { return this.state.font; } set font(value: string) { this.state.font = value; }
  get filter() { return this.state.filter; } set filter(value: string) { this.state.filter = value; }

  setLineDash(dash: number[]) { this.state.dash = [...dash]; }
  getLineDash() { return [...this.state.dash]; }
  save() { this.stack.push({ ...this.state }); }
  restore() { const previous = this.stack.pop(); if (previous) this.state = previous; }
  transform(a: number, b: number, c: number, d: number, e: number, f: number) { this.state.matrix = multiply(this.state.matrix, [a, b, c, d, e, f]); }
  setTransform(a?: number | { a: number; b: number; c: number; d: number; e: number; f: number }, b?: number, c?: number, d?: number, e?: number, f?: number) {
    if (a === undefined) this.state.matrix = [1, 0, 0, 1, 0, 0];
    else if (typeof a === "object") this.state.matrix = [a.a, a.b, a.c, a.d, a.e, a.f];
    else this.state.matrix = [a, b ?? 0, c ?? 0, d ?? 1, e ?? 0, f ?? 0];
  }
  resetTransform() { this.state.matrix = [1, 0, 0, 1, 0, 0]; }
  getTransform() { return new this.napi.DOMMatrix([...this.state.matrix]); }
  translate(x: number, y: number) { this.transform(1, 0, 0, 1, x, y); }
  scale(x: number, y: number) { this.transform(x, 0, 0, y, 0, 0); }
  rotate(angle: number) { const cos = Math.cos(angle), sin = Math.sin(angle); this.transform(cos, sin, -sin, cos, 0, 0); }
  beginPath() {}
  closePath() {}
  moveTo() { this.unsupported.add("implicit-path"); }
  lineTo() { this.unsupported.add("implicit-path"); }
  rect() { this.unsupported.add("implicit-path"); }
  clearRect() {}
  fillRect(x: number, y: number, w: number, h: number) {
    const path = new this.napi.Path2D();
    path.rect(x, y, w, h);
    this.fill(path);
  }

  private blendSupported(): boolean {
    if (this.state.globalCompositeOperation === "source-over") return true;
    this.unsupported.add(`blend:${this.state.globalCompositeOperation}`);
    return false;
  }

  private filterSupported(): boolean {
    if (!this.state.filter || this.state.filter === "none") return true;
    this.unsupported.add("filter");
    return false;
  }

  clip(path?: unknown, rule?: string) {
    if (!(path instanceof this.napi.Path2D)) { this.unsupported.add("implicit-clip"); return; }
    this.state.clip = { parent: this.state.clip, matrix: this.state.matrix, d: path.toSVGString(), rule: rule === "evenodd" ? "evenodd" : "nonzero" };
  }

  fill(path?: unknown, rule?: string) {
    if (!(path instanceof this.napi.Path2D)) { this.unsupported.add("implicit-path"); return; }
    const glyph = glyphPaths.get(path);
    if (glyph) { this.recordGlyph(path, glyph, this.state.fillStyle); return; }
    if (typeof this.state.fillStyle !== "string") { this.unsupported.add("pattern-fill"); return; }
    if (!this.blendSupported() || !this.filterSupported()) return;
    this.draws.push({
      kind: "fill", d: path.toSVGString(), matrix: this.state.matrix, clip: this.state.clip, opacity: this.state.globalAlpha,
      color: this.state.fillStyle, rule: rule === "evenodd" ? "evenodd" : "nonzero",
    });
  }

  stroke(path?: unknown) {
    if (!(path instanceof this.napi.Path2D)) { this.unsupported.add("implicit-path"); return; }
    const glyph = glyphPaths.get(path);
    if (glyph) { this.recordGlyph(path, glyph, this.state.strokeStyle); return; }
    if (typeof this.state.strokeStyle !== "string") { this.unsupported.add("pattern-stroke"); return; }
    if (!this.blendSupported() || !this.filterSupported()) return;
    const state = this.state;
    this.draws.push({
      kind: "stroke", d: path.toSVGString(), matrix: state.matrix, clip: state.clip, opacity: state.globalAlpha,
      color: state.strokeStyle as string, lineWidth: state.lineWidth, lineCap: state.lineCap, lineJoin: state.lineJoin,
      miterLimit: state.miterLimit, dash: state.dash, dashOffset: state.dashOffset,
    });
  }

  private recordGlyph(path: object, glyph: { font: PdfFontObject; character: string }, color: unknown) {
    const matrix = this.state.matrix;
    // 塗りと縁取りの両方を指定した文字 (Tr 2) は同じ字形が 2 回届く。1 文字として扱う。
    if (this.lastGlyph && this.lastGlyph.path === path && this.lastGlyph.matrix.every((value, index) => value === matrix[index])) return;
    this.lastGlyph = { path, matrix };
    this.glyphs.push({ ...glyph, matrix, color, alpha: this.state.globalAlpha });
  }

  drawImage(image: NapiCanvas | { width: number; height: number }, ...args: number[]) {
    if (!this.blendSupported() || !this.filterSupported()) return;
    let sx = 0, sy = 0, sw = image.width, sh = image.height, dx = 0, dy = 0, dw = image.width, dh = image.height;
    if (args.length === 2) [dx, dy] = args as [number, number];
    else if (args.length === 4) [dx, dy, dw, dh] = args as [number, number, number, number];
    else if (args.length >= 8) [sx, sy, sw, sh, dx, dy, dw, dh] = args as [number, number, number, number, number, number, number, number];
    if (!(sw > 0) || !(sh > 0)) return;
    const [a, b, c, d] = this.state.matrix;
    // 描画先での画素数。切り出しがあれば画像全体へ換算する。
    const displayWidth = Math.hypot(a, b) * Math.abs(dw) * (image.width / sw);
    const displayHeight = Math.hypot(c, d) * Math.abs(dh) * (image.height / sh);
    const encoded = encodeImage(this.napi, image, displayWidth, displayHeight);
    if (!encoded) { this.unsupported.add("image"); return; }
    // 縮小して書き出した画像も、切り出し範囲は元の画素座標で届く。比率で合わせる。
    const scaleX = encoded.width / image.width;
    const scaleY = encoded.height / image.height;
    this.draws.push({
      kind: "image", href: encoded.href, imageWidth: encoded.width, imageHeight: encoded.height,
      matrix: this.state.matrix, clip: this.state.clip, opacity: this.state.globalAlpha,
      sx: sx * scaleX, sy: sy * scaleY, sw: sw * scaleX, sh: sh * scaleY, dx, dy, dw, dh,
    });
  }

  fillText() { this.unsupported.add("native-text"); }
  strokeText() { this.unsupported.add("native-text"); }
  measureText(text: string) {
    const size = Number(/(\d+(?:\.\d+)?)px/u.exec(this.state.font)?.[1] ?? 10);
    return { width: text.length * size * 0.5, actualBoundingBoxAscent: size * 0.8, actualBoundingBoxDescent: size * 0.2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * size * 0.5, fontBoundingBoxAscent: size * 0.8, fontBoundingBoxDescent: size * 0.2 };
  }
  createPattern() { this.unsupported.add("pattern"); return { setTransform() {} }; }
  createLinearGradient() { this.unsupported.add("gradient"); return { addColorStop() {} }; }
  createRadialGradient() { this.unsupported.add("gradient"); return { addColorStop() {} }; }
  createConicGradient() { this.unsupported.add("gradient"); return { addColorStop() {} }; }
  putImageData() { this.unsupported.add("put-image-data"); }
  getImageData(_x: number, _y: number, w: number, h: number) { this.unsupported.add("read-back"); return new this.napi.ImageData(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h))); }
  createImageData(w: number, h: number) { return new this.napi.ImageData(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h))); }
  isPointInPath() { return false; }
  isPointInStroke() { return false; }
  transferFromImageBitmap() { this.unsupported.add("bitmap"); }
}

function colorString(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase()
    : typeof value === "string" && /^#[0-9a-f]{3}$/iu.test(value) ? `#${[...value.slice(1)].map((char) => char + char).join("")}`.toLowerCase()
      : typeof value === "string" ? rgbToHex(value) : "#000000";
}

function rgbToHex(value: string): string {
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/iu.exec(value);
  if (!match) return "#000000";
  return `#${match.slice(1, 4).map((part) => Math.max(0, Math.min(255, Math.round(Number(part)))).toString(16).padStart(2, "0")).join("")}`;
}

/** 画像を描画先の画素数以下の data URL にする。 */
function encodeImage(
  napi: NapiCanvasModule,
  source: NapiCanvas | { width: number; height: number },
  displayWidthPx: number,
  displayHeightPx: number,
): { href: string; width: number; height: number } | null {
  if (!(source instanceof napi.Canvas) || source.width < 1 || source.height < 1) return null;
  const limitW = Math.max(1, Math.ceil(displayWidthPx));
  const limitH = Math.max(1, Math.ceil(displayHeightPx));
  const ratio = Math.min(1, limitW / source.width, limitH / source.height);
  let canvas = source;
  if (ratio < 1) {
    const width = Math.max(1, Math.round(source.width * ratio));
    const height = Math.max(1, Math.round(source.height * ratio));
    canvas = napi.createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
  }
  const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  const pixels = canvas.width * canvas.height;
  const step = Math.max(1, Math.floor(pixels / 4096));
  const colors = new Set<number>();
  for (let pixel = 0; pixel < pixels; pixel += step) {
    const offset = pixel * 4;
    if (colors.size <= 256) colors.add((data[offset]! << 16) | (data[offset + 1]! << 8) | data[offset + 2]!);
  }
  // 色数の少ない図 (線画・ベタ塗り) は PNG のほうが小さく、輪郭もにじまない。
  // それ以外 (写真・グラデーションのある挿絵・スキャン) は WebP。透明を保ったまま JPEG より小さい。
  // 教材は数百ページになるので、画像の容量がそのまま保存・読み込みの重さになる。
  const png = colors.size <= 256 ? canvas.toBuffer("image/png") : null;
  if (png && png.length < 96 * 1024) {
    return { href: `data:image/png;base64,${png.toString("base64")}`, width: canvas.width, height: canvas.height };
  }
  const webp = canvas.toBuffer("image/webp", 80);
  const usePng = png !== null && png.length <= webp.length * 1.5;
  const buffer = usePng ? png : webp;
  return { href: `data:${usePng ? "image/png" : "image/webp"};base64,${buffer.toString("base64")}`, width: canvas.width, height: canvas.height };
}

function glyphsToPdfGlyphs(
  recorded: RecordingContext["glyphs"],
  glyphInfo: Map<PdfFontObject, Map<string, GlyphInfo>>,
): PdfGlyph[] {
  const fontClasses = new Map<PdfFontObject, ReturnType<typeof classifyPdfFont>>();
  const glyphs: PdfGlyph[] = [];
  for (const entry of recorded) {
    const info = glyphInfo.get(entry.font)?.get(entry.character);
    const text = info?.unicode ?? "";
    if (!text) continue;
    let style = fontClasses.get(entry.font);
    if (!style) { style = classifyPdfFont(entry.font); fontClasses.set(entry.font, style); }
    const [a, b, c, d, e, f] = entry.matrix;
    // pdf.js は字形を ctx.translate(x, y); ctx.scale(size, -size) の座標で描く。
    // y 軸の長さが文字の大きさ、x 軸の向きがベースラインの向き。
    const fontSizePx = Math.hypot(c, d) / RECORD_SCALE;
    const fontMatrixX = entry.font.fontMatrix?.[0] ?? 0.001;
    glyphs.push({
      text,
      x: e / RECORD_SCALE,
      y: f / RECORD_SCALE,
      advance: info!.width * fontMatrixX * Math.hypot(a, b) / RECORD_SCALE,
      fontSizePx,
      angle: Math.atan2(b, a),
      color: colorString(entry.color),
      ...(entry.alpha < 1 ? { opacity: entry.alpha } : {}),
      ...style,
    });
  }
  return glyphs;
}

async function loadPdfJs(): Promise<{ pdfjs: PdfJsModule; napi: NapiCanvasModule; packageRoot: string }> {
  // ESM のライブラリは Electron の CommonJS バンドルへ入れない (ai-edit-pdf.ts と同じ)。
  const napi = await import("@napi-rs/canvas");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  return { pdfjs, napi, packageRoot };
}

const TEXT_OPS = (OPS: PdfJsModule["OPS"]) => new Set<number>([
  OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText,
]);

async function rasterizeGraphics(page: PdfPageProxy, pdfjs: PdfJsModule, napi: NapiCanvasModule, widthPx: number, heightPx: number): Promise<string | null> {
  const viewport = page.getViewport({ scale: PX_PER_PT * RECORD_SCALE });
  const canvas = napi.createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  const textOps = TEXT_OPS(pdfjs.OPS);
  const operatorList = await page.getOperatorList();
  try {
    await page.render({
      canvas: null,
      canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
      viewport,
      background: "rgba(0,0,0,0)",
      operationsFilter: (index: number) => !textOps.has(operatorList.fnArray[index]!),
    }).promise;
    const image = encodeImage(napi, canvas, canvas.width, canvas.height);
    if (!image) return null;
    return buildPdfGraphicsSvg([{
      kind: "image", href: image.href, imageWidth: image.width, imageHeight: image.height,
      matrix: [1, 0, 0, 1, 0, 0], clip: null, opacity: 1,
      sx: 0, sy: 0, sw: image.width, sh: image.height, dx: 0, dy: 0, dw: image.width, dh: image.height,
    }], widthPx, heightPx, image.width / widthPx);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** 描画を記録できなかったページの文字。色と太さは分からないので黒・標準にする。 */
async function textContentRuns(page: PdfPageProxy, viewportTransform: PdfMatrix): Promise<PdfTextRun[]> {
  const content = await page.getTextContent();
  const runs: PdfTextRun[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const [a, b, c, d, e, f] = multiply(viewportTransform, item.transform as unknown as PdfMatrix);
    const fontSizePx = Math.hypot(c, d);
    if (!(fontSizePx > 0)) continue;
    const family = content.styles[item.fontName]?.fontFamily ?? "";
    runs.push({
      text: item.str.trim(),
      x: e,
      y: f,
      width: item.width * PX_PER_PT,
      fontSizePx,
      angle: Math.atan2(b, a),
      color: "#000000",
      font: family === "monospace" ? "mono" : family === "serif" ? "serif" : "sans",
    });
  }
  return runs;
}

async function extractPage(page: PdfPageProxy, pdfjs: PdfJsModule, napi: NapiCanvasModule, issues: Set<string>): Promise<PdfImportPage> {
  const viewport = page.getViewport({ scale: PX_PER_PT * RECORD_SCALE });
  const widthPx = viewport.width / RECORD_SCALE;
  const heightPx = viewport.height / RECORD_SCALE;
  const operatorList = await page.getOperatorList();
  const { OPS } = pdfjs;
  // 字形の Path2D から Unicode と送り幅を引くための表。pdf.js の字形は fontChar で識別される。
  const glyphInfo = new Map<PdfFontObject, Map<string, GlyphInfo>>();
  let currentFont: PdfFontObject | null = null;
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] as unknown[];
    if (fn === OPS.setFont) {
      try { currentFont = page.commonObjs.get(args[0] as string) as PdfFontObject; } catch { currentFont = null; }
      if (currentFont) patchGlyphPathGenerator(currentFont);
    } else if ((fn === OPS.showText || fn === OPS.showSpacedText) && currentFont) {
      let table = glyphInfo.get(currentFont);
      if (!table) { table = new Map(); glyphInfo.set(currentFont, table); }
      for (const glyph of args[0] as Array<number | { fontChar?: string; unicode?: string; width?: number } | null>) {
        if (glyph && typeof glyph === "object" && typeof glyph.fontChar === "string" && !table.has(glyph.fontChar)) {
          table.set(glyph.fontChar, { unicode: glyph.unicode ?? "", width: glyph.width ?? 0 });
        }
      }
    }
  }

  const recorder = new RecordingContext(Math.ceil(viewport.width), Math.ceil(viewport.height), napi);
  try {
    await page.render({
      canvas: null,
      canvasContext: recorder as unknown as CanvasRenderingContext2D,
      viewport,
      background: "rgba(0,0,0,0)",
    }).promise;
  } catch {
    // 記録用の面では描けない構成 (背景を読み戻す透明グループ等)。文字は抽出し直し、残りは画像で描く。
    issues.add("render-fallback");
    return {
      widthPx,
      heightPx,
      runs: await textContentRuns(page, page.getViewport({ scale: PX_PER_PT }).transform as unknown as PdfMatrix),
      graphicsSvg: await rasterizeGraphics(page, pdfjs, napi, widthPx, heightPx),
    };
  }

  const runs = groupGlyphsIntoRuns(glyphsToPdfGlyphs(recorder.glyphs, glyphInfo));
  let graphicsSvg: string | null;
  if (recorder.unsupported.size > 0) {
    for (const reason of recorder.unsupported) issues.add(reason);
    graphicsSvg = await rasterizeGraphics(page, pdfjs, napi, widthPx, heightPx);
  } else {
    graphicsSvg = buildPdfGraphicsSvg(recorder.draws, widthPx, heightPx, RECORD_SCALE);
  }
  return { widthPx, heightPx, runs, graphicsSvg };
}

/**
 * PDF を読み、ページごとの文字の並びと、文字以外を描いた SVG を返す。
 * 1 ページずつ処理して解放するので、数百ページでもメモリは 1 ページ分で済む。
 */
export async function extractPdfForImport(
  bytes: Uint8Array,
  options: { onProgress?: (progress: PdfImportProgress) => void; signal?: AbortSignal } = {},
): Promise<PdfImportResult> {
  const { pdfjs, napi, packageRoot } = await loadPdfJs();
  const loading = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    cMapUrl: path.join(packageRoot, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(packageRoot, "standard_fonts") + path.sep,
    wasmUrl: path.join(packageRoot, "wasm") + path.sep,
    // 書体名 (太字・明朝の判定に使う) は、これを有効にしないと描画側へ渡ってこない。
    fontExtraProperties: true,
    verbosity: 0,
  });
  try {
    let pdf;
    try {
      pdf = await loading.promise;
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "PasswordException") throw new Error(te("electron.pdfImport.encrypted"));
      throw new Error(te("electron.pdfImport.unreadable"));
    }
    if (pdf.numPages > PDF_IMPORT_MAX_PAGES) {
      throw new Error(te("electron.pdfImport.tooManyPages", { count: pdf.numPages }));
    }
    const issues = new Set<string>();
    const pages: PdfImportPage[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (options.signal?.aborted) throw new Error(te("electron.pdfImport.cancelled"));
      const page = await pdf.getPage(pageNumber);
      try {
        pages.push(await extractPage(page, pdfjs, napi, issues));
      } finally {
        page.cleanup();
      }
      options.onProgress?.({ page: pageNumber, pageCount: pdf.numPages });
      // 主プロセスの IPC・ウィンドウ操作を止めないよう、ページごとにイベントループへ戻る。
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { pageCount: pdf.numPages, pages, issues: [...issues] };
  } finally {
    await loading.destroy();
  }
}
