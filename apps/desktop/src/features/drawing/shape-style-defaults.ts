import type {
  OverlayArrowhead,
  OverlayDash,
  OverlayTextSize,
} from "@/features/document";
import { getArrowheadMarkerSpec } from "@/features/rendering/core";

import type { OverlayInsertCommand } from "./overlay-tool";

/**
 * The style a newly inserted shape starts from: what the author last chose in the toolbar.
 *
 * Deliberately only style axes. Coordinates, sizes, rotation, point lists, labels and per-shape
 * geometry are absent from the type, so "the new shape inherited the old one's position" is not a
 * bug that can be introduced here — it is not expressible.
 *
 * **Every axis is optional, and absent means "the author has not chosen".** That is what lets each
 * shape keep its own designed look until there is a real choice to apply: a sector is drawn lightly
 * shaded, a block arrow pale blue, and neither should turn into a bare outline just because a
 * default table had to name some value for "fill".
 *
 * The matrix of which axes carry over to which shape is a table (`STYLE_AXES_BY_COMMAND`) rather
 * than a chain of conditionals, because a chain is how an axis quietly goes missing for one tool.
 */
export interface OverlayShapeStyleDefaults {
  color?: string;
  strokeOpacity?: number;
  dash?: OverlayDash;
  size?: OverlayTextSize;
  arrowheadStart?: OverlayArrowhead;
  arrowheadEnd?: OverlayArrowhead;
  fill?: "none" | "solid";
  fillColor?: string;
  fillOpacity?: number;
}

export type OverlayShapeStyleAxis = keyof OverlayShapeStyleDefaults;

/** Nothing chosen yet: every shape draws itself the way it was designed. */
export const DEFAULT_OVERLAY_SHAPE_STYLE: OverlayShapeStyleDefaults = Object.freeze({});

/** Every axis, in one place, so a new one cannot be forgotten by a loop below. */
const STYLE_AXES: readonly OverlayShapeStyleAxis[] = [
  "color",
  "strokeOpacity",
  "dash",
  "size",
  "arrowheadStart",
  "arrowheadEnd",
  "fill",
  "fillColor",
  "fillOpacity",
];

/** Axes every shape that has a stroke carries. */
const STROKE_AXES: readonly OverlayShapeStyleAxis[] = ["color", "strokeOpacity", "dash", "size"];

/** Open shapes add their endpoint decorations; closed ones add their fill. */
const OPEN_AXES: readonly OverlayShapeStyleAxis[] = [...STROKE_AXES, "arrowheadStart", "arrowheadEnd"];
const CLOSED_AXES: readonly OverlayShapeStyleAxis[] = [...STROKE_AXES, "fill", "fillColor", "fillOpacity"];

/**
 * Which axes each insert command takes from the remembered style.
 *
 * A total table, not a partial one: a command added to `OverlayInsertCommand` has to state its
 * answer here, rather than silently inheriting nothing.
 *
 * The empty lists are deliberate:
 * - `highlight` means "a translucent yellow marker"; feeding it the remembered colour would make
 *   the highlighter stop being a highlighter.
 * - `text` / `callout` / `graph` / `table` use `color` and `size` for their own purposes (text
 *   colour, font size), so a line's stroke settings do not mean the same thing there.
 * - `chart` colours its series from the table's own tracks and the shared palette; the remembered
 *   stroke colour would overwrite an author's per-series choice with the last line they drew.
 */
const STYLE_AXES_BY_COMMAND: Record<OverlayInsertCommand, readonly OverlayShapeStyleAxis[]> = {
  line: OPEN_AXES,
  arrow: OPEN_AXES,
  polyline: OPEN_AXES,
  curve: OPEN_AXES,
  freehand: OPEN_AXES,
  arc: OPEN_AXES,
  threePointArc: OPEN_AXES,
  rectangle: CLOSED_AXES,
  circle: CLOSED_AXES,
  ellipse: CLOSED_AXES,
  triangle: CLOSED_AXES,
  diamond: CLOSED_AXES,
  pentagon: CLOSED_AXES,
  hexagon: CLOSED_AXES,
  heptagon: CLOSED_AXES,
  octagon: CLOSED_AXES,
  nonagon: CLOSED_AXES,
  decagon: CLOSED_AXES,
  hendecagon: CLOSED_AXES,
  dodecagon: CLOSED_AXES,
  blockArrow: CLOSED_AXES,
  sector: CLOSED_AXES,
  highlight: [],
  text: [],
  callout: [],
  graph: [],
  graph3d: [],
  table: [],
  chart: [],
};

/**
 * The remembered values this command may use.
 *
 * Switching tools therefore carries only what the two shapes have in common: a line and a rectangle
 * share the stroke axes, so the colour follows; the rectangle's fill and the line's arrow heads do
 * not appear in the other's list at all.
 */
export function pickStyleDefaultsForInsert(
  command: OverlayInsertCommand,
  defaults: OverlayShapeStyleDefaults,
): Partial<OverlayShapeStyleDefaults> {
  const picked: Partial<OverlayShapeStyleDefaults> = {};
  for (const axis of STYLE_AXES_BY_COMMAND[command]) {
    const value = defaults[axis];
    if (value !== undefined) {
      // `!== undefined`, never truthiness: `fillOpacity: 0` is a fully transparent fill, and
      // `strokeOpacity: 0` an invisible outline. Both are values the author chose.
      assignAxis(picked, axis, value);
    }
  }
  return picked;
}

/**
 * The defaults after a toolbar change.
 *
 * Takes only the axes the patch actually names, so changing the line width does not also reset the
 * remembered fill. `!== undefined` rather than truthiness, so setting an opacity to 0 is a change
 * like any other.
 */
export function mergeStyleDefaults(
  current: OverlayShapeStyleDefaults,
  patch: Partial<OverlayShapeStyleDefaults>,
): OverlayShapeStyleDefaults {
  const next: OverlayShapeStyleDefaults = { ...current };
  for (const axis of STYLE_AXES) {
    copyAxis(next, patch, axis);
  }
  return normalizeStyleDefaults(next);
}

/**
 * A stored value read back into a usable one.
 *
 * Anything unrecognised falls back to the built-in default rather than being dropped, so a value
 * written by a newer build, or a hand-edited storage entry, cannot leave the insert path without a
 * colour or a line width.
 */
export function normalizeStyleDefaults(value: unknown): OverlayShapeStyleDefaults {
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const normalized: OverlayShapeStyleDefaults = {};
  const color = normalizeStyleColor(source.color);
  if (color !== undefined) {
    normalized.color = color;
  }
  const strokeOpacity = normalizeOpacity(source.strokeOpacity);
  if (strokeOpacity !== undefined) {
    normalized.strokeOpacity = strokeOpacity;
  }
  if (isDash(source.dash)) {
    normalized.dash = source.dash;
  }
  if (isTextSize(source.size)) {
    normalized.size = source.size;
  }
  if (isArrowhead(source.arrowheadStart)) {
    normalized.arrowheadStart = source.arrowheadStart;
  }
  if (isArrowhead(source.arrowheadEnd)) {
    normalized.arrowheadEnd = source.arrowheadEnd;
  }
  if (source.fill === "solid" || source.fill === "none") {
    normalized.fill = source.fill;
  }
  const fillColor = normalizeStyleColor(source.fillColor);
  if (fillColor !== undefined) {
    normalized.fillColor = fillColor;
  }
  const fillOpacity = normalizeOpacity(source.fillOpacity);
  if (fillOpacity !== undefined) {
    normalized.fillOpacity = fillOpacity;
  }
  return normalized;
}

/**
 * A colour this module is willing to hand to a shape.
 *
 * Checked as strictly as every other axis, and for the same reason: this value comes back from
 * storage, is written into `color`, `fillColor` *and* `labelColor`, and is then saved into the
 * material. An unchecked string would ride into documents that the published viewer refuses
 * outright — one bad entry would make the whole material unopenable there, permanently.
 *
 * Hex or a bare CSS keyword; the palette's own storage reader (`ColorPalette.tsx`) is no looser.
 */
function normalizeStyleColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return /^[a-z]{1,32}$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function normalizeOpacity(value: unknown): number | undefined {
  // `0` is a legitimate opacity; only a missing or unusable value falls back.
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, value));
}

function isDash(value: unknown): value is OverlayDash {
  return value === "solid" || value === "dashed" || value === "dotted";
}

function isTextSize(value: unknown): value is OverlayTextSize {
  return value === "s" || value === "m" || value === "l" || value === "xl";
}

function isArrowhead(value: unknown): value is OverlayArrowhead {
  // Asked of the marker spec table rather than of a second copy of the list: that table is keyed by
  // the head union, so the compiler already forces it to cover every value the model allows. This
  // feature may only reach `features/document` for types, so the list itself is out of reach here.
  return value === "none" || (typeof value === "string" && getArrowheadMarkerSpec(value) !== null);
}

function assignAxis<K extends OverlayShapeStyleAxis>(
  target: Partial<OverlayShapeStyleDefaults>,
  axis: K,
  value: OverlayShapeStyleDefaults[K],
): void {
  target[axis] = value;
}

function copyAxis<K extends OverlayShapeStyleAxis>(
  target: OverlayShapeStyleDefaults,
  source: Partial<OverlayShapeStyleDefaults>,
  axis: K,
): void {
  const value = source[axis];
  if (value !== undefined) {
    target[axis] = value;
  }
}
