/**
 * Colour arithmetic for the colour-creation dialog: hex text in, RGB/HSV out, and back.
 *
 * Deliberately narrow: only hex spellings are understood. A stored `red` or `rgb(...)` is a real
 * colour the palette must keep showing, but it is not a colour this module can round-trip, so it
 * is rejected here rather than approximated and written back over the document.
 *
 * Opacity between 0..1 (stored) and whole percents (edited) belongs to `fill-opacity.ts` and is not
 * reimplemented here. This module only converts between whole percents and the alpha *byte* that
 * an 8-digit hex spells out.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsv {
  /** 0..360. Greys report 0, so callers that care keep the previous hue themselves. */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  v: number;
}

export interface ParsedHexColor {
  rgb: Rgb;
  /** 0..255. `0` is a real alpha, not "missing" — see `hasAlpha`. */
  alpha: number;
  /** Whether the text spelled an alpha out (4 or 8 digits) at all. */
  hasAlpha: boolean;
}

const HEX_PATTERN = /^#?([0-9a-f]{3,8})$/i;

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function expand(digit: string): number {
  return Number.parseInt(`${digit}${digit}`, 16);
}

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`, with an optional `#`, any case, surrounding space. */
export function parseHexColor(input: string): ParsedHexColor | null {
  if (typeof input !== "string") return null;
  const match = HEX_PATTERN.exec(input.trim());
  if (!match) return null;
  const body = match[1];
  if (body.length === 3 || body.length === 4) {
    return {
      rgb: { r: expand(body[0]), g: expand(body[1]), b: expand(body[2]) },
      alpha: body.length === 4 ? expand(body[3]) : 255,
      hasAlpha: body.length === 4,
    };
  }
  if (body.length === 6 || body.length === 8) {
    return {
      rgb: {
        r: Number.parseInt(body.slice(0, 2), 16),
        g: Number.parseInt(body.slice(2, 4), 16),
        b: Number.parseInt(body.slice(4, 6), 16),
      },
      alpha: body.length === 8 ? Number.parseInt(body.slice(6, 8), 16) : 255,
      hasAlpha: body.length === 8,
    };
  }
  return null;
}

function hex2(value: number): string {
  return clampByte(value).toString(16).padStart(2, "0");
}

export function formatHex6(rgb: Rgb): string {
  return `#${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`;
}

export function formatHex8(rgb: Rgb, alpha: number): string {
  return `${formatHex6(rgb)}${hex2(alpha)}`;
}

export function rgbToHsv(rgb: Rgb): Hsv {
  const r = clampByte(rgb.r) / 255;
  const g = clampByte(rgb.g) / 255;
  const b = clampByte(rgb.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) {
      h = ((g - b) / delta) % 6;
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgb(hsv: Hsv): Rgb {
  const hue = Number.isFinite(hsv.h) ? ((hsv.h % 360) + 360) % 360 : 0;
  const s = clampUnit(hsv.s);
  const v = clampUnit(hsv.v);
  const chroma = v * s;
  const sector = hue / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const m = v - chroma;
  let r = 0;
  let g = 0;
  let b = 0;
  if (sector < 1) {
    r = chroma; g = x; b = 0;
  } else if (sector < 2) {
    r = x; g = chroma; b = 0;
  } else if (sector < 3) {
    r = 0; g = chroma; b = x;
  } else if (sector < 4) {
    r = 0; g = x; b = chroma;
  } else if (sector < 5) {
    r = x; g = 0; b = chroma;
  } else {
    r = chroma; g = 0; b = x;
  }
  return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255) };
}

export function alphaByteToPercent(byte: number): number {
  return Math.round((clampByte(byte) / 255) * 100);
}

export function percentToAlphaByte(percent: number): number {
  if (!Number.isFinite(percent)) return 255;
  return Math.round((Math.min(100, Math.max(0, percent)) / 100) * 255);
}
