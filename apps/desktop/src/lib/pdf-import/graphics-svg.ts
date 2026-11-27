/**
 * 記録した描画 (塗り・線・画像) を、ページ 1 枚分の自己完結した SVG へ書き出す。
 * 座標変換は記録時の行列をそのまま `transform` に載せるので、線幅の拡大縮小も PDF と同じになる。
 */

export type PdfMatrix = readonly [number, number, number, number, number, number];

export interface PdfClip {
  readonly parent: PdfClip | null;
  readonly matrix: PdfMatrix;
  readonly d: string;
  readonly rule: "nonzero" | "evenodd";
}

interface PdfDrawBase {
  matrix: PdfMatrix;
  clip: PdfClip | null;
  opacity: number;
}

export interface PdfFillDraw extends PdfDrawBase {
  kind: "fill";
  d: string;
  color: string;
  rule: "nonzero" | "evenodd";
}

export interface PdfStrokeDraw extends PdfDrawBase {
  kind: "stroke";
  d: string;
  color: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  dash: readonly number[];
  dashOffset: number;
}

export interface PdfImageDraw extends PdfDrawBase {
  kind: "image";
  href: string;
  /** 画像そのものの画素数。 */
  imageWidth: number;
  imageHeight: number;
  /** drawImage の切り出し元と描画先 (変換前の座標)。 */
  sx: number; sy: number; sw: number; sh: number;
  dx: number; dy: number; dw: number; dh: number;
}

export type PdfDraw = PdfFillDraw | PdfStrokeDraw | PdfImageDraw;

const num = (value: number): string => {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

/** Skia の SVG 文字列は小数を長く出すので、0.001 単位へ丸めて容量を抑える。 */
export function compactPathData(d: string): string {
  return d.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/giu, (match) => num(Number(match)));
}

const matrixAttr = (m: PdfMatrix): string =>
  m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
    ? ""
    : ` transform="matrix(${m.map(num).join(" ")})"`;

const escapeAttr = (value: string): string => value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");

/** CSS の色文字列を、SVG の属性で使える色と不透明度へ分ける。 */
function splitColor(color: string): { color: string; alpha: number } {
  const rgba = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/iu.exec(color.trim());
  if (rgba) {
    return { color: `rgb(${rgba[1]},${rgba[2]},${rgba[3]})`, alpha: Number(rgba[4]) };
  }
  return { color: /^#[0-9a-f]{3,8}$|^rgb\([\d.,\s]+\)$|^[a-z]+$/iu.test(color.trim()) ? color.trim() : "#000000", alpha: 1 };
}

function isWhite(color: string): boolean {
  const value = color.trim().toLowerCase();
  return value === "#ffffff" || value === "#fff" || value === "white" || /^rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(?:,\s*1(?:\.0*)?\s*)?\)$/u.test(value);
}

function clipChain(clip: PdfClip | null): PdfClip[] {
  const chain: PdfClip[] = [];
  for (let current = clip; current; current = current.parent) chain.unshift(current);
  return chain;
}

function drawElement(draw: PdfDraw): string | null {
  const transform = matrixAttr(draw.matrix);
  if (draw.kind === "fill") {
    const { color, alpha } = splitColor(draw.color);
    const opacity = alpha * draw.opacity;
    if (opacity <= 0) return null;
    return `<path d="${compactPathData(draw.d)}"${transform} fill="${color}"${draw.rule === "evenodd" ? ` fill-rule="evenodd"` : ""}${opacity < 1 ? ` fill-opacity="${num(opacity)}"` : ""}/>`;
  }
  if (draw.kind === "stroke") {
    const { color, alpha } = splitColor(draw.color);
    const opacity = alpha * draw.opacity;
    if (opacity <= 0) return null;
    const dash = draw.dash.length > 0 && draw.dash.some((value) => value > 0)
      ? ` stroke-dasharray="${draw.dash.map(num).join(" ")}"${draw.dashOffset ? ` stroke-dashoffset="${num(draw.dashOffset)}"` : ""}`
      : "";
    return `<path d="${compactPathData(draw.d)}"${transform} fill="none" stroke="${color}" stroke-width="${num(draw.lineWidth)}"`
      + `${draw.lineCap !== "butt" ? ` stroke-linecap="${escapeAttr(draw.lineCap)}"` : ""}`
      + `${draw.lineJoin !== "miter" ? ` stroke-linejoin="${escapeAttr(draw.lineJoin)}"` : ""}`
      + `${draw.lineJoin === "miter" && draw.miterLimit !== 4 ? ` stroke-miterlimit="${num(draw.miterLimit)}"` : ""}`
      + `${dash}${opacity < 1 ? ` stroke-opacity="${num(opacity)}"` : ""}/>`;
  }
  if (draw.opacity <= 0 || draw.dw === 0 || draw.dh === 0) return null;
  const opacity = draw.opacity < 1 ? ` opacity="${num(draw.opacity)}"` : "";
  const fullSource = draw.sx === 0 && draw.sy === 0 && draw.sw === draw.imageWidth && draw.sh === draw.imageHeight;
  const image = `<image href="${escapeAttr(draw.href)}" width="${num(fullSource ? draw.dw : draw.imageWidth)}" height="${num(fullSource ? draw.dh : draw.imageHeight)}"${fullSource ? ` x="${num(draw.dx)}" y="${num(draw.dy)}"` : ""} preserveAspectRatio="none"${opacity}/>`;
  if (fullSource) {
    return transform ? `<g${transform}>${image}</g>` : image;
  }
  // 切り出しは入れ子の viewport で表す。画像全体を置き、見える範囲だけを viewBox で選ぶ。
  return `<g${transform}><svg x="${num(draw.dx)}" y="${num(draw.dy)}" width="${num(draw.dw)}" height="${num(draw.dh)}" viewBox="${num(draw.sx)} ${num(draw.sy)} ${num(draw.sw)} ${num(draw.sh)}" preserveAspectRatio="none" overflow="hidden">${image}</svg></g>`;
}

/**
 * 1 ページ分の描画を SVG 文書にする。何も見えないページは null。
 * 白い紙に白を塗るだけの先頭の塗り (ページ背景) は落とす。
 * `recordScale` は描画を記録した座標の倍率。SVG の寸法は原寸 (px) で、viewBox が記録座標を受ける。
 */
export function buildPdfGraphicsSvg(draws: readonly PdfDraw[], widthPx: number, heightPx: number, recordScale = 1): string | null {
  let start = 0;
  while (start < draws.length) {
    const draw = draws[start]!;
    const transparent = draw.kind !== "image" && (draw.opacity <= 0 || splitColor(draw.color).alpha <= 0);
    if (transparent || (draw.kind === "fill" && isWhite(draw.color) && draw.opacity >= 1)) {
      start += 1;
      continue;
    }
    break;
  }
  const clipIds = new Map<PdfClip, string>();
  const defs: string[] = [];
  const clipId = (clip: PdfClip): string => {
    let id = clipIds.get(clip);
    if (!id) {
      id = `c${clipIds.size + 1}`;
      clipIds.set(clip, id);
      defs.push(`<clipPath id="${id}"><path d="${compactPathData(clip.d)}"${matrixAttr(clip.matrix)}${clip.rule === "evenodd" ? ` clip-rule="evenodd"` : ""}/></clipPath>`);
    }
    return id;
  };

  const body: string[] = [];
  let openChain: PdfClip[] = [];
  let drawn = 0;
  for (let index = start; index < draws.length; index += 1) {
    const draw = draws[index]!;
    const element = drawElement(draw);
    if (!element) continue;
    const chain = clipChain(draw.clip);
    let shared = 0;
    while (shared < openChain.length && shared < chain.length && openChain[shared] === chain[shared]) shared += 1;
    for (let close = openChain.length; close > shared; close -= 1) body.push("</g>");
    for (let open = shared; open < chain.length; open += 1) body.push(`<g clip-path="url(#${clipId(chain[open]!)})">`);
    openChain = chain;
    body.push(element);
    drawn += 1;
  }
  for (let close = openChain.length; close > 0; close -= 1) body.push("</g>");
  if (drawn === 0) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(widthPx)}" height="${num(heightPx)}" viewBox="0 0 ${num(widthPx * recordScale)} ${num(heightPx * recordScale)}" preserveAspectRatio="none">`
    + `${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${body.join("")}</svg>`;
}
