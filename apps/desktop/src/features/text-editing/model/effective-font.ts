import { resolveDocumentFontFamily } from "@/features/document";

/**
 * Which font a position in the body is actually drawn with.
 *
 * There is no paragraph-level font in SigmaDoc — `fontFamily` lives on inline nodes only — so the
 * "font of this paragraph" is whatever the surrounding frame or the document default says. The
 * three levels, in order:
 *
 *   1. the `styledText` mark on the run
 *   2. the enclosing box's `frame.bodyFontFamily` / `frame.titleFontFamily`
 *   3. the document default
 *
 * The toolbar has to show the value from *this* resolution, not the last font the user picked from
 * the dropdown: those are different things the moment the caret moves somewhere the user did not
 * set by hand.
 */
export type EffectiveFontSource = "mark" | "boxBody" | "boxTitle" | "document";

export type EffectiveFontResolution =
  | { kind: "resolved"; fontFamily: string; source: EffectiveFontSource }
  | { kind: "mixed" };

export interface EffectiveFontInput {
  /**
   * One entry per run in the selection, `null` where the run carries no font mark.
   * A collapsed caret contributes exactly one entry; an empty block contributes none.
   */
  markFontFamilies: readonly (string | null)[];
  boxBodyFontFamily?: string | null;
  boxTitleFontFamily?: string | null;
  inBoxTitle: boolean;
  documentFontFamily: string;
}

export function resolveEffectiveFontFamily(input: EffectiveFontInput): EffectiveFontResolution {
  const fallback = resolveFallback(input);
  if (input.markFontFamilies.length === 0) {
    // An empty paragraph or the position right after a line break has no run at all. Reporting
    // "mixed" there would hide the font the next keystroke will actually use.
    return fallback;
  }

  let resolved: EffectiveFontResolution | null = null;
  for (const markFontFamily of input.markFontFamilies) {
    // Compare *effective* values: an unmarked run and a run explicitly marked with the same font
    // look identical, so they must not read as a mix.
    const current: EffectiveFontResolution = normalizeFontFamily(markFontFamily) === null
      ? fallback
      : { kind: "resolved", fontFamily: normalizeFontFamily(markFontFamily)!, source: "mark" };

    if (!resolved) {
      resolved = current;
      continue;
    }
    if (resolved.kind === "resolved" && current.kind === "resolved" && resolved.fontFamily !== current.fontFamily) {
      return { kind: "mixed" };
    }
  }

  return resolved ?? fallback;
}

function resolveFallback(input: EffectiveFontInput): Extract<EffectiveFontResolution, { kind: "resolved" }> {
  // The title and the body are styled by two separate custom properties, and each is only emitted
  // when the frame sets that one. A title in a frame that only sets `bodyFontFamily` therefore
  // inherits the document default — it does *not* pick up the body font.
  if (input.inBoxTitle) {
    const boxTitle = normalizeFontFamily(input.boxTitleFontFamily);
    return boxTitle
      ? { kind: "resolved", fontFamily: boxTitle, source: "boxTitle" }
      : { kind: "resolved", fontFamily: input.documentFontFamily, source: "document" };
  }

  const boxBody = normalizeFontFamily(input.boxBodyFontFamily);
  if (boxBody) {
    return { kind: "resolved", fontFamily: boxBody, source: "boxBody" };
  }

  return { kind: "resolved", fontFamily: input.documentFontFamily, source: "document" };
}

function normalizeFontFamily(value: string | null | undefined): string | null {
  return resolveDocumentFontFamily(value) ?? null;
}
