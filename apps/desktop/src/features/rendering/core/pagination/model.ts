/**
 * Line model and placement output of the flow pagination engine.
 *
 * Every coordinate is an unzoomed px value in the natural coordinate space of
 * the page flow: the position an element has when nothing is displaced by the
 * paginator. Placement never feeds back into these values, so measuring the
 * natural flow and placing it is an open loop.
 */

/** Tolerance used for every "fits" comparison (matches the existing `+ 0.5` convention). */
export const FLOW_EPS = 0.5;

export type BreakKind = "page" | "column";

/**
 * Atomic vertical unit: one visual line (line box ∪ overlapping attachments ∪
 * glued chrome) or one unsplittable object. Problem numbers, box titles and
 * headings are ordinary lines.
 */
export interface FlowLine {
  kind: "line";
  /** `${ownerId}#${n}`; stable and document-derived. Unique within a model. */
  key: string;
  /** Positionable element that carries the line (PM node id, widget key, attachment id, unit id). */
  ownerId: string;
  /** Natural start when the line opens a region: min(line box top, glued opening chrome, attachments). */
  top: number;
  /** Must be ≤ region bottom + FLOW_EPS: max(ink bottom, attachments, glued closing chrome). */
  fitBottom: number;
  /** Natural end used for the next natural gap and for clip bands: max(line box bottom, fitBottom). */
  bottom: number;
  /** Own margin/padding kept only at a forced region start (first line of a block), otherwise 0. */
  leadingSpace: number;
  /** Container ids whose opening chrome is glued to this line (already included in `top`). */
  opens?: readonly string[];
  /** Container ids whose closing chrome is glued to this line (already included in `fitBottom`). */
  closes?: readonly string[];
}

/** Splittable vertical space. It may be cut at any position. */
export interface FlowBlank {
  kind: "blank";
  key: string;
  ownerId: string;
  /** Natural y. For a virtual blank this is the insertion point (zero natural height). */
  top: number;
  height: number;
  /** true = reservation that is not in the DOM; false = in the DOM (deferred-paste placeholder). */
  virtual: boolean;
  /**
   * Height of closing chrome that follows the blank in the natural flow and is
   * glued to its last piece (for example the bottom padding and border of a
   * frame around a reserved answer area). The last piece of the blank and this
   * chrome always share a region. Defaults to 0.
   */
  closingChrome?: number;
  /** Container ids whose closing chrome is glued to the end of this blank. */
  closes?: readonly string[];
}

/** Manual break. It is a no-op when nothing is placed yet in the current page (or column). */
export interface FlowBreak {
  kind: "break";
  key: string;
  ownerId: string;
  target: BreakKind;
}

/** One independent column of a band. Its items form their own flow keyed by `key`. */
export interface FlowColumn {
  key: string;
  ownerId: string;
  /** Horizontal offset of the column inside the band (reported in the region geometry only). */
  xOffset: number;
  width: number;
  items: readonly FlowItem[];
}

/**
 * Independent columns (layoutSection unit, including problemLayoutSection).
 * Columns are never balanced; the next item of the enclosing flow starts after
 * the column that ends last. Opening chrome of a container around the band is
 * part of `top`; the builder glues chrome that must follow the band's last
 * row to the last line of every column.
 */
export interface FlowBand {
  kind: "band";
  key: string;
  ownerId: string;
  /** Natural grid top. */
  top: number;
  /** Natural grid bottom (tallest column). */
  bottom: number;
  columns: readonly FlowColumn[];
  opens?: readonly string[];
  closes?: readonly string[];
}

export type FlowItem = FlowLine | FlowBlank | FlowBreak | FlowBand;

/**
 * A run of items with one column span. On a page with several columns, a
 * `column` section flows through the page columns and a `full` section spans
 * the content width. The column content on the last page before a `full`
 * section is balanced.
 */
export interface FlowSection {
  key: string;
  span: "column" | "full";
  items: readonly FlowItem[];
}

/** Things that need per-region pieces when rendered (not used by the placement itself). */
export interface FlowContainer {
  id: string;
  kind: "problemFrame" | "reservation" | "columnRule" | "areaExtent";
  /** Positionable that renders the pieces (unit id). */
  hostId: string;
  /** First..last items it spans (in its flow). */
  itemKeys: readonly string[];
}

export interface FlowModel {
  sections: readonly FlowSection[];
  containers: readonly FlowContainer[];
}

export interface PageGeometry {
  pageHeight: number;
  pageGap: number;
  /** Content box top relative to the page top. */
  contentTop: number;
  contentHeight: number;
  contentLeft: number;
  contentWidth: number;
  columnCount: number;
  columnWidth: number;
  columnGap: number;
}

/**
 * A rectangle that receives content. Region `index` values follow the order in
 * which the engine opened the regions, so within one flow they increase along
 * the flow.
 */
export interface Region {
  index: number;
  page: number;
  /** Page column index; -1 for a full-width region. Band column regions report their page column. */
  column: number;
  x: number;
  width: number;
  top: number;
  bottom: number;
  /** Flow that owns the region: "root" or a band column key. */
  flowKey: string;
  /** Region of the enclosing flow for a band column region, otherwise null. */
  parentIndex: number | null;
  /** Horizontal displacement applied to content placed in this region. */
  dx: number;
}

/**
 * A maximal run of one flow that is placed with a single displacement.
 * Ownership ranges of one flow are contiguous: a segment's `from` is the
 * previous segment's `to` (the cut), so margins above the first item of a
 * segment belong to that segment.
 */
export interface PlacementSegment {
  /** "root" | band column key. */
  flowKey: string;
  /** Natural half-open ownership range. */
  from: number;
  to: number;
  /** Natural clip band: first item top .. last item bottom, clamped to the region unless it ends with a tall line. */
  visibleFrom: number;
  visibleTo: number;
  regionIndex: number;
  dx: number;
  dy: number;
}

export interface PlacedLine {
  key: string;
  regionIndex: number;
  /** Placed top (canvas coordinates) of the line's `top`. */
  y: number;
  dx: number;
  /** y - line.top. */
  dy: number;
}

export interface PlacedBlankPiece {
  key: string;
  ownerId: string;
  regionIndex: number;
  y: number;
  height: number;
}

/** Column content of the last page before a full-span section that was balanced. */
export interface BalancedTail {
  sectionKey: string;
  page: number;
  /** Top of the balanced columns. */
  top: number;
  /** Column height chosen by the balancing (0.5px resolution). */
  height: number;
}

export interface FlowPlacementDiagnostics {
  /** Lines taller than a region, placed at a region top and overflowing it. */
  tallLines: readonly string[];
  /** Section keys whose last-page columns were balanced before a full-span section. */
  balanced: readonly string[];
  balancedTails: readonly BalancedTail[];
  /** Breaks inside band columns (column ownership is structural, R9). */
  ignoredBreaks: readonly string[];
}

export interface FlowPlacement {
  regions: readonly Region[];
  segments: readonly PlacementSegment[];
  /** Placed lines in placement order, keyed by line key. */
  lines: ReadonlyMap<string, PlacedLine>;
  blanks: readonly PlacedBlankPiece[];
  pageCount: number;
  diagnostics: FlowPlacementDiagnostics;
}
