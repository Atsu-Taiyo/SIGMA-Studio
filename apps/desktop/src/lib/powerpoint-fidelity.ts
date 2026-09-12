/**
 * Layout-fidelity measurement for the PowerPoint importer.
 *
 * The point of this module is to answer "did the import keep the slide?" with a
 * number instead of an opinion. It re-reads the PPTX with its **own** OOXML
 * reader and compares that against the imported `SigmaDocument`.
 *
 * ## Why a second reader
 *
 * Reusing `powerpoint-import.ts`'s OOXML helpers for the expected values would
 * make the check assert that the importer agrees with itself. So this file
 * parses the source again with `preserveOrder: true`, which yields exact
 * document order and correct nested-group nesting - two things the importer's
 * key-grouped parse plus regex slicer do not guarantee.
 *
 * Three conventions are unavoidably shared with the importer. They are OOXML/CSS
 * rules or importer decisions read back from the output, not re-derivations:
 *
 * 1. `EMU_PER_INCH = 914400` at 96 dpi - an OOXML/CSS constant.
 * 2. Slide order comes from `p:sldIdLst` + `ppt/_rels/presentation.xml.rels` -
 *    an OOXML rule. It is re-implemented here; disagreement is itself a finding.
 * 3. The page stride is an *importer* decision, so it is read back from the
 *    document (`getPageMetrics(...).page.heightPx + PAGE_GAP_PX`) and never
 *    recomputed from EMU.
 *
 * ## Why most objects are not strictly compared
 *
 * Predicting the imported box of a group child (`a:chOff`/`a:chExt` chains), a
 * rotated shape, a group (whose box is recomputed from its children), or a
 * placeholder that inherits its geometry from the layout/master would
 * re-implement the importer badly and produce confident wrong numbers. Those
 * objects are therefore *reported* in `notStrictlyCompared` with a reason -
 * never silently dropped. Coverage and text still apply to them: a lost group
 * child is lost content no matter how hard its geometry is to predict.
 */
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

import {
  getOverlayTextBlocksLabelText,
  getPageMetrics,
  inlineNodesToPlainText,
  PAGE_GAP_PX,
} from "@/features/document";
import type { OverlayShape, SigmaDocument, SigmaTableSpec } from "@/features/document";
import { createTranslator, type AppLocale, type Translate } from "@/lib/i18n";
import { POWERPOINT_OVERLAY_EXTENSION, readPowerPointShapeSlideIndex } from "@/lib/powerpoint-import";

const EMU_PER_INCH = 914400;
const PX_PER_INCH = 96;
const EMU_PER_PX = EMU_PER_INCH / PX_PER_INCH;
const DEFAULT_SLIDE_SIZE_EMU = { w: 10 * EMU_PER_INCH, h: 7.5 * EMU_PER_INCH };

/** `pptx-viewer-core` rounds every coordinate to an integer px, so 1px is the floor. */
export const DEFAULT_GEOMETRY_TOLERANCE_PX = 1;
export const DEFAULT_GEOMETRY_ERROR_TOLERANCE_PX = 4;
export const DEFAULT_FONT_SIZE_TOLERANCE_PT = 0.5;

const DRAWABLE_TAGS = new Set(["p:sp", "p:pic", "p:cxnSp", "p:graphicFrame", "p:grpSp"]);

export type PptxSourceObjectTag = "p:sp" | "p:pic" | "p:cxnSp" | "p:graphicFrame" | "p:grpSp";

export interface PptxEmuBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PptxSourceObject {
  slideIndex: number;
  /** Document order within the object's parent (`p:spTree` or the enclosing `p:grpSp`). */
  zIndex: number;
  tag: PptxSourceObjectTag;
  /** `p:cNvPr/@id`. */
  ooxmlId?: string;
  /** `p:cNvPr/@name` - the value `shapeNames` joins on. */
  name: string;
  /** Set for group descendants; the name of the enclosing `p:grpSp`. */
  parentName?: string;
  topLevel: boolean;
  hidden: boolean;
  isPlaceholder: boolean;
  /** Absent when the object carries no `a:off`/`a:ext` of its own. */
  boxEmu?: PptxEmuBox;
  /** Raw `a:xfrm/@rot` (1/60000 degree). */
  rotation1_60000?: number;
  flipH: boolean;
  flipV: boolean;
  /** `a:t` + `m:t` concatenated in document order. */
  text: string;
  /** `a:rPr/@sz / 100` for every run that declares one. */
  explicitRunSizesPt: number[];
  /** Total run count, so `explicitRunSizesPt.length < runCount` means inheritance. */
  runCount: number;
  /** `a:bodyPr/a:normAutofit/@fontScale / 100000`. */
  autoFitFontScale?: number;
  /**
   * For a `p:graphicFrame` holding an `a:tbl`, the size the table's own grid implies
   * (summed `a:gridCol/@w` and `a:tr/@h`). Google Slides exports authored frames with a
   * placeholder `a:ext` - both instances on the verification decks are exactly
   * 3000000x3000000 EMU - so the frame extent is not the rendered size.
   */
  intrinsicTableSizeEmu?: { w: number; h: number };
  /**
   * Product of the enclosing groups' `a:ext / a:chExt` vertical ratios, i.e. the factor
   * by which ancestors rescale this object's rendered font size. Exactly `1` (the usual
   * case - PowerPoint writes `chExt === ext` for a plain group) means no rescaling, so
   * the font size is still predictable and worth comparing.
   */
  ancestorFontScale?: number;
}

export interface PptxSourceSlide {
  index: number;
  partPath: string;
  objects: PptxSourceObject[];
  layoutObjectNames: string[];
  masterObjectNames: string[];
}

export interface PptxSourceOutline {
  slideSizeEmu: { w: number; h: number };
  slides: PptxSourceSlide[];
}

export type PptxFidelityAxis = "document" | "coverage" | "geometry" | "text";
export type PptxFidelitySeverity = "error" | "warning" | "info";

export type NotStrictlyComparedReason =
  | "group"
  | "groupChild"
  | "rotated"
  | "inheritedGeometry"
  | "inheritedFontSize"
  | "nonTextShapeKind"
  | "ambiguousName"
  | "unmappedGraphicFrame"
  | "intrinsicTableSize";

export type PptxFidelityDiscrepancyKind =
  | "slideCountMismatch"
  | "pageSizeMismatch"
  | "missingObject"
  | "emptyPlaceholderDropped"
  | "unknownImportedShape"
  | "groupDissolved"
  | "geometryDelta"
  | "offPage"
  | "textMissing"
  | "textMismatch"
  | "fontSizeDelta";

export interface PptxFidelityDiscrepancy {
  severity: PptxFidelitySeverity;
  axis: PptxFidelityAxis;
  kind: PptxFidelityDiscrepancyKind;
  slideIndex: number;
  objectName?: string;
  ooxmlId?: string;
  shapeId?: string;
  expected?: Record<string, number | string>;
  actual?: Record<string, number | string>;
  deltaPx?: number;
}

export interface PptxNotStrictlyComparedEntry {
  slideIndex: number;
  objectName: string;
  reason: NotStrictlyComparedReason;
}

export interface PptxFidelityReport {
  file: string;
  slideCount: { source: number; imported: number };
  /**
   * `strictlyCompared + notStrictlyCompared === sourceObjects` - the anti-silent-skip
   * invariant. The partition is over the **geometry** gate; font-size exclusions
   * (`inheritedFontSize`, `nonTextShapeKind`, and `groupChild` for a child whose group
   * rescales it) add entries to the `notStrictlyCompared` list without being counted a
   * second time, as does `intrinsicTableSize` (a table frame whose height is compared
   * as a lower bound, its width and position still strictly). `groupChild` is the one
   * reason both gates can produce, so it is recorded once rather than tallied twice.
   */
  counts: { strictlyCompared: number; notStrictlyCompared: number; sourceObjects: number };
  /** Pre-sorted: error → warning → info, then document → coverage → geometry → text. */
  discrepancies: PptxFidelityDiscrepancy[];
  notStrictlyCompared: PptxNotStrictlyComparedEntry[];
  /** Set by the runner when a whole file blew up before it could be compared. */
  failure?: string;
}

export interface PptxFidelityOptions {
  file?: string;
  geometryTolerancePx?: number;
  geometryErrorTolerancePx?: number;
  fontSizeTolerancePt?: number;
}

// ---------------------------------------------------------------------------
// Independent OOXML read
// ---------------------------------------------------------------------------

/**
 * `preserveOrder: true` turns every element into `{ "<tag>": [children], ":@": attrs }`
 * so document order and nesting survive intact. That is the whole reason this
 * harness does not reuse the importer's key-grouped parser.
 */
type OrderedNode = Record<string, unknown> & { ":@"?: Record<string, string> };

const orderedParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
});

function parseOrdered(xml: string): OrderedNode[] {
  return orderedParser.parse(xml) as OrderedNode[];
}

function tagOf(node: OrderedNode): string | undefined {
  return Object.keys(node).find((key) => key !== ":@" && key !== "#text");
}

function childrenOf(node: OrderedNode): OrderedNode[] {
  const tag = tagOf(node);
  if (tag === undefined) {
    return [];
  }
  const value = node[tag];
  return Array.isArray(value) ? (value as OrderedNode[]) : [];
}

function attrOf(node: OrderedNode | undefined, name: string): string | undefined {
  return node?.[":@"]?.[`@_${name}`];
}

function numberAttrOf(node: OrderedNode | undefined, name: string): number | undefined {
  const raw = attrOf(node, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function findChild(node: OrderedNode | undefined, tag: string): OrderedNode | undefined {
  return node === undefined ? undefined : childrenOf(node).find((child) => tagOf(child) === tag);
}

/**
 * Descendants that belong to the object being read, stopping where a nested element
 * becomes an object in its own right.
 *
 * `collectSourceObjects` recurses into `p:grpSp` and nothing else, so the children of
 * a group - and only those - are collected separately. A `p:grpSp` has no `p:txBody`
 * of its own (OOXML does not allow one), and the imported group shape holds no text
 * either, so walking its whole subtree credited the container with everything inside
 * it and the text axis then accused it of losing text that was never its own.
 *
 * The skip is deliberately scoped to groups: skipping nested drawables everywhere
 * would exclude them from their ancestor while nothing collected them separately,
 * leaving their content measured nowhere - which the module header forbids.
 */
function findOwnDescendants(
  node: OrderedNode,
  tag: string,
  skipNestedObjects: boolean,
  out: OrderedNode[] = [],
): OrderedNode[] {
  for (const child of childrenOf(node)) {
    const childTag = tagOf(child);
    if (childTag === tag) {
      out.push(child);
    }
    if (childTag === "mc:AlternateContent") {
      for (const alternative of unwrapAlternateContent(child)) {
        findOwnDescendants(alternative, tag, skipNestedObjects, out);
      }
      continue;
    }
    if (skipNestedObjects && childTag !== undefined && DRAWABLE_TAGS.has(childTag)) {
      continue;
    }
    findOwnDescendants(child, tag, skipNestedObjects, out);
  }
  return out;
}

/** `a:t` + `m:t` concatenated in document order - the trap the importer's tag-grouped walk falls into. */
function readOrderedText(node: OrderedNode, skipNestedObjects: boolean, out: string[] = []): string[] {
  for (const child of childrenOf(node)) {
    const tag = tagOf(child);
    if (tag === "a:t" || tag === "m:t") {
      out.push(readNodeText(child));
      continue;
    }
    if (tag === "a:br") {
      out.push("\n");
      continue;
    }
    if (tag === "a:p") {
      // Every `a:p` is a paragraph, i.e. a line break in the rendered text. Without
      // this separator two paragraphs run together into one word and every
      // multi-paragraph body reads as a text mismatch that is not there.
      readOrderedText(child, skipNestedObjects, out);
      out.push("\n");
      continue;
    }
    if (tag === "mc:AlternateContent") {
      // Inline equations are authored as `mc:Choice` (OMML) + `mc:Fallback` (plain
      // runs) carrying the SAME characters. Reading both concatenates the text with
      // itself ("x+1x+1"), which is a permanent bogus mismatch and would mask a real
      // text loss on that shape.
      for (const alternative of unwrapAlternateContent(child)) {
        readOrderedText(alternative, skipNestedObjects, out);
      }
      continue;
    }
    if (skipNestedObjects && tag !== undefined && DRAWABLE_TAGS.has(tag)) {
      continue;
    }
    readOrderedText(child, skipNestedObjects, out);
  }
  return out;
}

function readNodeText(node: OrderedNode): string {
  return childrenOf(node)
    .map((child) => (typeof child["#text"] === "string" ? child["#text"] : ""))
    .join("");
}

/**
 * `mc:AlternateContent` wraps the same object in `mc:Choice` and `mc:Fallback`.
 * Only the Choice subtree is the object; taking both would double-count it.
 */
function unwrapAlternateContent(node: OrderedNode): OrderedNode[] {
  const choice = findChild(node, "mc:Choice") ?? findChild(node, "mc:Fallback");
  return choice === undefined ? [] : childrenOf(choice);
}

function nonVisualPropsOf(node: OrderedNode): OrderedNode | undefined {
  return childrenOf(node).find((child) => /^p:nv[A-Za-z0-9]*Pr$/u.test(tagOf(child) ?? ""));
}

function transformOf(node: OrderedNode, tag: string): OrderedNode | undefined {
  if (tag === "p:graphicFrame") {
    return findChild(node, "p:xfrm");
  }
  if (tag === "p:grpSp") {
    return findChild(findChild(node, "p:grpSpPr"), "a:xfrm");
  }
  return findChild(findChild(node, "p:spPr"), "a:xfrm");
}

/**
 * The size a table's own grid implies. Derived straight from the source XML, so it
 * stays independent of whatever the importer decided.
 */
function readIntrinsicTableSizeEmu(node: OrderedNode): { w: number; h: number } | undefined {
  const columns = findOwnDescendants(node, "a:gridCol", false).map((column) => numberAttrOf(column, "w"));
  const rows = findOwnDescendants(node, "a:tr", false).map((row) => numberAttrOf(row, "h"));
  // A missing `@w`/`@h` must not silently become 0: that would make the grid disagree
  // with any extent and quietly weaken the comparison instead of reporting it.
  if (columns.length === 0 || rows.length === 0
    || columns.some((value) => value === undefined) || rows.some((value) => value === undefined)) {
    return undefined;
  }
  return {
    w: columns.reduce((total: number, value) => total + (value ?? 0), 0),
    h: rows.reduce((total: number, value) => total + (value ?? 0), 0),
  };
}

function readSourceObject(
  node: OrderedNode,
  tag: PptxSourceObjectTag,
  context: { slideIndex: number; zIndex: number; parentName?: string; ancestorFontScale?: number },
): PptxSourceObject {
  const nonVisual = nonVisualPropsOf(node);
  const cNvPr = findChild(nonVisual, "p:cNvPr");
  const xfrm = transformOf(node, tag);
  const off = findChild(xfrm, "a:off");
  const ext = findChild(xfrm, "a:ext");
  const offX = numberAttrOf(off, "x");
  const offY = numberAttrOf(off, "y");
  const extW = numberAttrOf(ext, "cx");
  const extH = numberAttrOf(ext, "cy");
  const hasOwnBox = offX !== undefined && offY !== undefined && extW !== undefined && extH !== undefined;

  // Only a group's children are collected as separate objects, so only a group
  // must stop short of them.
  const ownsNestedObjects = tag === "p:grpSp";
  const intrinsicTableSizeEmu = tag === "p:graphicFrame" ? readIntrinsicTableSizeEmu(node) : undefined;
  const runs = findOwnDescendants(node, "a:r", ownsNestedObjects);
  const explicitRunSizesPt = runs
    .map((run) => numberAttrOf(findChild(run, "a:rPr"), "sz"))
    .filter((size): size is number => size !== undefined)
    .map((size) => size / 100);
  const fontScaleRaw = numberAttrOf(
    findChild(findOwnDescendants(node, "a:bodyPr", ownsNestedObjects)[0] ?? node, "a:normAutofit"),
    "fontScale",
  );
  const rotation = numberAttrOf(xfrm, "rot");

  return {
    slideIndex: context.slideIndex,
    zIndex: context.zIndex,
    tag,
    ...(attrOf(cNvPr, "id") === undefined ? {} : { ooxmlId: attrOf(cNvPr, "id") }),
    name: attrOf(cNvPr, "name") ?? "",
    ...(context.parentName === undefined ? {} : { parentName: context.parentName }),
    topLevel: context.parentName === undefined,
    hidden: attrOf(cNvPr, "hidden") === "1",
    isPlaceholder: findChild(findChild(nonVisual, "p:nvPr"), "p:ph") !== undefined,
    ...(hasOwnBox ? { boxEmu: { x: offX, y: offY, w: extW, h: extH } } : {}),
    ...(rotation === undefined ? {} : { rotation1_60000: rotation }),
    flipH: attrOf(xfrm, "flipH") === "1",
    flipV: attrOf(xfrm, "flipV") === "1",
    text: readOrderedText(node, ownsNestedObjects).join(""),
    explicitRunSizesPt,
    runCount: runs.length,
    ...(fontScaleRaw === undefined ? {} : { autoFitFontScale: fontScaleRaw / 100000 }),
    ...(context.ancestorFontScale === undefined ? {} : { ancestorFontScale: context.ancestorFontScale }),
    ...(intrinsicTableSizeEmu === undefined ? {} : { intrinsicTableSizeEmu }),
  };
}

/**
 * The factor by which a group rescales its children vertically (`a:ext / a:chExt`).
 * Reading it is not the same as re-implementing the `chOff`/`chExt` chain: it is only
 * used to tell "this group rescales its children" from "this group does not", and when
 * it does not, no prediction is needed at all.
 */
function groupChildScaleY(node: OrderedNode): number {
  const xfrm = transformOf(node, "p:grpSp");
  const ext = numberAttrOf(findChild(xfrm, "a:ext"), "cy");
  const childExt = numberAttrOf(findChild(xfrm, "a:chExt"), "cy");
  if (ext === undefined || childExt === undefined || childExt === 0) {
    return 1;
  }
  return ext / childExt;
}

function collectSourceObjects(
  container: OrderedNode,
  context: { slideIndex: number; parentName?: string; ancestorFontScale?: number },
  out: PptxSourceObject[] = [],
): PptxSourceObject[] {
  let zIndex = 0;
  const visit = (nodes: OrderedNode[]): void => {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === "mc:AlternateContent") {
        visit(unwrapAlternateContent(node));
        continue;
      }
      if (tag === undefined || !DRAWABLE_TAGS.has(tag)) {
        continue;
      }
      const object = readSourceObject(node, tag as PptxSourceObjectTag, {
        slideIndex: context.slideIndex,
        zIndex,
        ...(context.parentName === undefined ? {} : { parentName: context.parentName }),
        ...(context.ancestorFontScale === undefined ? {} : { ancestorFontScale: context.ancestorFontScale }),
      });
      zIndex += 1;
      out.push(object);
      if (tag === "p:grpSp") {
        collectSourceObjects(node, {
          slideIndex: context.slideIndex,
          parentName: object.name,
          ancestorFontScale: (context.ancestorFontScale ?? 1) * groupChildScaleY(node),
        }, out);
      }
    }
  };
  visit(childrenOf(container));
  return out;
}

function findSpTree(root: OrderedNode[]): OrderedNode | undefined {
  const sld = root.find((node) => tagOf(node) !== undefined && tagOf(node)?.startsWith("p:sld"));
  const cSld = findChild(sld, "p:cSld");
  return findChild(cSld, "p:spTree");
}

function resolvePartPath(fromPart: string, target: string): string {
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  const segments = fromPart.split("/").slice(0, -1);
  for (const piece of target.split("/")) {
    if (piece === "." || piece === "") continue;
    if (piece === "..") {
      segments.pop();
      continue;
    }
    segments.push(piece);
  }
  return segments.join("/");
}

async function readRelationshipTargets(zip: JSZip, relsPath: string): Promise<Map<string, { id: string; type: string; target: string }>> {
  const file = zip.file(relsPath);
  const relationships = new Map<string, { id: string; type: string; target: string }>();
  if (!file) {
    return relationships;
  }
  const root = parseOrdered(await file.async("string"));
  const container = root.find((node) => tagOf(node) === "Relationships");
  for (const node of container === undefined ? [] : childrenOf(container)) {
    if (tagOf(node) !== "Relationship") continue;
    const id = attrOf(node, "Id");
    if (id === undefined) continue;
    relationships.set(id, { id, type: attrOf(node, "Type") ?? "", target: attrOf(node, "Target") ?? "" });
  }
  return relationships;
}

async function readObjectNames(zip: JSZip, partPath: string): Promise<string[]> {
  const file = zip.file(partPath);
  if (!file) {
    return [];
  }
  const spTree = findSpTree(parseOrdered(await file.async("string")));
  if (spTree === undefined) {
    return [];
  }
  return collectSourceObjects(spTree, { slideIndex: 0 }).map((object) => object.name).filter(Boolean);
}

/**
 * Reads the slide outline straight out of the PPTX with an independent parser.
 * Slide order comes from `p:sldIdLst` + the presentation relationships, never
 * from zip entry order.
 */
export async function readPptxSourceOutline(bytes: Uint8Array): Promise<PptxSourceOutline> {
  const zip = await JSZip.loadAsync(bytes);
  const presentationPath = "ppt/presentation.xml";
  const presentationFile = zip.file(presentationPath);
  if (!presentationFile) {
    throw new Error(`${presentationPath} is missing - not a PowerPoint package`);
  }
  const presentationRoot = parseOrdered(await presentationFile.async("string"));
  const presentation = presentationRoot.find((node) => tagOf(node) === "p:presentation");
  const sldSz = findChild(presentation, "p:sldSz");
  const slideSizeEmu = {
    w: numberAttrOf(sldSz, "cx") ?? DEFAULT_SLIDE_SIZE_EMU.w,
    h: numberAttrOf(sldSz, "cy") ?? DEFAULT_SLIDE_SIZE_EMU.h,
  };

  const presentationRels = await readRelationshipTargets(zip, "ppt/_rels/presentation.xml.rels");
  const slideIdList = findChild(presentation, "p:sldIdLst");
  const slidePaths = (slideIdList === undefined ? [] : childrenOf(slideIdList))
    .filter((node) => tagOf(node) === "p:sldId")
    .map((node) => presentationRels.get(attrOf(node, "r:id") ?? "")?.target)
    .filter((target): target is string => Boolean(target))
    .map((target) => resolvePartPath(presentationPath, target));

  const slides: PptxSourceSlide[] = [];
  for (const [index, partPath] of slidePaths.entries()) {
    const slideFile = zip.file(partPath);
    const spTree = slideFile ? findSpTree(parseOrdered(await slideFile.async("string"))) : undefined;
    const objects = spTree === undefined ? [] : collectSourceObjects(spTree, { slideIndex: index });

    const slideRels = await readRelationshipTargets(zip, resolvePartPath(partPath, `_rels/${partPath.split("/").pop()}.rels`));
    const layoutRel = [...slideRels.values()].find((rel) => rel.type.endsWith("/slideLayout"));
    const layoutPath = layoutRel ? resolvePartPath(partPath, layoutRel.target) : undefined;
    const layoutObjectNames = layoutPath ? await readObjectNames(zip, layoutPath) : [];

    let masterObjectNames: string[] = [];
    if (layoutPath !== undefined) {
      const layoutRels = await readRelationshipTargets(zip, resolvePartPath(layoutPath, `_rels/${layoutPath.split("/").pop()}.rels`));
      const masterRel = [...layoutRels.values()].find((rel) => rel.type.endsWith("/slideMaster"));
      if (masterRel) {
        masterObjectNames = await readObjectNames(zip, resolvePartPath(layoutPath, masterRel.target));
      }
    }

    slides.push({ index, partPath, objects, layoutObjectNames, masterObjectNames });
  }

  return { slideSizeEmu, slides };
}

// ---------------------------------------------------------------------------
// Imported-side read models
// ---------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function pointsBox(x: number, y: number, points: ReadonlyArray<{ x: number; y: number }>): Box {
  if (points.length === 0) {
    return { x, y, w: 0, h: 0 };
  }
  const xs = points.map((point) => x + point.x);
  const ys = points.map((point) => y + point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/**
 * The *stored* box of an imported shape.
 *
 * Never use `getShapeBounds` here: it routes text through `measureOverlayText`
 * and returns a render-time estimate (`max(storedH, fallbackHeight, measuredH)`),
 * which would make the geometry axis measure the renderer instead of the import.
 */
export function importedShapeBox(shape: OverlayShape): Box {
  switch (shape.type) {
    case "group":
    case "geo":
    case "image":
    case "tableShape":
    case "chartShape":
    case "graph2dShape":
    case "graph3dShape":
    case "callout":
      return { x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h };
    case "text":
      return { x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h ?? 0 };
    case "arc": {
      const rx = shape.props.rx ?? shape.props.r;
      const ry = shape.props.ry ?? shape.props.r;
      return { x: shape.x, y: shape.y, w: rx * 2, h: ry * 2 };
    }
    case "line":
      return pointsBox(shape.x, shape.y, shape.props.points);
    case "arrow":
      return pointsBox(shape.x, shape.y, [shape.props.start, shape.props.end]);
  }
}

function tableText(table: SigmaTableSpec): string {
  const rowOrder = new Map(table.rows.map((row, index) => [row.id, index]));
  const columnOrder = new Map(table.columns.map((column, index) => [column.id, index]));
  return [...table.cells]
    .sort((a, b) => (
      (rowOrder.get(a.rowId) ?? 0) - (rowOrder.get(b.rowId) ?? 0)
      || (columnOrder.get(a.columnId) ?? 0) - (columnOrder.get(b.columnId) ?? 0)
    ))
    .flatMap((cell) => cell.content.map((content) => (
      content.type === "paragraph" ? inlineNodesToPlainText(content.children) : ""
    )))
    .join(" ");
}

/** Preset geometry arrives as `line`/`geo`/`arrow` with the text in `props.label`, not `richText`. */
export function importedShapeText(shape: OverlayShape): string {
  switch (shape.type) {
    case "text":
    case "callout":
      return getOverlayTextBlocksLabelText(shape.props.blocks);
    case "geo":
    case "line":
    case "arrow":
      return shape.props.label ?? "";
    case "tableShape":
      return tableText(shape.props.table);
    default:
      return "";
  }
}

function importedShapeFontSizePt(shape: OverlayShape): number | undefined {
  return shape.type === "text" || shape.type === "callout" ? shape.props.fontSize : undefined;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function emuToPx(emu: number): number {
  return emu / EMU_PER_PX;
}

function bucketKey(slideIndex: number, name: string): string {
  return `${slideIndex} ${name}`;
}

function isDrawable(object: PptxSourceObject): boolean {
  if (object.hidden) {
    return false;
  }
  if (object.tag === "p:grpSp") {
    // A group's content is its children, so its own empty text says nothing about
    // whether it is drawable. Without this a placeholder group drops out of the
    // measured set entirely and is reported as an empty placeholder that vanished.
    return true;
  }
  return !(object.isPlaceholder && collapseWhitespace(object.text) === "");
}

function readShapeNames(document: SigmaDocument): Record<string, string> {
  const extension = document.pageLayout?.overlay?.overlaySnapshot?.extensions?.[POWERPOINT_OVERLAY_EXTENSION];
  const shapeNames = (extension as { shapeNames?: Record<string, string> } | undefined)?.shapeNames;
  return shapeNames ?? {};
}

/**
 * How many pages the imported document actually reaches, measured from shape
 * extents the way `PageCanvasEditor` grows its sheet count.
 *
 * `metadata.source.slideCount` must NOT be used here. The importer sets it to
 * `slidePaths.length`, which is the same list this harness derives
 * `outline.slides.length` from - comparing the two would be circular and the
 * `slideCountMismatch` axis could never fire. That is the exact failure this
 * harness exists to prevent, so the imported side is measured, not asked.
 */
function measureImportedPageCount(shapes: readonly OverlayShape[], stride: number): number {
  let lastPageIndex = -1;
  for (const shape of shapes) {
    const box = importedShapeBox(shape);
    const bottom = box.y + Math.max(0, box.h);
    lastPageIndex = Math.max(lastPageIndex, Math.floor(box.y / stride), Math.floor(bottom / stride));
  }
  return lastPageIndex + 1;
}

/** The importer's own claim about the slide count - provenance only, never the expected value. */
function readDeclaredSlideCount(document: SigmaDocument): number | undefined {
  const declared = document.metadata?.source?.slideCount;
  return typeof declared === "number" && Number.isFinite(declared) ? declared : undefined;
}

const SEVERITY_RANK: Record<PptxFidelitySeverity, number> = { error: 0, warning: 1, info: 2 };
const AXIS_RANK: Record<PptxFidelityAxis, number> = { document: 0, coverage: 1, geometry: 2, text: 3 };

interface RankedDiscrepancy {
  discrepancy: PptxFidelityDiscrepancy;
  zIndex: number;
}

/**
 * Compares one imported document against the source outline. Pure: no zip, no
 * filesystem, no async - so the whole rule set is unit-testable in milliseconds.
 */
export function comparePptxImportFidelity(
  outline: PptxSourceOutline,
  document: SigmaDocument,
  options: PptxFidelityOptions = {},
): PptxFidelityReport {
  const geometryTolerancePx = options.geometryTolerancePx ?? DEFAULT_GEOMETRY_TOLERANCE_PX;
  const geometryErrorTolerancePx = options.geometryErrorTolerancePx ?? DEFAULT_GEOMETRY_ERROR_TOLERANCE_PX;
  const fontSizeTolerancePt = options.fontSizeTolerancePt ?? DEFAULT_FONT_SIZE_TOLERANCE_PT;
  const file = options.file ?? document.metadata?.source?.originalFileName ?? "(unnamed)";

  const metrics = getPageMetrics(document.pageLayout);
  const stride = metrics.page.heightPx + PAGE_GAP_PX;
  const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
  const shapeNames = readShapeNames(document);
  const sourceSlideCount = outline.slides.length;
  const importedSlideCount = measureImportedPageCount(shapes, stride);
  const declaredSlideCount = readDeclaredSlideCount(document);

  const ranked: RankedDiscrepancy[] = [];
  const notStrictlyCompared: PptxNotStrictlyComparedEntry[] = [];
  const push = (discrepancy: PptxFidelityDiscrepancy, zIndex = 0): void => {
    ranked.push({ discrepancy, zIndex });
  };

  // --- document axis ------------------------------------------------------
  //
  // Off-slide ("pasteboard") content is imported as authored - a product decision,
  // not a defect - so a page count that runs past the slide count *because* a shape
  // hangs below its own slide is accepted behaviour and must not be an error. It is
  // still reported, at `info`, because it is worth seeing.
  //
  // The excess is "explained" only when every imported shape still belongs to a real
  // slide, which is recorded in its id. A shape claiming a slide that does not exist,
  // or pages going missing, is a genuine pagination defect and stays an error.
  const maxRecordedSlideIndex = shapes.reduce((highest, shape) => {
    const recorded = readPowerPointShapeSlideIndex(shape.id);
    return recorded === undefined ? highest : Math.max(highest, recorded);
  }, -1);
  // Every shape must actually state which slide it belongs to. Treating an
  // unparseable id as "makes no claim" would let a stray shape explain itself away,
  // and a document of entirely foreign ids could never raise this axis at all.
  const everyShapeRecordsItsSlide = shapes.every(
    (shape) => readPowerPointShapeSlideIndex(shape.id) !== undefined,
  );
  const excessIsOffSlideContent = importedSlideCount > sourceSlideCount
    && everyShapeRecordsItsSlide
    && maxRecordedSlideIndex < sourceSlideCount;
  if (sourceSlideCount !== importedSlideCount) {
    push({
      severity: excessIsOffSlideContent ? "info" : "error",
      axis: "document",
      kind: "slideCountMismatch",
      slideIndex: 0,
      expected: { slides: sourceSlideCount },
      actual: {
        slides: importedSlideCount,
        ...(excessIsOffSlideContent ? { explainedBy: "offSlideContent" } : {}),
        // Surfaced so a reader can see the importer's claim next to the measurement.
        ...(declaredSlideCount === undefined || declaredSlideCount === importedSlideCount
          ? {}
          : { declared: declaredSlideCount }),
      },
    });
  }
  const expectedPage = { widthPx: emuToPx(outline.slideSizeEmu.w), heightPx: emuToPx(outline.slideSizeEmu.h) };
  const pageDelta = Math.max(
    Math.abs(expectedPage.widthPx - metrics.page.widthPx),
    Math.abs(expectedPage.heightPx - metrics.page.heightPx),
  );
  if (pageDelta > geometryErrorTolerancePx) {
    push({
      severity: "error",
      axis: "document",
      kind: "pageSizeMismatch",
      slideIndex: 0,
      expected: { widthPx: round2(expectedPage.widthPx), heightPx: round2(expectedPage.heightPx) },
      actual: { widthPx: round2(metrics.page.widthPx), heightPx: round2(metrics.page.heightPx) },
      deltaPx: round2(pageDelta),
    });
  }

  // --- imported shapes attributed to their source slide --------------------
  //
  // The slide comes from the shape's own id, which the importer mints as
  // `ppt_shape_<slide+1>_<sourceId>` - recorded provenance, not a guess.
  //
  // Inferring it from geometry (`floor(shape.y / stride)`) is wrong for any shape
  // authored outside its slide bounds, and that is ordinary content: decks park
  // objects on the pasteboard above or below the slide, and a group child's absolute
  // position need not match its group-relative source box. Such a shape lands in a
  // neighbouring band where its name matches nothing, which reported a present object
  // as `missingObject` and its shape as a phantom `unknownImportedShape`. Guessing by
  // name instead is worse: it lets one slide's object claim a same-named shape from
  // another page, which masks a genuinely dropped object - a false negative.
  const maxPage = Math.max(0, sourceSlideCount - 1);
  const clampPage = (page: number): number => Math.min(maxPage, Math.max(0, page));
  const slideIndexOfShape = (shape: OverlayShape): number => {
    const recorded = readPowerPointShapeSlideIndex(shape.id);
    // The fallback is defensive only: every id reaching here was minted above.
    return clampPage(recorded ?? Math.floor(shape.y / stride));
  };

  const buckets = new Map<string, OverlayShape[]>();
  for (const shape of shapes) {
    const name = shapeNames[shape.id];
    if (name === undefined) {
      continue;
    }
    const key = bucketKey(slideIndexOfShape(shape), name);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [shape]);
    } else {
      bucket.push(shape);
    }
  }

  let strictlyCompared = 0;
  let notStrictlyComparedCount = 0;
  let sourceObjectCount = 0;
  const claimedShapeIds = new Set<string>();

  for (const slide of outline.slides) {
    const drawable = slide.objects.filter(isDrawable);
    sourceObjectCount += drawable.length;
    const mappedByObject = assignShapes(slide, drawable, buckets, stride);

    for (const object of slide.objects) {
      const mapped = mappedByObject.get(object) ?? [];
      for (const shape of mapped) {
        claimedShapeIds.add(shape.id);
      }
    }

    for (const object of slide.objects) {
      if (!isDrawable(object)) {
        // An empty placeholder that vanished is expected, not a loss - but say so.
        if (object.isPlaceholder && !object.hidden && (mappedByObject.get(object) ?? []).length === 0) {
          push({
            severity: "info",
            axis: "coverage",
            kind: "emptyPlaceholderDropped",
            slideIndex: slide.index,
            objectName: object.name,
            ...(object.ooxmlId === undefined ? {} : { ooxmlId: object.ooxmlId }),
          }, object.zIndex);
        }
        continue;
      }

      const mapped = mappedByObject.get(object) ?? [];
      const ambiguous = mappedByObject.has(object) && mapped.length === 0 && hasNameRival(slide, object);

      // --- classification (geometry gate) ---------------------------------
      const reason = classifyGeometry(object, ambiguous);
      if (reason === undefined) {
        strictlyCompared += 1;
      } else {
        notStrictlyComparedCount += 1;
        notStrictlyCompared.push({ slideIndex: slide.index, objectName: object.name, reason });
      }

      if (ambiguous) {
        continue;
      }

      // --- coverage -------------------------------------------------------
      if (mapped.length === 0) {
        if (object.tag === "p:grpSp" && groupHasMappedDescendant(slide, object, mappedByObject)) {
          push({
            severity: "info",
            axis: "coverage",
            kind: "groupDissolved",
            slideIndex: slide.index,
            objectName: object.name,
            ...(object.ooxmlId === undefined ? {} : { ooxmlId: object.ooxmlId }),
          }, object.zIndex);
        } else {
          push({
            severity: "error",
            axis: "coverage",
            kind: "missingObject",
            slideIndex: slide.index,
            objectName: object.name,
            ...(object.ooxmlId === undefined ? {} : { ooxmlId: object.ooxmlId }),
          }, object.zIndex);
        }
        continue;
      }

      // A source object can legitimately expand into several shapes (charts,
      // SmartArt, ink, multi-subpath geometry). Children append a suffix to the
      // parent id, so the shortest id is the object's own shape.
      const primary = [...mapped].sort((a, b) => a.id.length - b.id.length)[0]!;

      // --- geometry -------------------------------------------------------
      if (object.boxEmu !== undefined) {
        // A table frame's rendered size is its GRID's size, not its `a:ext`. Google
        // Slides writes a placeholder extent - both instances on the verification decks
        // are exactly 3000000x3000000 EMU - and Google's own rendering of deck04 slide 5
        // shows the 3x9 table at ~216x444px, not a 315px square.
        //
        // So the expected size for a table frame comes from `a:gridCol/@w` and
        // `a:tr/@h`, read here from the source XML by this harness's own parser. That
        // keeps the axis live: comparing against the grid checks that the importer
        // actually applied the intrinsic size, whereas merely declining to compare
        // would go green even if it regressed to the placeholder extent.
        const expectedSizeEmu = object.intrinsicTableSizeEmu ?? { w: object.boxEmu.w, h: object.boxEmu.h };
        const expectedBox: Box = {
          x: emuToPx(object.boxEmu.x),
          y: emuToPx(object.boxEmu.y) + slide.index * stride,
          w: emuToPx(expectedSizeEmu.w),
          h: emuToPx(expectedSizeEmu.h),
        };
        const actualBox = importedShapeBox(primary);

        // Width is exact: only rows grow to fit text, never columns. Height is a lower
        // bound, because `a:tr/@h` is a minimum - a table rendered TALLER than its
        // declared rows is legitimate, shorter is content being cut off.
        const heightIsLowerBound = object.intrinsicTableSizeEmu !== undefined;
        if (reason === undefined && heightIsLowerBound) {
          notStrictlyCompared.push({
            slideIndex: slide.index,
            objectName: object.name,
            reason: "intrinsicTableSize",
          });
        }
        const heightDeltaPx = heightIsLowerBound
          ? Math.max(0, expectedBox.h - actualBox.h)
          : Math.abs(expectedBox.h - actualBox.h);
        const deltaPx = Math.max(
          Math.abs(expectedBox.x - actualBox.x),
          Math.abs(expectedBox.y - actualBox.y),
          Math.abs(expectedBox.w - actualBox.w),
          heightDeltaPx,
        );
        if (reason === undefined && deltaPx > geometryTolerancePx) {
          push({
            severity: deltaPx > geometryErrorTolerancePx ? "error" : "warning",
            axis: "geometry",
            kind: "geometryDelta",
            slideIndex: slide.index,
            objectName: object.name,
            ...(object.ooxmlId === undefined ? {} : { ooxmlId: object.ooxmlId }),
            shapeId: primary.id,
            expected: {
              x: round2(emuToPx(object.boxEmu.x)),
              y: round2(emuToPx(object.boxEmu.y)),
              w: round2(expectedBox.w),
              // Named so the row shows the height was judged as a floor, not an equality.
              ...(heightIsLowerBound ? { minH: round2(expectedBox.h) } : { h: round2(expectedBox.h) }),
            },
            actual: {
              x: round2(actualBox.x),
              y: round2(actualBox.y - slide.index * stride),
              w: round2(actualBox.w),
              h: round2(actualBox.h),
            },
            deltaPx: round2(deltaPx),
          }, object.zIndex);
        }

        // A shape that escapes its own page band is lost to the reader even when the
        // delta looks small - so this runs for objects the strict geometry gate
        // excluded too (a rotated shape stranded three pages away is still stranded).
        // It needs the source box in SLIDE coordinates, so it is limited to top-level
        // objects; a group child's box is group-relative and a group's own imported box
        // is recomputed from its children, so neither can be judged this way.
        //
        // Deliberate limitation: a group child dropped onto the wrong page is therefore
        // still not caught here. Predicting where it should have landed means walking
        // the `chOff`/`chExt` chain, which this harness does not do.
        // Judged with the size that actually renders: a table frame's placeholder
        // `a:ext` is over half a slide tall, so using it would silently skip this check
        // for every table in the lower half of a slide.
        const sourceFitsSlide = object.boxEmu.x >= 0
          && object.boxEmu.y >= 0
          && object.boxEmu.x + expectedSizeEmu.w <= outline.slideSizeEmu.w
          && object.boxEmu.y + expectedSizeEmu.h <= outline.slideSizeEmu.h;
        const yInPage = actualBox.y - slide.index * stride;
        const escapesPage = yInPage < -geometryTolerancePx
          || yInPage + actualBox.h > metrics.page.heightPx + geometryTolerancePx
          || actualBox.x < -geometryTolerancePx
          || actualBox.x + actualBox.w > metrics.page.widthPx + geometryTolerancePx;
        if (object.topLevel && object.tag !== "p:grpSp" && sourceFitsSlide && escapesPage) {
          push({
            severity: "error",
            axis: "geometry",
            kind: "offPage",
            slideIndex: slide.index,
            objectName: object.name,
            ...(object.ooxmlId === undefined ? {} : { ooxmlId: object.ooxmlId }),
            shapeId: primary.id,
            expected: { pageWidthPx: round2(metrics.page.widthPx), pageHeightPx: round2(metrics.page.heightPx) },
            actual: { x: round2(actualBox.x), y: round2(yInPage), w: round2(actualBox.w), h: round2(actualBox.h) },
          }, object.zIndex);
        }
      }

      // --- text -----------------------------------------------------------
      const expectedText = collapseWhitespace(object.text);
      if (expectedText !== "") {
        const actualText = collapseWhitespace(mapped.map(importedShapeText).join(" "));
        if (actualText === "") {
          push({
            severity: "error",
            axis: "text",
            kind: "textMissing",
            slideIndex: slide.index,
            objectName: object.name,
            shapeId: primary.id,
            expected: { text: expectedText },
          }, object.zIndex);
        } else if (actualText !== expectedText) {
          push({
            severity: "warning",
            axis: "text",
            kind: "textMismatch",
            slideIndex: slide.index,
            objectName: object.name,
            shapeId: primary.id,
            expected: { text: expectedText },
            actual: { text: actualText },
          }, object.zIndex);
        }
      }

      // --- font size ------------------------------------------------------
      if (object.runCount > 0) {
        const fontSizeReason = classifyFontSize(object, primary);
        if (fontSizeReason !== undefined) {
          // A group child is excluded from both axes for the same `chExt` reason, so
          // record it once rather than tallying the same object twice.
          if (fontSizeReason !== reason) {
            notStrictlyCompared.push({ slideIndex: slide.index, objectName: object.name, reason: fontSizeReason });
          }
        } else {
          // `normAutofit` shrinks the run to fit the box, and PowerPoint draws it
          // at the shrunk size - so the expected size carries the scale too.
          const nominalPt = object.explicitRunSizesPt[0]!;
          const expectedPt = round3(nominalPt * (object.autoFitFontScale ?? 1));
          const actualPt = importedShapeFontSizePt(primary);
          if (actualPt !== undefined && Math.abs(actualPt - expectedPt) > fontSizeTolerancePt) {
            push({
              severity: "warning",
              axis: "text",
              kind: "fontSizeDelta",
              slideIndex: slide.index,
              objectName: object.name,
              shapeId: primary.id,
              expected: { fontSizePt: expectedPt },
              actual: { fontSizePt: actualPt },
            }, object.zIndex);
          }
        }
      }
    }
  }

  // --- reverse coverage ---------------------------------------------------
  const reported = new Set<string>();
  for (const shape of shapes) {
    const name = shapeNames[shape.id];
    if (name === undefined || claimedShapeIds.has(shape.id)) {
      continue;
    }
    // Scoped to the shape's own slide, which is now known exactly - so this axis
    // can still report a shape that landed on a slide never declaring its name.
    const page = slideIndexOfShape(shape);
    const slide = outline.slides[page];
    const known = slide === undefined
      ? false
      : slide.objects.some((object) => object.name === name)
        || slide.layoutObjectNames.includes(name)
        || slide.masterObjectNames.includes(name);
    const key = bucketKey(page, name);
    if (known || reported.has(key)) {
      continue;
    }
    reported.add(key);
    push({
      severity: "info",
      axis: "coverage",
      kind: "unknownImportedShape",
      slideIndex: page,
      objectName: name,
      shapeId: shape.id,
    });
  }

  ranked.sort((a, b) => (
    SEVERITY_RANK[a.discrepancy.severity] - SEVERITY_RANK[b.discrepancy.severity]
    || AXIS_RANK[a.discrepancy.axis] - AXIS_RANK[b.discrepancy.axis]
    || a.discrepancy.slideIndex - b.discrepancy.slideIndex
    || a.zIndex - b.zIndex
  ));

  return {
    file,
    slideCount: { source: sourceSlideCount, imported: importedSlideCount },
    counts: {
      strictlyCompared,
      notStrictlyCompared: notStrictlyComparedCount,
      sourceObjects: sourceObjectCount,
    },
    discrepancies: ranked.map((item) => item.discrepancy),
    notStrictlyCompared,
  };
}

function classifyGeometry(object: PptxSourceObject, ambiguous: boolean): NotStrictlyComparedReason | undefined {
  if (object.tag === "p:grpSp") {
    // `updateGroupBounds` recomputes a group's box from its children (plus point
    // padding), so the source `a:ext` is never the expected value.
    return "group";
  }
  if (!object.topLevel) {
    return "groupChild";
  }
  if (object.rotation1_60000 !== undefined && object.rotation1_60000 !== 0) {
    return "rotated";
  }
  if (object.boxEmu === undefined) {
    return "inheritedGeometry";
  }
  if (ambiguous) {
    return "ambiguousName";
  }
  return undefined;
}

const FONT_SCALE_EPSILON = 1e-6;

function classifyFontSize(object: PptxSourceObject, primary: OverlayShape): NotStrictlyComparedReason | undefined {
  // Most specific reason first, so a group child that also inherits its size is
  // reported as `inheritedFontSize` rather than losing that detail.
  if (object.explicitRunSizesPt.length < object.runCount) {
    return "inheritedFontSize";
  }
  if (importedShapeFontSizePt(primary) === undefined) {
    return "nonTextShapeKind";
  }
  if (!object.topLevel && Math.abs((object.ancestorFontScale ?? 1) - 1) > FONT_SCALE_EPSILON) {
    // A group that rescales its children rescales their font size too, and predicting
    // the rendered point size would be the same guess the geometry axis declines to
    // make. A group that does NOT rescale (the usual `chExt === ext`) leaves the size
    // predictable, so it stays compared - otherwise a repeat of the px-vs-pt defect
    // would go silent inside every group.
    return "groupChild";
  }
  return undefined;
}

function hasNameRival(slide: PptxSourceSlide, object: PptxSourceObject): boolean {
  return slide.objects.filter((other) => other.name === object.name).length > 1;
}

function groupHasMappedDescendant(
  slide: PptxSourceSlide,
  group: PptxSourceObject,
  mapped: Map<PptxSourceObject, OverlayShape[]>,
): boolean {
  const names = new Set([group.name]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const object of slide.objects) {
      if (object.parentName !== undefined && names.has(object.parentName) && !names.has(object.name)) {
        names.add(object.name);
        grew = true;
      }
    }
  }
  return slide.objects.some((object) => (
    object !== group && object.parentName !== undefined && names.has(object.parentName)
    && (mapped.get(object) ?? []).length > 0
  ));
}

/**
 * `cNvPr/@name` is authored text and repeats freely, so a bucket can hold several
 * source objects. One object owns every shape in its bucket (1:N is legitimate);
 * several objects share it greedily by nearest box centre and whoever is left over
 * is reported as `ambiguousName` rather than guessed at.
 */
function assignShapes(
  slide: PptxSourceSlide,
  drawable: readonly PptxSourceObject[],
  buckets: Map<string, OverlayShape[]>,
  stride: number,
): Map<PptxSourceObject, OverlayShape[]> {
  const assigned = new Map<PptxSourceObject, OverlayShape[]>();
  const byName = new Map<string, PptxSourceObject[]>();
  for (const object of drawable) {
    byName.set(object.name, [...(byName.get(object.name) ?? []), object]);
  }

  for (const [name, objects] of byName) {
    // Copy: the greedy branch below splices, and the bucket is shared.
    const candidates = [...(buckets.get(bucketKey(slide.index, name)) ?? [])];
    if (objects.length === 1) {
      assigned.set(objects[0]!, candidates);
      continue;
    }
    const remaining = [...candidates];
    for (const object of objects) {
      if (object.boxEmu === undefined || remaining.length === 0) {
        assigned.set(object, []);
        continue;
      }
      const expectedCentre = {
        x: emuToPx(object.boxEmu.x + object.boxEmu.w / 2),
        y: emuToPx(object.boxEmu.y + object.boxEmu.h / 2) + slide.index * stride,
      };
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const [index, shape] of remaining.entries()) {
        const box = importedShapeBox(shape);
        const distance = Math.hypot(
          box.x + box.w / 2 - expectedCentre.x,
          box.y + box.h / 2 - expectedCentre.y,
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
      assigned.set(object, remaining.splice(bestIndex, 1));
    }
  }

  return assigned;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Runner support
// ---------------------------------------------------------------------------

export async function measurePptxImportFidelity(
  bytes: Uint8Array,
  document: SigmaDocument,
  options: PptxFidelityOptions = {},
): Promise<PptxFidelityReport> {
  return comparePptxImportFidelity(await readPptxSourceOutline(bytes), document, options);
}

/**
 * Measures a whole deck directory. One broken file must never take the run down,
 * so a failure becomes `report.failure` and the loop continues.
 */
export async function runPptxFidelitySuite(
  files: readonly string[],
  load: (file: string) => Promise<{ bytes: Uint8Array; document: SigmaDocument }>,
): Promise<PptxFidelityReport[]> {
  const reports: PptxFidelityReport[] = [];
  for (const file of files) {
    try {
      const { bytes, document } = await load(file);
      reports.push(await measurePptxImportFidelity(bytes, document, { file }));
    } catch (error) {
      reports.push({
        file,
        slideCount: { source: 0, imported: 0 },
        counts: { strictlyCompared: 0, notStrictlyCompared: 0, sourceObjects: 0 },
        discrepancies: [],
        notStrictlyCompared: [],
        failure: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Report rendering (the output format is part of the contract, so it is tested)
// ---------------------------------------------------------------------------

const MAX_LISTED_DISCREPANCIES = 20;

const MAX_CELL_LENGTH = 200;

/**
 * Deck-controlled text lands in these cells. Object names and text runs routinely
 * contain `|` and newlines, and an unescaped one splits the row - silently
 * corrupting the ranked table that is the actual product of this harness.
 */
function tableCell(value: string, t: Translate<"editor">): string {
  const cleaned = value
    // Deck text carries real control characters; strip them before they reach a cell.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\|/gu, "\\|")
    .trim();
  if (cleaned === "") {
    return "-";
  }
  return cleaned.length <= MAX_CELL_LENGTH
    ? cleaned
    : `${cleaned.slice(0, MAX_CELL_LENGTH)}${t("powerPoint.fidelity.truncated", {
      characters: cleaned.length - MAX_CELL_LENGTH,
    })}`;
}

function describeSide(side: Record<string, number | string> | undefined): string {
  if (side === undefined) {
    return "-";
  }
  return Object.entries(side).map(([key, value]) => `${key}=${value}`).join(" ");
}

/**
 * Localized prose is resolved at formatting time; every machine-readable field stays English.
 * A run with nothing to measure must say so - it must never read as a pass.
 */
export function formatPptxFidelityReport(
  reports: readonly PptxFidelityReport[],
  locale: AppLocale = "ja",
): string {
  const t = createTranslator(locale, "editor");
  const lines: string[] = [`# ${t("powerPoint.fidelity.title")}`, ""];
  if (reports.length === 0) {
    lines.push(t("powerPoint.fidelity.empty"), "");
    return lines.join("\n");
  }

  const all = reports.flatMap((report) => report.discrepancies);
  const errorCount = all.filter((item) => item.severity === "error").length;
  const warningCount = all.filter((item) => item.severity === "warning").length;
  const infoCount = all.filter((item) => item.severity === "info").length;
  lines.push(
    t("powerPoint.fidelity.summary", {
      files: reports.length,
      differences: all.length,
      critical: errorCount,
      warnings: warningCount,
      info: infoCount,
    }),
    "",
  );

  for (const report of reports) {
    lines.push(`## ${report.file}`, "");
    if (report.failure !== undefined) {
      lines.push(t("powerPoint.fidelity.failed", { reason: report.failure }), "");
      continue;
    }
    lines.push(
      t("powerPoint.fidelity.slides", { source: report.slideCount.source, imported: report.slideCount.imported }),
      t("powerPoint.fidelity.objects", {
        sourceObjects: report.counts.sourceObjects,
        strict: report.counts.strictlyCompared,
        excluded: report.counts.notStrictlyCompared,
      }),
      "",
    );

    if (report.discrepancies.length === 0) {
      lines.push(t("powerPoint.fidelity.noDiscrepancy"), "");
    } else {
      lines.push(t("powerPoint.fidelity.tableHeader"));
      lines.push("| --- | --- | --- | ---: | --- | --- | --- | ---: |");
      for (const item of report.discrepancies.slice(0, MAX_LISTED_DISCREPANCIES)) {
        lines.push([
          "",
          t(`powerPoint.fidelity.severity.${item.severity}`),
          t(`powerPoint.fidelity.axis.${item.axis}`),
          t(`powerPoint.fidelity.kind.${item.kind}`),
          String(item.slideIndex + 1),
          tableCell(item.objectName ?? "", t),
          tableCell(describeSide(item.expected), t),
          tableCell(describeSide(item.actual), t),
          item.deltaPx === undefined ? "-" : String(item.deltaPx),
          "",
        ].join(" | ").trim());
      }
      if (report.discrepancies.length > MAX_LISTED_DISCREPANCIES) {
        lines.push("", t("powerPoint.fidelity.omitted", {
          remaining: report.discrepancies.length - MAX_LISTED_DISCREPANCIES,
        }));
      }
      lines.push("");
    }

    if (report.notStrictlyCompared.length > 0) {
      const byReason = new Map<NotStrictlyComparedReason, number>();
      for (const entry of report.notStrictlyCompared) {
        byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
      }
      lines.push(t("powerPoint.fidelity.exclusions"));
      for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
        lines.push(t("powerPoint.fidelity.exclusionRow", {
          reason,
          label: t(`powerPoint.fidelity.reason.${reason}`),
          number: count,
        }));
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
