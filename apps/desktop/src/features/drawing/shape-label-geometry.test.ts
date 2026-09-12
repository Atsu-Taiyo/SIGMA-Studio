import { describe, expect, it } from "vitest";

import type {
  OverlayArrowShape,
  OverlayGeoShape,
  OverlayLineShape,
  OverlayShape,
} from "@/features/document";

import { getShapeLabelBounds, getShapeLabelPlacement } from "./shape-label-geometry";
import { TEXT_ASCENT_EM, TEXT_DESCENT_EM } from "./svg-label-metrics";

/** `overlayLabelFontSize("m")`, the default size the fixtures below use. */
const LABEL_FONT_SIZE_M = 18;

function line(props: Partial<OverlayLineShape["props"]> = {}): OverlayLineShape {
  return {
    id: "line",
    type: "line",
    x: 10,
    y: 20,
    props: {
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      closed: false,
      color: "#111111",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
      ...props,
    },
  } as OverlayLineShape;
}

function arrow(props: Partial<OverlayArrowShape["props"]> = {}): OverlayArrowShape {
  return {
    id: "arrow",
    type: "arrow",
    x: 0,
    y: 0,
    props: {
      start: { x: 0, y: 50 },
      end: { x: 100, y: 50 },
      arrowheadStart: "none",
      arrowheadEnd: "none",
      fill: "none",
      color: "#111111",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
      ...props,
    },
  } as OverlayArrowShape;
}

function geo(): OverlayGeoShape {
  return {
    id: "geo",
    type: "geo",
    x: 0,
    y: 0,
    props: {
      w: 100,
      h: 40,
      geo: "rectangle",
      fill: "none",
      color: "#111111",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
      label: "A",
    },
  } as OverlayGeoShape;
}

function anchorOf(shape: OverlayShape) {
  return getShapeLabelPlacement(shape)?.anchor ?? null;
}

describe("getShapeLabelPlacement", () => {
  it("puts a two-point line's label on its end point, where the renderer draws it", () => {
    // `getLineMidpoint` is `points[floor(n / 2)]`, not the geometric middle, so a two-point line
    // captions its *end*. Copying that rule is the point of this module.
    expect(anchorOf(line({ label: "AB" }))).toEqual({ x: 110, y: 12 });
  });

  it("uses the middle vertex of a three-point line", () => {
    const shape = line({
      label: "AB",
      points: [{ x: 0, y: 0 }, { x: 50, y: -100 }, { x: 100, y: 0 }],
    });

    expect(anchorOf(shape)).toEqual({ x: 60, y: -88 });
  });

  it("puts an arrow's label eight pixels above the middle of its segment", () => {
    expect(anchorOf(arrow({ label: "AB" }))).toEqual({ x: 50, y: 42 });
  });

  it("stays on the stored segment when a head shortens the drawn line", () => {
    const trimmed = arrow({ label: "AB", arrowheadEnd: "arrow", size: "xl" });

    expect(anchorOf(trimmed)).toEqual(anchorOf(arrow({ label: "AB" })));
  });

  it("reports the text and font size the caption is drawn with", () => {
    expect(getShapeLabelPlacement(line({ label: "AB" })))
      .toMatchObject({ text: "AB", fontSizePx: LABEL_FONT_SIZE_M });
    expect(getShapeLabelPlacement(line({ label: "AB", size: "xl" }))?.fontSizePx).toBe(28);
  });

  it.each([
    ["no label", line()],
    ["an empty label", line({ label: "" })],
    ["no points", line({ label: "AB", points: [] })],
    ["a shape that captions its own box", geo() as OverlayShape],
  ])("returns null for %s", (_label, shape) => {
    expect(getShapeLabelPlacement(shape)).toBeNull();
  });
});

describe("getShapeLabelBounds", () => {
  it("reaches an ascent above the baseline and a descent below it", () => {
    const bounds = getShapeLabelBounds(line({ label: "AB" }))!;
    const anchor = anchorOf(line({ label: "AB" }))!;

    expect(bounds.y).toBeCloseTo(anchor.y - LABEL_FONT_SIZE_M * TEXT_ASCENT_EM, 10);
    expect(bounds.y + bounds.h).toBeCloseTo(anchor.y + LABEL_FONT_SIZE_M * TEXT_DESCENT_EM, 10);
    expect(bounds.h).toBeCloseTo(LABEL_FONT_SIZE_M, 10);
  });

  it("centres the box on the anchor, as `text-anchor: middle` draws it", () => {
    const bounds = getShapeLabelBounds(line({ label: "AB" }))!;
    const anchor = anchorOf(line({ label: "AB" }))!;

    expect(bounds.x + bounds.w / 2).toBeCloseTo(anchor.x, 10);
    expect(bounds.w).toBeGreaterThan(0);
  });

  it("grows with the label and with the size token", () => {
    const short = getShapeLabelBounds(line({ label: "A" }))!;
    const long = getShapeLabelBounds(line({ label: "A much longer caption" }))!;
    const large = getShapeLabelBounds(line({ label: "A", size: "xl" }))!;

    expect(long.w).toBeGreaterThan(short.w);
    expect(large.w).toBeGreaterThan(short.w);
    expect(large.h).toBeGreaterThan(short.h);
  });

  it("measures a label with a line break as the single line SVG draws", () => {
    const broken = getShapeLabelBounds(line({ label: "A\nB" }))!;
    const spaced = getShapeLabelBounds(line({ label: "A B" }))!;

    expect(broken.h).toBeCloseTo(spaced.h, 10);
    expect(broken.w).toBe(spaced.w);
  });

  /**
   * Characterization: the caption box is exactly what the shared estimator used to return, now
   * that the estimator lives in `svg-label-metrics.ts` instead of the rich-text measurement path.
   * The expected widths are written out from the character-class table rather than computed by
   * calling the estimator, so this pins the numbers instead of restating the implementation.
   */
  it.each([
    ["latin glyphs", "AB", 0.58 * 2],
    ["full-width glyphs", "あい", 1 * 2],
    ["a space between words", "a b", 0.58 + 0.35 + 0.58],
    ["operators and digits", "x=1", 0.58 + 0.45 + 0.58],
    ["a line break, drawn as one line", "A\nB", 0.58 + 0.35 + 0.58],
  ])("measures %s at the estimator's own width", (_name, label, widthEm) => {
    expect(getShapeLabelBounds(line({ label }))!.w).toBe(Math.ceil(widthEm * LABEL_FONT_SIZE_M));
  });

  it("returns null wherever there is no anchor", () => {
    expect(getShapeLabelBounds(line())).toBeNull();
    expect(getShapeLabelBounds(geo() as OverlayShape)).toBeNull();
  });
});
