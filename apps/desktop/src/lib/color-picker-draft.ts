/**
 * The colour-creation dialog's state machine, kept as pure transitions.
 *
 * The dialog is driven by pointer drags, sliders and typed text — none of which a Node test can
 * exercise. Keeping every transition here means hue retention, the eight-digit hex, the clamping
 * and the "nothing changed" guard are all fixed by unit tests, and the React component is left with
 * nothing but event plumbing.
 *
 * HSV is the stored form rather than RGB because black and white have no hue of their own: deriving
 * the hue from RGB on every move would throw the author's hue away the moment they dragged into a
 * corner of the saturation/value square.
 */

import {
  type Hsv,
  type Rgb,
  alphaByteToPercent,
  formatHex6,
  formatHex8,
  hsvToRgb,
  parseHexColor,
  percentToAlphaByte,
  rgbToHsv,
} from "./color";
import { fillOpacityToPercent, percentToFillOpacity } from "./fill-opacity";

/** What the dialog shows when the selection has no single colour to start from. */
export const DEFAULT_DRAFT_COLOR = "#000000";

export type ColorChannel = "r" | "g" | "b";

export interface ColorDraft {
  readonly hsv: Hsv;
  /** 0..100 whole percent, the same precision the toolbar has always edited opacity in. */
  readonly alphaPercent: number;
  /** Exactly what the hex box shows, including text that is not (yet) a colour. */
  readonly hexText: string;
  /** Whether the author has changed anything. Until then the dialog previews nothing. */
  readonly touched: boolean;
  /** Whether this caller edits transparency at all; decides six- vs eight-digit hex. */
  readonly alphaEnabled: boolean;
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clampHue(hue: number): number {
  if (!Number.isFinite(hue)) return 0;
  return Math.min(360, Math.max(0, hue));
}

function canonicalHexText(hsv: Hsv, alphaPercent: number, alphaEnabled: boolean): string {
  const rgb = hsvToRgb(hsv);
  return alphaEnabled ? formatHex8(rgb, percentToAlphaByte(alphaPercent)) : formatHex6(rgb);
}

/** Re-derives HSV from RGB while keeping the hue (and, for black, the saturation) the author set. */
function hsvFromRgbKeepingHue(rgb: Rgb, previous: Hsv): Hsv {
  const next = rgbToHsv(rgb);
  return {
    h: next.s === 0 ? previous.h : next.h,
    s: next.v === 0 ? previous.s : next.s,
    v: next.v,
  };
}

function commit(draft: ColorDraft, hsv: Hsv, alphaPercent: number): ColorDraft {
  if (hsv.h === draft.hsv.h && hsv.s === draft.hsv.s && hsv.v === draft.hsv.v
    && alphaPercent === draft.alphaPercent) {
    return draft;
  }
  return {
    hsv,
    alphaPercent,
    hexText: canonicalHexText(hsv, alphaPercent, draft.alphaEnabled),
    touched: true,
    alphaEnabled: draft.alphaEnabled,
  };
}

export function createColorDraft(input: { color: string | null; opacity: number | undefined }): ColorDraft {
  const alphaEnabled = input.opacity !== undefined;
  const alphaPercent = fillOpacityToPercent(input.opacity);
  const parsed = input.color === null ? null : parseHexColor(input.color);
  const hsv = parsed ? rgbToHsv(parsed.rgb) : rgbToHsv(parseHexColor(DEFAULT_DRAFT_COLOR)!.rgb);
  return {
    hsv,
    alphaPercent,
    // A stored colour this module cannot parse (`red`, `rgb(...)`) is shown as it is, so the author
    // can see what is really there instead of finding it silently replaced with black.
    hexText: parsed || input.color === null
      ? canonicalHexText(hsv, alphaPercent, alphaEnabled)
      : input.color,
    touched: false,
    alphaEnabled,
  };
}

export function setDraftHue(draft: ColorDraft, hue: number): ColorDraft {
  return commit(draft, { ...draft.hsv, h: clampHue(hue) }, draft.alphaPercent);
}

export function setDraftSaturationValue(draft: ColorDraft, saturation: number, value: number): ColorDraft {
  return commit(draft, { h: draft.hsv.h, s: clampUnit(saturation), v: clampUnit(value) }, draft.alphaPercent);
}

export function setDraftAlphaPercent(draft: ColorDraft, percent: number): ColorDraft {
  return commit(draft, draft.hsv, clampPercent(percent));
}

export function setDraftChannel(draft: ColorDraft, channel: ColorChannel, value: number): ColorDraft {
  if (!Number.isFinite(value)) return draft;
  const rgb = { ...draftRgb(draft), [channel]: Math.min(255, Math.max(0, Math.round(value))) };
  return commit(draft, hsvFromRgbKeepingHue(rgb, draft.hsv), draft.alphaPercent);
}

export function setDraftHexText(draft: ColorDraft, text: string): ColorDraft {
  if (text === draft.hexText) return draft;
  const parsed = parseHexColor(text);
  if (!parsed) {
    // Half-typed text has to stay on screen, or the box fights the author on every keystroke.
    return { ...draft, hexText: text };
  }
  // An alpha only moves when the text actually spells one out; otherwise editing `#00ff00` while
  // the fill sits at 40% would quietly make it opaque.
  const alphaPercent = draft.alphaEnabled && parsed.hasAlpha
    ? alphaByteToPercent(parsed.alpha)
    : draft.alphaPercent;
  const hsv = hsvFromRgbKeepingHue(parsed.rgb, draft.hsv);
  // `commit` collapses an unchanged colour to the same object, which is what a stationary drag
  // needs — but the text did change (the guard above proved it), so it is kept either way.
  // Dropping it here would eat the last character every time the author retypes the colour that
  // is already shown, and a controlled input would snap the box back on the next keystroke.
  return { ...commit(draft, hsv, alphaPercent), hexText: text };
}

export function draftRgb(draft: ColorDraft): Rgb {
  return hsvToRgb(draft.hsv);
}

/** Always six digits: the document stores colour and opacity in separate fields. */
export function draftColor(draft: ColorDraft): string {
  return formatHex6(draftRgb(draft));
}

export function draftOpacity(draft: ColorDraft): number {
  return percentToFillOpacity(draft.alphaPercent);
}

/** The eight-digit spelling, for display and typing only. */
export function draftHex8(draft: ColorDraft): string {
  return formatHex8(draftRgb(draft), percentToAlphaByte(draft.alphaPercent));
}
