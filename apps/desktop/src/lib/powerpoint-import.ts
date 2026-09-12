
import JSZip from "jszip";
import { PptxRenderer } from "pptx-svg";
import  {
  hasShapeProperties,
  hasTextProperties,
  isConnectorElement,
  isImageLikeElement,
  isTextElement,
  parseSvgPath,
  PptxHandler,
} from "pptx-viewer-core";
import  {
  asArray,
  boundsFromEmu,
  bytesToBase64,
  CHART_SERIES_COLORS,
  clamp,
  clamp01,
  collectSlideShapesWithXmlInheritance,
  computeDonutOutlinePointSets,
  computePresetGeometryPoints,
  countSmartArtNodes,
  createConversionCandidate,
  createPptxNonVisualMetadata,
  createPptxPlaceholderMetadata,
  DEFAULT_COLOR_MAP,
  DEFAULT_SCHEME_COLORS,
  degreesToRadians,
  EMU_PER_INCH,
  EMU_PER_PX,
  emuToPx,
  findFirstXmlRecordByKey,
  flattenSmartArtNodes,
  getPowerPointTextPrimaryColor,
  getPptxTableColumnCount,
  getRecord,
  getRecordFromUnknown,
  getRecordFromValue,
  imageMimeType,
  isLinePreset,
  isRecord,
  jsonSafeValue,
  normalizeHexColor,
  parseXmlRecord,
  PowerPointColorContext,
  PowerPointConnectorConnection,
  PowerPointSourceCustomGeometry,
  PowerPointSourceFillStyle,
  PowerPointSourceImageCrop,
  PowerPointSourceLineStyle,
  PowerPointSourceShape,
  readAttr,
  readCustomGeometry,
  readNumberAttr,
  readPowerPointTableIntrinsicSize,
  readRelationships,
  readZipText,
  Relationship,
  relationshipPathForPart,
  resolvePartPath,
  round,
  sampleCubicBezier,
  sampleOoxmlArc,
  sampleQuadraticBezier,
  sanitizeId,
  SlideRenderShape,
  stripUndefinedFields,
  XmlValue,
} from "./powerpoint-import/xml-source";
export type { PowerPointSourceShape } from "./powerpoint-import/xml-source";

import type  {
  InlineNode,
  OverlayArrowhead,
  OverlayAsset,
  OverlayDash,
  OverlayExtensions,
  OverlayImageCrop,
  OverlayLineShape,
  OverlayShape,
  OverlayTextBlock,
  OverlayTextSize,
  PageLayout,
  ParagraphNode,
  RichBlock,
  SigmaDocument,
  SigmaTableSpec,
  TextAlign,
  TextMark,
} from "@/features/document";
import { fontSizeToOverlaySize, normalizeLineHeight, PAGE_GAP_PX } from "@/features/document";
import { createTranslator, type AppLocale, type Translate } from "@/lib/i18n";
import { createId } from "@/lib/id";
import type  {
  GroupPptxElement,
  MediaPptxElement,
  Model3DPptxElement,
  OlePptxElement,
  PptxChartData,
  PptxData,
  PptxElement,
  PptxElementAnimation,
  PptxElementWithShapeStyle,
  PptxElementWithText,
  PptxImageLikeElement,
  PptxImageProperties,
  PptxSlide,
  PptxSlideLayout,
  PptxSlideMaster,
  PptxSmartArtData,
  PptxSmartArtDrawingShape,
  PptxTableCellStyle,
  PptxTableData,
  ShapeStyle,
  TextSegment,
} from "pptx-viewer-core";

interface PowerPointInlineStyle {
  marks?: TextMark[];
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: number;
}

/** Namespace for the PowerPoint provenance record kept in `overlaySnapshot.extensions`. */
export const POWERPOINT_OVERLAY_EXTENSION = "sigma.powerpoint";
const EMU_PER_MM = 36000;
const DEFAULT_SLIDE_SIZE_EMU = {
  width: 10 * EMU_PER_INCH,
  height: 7.5 * EMU_PER_INCH,
};

export interface PowerPointImportOptions {
  importedAt?: string;
  /** UI-generated fallback text is baked in this locale. Source PPTX text is never translated. */
  locale?: AppLocale;
  /** "editable" imports PPTX objects as Sigma-native shapes. "renderedSvg" keeps exact-looking SVG object images for comparison/fallback. */
  objectMode?: "editable" | "renderedSvg";
  visualRenderer?: "pptx-svg" | "none";
  pptxSvgWasmSource?: string | ArrayBuffer | Uint8Array;
}

interface RelationshipContext {
  sourcePartPath: string;
  relationships: Map<string, Relationship>;
}

interface PowerPointSlideImport {
  index: number;
  path: string;
  shapes: OverlayShape[];
  assets: Record<string, OverlayAsset>;
  /** Shape id -> the name the object had on the slide. */
  shapeNames: Record<string, string>;
}

interface PptxImageReadResult {
  dataUrl?: string;
  target?: string;
  mimeType?: string;
  fileSize?: number;
  crop?: PowerPointSourceImageCrop;
}

interface PowerPointVisualRenderer {
  name: "pptx-svg";
  renderShapeSvg(slideIndex: number, shapeIndex: number): string;
}

export const POWERPOINT_IMPORT_ACCEPT = ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation";

export function isPowerPointPptxFilename(filename: string): boolean {
  return /\.pptx$/i.test(filename.trim());
}

export async function importPowerPointPptxBuffer(
  input: ArrayBuffer | Uint8Array,
  filename: string,
  options: PowerPointImportOptions = {},
): Promise<SigmaDocument> {
  const t = createTranslator(options.locale ?? "ja", "editor");
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const zip = await JSZip.loadAsync(bytes);
  const presentationXml = await readZipText(zip, "ppt/presentation.xml");
  if (!presentationXml) {
    throw new Error(t("powerPoint.import.presentationMissing"));
  }

  const presentation = parseXmlRecord(presentationXml)["p:presentation"];
  const slideSize = readPresentationSlideSize(presentation);
  const pageSizePx = {
    width: emuToPx(slideSize.width),
    height: emuToPx(slideSize.height),
  };
  const pageSizeMm = {
    width: emuToMm(slideSize.width),
    height: emuToMm(slideSize.height),
  };
  const slidePaths = await readSlidePaths(zip, presentation, "ppt/presentation.xml");
  if (slidePaths.length === 0) {
    throw new Error(t("powerPoint.import.noSlides"));
  }

  const importedAt = options.importedAt ?? new Date().toISOString();
  const fileHash = hashBytes(bytes);
  const title = filename.replace(/\.pptx$/i, "") || t("powerPoint.import.fallbackTitle");
  const slides: PowerPointSlideImport[] = [];
  const { model: pptxModel } = await loadPowerPointModel(bytes);
  const colorContext = await createPowerPointColorContext(zip, pptxModel, t);
  const visualRenderer = await createPowerPointVisualRenderer(bytes, { ...options, importedAt });

  for (let index = 0; index < slidePaths.length; index += 1) {
    const slide = await importSlide(zip, slidePaths[index]!, index, {
      filename,
      importedAt,
      fileHash,
      slideSize,
      pageSizePx,
      pageSizeMm,
      objectMode: options.objectMode ?? "editable",
      pptxModel,
      colorContext,
      visualRenderer,
      t,
    });
    slides.push(slide);
  }
  return {
    version: "2.0",
    docId: "ppt_import_document",
    metadata: {
      title,
      source: {
        format: "powerpoint",
        layoutMode: "fixedOverlay",
        printFlowContent: false,
        originalFileName: filename,
        importedAt,
        slideCount: slides.length,
        pageSize: {
          widthPx: pageSizePx.width,
          heightPx: pageSizePx.height,
          widthMm: pageSizeMm.width,
          heightMm: pageSizeMm.height,
        },
      },
      // Font sizes here are already points (OOXML `a:rPr/@sz` is hundredths of a
      // point). Without this declaration `normalizeFontSizeUnits` treats every
      // `fontSize` in the document as pixels and scales it by 0.75, shrinking all
      // imported text by a quarter.
      styleUnits: { fontSize: "pt" },
    },
    // Each slide is a fixed-layout page drawn entirely from overlay shapes at
    // page-absolute coordinates. The body keeps one empty anchor paragraph per
    // slide so the document is still editable; page count comes from the shape
    // extents (PageCanvasEditor grows the sheet count to cover overlay figures),
    // never from body reflow. Nothing here may push a slide off its own page.
    content: slides.map((slide): RichBlock => ({
      type: "paragraph",
      id: `ppt_slide_anchor_${slide.index + 1}`,
      children: [],
    })),
    outputProfiles: {
      student: { includeAnswers: false, showHints: false, showSolutions: false },
      teacher: { includeAnswers: true, showHints: true, showSolutions: true },
      answerBook: { includeAnswers: true, onlySolutions: true, showSolutions: true },
    },
    pageLayout: buildPowerPointPageLayout(pageSizeMm, slides),
    updatedAt: importedAt,
  };
}

async function importSlide(
  zip: JSZip,
  slidePath: string,
  index: number,
  context: {
    filename: string;
    importedAt: string;
    fileHash: string;
    slideSize: { width: number; height: number };
    pageSizePx: { width: number; height: number };
    pageSizeMm: { width: number; height: number };
    objectMode: "editable" | "renderedSvg";
    pptxModel: PptxData | null;
    colorContext: PowerPointColorContext;
    visualRenderer: PowerPointVisualRenderer | null;
    t: Translate<"editor">;
  },
): Promise<PowerPointSlideImport> {
  const slideXml = await readZipText(zip, slidePath);
  if (!slideXml) {
    throw new Error(context.t("powerPoint.import.slideReadFailed", { path: slidePath }));
  }

  const rels = await readRelationships(zip, relationshipPathForPart(slidePath));
  const slide = parseXmlRecord(slideXml)["p:sld"];
  const spTree = getRecord(getRecord(slide, "p:cSld"), "p:spTree");
  const sourceShapes = await collectSlideShapesFromModel(zip, context.pptxModel?.slides[index], context.pageSizePx, context.pptxModel, {
    sourcePartPath: slidePath,
    relationships: rels,
  }) ??
    await collectSlideShapesWithXmlInheritance(zip, slidePath, slideXml, spTree, rels, context.colorContext);
  const overlay = createEditableOverlayObjectsForSlide(sourceShapes, index, {
    filename: context.filename,
    importedAt: context.importedAt,
    fileHash: context.fileHash,
    slidePath,
    pageSizePx: context.pageSizePx,
    pageSizeMm: context.pageSizeMm,
    objectMode: context.objectMode,
    visualRenderer: context.visualRenderer,
    t: context.t,
  });

  return { index, path: slidePath, shapes: overlay.shapes, assets: overlay.assets, shapeNames: overlay.shapeNames };
}

async function loadPowerPointModel(bytes: Uint8Array): Promise<{ model: PptxData | null; error?: string }> {
  try {
    return { model: await new PptxHandler().load(toArrayBuffer(bytes)) };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { model: null, error: errorMessage };
  }
}

async function createPowerPointColorContext(
  zip: JSZip,
  pptxModel: PptxData | null,
  t: Translate<"editor">,
): Promise<PowerPointColorContext> {
  const parsedThemeColors = await readPowerPointThemeColorScheme(zip, t);
  return {
    colorScheme: {
      ...DEFAULT_SCHEME_COLORS,
      ...pickHexColorRecord(pptxModel?.theme?.colorScheme),
      ...parsedThemeColors,
      ...pickHexColorRecord(pptxModel?.themeColorMap),
    },
    colorMap: {
      ...DEFAULT_COLOR_MAP,
      ...pickSchemeColorMap(pptxModel?.themeColorMap),
    },
  };
}

async function readPowerPointThemeColorScheme(
  zip: JSZip,
  t: Translate<"editor">,
): Promise<Record<string, string>> {
  const themePath = Object.keys(zip.files)
    .filter((path) => /^ppt\/theme\/theme\d+\.xml$/u.test(path))
    .sort(naturalCompare)[0];
  const xml = themePath ? await readZipText(zip, themePath) : null;
  if (!xml) {
    return {};
  }

  const parsed = parseXmlRecordSafely(xml, t);
  const theme = getRecordFromUnknown(parsed)["a:theme"];
  const colorScheme = getRecord(getRecord(theme, "a:themeElements"), "a:clrScheme");
  const result: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_SCHEME_COLORS)) {
    const color = readThemeColorValue(getRecord(colorScheme, `a:${key}`));
    if (color) {
      result[key] = color;
    }
  }
  return result;
}

function readThemeColorValue(value: XmlValue): string | undefined {
  const record = getRecordFromValue(value);
  return normalizeHexColor(readAttr(getRecord(record, "a:srgbClr"), "val")) ??
    normalizeHexColor(readAttr(getRecord(record, "a:sysClr"), "lastClr"));
}

function pickHexColorRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const color = normalizeHexColor(typeof raw === "string" ? raw : undefined);
    if (color) {
      result[key] = color;
    }
  }
  return result;
}

function pickSchemeColorMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && raw in DEFAULT_SCHEME_COLORS) {
      result[key] = raw;
    }
  }
  return result;
}

function parseXmlRecordSafely(xml: string, t: Translate<"editor">): unknown {
  return parseXmlRecordWithError(xml, t).json;
}

function parseXmlRecordWithError(
  xml: string,
  t: Translate<"editor">,
): { json?: unknown; parseError?: string } {
  try {
    return { json: parseXmlRecord(xml) };
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : t("powerPoint.import.xmlParseFailed"),
    };
  }
}

async function collectSlideShapesFromModel(
  zip: JSZip,
  slide: PptxSlide | undefined,
  pageSizePx: { width: number; height: number },
  pptxModel: PptxData | null,
  relationshipContext: RelationshipContext,
): Promise<SlideRenderShape[] | null> {
  if (!slide) {
    return null;
  }

  const shapes: SlideRenderShape[] = [];
  shapes.push(...await collectInheritedPowerPointShapes(zip, pptxModel, slide, pageSizePx));
  const background = createPptxSlideBackgroundSourceShape(slide, pageSizePx);
  if (background) {
    shapes.push(background);
  }
  const animationsByElementId = groupPptxAnimationsByElementId(slide.animations);
  for (let zIndex = 0; zIndex < slide.elements.length; zIndex += 1) {
    shapes.push(...await convertPptxElementToSourceShapes(zip, slide.elements[zIndex]!, zIndex, undefined, animationsByElementId, {
      relationshipContext,
    }));
  }

  return shapes.length > 0 ? shapes : null;
}

async function collectInheritedPowerPointShapes(
  zip: JSZip,
  pptxModel: PptxData | null,
  slide: PptxSlide,
  pageSizePx: { width: number; height: number },
): Promise<SlideRenderShape[]> {
  if (!pptxModel) {
    return [];
  }
  const layout = findPowerPointSlideLayout(pptxModel, slide.layoutPath, slide.layoutName);
  const master = findPowerPointSlideMasterForLayout(pptxModel, layout?.path, slide.layoutPath);
  const shapes: SlideRenderShape[] = [];

  if (slide.showMasterShapes !== false && master) {
    const masterRelationshipContext = await readRelationshipContextForPart(zip, master.path);
    const background = createInheritedBackgroundSourceShape(
      {
        kind: "slideMaster",
        path: master.path,
        name: master.name,
      },
      master.backgroundColor,
      master.backgroundImage,
      pageSizePx,
      -3000,
    );
    if (background) {
      shapes.push(background);
    }
    shapes.push(...await convertPptxElementListToInheritedSourceShapes(zip, master.elements, -2900, {
      kind: "slideMaster",
      path: master.path,
      name: master.name,
    }, masterRelationshipContext));
  }

  if (layout) {
    const layoutRelationshipContext = await readRelationshipContextForPart(zip, layout.path);
    const background = createInheritedBackgroundSourceShape(
      {
        kind: "slideLayout",
        path: layout.path,
        name: layout.name,
        masterPath: master?.path,
      },
      layout.backgroundColor,
      layout.backgroundImage,
      pageSizePx,
      -2000,
    );
    if (background) {
      shapes.push(background);
    }
    shapes.push(...await convertPptxElementListToInheritedSourceShapes(zip, layout.elements, -1900, {
      kind: "slideLayout",
      path: layout.path,
      name: layout.name,
      masterPath: master?.path,
    }, layoutRelationshipContext));
  }

  return shapes;
}

async function readRelationshipContextForPart(
  zip: JSZip,
  sourcePartPath: string | undefined,
): Promise<RelationshipContext | undefined> {
  if (!sourcePartPath) {
    return undefined;
  }
  return {
    sourcePartPath,
    relationships: await readRelationships(zip, relationshipPathForPart(sourcePartPath)),
  };
}

function groupPptxAnimationsByElementId(
  animations: PptxElementAnimation[] | undefined,
): Map<string, PptxElementAnimation[]> {
  const result = new Map<string, PptxElementAnimation[]>();
  for (const animation of animations ?? []) {
    const current = result.get(animation.elementId) ?? [];
    current.push(animation);
    result.set(animation.elementId, current);
  }
  return result;
}

function createPptxSlideBackgroundSourceShape(
  slide: PptxSlide,
  pageSizePx: { width: number; height: number },
): SlideRenderShape | null {
  const imageDataUrl = isDataUrl(slide.backgroundImage) ? slide.backgroundImage : undefined;
  const hasBackground = Boolean(slide.backgroundColor || imageDataUrl || slide.backgroundGradient || slide.backgroundPattern);
  if (!hasBackground) {
    return null;
  }

  return {
    sourceId: `${slide.id || `slide_${slide.slideNumber}`}_background`,
    name: `Slide ${slide.slideNumber} background`,
    kind: "background",
    zIndex: -1,
    bounds: {
      x: 0,
      y: 0,
      w: round(pageSizePx.width),
      h: round(pageSizePx.height),
      unit: "px",
    },
    boundsEmu: {
      x: 0,
      y: 0,
      w: round(pxToEmu(pageSizePx.width)),
      h: round(pxToEmu(pageSizePx.height)),
    },
    fill: slide.backgroundColor ? { type: "solid", color: slide.backgroundColor } : slide.backgroundGradient ? { type: "gradient", raw: "slide.backgroundGradient" } : undefined,
    ...(imageDataUrl ? {
      imageDataUrl,
      picture: {
        target: slide.backgroundImage,
        mimeType: dataUrlMimeType(imageDataUrl),
        fileSize: byteLength(imageDataUrl),
      },
    } : {}),
    background: {
      type: imageDataUrl ? "image" : slide.backgroundGradient ? "gradient" : slide.backgroundPattern ? "pattern" : "solid",
      color: slide.backgroundColor,
      raw: jsonSafeValue({
        backgroundGradient: slide.backgroundGradient,
        backgroundPattern: slide.backgroundPattern,
        backgroundShadeToTitle: slide.backgroundShadeToTitle,
      }),
    },
    conversionCandidate: {
      sigmaKind: imageDataUrl ? "image" : "geo",
      confidence: imageDataUrl || slide.backgroundColor ? "high" : "medium",
      reason: "PowerPoint slide background maps to a Sigma background-layer overlay shape.",
    },
    raw: { drawingElement: "p:bg" },
  };
}

async function convertPptxElementListToInheritedSourceShapes(
  zip: JSZip,
  elements: PptxElement[] | undefined,
  baseZIndex: number,
  inheritedFrom: NonNullable<PowerPointSourceShape["inheritedFrom"]>,
  relationshipContext?: RelationshipContext,
): Promise<SlideRenderShape[]> {
  const shapes: SlideRenderShape[] = [];
  const sourceIdPrefix = `${inheritedFrom.kind}_${sanitizeId(inheritedFrom.path || inheritedFrom.name || "unknown")}`;
  for (let index = 0; index < (elements?.length ?? 0); index += 1) {
    shapes.push(...await convertPptxElementToSourceShapes(zip, elements![index]!, baseZIndex + index, undefined, undefined, {
      sourceIdPrefix,
      inheritedFrom,
      relationshipContext,
    }));
  }
  return shapes;
}

function createInheritedBackgroundSourceShape(
  inheritedFrom: NonNullable<PowerPointSourceShape["inheritedFrom"]>,
  backgroundColor: string | undefined,
  backgroundImage: string | undefined,
  pageSizePx: { width: number; height: number },
  zIndex: number,
): SlideRenderShape | null {
  const imageDataUrl = backgroundImage && isDataUrl(backgroundImage) ? backgroundImage : undefined;
  if (!backgroundColor && !imageDataUrl) {
    return null;
  }
  const displayName = inheritedFrom.name || inheritedFrom.path || inheritedFrom.kind;
  return {
    sourceId: `${inheritedFrom.kind}_${sanitizeId(inheritedFrom.path || displayName)}_background`,
    name: `${displayName} background`,
    kind: "background",
    zIndex,
    bounds: {
      x: 0,
      y: 0,
      w: round(pageSizePx.width),
      h: round(pageSizePx.height),
      unit: "px",
    },
    boundsEmu: {
      x: 0,
      y: 0,
      w: round(pxToEmu(pageSizePx.width)),
      h: round(pxToEmu(pageSizePx.height)),
    },
    fill: backgroundColor ? { type: "solid", color: backgroundColor } : undefined,
    ...(imageDataUrl ? {
      imageDataUrl,
      picture: {
        target: backgroundImage,
        mimeType: dataUrlMimeType(imageDataUrl),
        fileSize: byteLength(imageDataUrl),
      },
    } : {}),
    background: {
      type: imageDataUrl ? "image" : "solid",
      color: backgroundColor,
    },
    inheritedFrom,
    conversionCandidate: {
      sigmaKind: imageDataUrl ? "image" : "geo",
      confidence: "high",
      reason: `PowerPoint ${inheritedFrom.kind} background maps to a Sigma background-layer overlay shape.`,
    },
    raw: { drawingElement: `${inheritedFrom.kind}:background` },
  };
}

function findPowerPointSlideLayout(
  pptxModel: PptxData,
  layoutPath: string | undefined,
  layoutName: string | undefined,
): PptxSlideLayout | undefined {
  for (const master of pptxModel.slideMasters ?? []) {
    const match = master.layouts?.find((layout) =>
      (layoutPath && layout.path === layoutPath) ||
      (layoutName && layout.name === layoutName),
    );
    if (match) {
      return match;
    }
  }
  return undefined;
}

function findPowerPointSlideMasterForLayout(
  pptxModel: PptxData,
  resolvedLayoutPath: string | undefined,
  requestedLayoutPath: string | undefined,
): PptxSlideMaster | undefined {
  const layoutPath = resolvedLayoutPath ?? requestedLayoutPath;
  if (!layoutPath) {
    return pptxModel.slideMasters?.[0];
  }
  const option = pptxModel.layoutOptions?.find((item) => item.path === layoutPath);
  const masterPath = option?.masterPath;
  return pptxModel.slideMasters?.find((master) =>
    (masterPath && master.path === masterPath) ||
    master.layoutPaths?.includes(layoutPath) ||
    master.layouts?.some((layout) => layout.path === layoutPath),
  );
}

async function convertPptxElementToSourceShapes(
  zip: JSZip,
  element: PptxElement,
  zIndex: number,
  parentSourceId?: string,
  animationsByElementId?: Map<string, PptxElementAnimation[]>,
  options: PptxElementSourceOptions = {},
): Promise<SlideRenderShape[]> {
  if (element.type === "group") {
    return convertPptxGroupToSourceShapes(zip, element, zIndex, parentSourceId, animationsByElementId, options);
  }
  return [await convertPptxElementToSourceShape(zip, element, zIndex, parentSourceId, animationsByElementId, options)];
}

async function convertPptxGroupToSourceShapes(
  zip: JSZip,
  element: GroupPptxElement,
  zIndex: number,
  parentSourceId: string | undefined,
  animationsByElementId: Map<string, PptxElementAnimation[]> | undefined,
  options: PptxElementSourceOptions = {},
): Promise<SlideRenderShape[]> {
  const sourceId = withPptxSourceIdPrefix(element.id || `group_${zIndex + 1}`, options.sourceIdPrefix);
  const nonVisual = createPptxNonVisualMetadata(element.rawXml);
  const placeholder = createPptxPlaceholderMetadata(element.rawXml);
  const bounds = resolvePptxModelElementBounds(element, options);
  const groupShape: SlideRenderShape = {
    sourceId,
    ...(parentSourceId ? { parentSourceId } : {}),
    name: element.name || `Group ${zIndex + 1}`,
    kind: "group",
    zIndex,
    bounds: bounds.px,
    boundsEmu: bounds.emu,
    ...(element.rotation ? { rotation: round(element.rotation) } : {}),
    ...(element.skewX || element.skewY ? { skew: { x: element.skewX, y: element.skewY } } : {}),
    ...(element.hidden ? { hidden: true } : {}),
    ...(element.opacity !== undefined ? { opacity: element.opacity } : {}),
    ...(nonVisual ? { nonVisual } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(options.inheritedFrom ? { inheritedFrom: options.inheritedFrom } : {}),
    model: createPptxModelMetadata(element, null, null, undefined, animationsByElementId?.get(element.id)),
    conversionCandidate: { sigmaKind: "group", confidence: "high", reason: "PowerPoint group maps to a Sigma overlay group with editable child shapes." },
  };
  const children: SlideRenderShape[] = [];
  const groupScale = readPptxModelGroupScale(element.rawXml);
  const childOptions: PptxElementSourceOptions = {
    ...options,
    coordinateOffset: { x: bounds.px.x, y: bounds.px.y },
    intrinsicScale: {
      x: (options.intrinsicScale?.x ?? 1) * groupScale.x,
      y: (options.intrinsicScale?.y ?? 1) * groupScale.y,
    },
  };
  for (let childIndex = 0; childIndex < element.children.length; childIndex += 1) {
    children.push(...await convertPptxElementToSourceShapes(zip, element.children[childIndex]!, zIndex + (childIndex + 1) / 1000, sourceId, animationsByElementId, childOptions));
  }
  return [groupShape, ...children];
}

async function convertPptxElementToSourceShape(
  zip: JSZip,
  element: PptxElement,
  zIndex: number,
  parentSourceId?: string,
  animationsByElementId?: Map<string, PptxElementAnimation[]>,
  options: PptxElementSourceOptions = {},
): Promise<SlideRenderShape> {
  const shapeElement = hasShapeProperties(element) ? element : null;
  // Font sizes are restated in points here, once, so neither the source text nor
  // the provenance record below can carry the library's px values downstream.
  const textElement = hasTextProperties(element) ? pptxTextElementInPoints(element) : null;
  const shapeStyle = shapeElement?.shapeStyle;
  const line = shapeStyleToSourceLineStyle(shapeStyle, options.sourceIdPrefix);
  const fill = shapeStyleToSourceFillStyle(shapeStyle);
  const text = textElement ? pptxTextToSourceText(textElement) : undefined;
  const geometryPreset = shapeElement?.shapeType ?? (isConnectorElement(element) ? "straightConnector1" : isImageLikeElement(element) ? "picture" : undefined);
  const customGeom = shapeElement ? extractCustomGeometryFromPptxElement(shapeElement) : undefined;
  const kind = pptxElementKind(element, geometryPreset, fill, line, text?.plainText ?? "");
  const image = isImageLikeElement(element)
    ? await readPptxElementImage(zip, element)
    : await readPptxPreviewImage(zip, element);
  const table = element.type === "table" && element.tableData ? {
    data: element.tableData,
    rowCount: element.tableData.rows.length,
    columnCount: getPptxTableColumnCount(element.tableData),
  } : undefined;
  const chart = element.type === "chart" && element.chartData ? {
    data: element.chartData,
    chartType: element.chartData.chartType,
    categoryCount: element.chartData.categories.length,
    seriesCount: element.chartData.series.length,
  } : undefined;
  const smartArt = element.type === "smartArt" && element.smartArtData ? {
    data: element.smartArtData,
    layoutType: element.smartArtData.resolvedLayoutType ?? element.smartArtData.layoutType,
    nodeCount: countSmartArtNodes(element.smartArtData.nodes),
    drawingShapeCount: element.smartArtData.drawingShapes?.length ?? 0,
  } : undefined;
  const ink = pptxInkToSourceInk(element);
  const media = element.type === "media" ? pptxMediaToSourceMedia(element) : undefined;
  const ole = element.type === "ole" ? pptxOleToSourceOle(element) : undefined;
  const model3d = element.type === "model3d" ? pptxModel3dToSourceModel3d(element) : undefined;
  const picture = createSourcePicture(element, image);
  const authoredName = getAuthoredPptxElementName(element);
  const nonVisual = createPptxNonVisualMetadata(element.rawXml);
  const placeholder = createPptxPlaceholderMetadata(element.rawXml);
  const bounds = resolvePptxModelElementBounds(element, options);

  const sourceShape: SlideRenderShape = {
    sourceId: withPptxSourceIdPrefix(element.id || `${element.type}_${zIndex + 1}`, options.sourceIdPrefix),
    ...(parentSourceId ? { parentSourceId } : {}),
    name: authoredName || element.name || `${element.type} ${zIndex + 1}`,
    kind,
    geometry: stripUndefinedFields({ preset: geometryPreset, custom: customGeom }),
    zIndex,
    bounds: bounds.px,
    boundsEmu: bounds.emu,
    ...(element.rotation ? { rotation: round(element.rotation) } : {}),
    ...(element.skewX || element.skewY ? { skew: { x: element.skewX, y: element.skewY } } : {}),
    ...(element.flipHorizontal || element.flipVertical ? { flip: { horizontal: Boolean(element.flipHorizontal), vertical: Boolean(element.flipVertical) } } : {}),
    ...(element.hidden ? { hidden: true } : {}),
    ...(element.opacity !== undefined ? { opacity: element.opacity } : {}),
    ...(nonVisual ? { nonVisual } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(line ? { line } : {}),
    ...(fill ? { fill } : {}),
    ...(text?.plainText ? { text } : {}),
    ...(picture ? { picture } : {}),
    ...(table ? { table } : {}),
    ...(chart ? { chart } : {}),
    ...(smartArt ? { smartArt } : {}),
    ...(ink ? { ink } : {}),
    ...(media ? { media } : {}),
    ...(ole ? { ole } : {}),
    ...(model3d ? { model3d } : {}),
    ...(image?.dataUrl ? { imageDataUrl: image.dataUrl } : {}),
    ...(options.inheritedFrom ? { inheritedFrom: options.inheritedFrom } : {}),
    model: createPptxModelMetadata(element, shapeElement, textElement, image?.crop, animationsByElementId?.get(element.id)),
    conversionCandidate: createConversionCandidate(kind, geometryPreset, line, text?.plainText ?? "", customGeom),
  };

  return sourceShape;
}

function extractCustomGeometryFromPptxElement(element: PptxElement): PowerPointSourceCustomGeometry | undefined {
  if (element.type !== "shape" && element.type !== "image" && element.type !== "picture") {
    return undefined;
  }
  const rawShapeProperties = findFirstXmlRecordByKey(element.rawXml, "p:spPr");
  const rawCustomGeometry = rawShapeProperties ? readCustomGeometry(rawShapeProperties) : undefined;
  if (rawCustomGeometry?.pathData) {
    return rawCustomGeometry;
  }
  if (!element.customGeometryPaths?.length) {
    return element.pathData ? {
      pathData: element.pathData,
      pathWidth: element.pathWidth,
      pathHeight: element.pathHeight,
    } : undefined;
  }

  const paths = element.customGeometryPaths
    .map((path) => {
      const commands: string[] = [];
      const subpaths: NonNullable<PowerPointSourceCustomGeometry["subpaths"]> = [];
      let pointCount = 0;
      let closed = false;
      let approximatedCurve = false;
      const unsupportedCommands: string[] = [];
      let currentPoint: { x: number; y: number } | null = null;
      let subpathStart: { x: number; y: number } | null = null;
      let subpathPoints: Array<{ x: number; y: number }> = [];
      let subpathClosed = false;
      const flushSubpath = () => {
        if (subpathPoints.length >= 2) {
          subpaths.push({
            points: subpathPoints,
            closed: subpathClosed,
            pathWidth: path.width,
            pathHeight: path.height,
          });
        }
        subpathPoints = [];
        subpathClosed = false;
        subpathStart = null;
      };
      const pushPointCommand = (prefix: "M" | "L", point: { x: number; y: number }) => {
        if (prefix === "M" && subpathPoints.length > 0) {
          flushSubpath();
        }
        commands.push(`${prefix} ${point.x} ${point.y}`);
        currentPoint = point;
        if (prefix === "M") {
          subpathStart = point;
        }
        subpathPoints.push(point);
        pointCount += 1;
      };

      for (const segment of path.segments) {
        if (segment.type === "moveTo") {
          pushPointCommand("M", segment.pt);
        } else if (segment.type === "lineTo") {
          pushPointCommand("L", segment.pt);
        } else if (segment.type === "close") {
          commands.push("Z");
          closed = true;
          const startPoint = subpathStart as { x: number; y: number } | null;
          if (startPoint) {
            currentPoint = startPoint;
            const lastPoint = subpathPoints[subpathPoints.length - 1];
            if (!lastPoint || lastPoint.x !== startPoint.x || lastPoint.y !== startPoint.y) {
              subpathPoints.push(startPoint);
            }
          }
          subpathClosed = true;
          flushSubpath();
        } else if (segment.type === "quadBezTo") {
          if (currentPoint) {
            for (const point of sampleQuadraticBezier(currentPoint, segment.pts[0], segment.pts[1])) {
              pushPointCommand("L", point);
            }
            approximatedCurve = true;
          }
        } else if (segment.type === "cubicBezTo") {
          if (currentPoint) {
            for (const point of sampleCubicBezier(currentPoint, segment.pts[0], segment.pts[1], segment.pts[2])) {
              pushPointCommand("L", point);
            }
            approximatedCurve = true;
          }
        } else if (segment.type === "arcTo") {
          const points = currentPoint ? sampleOoxmlArc(currentPoint, {
            "@_wR": segment.wR,
            "@_hR": segment.hR,
            "@_stAng": segment.stAng,
            "@_swAng": segment.swAng,
          }) : [];
          if (points.length > 0) {
            for (const point of points) {
              pushPointCommand("L", point);
            }
            approximatedCurve = true;
          } else {
            unsupportedCommands.push("a:arcTo");
          }
        }
      }
      flushSubpath();

      return commands.length > 0 ? {
        pathData: commands.join(" "),
        pathWidth: path.width,
        pathHeight: path.height,
        closed,
        subpaths,
        pointCount,
        approximatedCurve,
        unsupportedCommands,
      } : null;
    })
    .filter((path): path is NonNullable<typeof path> => Boolean(path));

  const pathData = paths.map((path) => path.pathData).join(" ");
  const pointCount = paths.reduce((sum, path) => sum + path.pointCount, 0);
  const firstPath = paths[0];
  const unsupportedCommands = Array.from(new Set(paths.flatMap((path) => path.unsupportedCommands)));
  const subpaths = paths.flatMap((path) => path.subpaths);
  return pathData ? stripUndefinedFields({
    pathData,
    pathWidth: firstPath?.pathWidth,
    pathHeight: firstPath?.pathHeight,
    closed: paths.some((path) => path.closed),
    subpaths: subpaths.length > 0 ? subpaths : undefined,
    pointCount: pointCount || undefined,
    approximatedCurve: paths.some((path) => path.approximatedCurve) || undefined,
    unsupportedCommands: unsupportedCommands.length > 0 ? unsupportedCommands : undefined,
  }) : undefined;
}

interface PptxElementSourceOptions {
  sourceIdPrefix?: string;
  inheritedFrom?: NonNullable<PowerPointSourceShape["inheritedFrom"]>;
  relationshipContext?: RelationshipContext;
  coordinateOffset?: { x: number; y: number };
  intrinsicScale?: { x: number; y: number };
}

function resolvePptxModelElementBounds(
  element: PptxElement,
  options: PptxElementSourceOptions,
): ReturnType<typeof boundsFromEmu> {
  const x = (options.coordinateOffset?.x ?? 0) + element.x;
  const y = (options.coordinateOffset?.y ?? 0) + element.y;
  // Google Slides may leave a placeholder graphicFrame extent; table tracks carry the rendered size.
  const intrinsicSize = element.type === "table"
    ? readPowerPointTableIntrinsicSize(element.rawXml)
    : undefined;
  const width = intrinsicSize?.w
    ? emuToPx(intrinsicSize.w) * (options.intrinsicScale?.x ?? 1)
    : element.width;
  const height = intrinsicSize?.h
    ? emuToPx(intrinsicSize.h) * (options.intrinsicScale?.y ?? 1)
    : element.height;

  return boundsFromEmu({
    x: pxToEmu(x),
    y: pxToEmu(y),
    w: pxToEmu(width),
    h: pxToEmu(height),
  });
}

function readPptxModelGroupScale(rawXml: unknown): { x: number; y: number } {
  const groupProperties = findFirstXmlRecordByKey(rawXml, "p:grpSpPr");
  const xfrm = getRecord(groupProperties, "a:xfrm");
  const ext = getRecord(xfrm, "a:ext");
  const childExt = getRecord(xfrm, "a:chExt");
  const extWidth = readNumberAttr(ext, "cx") ?? 0;
  const extHeight = readNumberAttr(ext, "cy") ?? 0;
  const childWidth = readNumberAttr(childExt, "cx") ?? 0;
  const childHeight = readNumberAttr(childExt, "cy") ?? 0;
  return {
    x: extWidth > 0 && childWidth > 0 ? extWidth / childWidth : 1,
    y: extHeight > 0 && childHeight > 0 ? extHeight / childHeight : 1,
  };
}

function withPptxSourceIdPrefix(sourceId: string, prefix: string | undefined): string {
  return prefix ? `${prefix}_${sourceId}` : sourceId;
}

function getAuthoredPptxElementName(element: PptxElement): string | undefined {
  return findPptxCnvPrName(element.rawXml);
}

function findPptxCnvPrName(value: unknown): string | undefined {
  const cNvPr = findFirstXmlRecordByKey(value, "p:cNvPr");
  const name = cNvPr ? readAttr(cNvPr, "name") : undefined;
  return name?.trim() ? name : undefined;
}

function pptxElementKind(
  element: PptxElement,
  preset: string | undefined,
  fill: PowerPointSourceFillStyle | undefined,
  line: PowerPointSourceLineStyle | undefined,
  text: string,
): PowerPointSourceShape["kind"] {
  if (element.type === "ole") {
    return "ole";
  }
  if (element.type === "media") {
    return "media";
  }
  if (element.type === "ink" || element.type === "contentPart") {
    return "ink";
  }
  if (element.type === "zoom") {
    return "zoom";
  }
  if (element.type === "model3d") {
    return "model3d";
  }
  if (isImageLikeElement(element)) {
    return "picture";
  }
  if (isConnectorElement(element)) {
    return "connector";
  }
  if (isTextElement(element)) {
    return "textBox";
  }
  if (element.type === "group") {
    return "group";
  }
  if (element.type === "table") {
    return "table";
  }
  if (element.type === "chart") {
    return "chart";
  }
  if (element.type === "smartArt") {
    return "smartArt";
  }
  if (text && fill?.type === "none" && (line?.noStroke || !line)) {
    return "textBox";
  }
  if (isLinePreset(preset)) {
    return "line";
  }
  if (element.type === "shape") {
    return "shape";
  }
  return "unknown";
}

function shapeStyleToSourceLineStyle(style: ShapeStyle | undefined, sourceIdPrefix?: string): PowerPointSourceLineStyle | undefined {
  if (!style) {
    return undefined;
  }

  const hasLine = style.strokeColor !== undefined ||
    style.strokeWidth !== undefined ||
    style.strokeDash !== undefined ||
    style.connectorStartArrow !== undefined ||
    style.connectorEndArrow !== undefined ||
    style.connectorStartConnection !== undefined ||
    style.connectorEndConnection !== undefined;
  if (!hasLine) {
    return undefined;
  }

  const widthPx = style.strokeWidth === undefined ? undefined : round(style.strokeWidth);
  return {
    color: style.strokeColor,
    widthPx,
    dash: style.strokeDash,
    beginArrow: style.connectorEndArrow,
    endArrow: style.connectorStartArrow,
    connectionStart: pptxConnectorConnectionToSource(style.connectorStartConnection, sourceIdPrefix),
    connectionEnd: pptxConnectorConnectionToSource(style.connectorEndConnection, sourceIdPrefix),
    opacity: style.strokeOpacity,
    noStroke: widthPx === 0 || style.strokeOpacity === 0 || style.strokeColor === "transparent",
  };
}

function pptxConnectorConnectionToSource(
  connection: { shapeId?: string; connectionSiteIndex?: number } | undefined,
  sourceIdPrefix?: string,
): PowerPointConnectorConnection | undefined {
  if (!connection?.shapeId && connection?.connectionSiteIndex === undefined) {
    return undefined;
  }
  return stripUndefinedFields({
    shapeId: connection.shapeId,
    targetSourceId: connection.shapeId ? withPptxSourceIdPrefix(connection.shapeId, sourceIdPrefix) : undefined,
    connectionSiteIndex: connection.connectionSiteIndex,
  });
}

function shapeStyleToSourceFillStyle(style: ShapeStyle | undefined): PowerPointSourceFillStyle | undefined {
  if (!style) {
    return undefined;
  }
  if (style.fillMode === "none") {
    return { type: "none" };
  }
  if (style.fillMode === "gradient") {
    return {
      type: "gradient",
      color: style.fillGradientStops?.[0]?.color ?? style.fillColor,
      opacity: style.fillOpacity,
      raw: "shapeStyle.fillGradientStops",
    };
  }
  if (style.fillMode === "solid" || style.fillColor) {
    return {
      type: "solid",
      color: style.fillColor ?? "#ffffff",
      opacity: style.fillOpacity,
    };
  }
  if (style.fillMode === "pattern" || style.fillMode === "image" || style.fillMode === "theme" || style.fillMode === "group") {
    return {
      type: "unknown",
      color: style.fillColor,
      opacity: style.fillOpacity,
      raw: `shapeStyle.${style.fillMode}`,
    };
  }
  return undefined;
}

/** CSS px per point. `pptx-viewer-core` bakes this into every run font size it reports. */
const PX_PER_PT = 96 / 72;

/**
 * `pptx-viewer-core` reports run font size in **CSS px**: it multiplies OOXML's
 * hundredths-of-a-point by `96 / 72` (`dist/index.mjs` :31790, :52461, :66645).
 * The XML fallback reads `a:rPr/@sz` directly and keeps **points**. SigmaDoc
 * inline `fontSize` is points and the document declares
 * `metadata.styleUnits.fontSize = "pt"`, so a px value reaching a shape renders
 * every run 4/3 too large - and the two parse paths disagree on the unit.
 *
 * Normalizing here, at the single boundary where the library model becomes a
 * source shape, is what keeps the rest of the importer unit-agnostic: everything
 * downstream of `convertPptxElementToSourceShape` is unambiguously points.
 *
 * Deliberately NOT converted - the library already reports these in points
 * (verified in its source and by loading a fixture through `PptxHandler`):
 * - `bulletInfo.sizePts`, a plain `/100` (`:31734`, `:63408`)
 * - `tableData` cell styles, where `applyRunProperties` does `Math.round(sz / 100)`
 *
 * A group's `a:chExt` scaling multiplies this same field by a *relative* factor
 * before we read it (`:65479-65488`), so it survives the conversion untouched.
 */
function pptxFontSizePxToPt(fontSizePx: number | undefined): number | undefined {
  if (fontSizePx === undefined || !Number.isFinite(fontSizePx) || fontSizePx <= 0) {
    return fontSizePx;
  }
  return round(fontSizePx / PX_PER_PT);
}

function pptxTextStyleInPoints<T extends { fontSize?: number }>(style: T): T {
  const fontSize = pptxFontSizePxToPt(style.fontSize);
  // `Object.is` rather than `===` so a NaN size (which is forwarded unchanged)
  // still counts as "nothing to do" instead of allocating a copy of itself.
  return Object.is(fontSize, style.fontSize) ? style : { ...style, fontSize };
}

/**
 * Restates one library element's text model in the terms the rest of the importer
 * expects: font sizes in points, and the text box's autofit scale carried on every
 * run. Both readers of the element - the rendered source text and the raw
 * provenance record - take this value, so `PowerPointSourceShape` never holds a
 * mix of units or loses the autofit factor.
 *
 * Consequence worth knowing: `model.textStyle` / `model.textSegments` are therefore
 * **no longer library-native**, while `model.tableData`, `model.chartData` and
 * `model.rawXml` still are. Nothing reads them today, but `pptx-viewer-core`'s
 * writer expects px (`dist/index.mjs` :50775, :55775 emit `sz = fontSize * 72/96 * 100`),
 * so a future pptx *export* fed from this record must convert back or it writes
 * every run at 3/4 size.
 */
function pptxTextElementInPoints(element: PptxElementWithText): PptxElementWithText {
  // `a:normAutofit` belongs to the text box, but the size a run actually renders at
  // depends on it, so the XML fallback copies it onto every run (see
  // `readParagraphTextSegments`). The library parses it onto `textStyle` only and
  // never reaches the segments, so without this the primary path draws
  // autofit-shrunk text at full size.
  const autoFitFontScale = element.textStyle?.autoFitFontScale;
  return {
    ...element,
    ...(element.textStyle === undefined ? {} : { textStyle: pptxTextStyleInPoints(element.textStyle) }),
    ...(element.textSegments === undefined ? {} : {
      textSegments: element.textSegments.map((segment) => {
        const inPoints = pptxTextStyleInPoints(segment.style);
        // Overwrite rather than defer to an existing run value, because that is what
        // the fallback does (`readTextBody`). The library only ever sets this on
        // `textStyle`, so the branch is unreachable today - but if that changes, the
        // two paths must still agree, which is the whole point of this normalization.
        const style = autoFitFontScale === undefined ? inPoints : { ...inPoints, autoFitFontScale };
        return style === segment.style ? segment : { ...segment, style };
      }),
    }),
  };
}

function pptxTextToSourceText(element: PptxElementWithText): NonNullable<PowerPointSourceShape["text"]> {
  const plainText = element.text ?? element.textSegments?.map((segment) => segment.text).join("") ?? "";
  return {
    plainText,
    paragraphs: plainText.split(/\r?\n/u).filter((paragraph) => paragraph.length > 0),
    style: jsonSafeValue(element.textStyle),
    segments: element.textSegments,
  };
}

function pptxInkToSourceInk(element: PptxElement): PowerPointSourceShape["ink"] | undefined {
  if (element.type === "ink") {
    const paths = element.inkPaths.map((path, index) => ({
      path,
      color: element.inkColors?.[index],
      width: element.inkWidths?.[index],
      opacity: element.inkOpacities?.[index],
    }));
    return paths.length > 0 ? { paths, tool: element.inkTool } : undefined;
  }
  if (element.type === "contentPart") {
    const paths = (element.inkStrokes ?? []).map((stroke) => ({
      path: stroke.path,
      color: stroke.color,
      width: stroke.width,
      opacity: stroke.opacity,
    }));
    return paths.length > 0 ? { paths } : undefined;
  }
  return undefined;
}

function pptxMediaToSourceMedia(element: MediaPptxElement): PowerPointSourceShape["media"] {
  return {
    mediaType: element.mediaType,
    mediaPath: element.mediaPath,
    mediaMimeType: element.mediaMimeType,
    posterFramePath: element.posterFramePath,
    trimStartMs: element.trimStartMs,
    trimEndMs: element.trimEndMs,
    autoPlay: element.autoPlay,
    loop: element.loop,
    volume: element.volume,
  };
}

function pptxOleToSourceOle(element: OlePptxElement): PowerPointSourceShape["ole"] {
  return {
    objectType: element.oleObjectType,
    progId: element.oleProgId,
    fileName: element.oleEmbeddedFileName ?? element.fileName ?? element.oleName,
    mimeType: element.oleEmbeddedMimeType,
    byteSize: element.oleEmbeddedByteSize,
    showAsIcon: element.oleShowAsIcon,
    isLinked: element.isLinked,
    externalPath: element.externalPath,
  };
}

function pptxModel3dToSourceModel3d(element: Model3DPptxElement): PowerPointSourceShape["model3d"] {
  return {
    modelPath: element.modelPath,
    modelMimeType: element.modelMimeType,
    posterImage: element.posterImage && !isDataUrl(element.posterImage) ? element.posterImage : undefined,
  };
}

async function readPptxElementImage(
  zip: JSZip,
  element: PptxImageLikeElement,
): Promise<PptxImageReadResult | null> {
  const dataUrl = element.svgData ?? element.imageData;
  const path = element.svgPath ?? element.imagePath;
  return readPptxImageData(zip, dataUrl, path, imageCropFromElement(element));
}

async function readPptxPreviewImage(
  zip: JSZip,
  element: PptxElement,
): Promise<PptxImageReadResult | null> {
  if (element.type === "ole") {
    return readPptxImageData(zip, element.previewImageData, element.previewImage, undefined);
  }
  if (element.type === "media") {
    return readPptxImageData(zip, element.posterFrameData, element.posterFramePath, undefined);
  }
  if (element.type === "zoom") {
    return readPptxImageData(zip, element.svgData ?? element.imageData, element.svgPath ?? element.imagePath, imageCropFromImageProperties(element));
  }
  if (element.type === "model3d") {
    const poster = element.posterImage;
    const posterResult = poster
      ? await readPptxImageData(zip, poster, isDataUrl(poster) ? undefined : poster, undefined)
      : null;
    if (posterResult?.dataUrl) {
      return posterResult;
    }
    return readPptxImageData(zip, element.svgData ?? element.imageData, element.svgPath ?? element.imagePath, imageCropFromImageProperties(element));
  }
  return null;
}

async function readPptxImageData(
  zip: JSZip,
  dataUrlOrPath: string | undefined,
  path: string | undefined,
  crop: PowerPointSourceImageCrop | undefined,
): Promise<PptxImageReadResult | null> {
  const dataUrl = isDataUrl(dataUrlOrPath) ? dataUrlOrPath : undefined;
  const targetCandidate = path ?? (dataUrl ? undefined : dataUrlOrPath);
  const target = targetCandidate && !isDataUrl(targetCandidate) ? targetCandidate : undefined;
  const mimeType = dataUrlMimeType(dataUrl) ?? (target ? imageMimeType(target) : undefined);
  if (dataUrl) {
    return {
      dataUrl,
      target,
      mimeType,
      fileSize: byteLength(dataUrl),
      crop,
    };
  }

  const media = target ? zip.file(stripPptxZipPath(target)) : null;
  const mediaBytes = media ? await media.async("uint8array") : null;
  if (!mediaBytes || !mimeType) {
    return {
      target,
      mimeType,
      crop,
    };
  }

  return {
    dataUrl: `data:${mimeType};base64,${bytesToBase64(mediaBytes)}`,
    target,
    mimeType,
    fileSize: mediaBytes.byteLength,
    crop,
  };
}

function imageCropFromElement(element: PptxImageLikeElement): PowerPointSourceImageCrop | undefined {
  return imageCropFromImageProperties(element);
}

function imageCropFromImageProperties(element: PptxImageProperties): PowerPointSourceImageCrop | undefined {
  const crop = {
    left: element.cropLeft,
    top: element.cropTop,
    right: element.cropRight,
    bottom: element.cropBottom,
  };
  return Object.values(crop).some((value) => value !== undefined) ? crop : undefined;
}

function createSourcePicture(element: PptxElement, image: PptxImageReadResult | null): PowerPointSourceShape["picture"] | undefined {
  const target = image?.target ?? getPptxPreviewImagePath(element);
  const imageProperties = isPptxImagePropertiesElement(element) ? element : null;
  const tile = imageProperties ? pptxImageTileToMetadata(imageProperties) : undefined;
  if (!target && !image?.mimeType && !image?.fileSize && !image?.crop && !imageProperties?.altText && !imageProperties?.cropShape && !imageProperties?.imageEffects && !tile) {
    return undefined;
  }
  return {
    target,
    mimeType: image?.mimeType,
    fileSize: image?.fileSize,
    crop: image?.crop,
    altText: imageProperties?.altText,
    cropShape: imageProperties?.cropShape,
    effects: jsonSafeValue(imageProperties?.imageEffects),
    tile,
  };
}

function isPptxImagePropertiesElement(element: PptxElement): element is PptxElement & PptxImageProperties {
  return isImageLikeElement(element) || element.type === "zoom" || element.type === "model3d";
}

function pptxImageTileToMetadata(element: PptxImageProperties): unknown {
  const tile = {
    offsetX: element.tileOffsetX,
    offsetY: element.tileOffsetY,
    scaleX: element.tileScaleX,
    scaleY: element.tileScaleY,
    flip: element.tileFlip,
    alignment: element.tileAlignment,
  };
  return Object.values(tile).some((value) => value !== undefined) ? jsonSafeValue(tile) : undefined;
}

function getPptxPreviewImagePath(element: PptxElement): string | undefined {
  if (isImageLikeElement(element)) {
    return element.svgPath ?? element.imagePath;
  }
  if (element.type === "ole") {
    return element.previewImage && !isDataUrl(element.previewImage) ? element.previewImage : undefined;
  }
  if (element.type === "media") {
    return element.posterFramePath;
  }
  if (element.type === "zoom") {
    return element.svgPath ?? element.imagePath;
  }
  if (element.type === "model3d") {
    return element.posterImage && !isDataUrl(element.posterImage)
      ? element.posterImage
      : element.svgPath ?? element.imagePath;
  }
  return undefined;
}

function pptxImageCropToOverlayCrop(crop: PowerPointSourceImageCrop | undefined): { crop?: OverlayImageCrop } {
  if (!crop) {
    return {};
  }
  const left = clamp01(crop.left ?? 0);
  const top = clamp01(crop.top ?? 0);
  const right = clamp01(1 - (crop.right ?? 0));
  const bottom = clamp01(1 - (crop.bottom ?? 0));
  if (right <= left || bottom <= top) {
    return {};
  }
  if (left === 0 && top === 0 && right === 1 && bottom === 1) {
    return {};
  }
  return {
    crop: {
      topLeft: { x: left, y: top },
      bottomRight: { x: right, y: bottom },
    },
  };
}

function createPptxModelMetadata(
  element: PptxElement,
  shapeElement: PptxElementWithShapeStyle | null,
  textElement: PptxElementWithText | null,
  crop: PowerPointSourceImageCrop | undefined,
  animations: PptxElementAnimation[] | undefined,
): NonNullable<PowerPointSourceShape["model"]> {
  return {
    library: "pptx-viewer-core",
    elementId: element.id,
    elementType: element.type,
    hidden: element.hidden,
    opacity: element.opacity,
    skew: element.skewX || element.skewY ? { x: element.skewX, y: element.skewY } : undefined,
    actionClick: jsonSafeValue(element.actionClick),
    actionHover: jsonSafeValue(element.actionHover),
    locks: jsonSafeValue(element.locks),
    extLstXml: jsonSafeValue(element.extLstXml),
    nonVisual: createPptxNonVisualMetadata(element.rawXml),
    placeholder: createPptxPlaceholderMetadata(element.rawXml),
    shapeType: shapeElement?.shapeType,
    shapeStyle: jsonSafeValue(shapeElement?.shapeStyle),
    shapeAdjustments: jsonSafeValue(shapeElement?.shapeAdjustments),
    adjustmentHandles: jsonSafeValue(shapeElement?.adjustmentHandles),
    connector: isConnectorElement(element) ? jsonSafeValue(createPptxConnectorMetadata(element, shapeElement)) : undefined,
    textStyle: jsonSafeValue(textElement?.textStyle),
    textSegments: jsonSafeValue(textElement?.textSegments),
    textProperties: textElement ? jsonSafeValue({
      paragraphIndents: textElement.paragraphIndents,
      promptText: textElement.promptText,
      linkedTxbxId: textElement.linkedTxbxId,
      linkedTxbxSeq: textElement.linkedTxbxSeq,
      hyperlinks: extractTextSegmentHyperlinks(textElement.textSegments),
      fields: extractTextSegmentFields(textElement.textSegments),
      equations: extractTextSegmentEquations(textElement.textSegments),
    }) : undefined,
    tableData: element.type === "table" ? jsonSafeValue(element.tableData) : undefined,
    chartData: element.type === "chart" ? jsonSafeValue(element.chartData) : undefined,
    smartArtData: element.type === "smartArt" ? jsonSafeValue(element.smartArtData) : undefined,
    animations: animations?.length ? jsonSafeValue(animations) : undefined,
    elementData: createPptxElementSpecificMetadata(element),
    rawXml: jsonSafeValue(element.rawXml),
    imagePath: getPptxPreviewImagePath(element),
    crop,
  };
}

function extractTextSegmentHyperlinks(segments: TextSegment[] | undefined): unknown {
  const hyperlinks = (segments ?? [])
    .map((segment, index) => {
      const style = segment.style;
      if (!style.hyperlink && !style.hyperlinkMouseOver && style.hyperlinkTargetSlideIndex === undefined && !style.hyperlinkAction && !style.hyperlinkRId) {
        return null;
      }
      return {
        index,
        text: segment.text,
        hyperlink: style.hyperlink,
        rId: style.hyperlinkRId,
        tooltip: style.hyperlinkTooltip,
        action: style.hyperlinkAction,
        targetSlideIndex: style.hyperlinkTargetSlideIndex,
        mouseOver: style.hyperlinkMouseOver,
        invalidUrl: style.hyperlinkInvalidUrl,
        targetFrame: style.hyperlinkTargetFrame,
        history: style.hyperlinkHistory,
        highlightClick: style.hyperlinkHighlightClick,
        endSound: style.hyperlinkEndSound,
        bookmark: style.bookmark,
      };
    })
    .filter(Boolean);
  return hyperlinks.length > 0 ? hyperlinks : undefined;
}

function createPptxConnectorMetadata(
  element: PptxElement,
  shapeElement: PptxElementWithShapeStyle | null,
): unknown {
  return stripUndefinedFields({
    elementId: element.id,
    geometry: shapeElement?.shapeType,
    startConnection: jsonSafeValue(shapeElement?.shapeStyle?.connectorStartConnection),
    endConnection: jsonSafeValue(shapeElement?.shapeStyle?.connectorEndConnection),
    startArrow: shapeElement?.shapeStyle?.connectorStartArrow,
    startArrowWidth: shapeElement?.shapeStyle?.connectorStartArrowWidth,
    startArrowLength: shapeElement?.shapeStyle?.connectorStartArrowLength,
    endArrow: shapeElement?.shapeStyle?.connectorEndArrow,
    endArrowWidth: shapeElement?.shapeStyle?.connectorEndArrowWidth,
    endArrowLength: shapeElement?.shapeStyle?.connectorEndArrowLength,
  });
}

function extractTextSegmentFields(segments: TextSegment[] | undefined): unknown {
  const fields = (segments ?? [])
    .map((segment, index) => {
      if (!segment.fieldType && !segment.fieldGuid) {
        return null;
      }
      return {
        index,
        text: segment.text,
        fieldType: segment.fieldType,
        fieldGuid: segment.fieldGuid,
        fieldGuidAttr: segment.fieldGuidAttr,
        fieldParagraphPropertiesXml: segment.fieldParagraphPropertiesXml,
      };
    })
    .filter(Boolean);
  return fields.length > 0 ? fields : undefined;
}

function extractTextSegmentEquations(segments: TextSegment[] | undefined): unknown {
  const equations = (segments ?? [])
    .map((segment, index) => {
      if (!segment.equationXml && !segment.equationNumber) {
        return null;
      }
      return {
        index,
        text: segment.text,
        equationXml: segment.equationXml,
        equationNumber: segment.equationNumber,
      };
    })
    .filter(Boolean);
  return equations.length > 0 ? equations : undefined;
}

function createPptxElementSpecificMetadata(element: PptxElement): unknown {
  switch (element.type) {
    case "ole":
      return jsonSafeValue({
        type: element.type,
        oleTarget: element.oleTarget,
        oleProgId: element.oleProgId,
        oleName: element.oleName,
        oleClsId: element.oleClsId,
        oleObjectType: element.oleObjectType,
        oleFileExtension: element.oleFileExtension,
        fileName: element.fileName,
        isLinked: element.isLinked,
        externalPath: element.externalPath,
        previewImage: element.previewImage,
        hasPreviewImageData: Boolean(element.previewImageData),
        oleShowAsIcon: element.oleShowAsIcon,
        oleImgW: element.oleImgW,
        oleImgH: element.oleImgH,
        hasEmbeddedData: Boolean(element.oleEmbeddedData),
        oleEmbeddedFileName: element.oleEmbeddedFileName,
        oleEmbeddedMimeType: element.oleEmbeddedMimeType,
        oleEmbeddedByteSize: element.oleEmbeddedByteSize,
        extensionXml: element.extensionXml,
      });
    case "media":
      return jsonSafeValue({
        type: element.type,
        mediaType: element.mediaType,
        mediaPath: element.mediaPath,
        hasMediaData: Boolean(element.mediaData),
        mediaMimeType: element.mediaMimeType,
        trimStartMs: element.trimStartMs,
        trimEndMs: element.trimEndMs,
        posterFramePath: element.posterFramePath,
        hasPosterFrameData: Boolean(element.posterFrameData),
        fullScreen: element.fullScreen,
        loop: element.loop,
        fadeInDuration: element.fadeInDuration,
        fadeOutDuration: element.fadeOutDuration,
        volume: element.volume,
        autoPlay: element.autoPlay,
        playAcrossSlides: element.playAcrossSlides,
        hideWhenNotPlaying: element.hideWhenNotPlaying,
        bookmarks: element.bookmarks,
        playbackSpeed: element.playbackSpeed,
        metadata: element.metadata,
        captionTracks: element.captionTracks,
        mediaMissing: element.mediaMissing,
        isLinked: element.isLinked,
        extensionXml: element.extensionXml,
      });
    case "ink":
      return jsonSafeValue({
        type: element.type,
        pathCount: element.inkPaths.length,
        inkColors: element.inkColors,
        inkWidths: element.inkWidths,
        inkOpacities: element.inkOpacities,
        inkTool: element.inkTool,
        hasPointPressures: Boolean(element.inkPointPressures?.length),
        extensionXml: element.extensionXml,
      });
    case "contentPart":
      return jsonSafeValue({
        type: element.type,
        inkStrokeCount: element.inkStrokes?.length ?? 0,
      });
    case "zoom":
      return jsonSafeValue({
        type: element.type,
        zoomType: element.zoomType,
        targetSlideIndex: element.targetSlideIndex,
        targetSectionId: element.targetSectionId,
        imagePath: element.imagePath,
        svgPath: element.svgPath,
        altText: element.altText,
        crop: imageCropFromImageProperties(element),
      });
    case "model3d":
      return jsonSafeValue({
        type: element.type,
        modelPath: element.modelPath,
        hasModelData: Boolean(element.modelData),
        modelMimeType: element.modelMimeType,
        posterImage: element.posterImage && !isDataUrl(element.posterImage) ? element.posterImage : undefined,
        imagePath: element.imagePath,
        svgPath: element.svgPath,
        altText: element.altText,
        crop: imageCropFromImageProperties(element),
        extensionXml: element.extensionXml,
      });
    default:
      return undefined;
  }
}

async function createPowerPointVisualRenderer(
  bytes: Uint8Array,
  options: PowerPointImportOptions,
): Promise<PowerPointVisualRenderer | null> {
  if (options.visualRenderer === "none") {
    return null;
  }

  try {
    const renderer = new PptxRenderer({
      logLevel: "silent",
      currentDate: options.importedAt ?? "2026-07-04",
    });
    await renderer.init(options.pptxSvgWasmSource);
    await renderer.loadPptx(toArrayBuffer(bytes));
    return {
      name: "pptx-svg",
      renderShapeSvg(slideIndex: number, shapeIndex: number) {
        return renderer.renderShapeSvg(slideIndex, shapeIndex);
      },
    };
  } catch {
    return null;
  }
}

function buildPowerPointPageLayout(
  pageSizeMm: { width: number; height: number },
  slides: PowerPointSlideImport[],
): PageLayout {
  return {
    preset: "custom",
    orientation: pageSizeMm.width >= pageSizeMm.height ? "landscape" : "portrait",
    pageSize: {
      widthMm: round(pageSizeMm.width),
      heightMm: round(pageSizeMm.height),
    },
    marginsMm: {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
    flow: {
      type: "columns",
      columnCount: 1,
      columnGapMm: 0,
    },
    header: {
      enabled: false,
      heightMm: 8,
      offsetMm: 0,
      showOnFirstPage: true,
      blocks: [{ type: "paragraph", id: "ppt_page_header_empty", children: [] }],
    },
    footer: {
      enabled: false,
      heightMm: 8,
      offsetMm: 0,
      showOnFirstPage: true,
      blocks: [{ type: "paragraph", id: "ppt_page_footer_empty", children: [] }],
    },
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: slides.flatMap((slide) => slide.shapes),
        assets: slides.reduce<Record<string, OverlayAsset>>((assets, slide) => ({
          ...assets,
          ...slide.assets,
        }), {}),
        ...buildPowerPointOverlayExtensions(slides),
      },
    },
  };
}

function buildPowerPointOverlayExtensions(slides: PowerPointSlideImport[]): { extensions?: OverlayExtensions } {
  const shapeNames = slides.reduce<Record<string, string>>((names, slide) => ({
    ...names,
    ...slide.shapeNames,
  }), {});
  if (Object.keys(shapeNames).length === 0) {
    return {};
  }
  return { extensions: { [POWERPOINT_OVERLAY_EXTENSION]: { shapeNames } } };
}

function createEditableOverlayObjectsForSlide(
  sourceShapes: SlideRenderShape[],
  slideIndex: number,
  context: {
    filename: string;
    importedAt: string;
    fileHash: string;
    slidePath: string;
    pageSizePx: { width: number; height: number };
    pageSizeMm: { width: number; height: number };
    objectMode: "editable" | "renderedSvg";
    visualRenderer: PowerPointVisualRenderer | null;
    t: Translate<"editor">;
  },
): { shapes: OverlayShape[]; assets: Record<string, OverlayAsset>; shapeNames: Record<string, string> } {
  // Every slide is a page of its own: shapes keep page-absolute coordinates and
  // the sheet count follows the shape extents, so slide N always lands on page N
  // no matter what the body text does.
  const pageOffsetY = slideIndex * (context.pageSizePx.height + PAGE_GAP_PX);
  const shapes: OverlayShape[] = [];
  const assets: Record<string, OverlayAsset> = {};
  const shapeNames: Record<string, string> = {};

  for (const sourceShape of sourceShapes) {
    const entries = convertSourceShapeToOverlayEntries(sourceShape, slideIndex, pageOffsetY, context);
    shapes.push(...entries.shapes);
    Object.assign(assets, entries.assets);
    // Every shape produced for one slide object keeps that object's name: an
    // object can expand into a group plus generated children (charts, ink,
    // SmartArt, multi-subpath geometry), and all of them came from that object.
    for (const shape of entries.shapes) {
      if (sourceShape.name && shapeNames[shape.id] === undefined) {
        shapeNames[shape.id] = sourceShape.name;
      }
    }
  }

  return { shapes, assets, shapeNames };
}

function convertSourceShapeToOverlayEntries(
  sourceShape: SlideRenderShape,
  slideIndex: number,
  pageOffsetY: number,
  context: {
    filename: string;
    importedAt: string;
    fileHash: string;
    slidePath: string;
    pageSizePx: { width: number; height: number };
    pageSizeMm: { width: number; height: number };
    objectMode: "editable" | "renderedSvg";
    visualRenderer: PowerPointVisualRenderer | null;
    t: Translate<"editor">;
  },
): { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> } {
  if (sourceShape.bounds.w <= 0 && sourceShape.bounds.h <= 0) {
    return { shapes: [], assets: {} };
  }

  const shapeId = powerPointShapeId(slideIndex, sourceShape);
  const finalize = (result: { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> }) => {
    const flagged = withPowerPointObjectFlags(withPowerPointParent(result, sourceShape, slideIndex), sourceShape, shapeId);
    return { shapes: flagged.shapes, assets: flagged.assets };
  };

  if (context.objectMode === "renderedSvg") {
    const rendered = createRenderedObjectImageEntry(sourceShape, shapeId, slideIndex, pageOffsetY, context);
    if (rendered) {
      return finalize(rendered);
    }
  }

  if (sourceShape.kind === "background") {
    return finalize(createOverlayBackgroundEntry(sourceShape, shapeId, slideIndex, pageOffsetY));
  }

  if (sourceShape.kind === "group") {
    return finalize({
      shapes: [createOverlayGroupShape(sourceShape, shapeId, pageOffsetY)],
      assets: {},
    });
  }

  if (sourceShape.kind === "table" && sourceShape.table) {
    return finalize({
      shapes: [createOverlayTableShape(sourceShape, shapeId, pageOffsetY)],
      assets: {},
    });
  }

  if (sourceShape.kind === "chart" && sourceShape.chart) {
    const chartEntries = createOverlayChartGroupEntries(sourceShape, shapeId, pageOffsetY, context.t);
    if (chartEntries) {
      return finalize(chartEntries);
    }
  }

  if (sourceShape.kind === "smartArt" && sourceShape.smartArt) {
    const smartArtEntries = createOverlaySmartArtGroupEntries(sourceShape, shapeId, pageOffsetY);
    if (smartArtEntries) {
      return finalize(smartArtEntries);
    }
  }

  if (sourceShape.kind === "ink" && sourceShape.ink?.paths.length) {
    const inkEntries = createOverlayInkEntries(sourceShape, shapeId, pageOffsetY);
    if (inkEntries) {
      return finalize(inkEntries);
    }
  }

  if (isPowerPointPreviewImageKind(sourceShape.kind) && sourceShape.imageDataUrl) {
    return finalize(createOverlayImageEntry(sourceShape, shapeId, slideIndex, pageOffsetY, context.t));
  }

  const preset = sourceShape.geometry?.preset;
  if (sourceShape.kind === "connector" || sourceShape.kind === "line" || isLinePreset(preset)) {
    return finalize({
      shapes: [createOverlayLineOrArrowShape(sourceShape, shapeId, pageOffsetY)],
      assets: {},
    });
  }

  if (preset === "arc" || preset === "pie") {
    return finalize({
      shapes: [createOverlayArcShape(sourceShape, shapeId, pageOffsetY)],
      assets: {},
    });
  }

  // Handle preset geometry shapes (hexagon, star5, chevron, wedgeRectCallout, heart, etc.)
  if (preset && sourceShape.kind === "shape") {
    const presetPoints = computePresetGeometryPoints(
      preset,
      sourceShape.bounds.w,
      sourceShape.bounds.h,
      sourceShape.geometry?.adjustments
    );
    if (presetPoints) {
      if (preset === "donut") {
        const { outer, inner } = computeDonutOutlinePointSets(
          sourceShape.bounds.w,
          sourceShape.bounds.h,
          sourceShape.geometry?.adjustments,
        );
        return finalize({
          shapes: [
            createOverlayPresetGeometryShape(
              sourceShape,
              shapeId,
              pageOffsetY,
              presetPoints,
              { strokeOpacity: 0 },
            ),
            createOverlayPresetGeometryShape(
              sourceShape,
              `${shapeId}_outer`,
              pageOffsetY,
              outer,
              { fill: "none" },
            ),
            createOverlayPresetGeometryShape(
              sourceShape,
              `${shapeId}_inner`,
              pageOffsetY,
              inner,
              { fill: "none" },
            ),
          ],
          assets: {},
        });
      }
      return finalize({
        shapes: [createOverlayPresetGeometryShape(sourceShape, shapeId, pageOffsetY, presetPoints)],
        assets: {},
      });
    }
  }

  if (sourceShape.geometry?.custom) {
    const customShapes = createOverlayCustomGeometryShape(sourceShape, shapeId, pageOffsetY);
    if (customShapes.length > 0) {
      return finalize({
        shapes: customShapes,
        assets: {},
      });
    }
  }

  if (sourceShape.kind === "textBox" || isTextOnlyShape(sourceShape)) {
    return finalize({
      shapes: [createOverlayTextShape(sourceShape, shapeId, pageOffsetY)],
      assets: {},
    });
  }

  if (sourceShape.kind === "shape") {
    return finalize({
      shapes: [createOverlayGeoShape(sourceShape, shapeId, pageOffsetY)],
      assets: {},
    });
  }

  const rendered = createRenderedObjectImageEntry(sourceShape, shapeId, slideIndex, pageOffsetY, context);
  if (rendered) {
    return finalize(rendered);
  }

  return finalize({
    shapes: [createOverlayUnsupportedPlaceholderShape(sourceShape, shapeId, pageOffsetY)],
    assets: {},
  });
}

function createOverlayBackgroundEntry(
  sourceShape: SlideRenderShape,
  shapeId: string,
  slideIndex: number,
  pageOffsetY: number,
): { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> } {
  if (sourceShape.imageDataUrl) {
    const assetId = powerPointAssetId(slideIndex, sourceShape);
    const asset: OverlayAsset = {
      id: assetId,
      type: "image",
      props: {
        w: Math.max(1, sourceShape.bounds.w),
        h: Math.max(1, sourceShape.bounds.h),
        name: `${sourceShape.name}.png`,
        isAnimated: false,
        mimeType: sourceShape.picture?.mimeType ?? dataUrlMimeType(sourceShape.imageDataUrl) ?? null,
        src: sourceShape.imageDataUrl,
        fileSize: sourceShape.picture?.fileSize ?? byteLength(sourceShape.imageDataUrl),
      },
    };
    return {
      shapes: [{
        id: shapeId,
        type: "image",
        x: sourceShape.bounds.x,
        y: pageOffsetY + sourceShape.bounds.y,
        stackLayer: "background",
        anchor: { type: "page" },
        props: {
          assetId,
          w: Math.max(1, sourceShape.bounds.w),
          h: Math.max(1, sourceShape.bounds.h),
        },
      }],
      assets: { [assetId]: asset },
    };
  }

  return {
    shapes: [{
      id: shapeId,
      type: "geo",
      x: sourceShape.bounds.x,
      y: pageOffsetY + sourceShape.bounds.y,
      stackLayer: "background",
      anchor: { type: "page" },
      props: {
        w: Math.max(1, sourceShape.bounds.w),
        h: Math.max(1, sourceShape.bounds.h),
        geo: "rectangle",
        fill: "solid",
        fillColor: getFillColor(sourceShape),
        color: getFillColor(sourceShape),
        strokeOpacity: 0,
        labelColor: "#111111",
        dash: "solid",
        size: "s",
      },
    }],
    assets: {},
  };
}

function createOverlayImageEntry(
  sourceShape: SlideRenderShape,
  shapeId: string,
  slideIndex: number,
  pageOffsetY: number,
  t: Translate<"editor">,
): { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> } {
  const assetId = powerPointAssetId(slideIndex, sourceShape);
  const asset: OverlayAsset = {
    id: assetId,
    type: "image",
    props: {
      w: Math.max(1, sourceShape.bounds.w),
      h: Math.max(1, sourceShape.bounds.h),
      name: sourceShape.picture?.target?.split("/").pop()
        ?? `${sourceShape.name || t("powerPoint.import.fallbackImageName")}.png`,
      isAnimated: false,
      mimeType: sourceShape.picture?.mimeType ?? dataUrlMimeType(sourceShape.imageDataUrl) ?? null,
      src: sourceShape.imageDataUrl ?? "",
      fileSize: sourceShape.picture?.fileSize ?? byteLength(sourceShape.imageDataUrl ?? ""),
    },
  };
  return {
    shapes: [{
      id: shapeId,
      type: "image",
      x: sourceShape.bounds.x,
      y: pageOffsetY + sourceShape.bounds.y,
      rotation: degreesToRadians(sourceShape.rotation ?? 0),
      anchor: { type: "page" },
      ...(sourceShape.opacity !== undefined ? { opacity: sourceShape.opacity } : {}),
      props: {
        assetId,
        w: Math.max(1, sourceShape.bounds.w),
        h: Math.max(1, sourceShape.bounds.h),
        ...pptxImageCropToOverlayCrop(sourceShape.model?.crop ?? sourceShape.picture?.crop),
      },
    }],
    assets: { [assetId]: asset },
  };
}

function createOverlayInkEntries(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
): { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> } | null {
  const strokes = sourceShape.ink?.paths ?? [];
  if (strokes.length === 0) {
    return null;
  }
  const group = createOverlayGroupShape(sourceShape, shapeId, pageOffsetY);
  const shapes: OverlayShape[] = [group];
  strokes.forEach((stroke, index) => {
    const path = svgPathToOverlayLine(stroke.path, sourceShape, pageOffsetY);
    if (!path || path.points.length < 2) {
      return;
    }
    shapes.push({
      id: `${shapeId}_ink_${index + 1}`,
      type: "line",
      x: path.x,
      y: path.y,
      rotation: degreesToRadians(sourceShape.rotation ?? 0),
      parentId: shapeId,
      anchor: { type: "page" },
      props: {
        kind: "freehand",
        points: path.points,
        closed: false,
        arrowheadStart: "none",
        arrowheadEnd: "none",
        fill: "none",
        fillColor: "#ffffff",
        color: stroke.color ?? "#111111",
        strokeOpacity: stroke.opacity,
        labelColor: "#111827",
        dash: "solid",
        size: toOverlayTextSize(stroke.width),
      },
    });
  });
  return shapes.length > 1 ? { shapes, assets: {} } : null;
}

function createRenderedObjectImageEntry(
  sourceShape: SlideRenderShape,
  shapeId: string,
  slideIndex: number,
  pageOffsetY: number,
  context: {
    filename: string;
    visualRenderer: PowerPointVisualRenderer | null;
  },
): { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> } | null {
  if (!context.visualRenderer) {
    return null;
  }

  const rendered = renderPowerPointObjectSvg(sourceShape, slideIndex, context.visualRenderer);
  if (!rendered) {
    return null;
  }
  const assetId = powerPointRenderedAssetId(slideIndex, sourceShape);
  const asset: OverlayAsset = {
    id: assetId,
    type: "image",
    props: {
      w: rendered.bounds.w,
      h: rendered.bounds.h,
      name: `${context.filename.replace(/\.pptx$/i, "") || "slide"}-${slideIndex + 1}-${sourceShape.name || sourceShape.zIndex + 1}.svg`,
      isAnimated: false,
      mimeType: "image/svg+xml",
      src: rendered.dataUrl,
      fileSize: byteLength(rendered.dataUrl),
    },
  };

  return {
    shapes: [{
      id: shapeId,
      type: "image",
      x: rendered.bounds.x,
      y: pageOffsetY + rendered.bounds.y,
      rotation: 0,
      anchor: { type: "page" },
      props: {
        assetId,
        w: rendered.bounds.w,
        h: rendered.bounds.h,
      },
    }],
    assets: { [assetId]: asset },
  };
}

function renderPowerPointObjectSvg(
  sourceShape: SlideRenderShape,
  slideIndex: number,
  visualRenderer: PowerPointVisualRenderer,
): { dataUrl: string; bounds: { x: number; y: number; w: number; h: number } } | null {
  const fragment = visualRenderer.renderShapeSvg(slideIndex, sourceShape.zIndex);
  if (!fragment || fragment.startsWith("ERROR:")) {
    return null;
  }

  const bounds = getPaddedObjectBounds(sourceShape);
  const svg = wrapRenderedObjectSvg(fragment, bounds);
  return {
    dataUrl: svgToDataUrl(svg),
    bounds,
  };
}

function withPowerPointParent(
  result: { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> },
  sourceShape: SlideRenderShape,
  slideIndex: number,
): { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> } {
  if (!sourceShape.parentSourceId) {
    return result;
  }
  const parentId = powerPointShapeIdFromSourceId(slideIndex, sourceShape.parentSourceId);
  return {
    ...result,
    shapes: result.shapes.map((shape) =>
      shape.id === parentId || shape.parentId ? shape : ({ ...shape, parentId } as OverlayShape),
    ),
  };
}

function withPowerPointObjectFlags(
  result: { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> },
  sourceShape: SlideRenderShape,
  shapeId: string,
): { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> } {
  if (!sourceShape.hidden && sourceShape.opacity === undefined) {
    return result;
  }
  return {
    ...result,
    shapes: result.shapes.map((shape) =>
      shape.id === shapeId
        ? {
            ...shape,
            ...(sourceShape.hidden ? { hidden: true } : {}),
            ...(sourceShape.opacity !== undefined ? { opacity: clamp01(sourceShape.opacity) } : {}),
          } as OverlayShape
        : shape,
    ),
  };
}

function createOverlayGroupShape(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
): OverlayShape {
  return {
    id: shapeId,
    type: "group",
    x: sourceShape.bounds.x,
    y: pageOffsetY + sourceShape.bounds.y,
    rotation: degreesToRadians(sourceShape.rotation ?? 0),
    anchor: { type: "page" },
    props: {
      w: Math.max(1, sourceShape.bounds.w),
      h: Math.max(1, sourceShape.bounds.h),
      name: sourceShape.name,
    },
  };
}

function createOverlayTableShape(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
): OverlayShape {
  return {
    id: shapeId,
    type: "tableShape",
    x: sourceShape.bounds.x,
    y: pageOffsetY + sourceShape.bounds.y,
    rotation: degreesToRadians(sourceShape.rotation ?? 0),
    anchor: { type: "page" },
    props: {
      w: Math.max(24, sourceShape.bounds.w),
      h: Math.max(24, sourceShape.bounds.h),
      table: powerPointTableToSigmaTable(
        sourceShape.table!.data,
        shapeId,
        Math.max(24, sourceShape.bounds.w),
        Math.max(24, sourceShape.bounds.h),
      ),
    },
  };
}

function createOverlayChartGroupEntries(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
  t: Translate<"editor">,
): { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> } | null {
  const chartData = sourceShape.chart?.data;
  if (!chartData || chartData.series.length === 0) {
    return null;
  }

  const bounds = {
    x: sourceShape.bounds.x,
    y: pageOffsetY + sourceShape.bounds.y,
    w: Math.max(80, sourceShape.bounds.w),
    h: Math.max(60, sourceShape.bounds.h),
  };
  const group = createOverlayGroupShape(sourceShape, shapeId, pageOffsetY);
  const shapes: OverlayShape[] = [group];
  const title = chartData.title?.trim() || sourceShape.name;
  if (title) {
    shapes.push(createOverlayTextLabelShape(
      `${shapeId}_title`,
      bounds.x + 8,
      bounds.y + 4,
      Math.max(40, bounds.w - 16),
      22,
      title,
      shapeId,
      "m",
    ));
  }

  const plot = {
    x: bounds.x + Math.min(56, Math.max(34, bounds.w * 0.12)),
    y: bounds.y + Math.min(42, Math.max(28, bounds.h * 0.16)),
    w: Math.max(24, bounds.w - Math.min(86, Math.max(52, bounds.w * 0.18))),
    h: Math.max(24, bounds.h - Math.min(78, Math.max(52, bounds.h * 0.26))),
  };
  const valueBounds = getChartValueBounds(chartData);
  const baselineY = plot.y + (valueBounds.max / valueBounds.range) * plot.h;

  shapes.push(createOverlayLineShape(
    `${shapeId}_axis_x`,
    plot.x,
    baselineY,
    [{ x: 0, y: 0 }, { x: plot.w, y: 0 }],
    shapeId,
    "#475569",
  ));
  shapes.push(createOverlayLineShape(
    `${shapeId}_axis_y`,
    plot.x,
    plot.y,
    [{ x: 0, y: 0 }, { x: 0, y: plot.h }],
    shapeId,
    "#475569",
  ));

  if (isLineChartType(chartData.chartType)) {
    shapes.push(...createOverlayLineChartShapes(chartData, shapeId, plot, valueBounds));
  } else if (isPieChartType(chartData.chartType)) {
    shapes.push(...createOverlayPieChartShapes(chartData, shapeId, plot));
  } else {
    shapes.push(...createOverlayBarChartShapes(chartData, shapeId, plot, valueBounds, baselineY));
  }
  shapes.push(...createOverlayChartCategoryLabels(chartData, shapeId, plot, bounds));
  shapes.push(...createOverlayChartLegendShapes(chartData, shapeId, bounds, t));

  return { shapes, assets: {} };
}

function createOverlayBarChartShapes(
  chartData: PptxChartData,
  groupId: string,
  plot: { x: number; y: number; w: number; h: number },
  valueBounds: { min: number; max: number; range: number },
  baselineY: number,
): OverlayShape[] {
  const categoryCount = getChartCategoryCount(chartData);
  const seriesCount = Math.max(1, chartData.series.length);
  const slotWidth = plot.w / categoryCount;
  const barGroupWidth = Math.max(2, slotWidth * 0.72);
  const barWidth = Math.max(2, barGroupWidth / seriesCount);
  const shapes: OverlayShape[] = [];

  chartData.series.forEach((series, seriesIndex) => {
    const color = series.color || chartData.colorPalette?.[seriesIndex] || CHART_SERIES_COLORS[seriesIndex % CHART_SERIES_COLORS.length]!;
    for (let categoryIndex = 0; categoryIndex < categoryCount; categoryIndex += 1) {
      const value = toChartNumber(series.values[categoryIndex]);
      if (value === undefined) {
        continue;
      }
      const valueY = chartValueToY(value, plot, valueBounds);
      const barHeight = Math.max(1, Math.abs(valueY - baselineY));
      const x = plot.x + categoryIndex * slotWidth + (slotWidth - barGroupWidth) / 2 + seriesIndex * barWidth;
      const y = Math.min(valueY, baselineY);
      shapes.push({
        id: `${groupId}_bar_${seriesIndex + 1}_${categoryIndex + 1}`,
        type: "geo",
        x: round(x),
        y: round(y),
        parentId: groupId,
        anchor: { type: "page" },
        props: {
          w: round(Math.max(1, barWidth - 1)),
          h: round(barHeight),
          geo: "rectangle",
          fill: "solid",
          fillColor: color,
          color,
          strokeOpacity: 0,
          labelColor: "#111827",
          dash: "solid",
          size: "s",
        },
      });
    }
  });

  return shapes;
}

function createOverlayLineChartShapes(
  chartData: PptxChartData,
  groupId: string,
  plot: { x: number; y: number; w: number; h: number },
  valueBounds: { min: number; max: number; range: number },
): OverlayShape[] {
  const categoryCount = getChartCategoryCount(chartData);
  const step = categoryCount > 1 ? plot.w / (categoryCount - 1) : 0;
  const shapes: OverlayShape[] = [];

  chartData.series.forEach((series, seriesIndex) => {
    const color = series.color || chartData.colorPalette?.[seriesIndex] || CHART_SERIES_COLORS[seriesIndex % CHART_SERIES_COLORS.length]!;
    const points = Array.from({ length: categoryCount }, (_, categoryIndex) => {
      const value = toChartNumber(series.values[categoryIndex]);
      return value === undefined
        ? null
        : {
            x: plot.x + categoryIndex * step,
            y: chartValueToY(value, plot, valueBounds),
            value,
            category: chartData.categories[categoryIndex] ?? `${categoryIndex + 1}`,
          };
    });
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      if (!start || !end) {
        continue;
      }
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      shapes.push(createOverlayLineShape(
        `${groupId}_line_${seriesIndex + 1}_${index + 1}`,
        x,
        y,
        [
          { x: round(start.x - x), y: round(start.y - y) },
          { x: round(end.x - x), y: round(end.y - y) },
        ],
        groupId,
        color,
      ));
    }
    points.filter((point): point is NonNullable<typeof point> => point !== null).forEach((point, pointIndex) => {
      shapes.push({
        id: `${groupId}_point_${seriesIndex + 1}_${pointIndex + 1}`,
        type: "geo",
        x: round(point.x - 3),
        y: round(point.y - 3),
        parentId: groupId,
        anchor: { type: "page" },
        props: {
          w: 6,
          h: 6,
          geo: "ellipse",
          fill: "solid",
          fillColor: color,
          color,
          labelColor: "#111827",
          dash: "solid",
          size: "s",
        },
      });
    });
  });

  return shapes;
}

function createOverlayPieChartShapes(
  chartData: PptxChartData,
  groupId: string,
  plot: { x: number; y: number; w: number; h: number },
): OverlayShape[] {
  const firstSeries = chartData.series[0];
  if (!firstSeries) {
    return [];
  }
  const diameter = Math.max(24, Math.min(plot.w, plot.h) * 0.72);
  const centerX = plot.x + plot.w * 0.38;
  const centerY = plot.y + plot.h * 0.48;
  const summary = firstSeries.values
    .map((value, index) => `${chartData.categories[index] ?? index + 1}: ${value}`)
    .join("\n");
  return [
    {
      id: `${groupId}_pie_body`,
      type: "geo",
      x: round(centerX - diameter / 2),
      y: round(centerY - diameter / 2),
      parentId: groupId,
      anchor: { type: "page" },
      props: {
        w: round(diameter),
        h: round(diameter),
        geo: "ellipse",
        fill: "solid",
        fillColor: firstSeries.color || chartData.colorPalette?.[0] || CHART_SERIES_COLORS[0],
        color: "#334155",
        labelColor: "#111827",
        dash: "solid",
        size: "s",
        label: firstSeries.name,
      },
    },
    createOverlayTextLabelShape(
      `${groupId}_pie_values`,
      plot.x + plot.w * 0.58,
      plot.y + 8,
      Math.max(40, plot.w * 0.38),
      Math.max(28, plot.h - 16),
      summary,
      groupId,
      "s",
    ),
  ];
}

function createOverlayChartCategoryLabels(
  chartData: PptxChartData,
  groupId: string,
  plot: { x: number; y: number; w: number; h: number },
  bounds: { x: number; y: number; w: number; h: number },
): OverlayShape[] {
  const categoryCount = getChartCategoryCount(chartData);
  if (categoryCount === 0 || isPieChartType(chartData.chartType)) {
    return [];
  }
  const visibleCategoryIndexes = categoryCount <= 8
    ? Array.from({ length: categoryCount }, (_, index) => index)
    : [0, Math.floor(categoryCount / 2), categoryCount - 1];
  const slotWidth = plot.w / categoryCount;
  return visibleCategoryIndexes.map((categoryIndex) => createOverlayTextLabelShape(
    `${groupId}_category_${categoryIndex + 1}`,
    plot.x + categoryIndex * slotWidth,
    Math.min(bounds.y + bounds.h - 18, plot.y + plot.h + 4),
    Math.max(22, slotWidth),
    16,
    chartData.categories[categoryIndex] ?? `${categoryIndex + 1}`,
    groupId,
    "s",
  ));
}

function createOverlayChartLegendShapes(
  chartData: PptxChartData,
  groupId: string,
  bounds: { x: number; y: number; w: number; h: number },
  t: Translate<"editor">,
): OverlayShape[] {
  if (chartData.series.length <= 1) {
    return [];
  }
  const legendX = bounds.x + Math.max(8, bounds.w - 96);
  const legendY = bounds.y + 28;
  return chartData.series.flatMap((series, index): OverlayShape[] => {
    const color = series.color || chartData.colorPalette?.[index] || CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]!;
    const y = legendY + index * 16;
    return [
      {
        id: `${groupId}_legend_swatch_${index + 1}`,
        type: "geo",
        x: round(legendX),
        y: round(y + 3),
        parentId: groupId,
        anchor: { type: "page" },
        props: {
          w: 9,
          h: 9,
          geo: "rectangle",
          fill: "solid",
          fillColor: color,
          color,
          strokeOpacity: 0,
          labelColor: "#111827",
          dash: "solid",
          size: "s",
        },
      },
      createOverlayTextLabelShape(
        `${groupId}_legend_label_${index + 1}`,
        legendX + 13,
        y,
        78,
        14,
        series.name || t("powerPoint.import.fallbackSeriesName", { number: index + 1 }),
        groupId,
        "s",
      ),
    ];
  });
}

function createOverlaySmartArtGroupEntries(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
): { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> } | null {
  const smartArtData = sourceShape.smartArt?.data;
  if (!smartArtData) {
    return null;
  }

  const group = createOverlayGroupShape(sourceShape, shapeId, pageOffsetY);
  const drawingShapes = smartArtData.drawingShapes ?? [];
  const shapes = drawingShapes.length > 0
    ? createOverlaySmartArtDrawingShapes(sourceShape, shapeId, pageOffsetY, drawingShapes)
    : createOverlaySmartArtNodeShapes(sourceShape, shapeId, pageOffsetY, smartArtData);
  if (shapes.length === 0) {
    return null;
  }
  return { shapes: [group, ...shapes], assets: {} };
}

function createOverlaySmartArtDrawingShapes(
  sourceShape: SlideRenderShape,
  groupId: string,
  pageOffsetY: number,
  drawingShapes: PptxSmartArtDrawingShape[],
): OverlayShape[] {
  const drawingBounds = getSmartArtDrawingBounds(drawingShapes);
  if (!drawingBounds) {
    return [];
  }
  const scaleX = sourceShape.bounds.w / drawingBounds.w;
  const scaleY = sourceShape.bounds.h / drawingBounds.h;
  return drawingShapes.map((drawingShape, index): OverlayShape => {
    const x = sourceShape.bounds.x + (drawingShape.x - drawingBounds.x) * scaleX;
    const y = pageOffsetY + sourceShape.bounds.y + (drawingShape.y - drawingBounds.y) * scaleY;
    const w = Math.max(8, drawingShape.width * scaleX);
    const h = Math.max(8, drawingShape.height * scaleY);
    return {
      id: `${groupId}_smartart_shape_${index + 1}_${sanitizeId(drawingShape.id)}`,
      type: "geo",
      x: round(x),
      y: round(y),
      rotation: degreesToRadians(drawingShape.rotation ?? 0),
      parentId: groupId,
      anchor: { type: "page" },
      props: {
        w: round(w),
        h: round(h),
        geo: toOverlayGeo(drawingShape.shapeType),
        fill: drawingShape.fillColor ? "solid" : "none",
        fillColor: drawingShape.fillColor,
        color: drawingShape.strokeColor ?? "#334155",
        labelColor: drawingShape.fontColor ?? "#111827",
        dash: "solid",
        size: toOverlayTextSize(drawingShape.strokeWidth),
        ...(drawingShape.text ? { label: drawingShape.text } : {}),
      },
    };
  });
}

function createOverlaySmartArtNodeShapes(
  sourceShape: SlideRenderShape,
  groupId: string,
  pageOffsetY: number,
  smartArtData: PptxSmartArtData,
): OverlayShape[] {
  const nodes = flattenSmartArtNodes(smartArtData.nodes);
  if (nodes.length === 0) {
    return [];
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const rows = Math.max(1, Math.ceil(nodes.length / cols));
  const gap = 8;
  const cellW = Math.max(24, (sourceShape.bounds.w - gap * (cols + 1)) / cols);
  const cellH = Math.max(18, (sourceShape.bounds.h - gap * (rows + 1)) / rows);
  return nodes.map((node, index): OverlayShape => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const fillColor = node.style?.fillColor ?? smartArtData.chrome?.backgroundColor ?? "#DBEAFE";
    return {
      id: `${groupId}_smartart_node_${index + 1}_${sanitizeId(node.id)}`,
      type: "geo",
      x: round(sourceShape.bounds.x + gap + col * (cellW + gap)),
      y: round(pageOffsetY + sourceShape.bounds.y + gap + row * (cellH + gap)),
      parentId: groupId,
      anchor: { type: "page" },
      props: {
        w: round(cellW),
        h: round(cellH),
        geo: "rectangle",
        fill: "solid",
        fillColor,
        color: node.style?.lineColor ?? smartArtData.chrome?.outlineColor ?? "#2563EB",
        labelColor: node.style?.fontColor ?? "#111827",
        dash: "solid",
        size: "s",
        label: node.text,
      },
    };
  });
}

function createOverlayUnsupportedPlaceholderShape(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
): OverlayShape {
  return {
    id: shapeId,
    type: "geo",
    x: sourceShape.bounds.x,
    y: pageOffsetY + sourceShape.bounds.y,
    rotation: degreesToRadians(sourceShape.rotation ?? 0),
    anchor: { type: "page" },
    opacity: 0.72,
    props: {
      w: Math.max(24, sourceShape.bounds.w),
      h: Math.max(24, sourceShape.bounds.h),
      geo: "rectangle",
      fill: "solid",
      fillColor: "#f8fafc",
      color: "#64748b",
      labelColor: "#334155",
      dash: "dashed",
      size: "m",
      label: `${sourceShape.name || "PowerPoint object"} (${sourceShape.kind})`,
    },
  };
}

function createOverlayLineOrArrowShape(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
): OverlayShape {
  const { start, end } = getLineLocalEndpoints(sourceShape);
  const arrowheadStart = toOverlayArrowhead(sourceShape.line?.beginArrow);
  const arrowheadEnd = toOverlayArrowhead(sourceShape.line?.endArrow);
  const hasArrowhead = arrowheadStart !== "none" || arrowheadEnd !== "none";
  const base = {
    id: shapeId,
    x: sourceShape.bounds.x,
    y: pageOffsetY + sourceShape.bounds.y,
    rotation: degreesToRadians(sourceShape.rotation ?? 0),
    anchor: { type: "page" as const },
  };

  if (hasArrowhead) {
    return {
      ...base,
      type: "arrow",
      props: {
        start,
        end,
        arrowheadStart,
        arrowheadEnd,
        fill: "none",
        color: getStrokeColor(sourceShape),
        strokeOpacity: sourceShape.line?.noStroke ? 0 : sourceShape.line?.opacity,
        labelColor: "#111111",
        dash: toOverlayDash(sourceShape.line?.dash),
        size: toOverlayTextSize(sourceShape.line?.widthPx),
        label: sourceShape.text?.plainText || undefined,
      },
    };
  }

  return {
    ...base,
    type: "line",
    props: {
      kind: "polyline",
      points: [start, end],
      closed: false,
      arrowheadStart,
      arrowheadEnd,
      fill: "none",
      fillColor: "#ffffff",
      color: getStrokeColor(sourceShape),
      strokeOpacity: sourceShape.line?.noStroke ? 0 : sourceShape.line?.opacity,
      labelColor: "#111111",
      dash: toOverlayDash(sourceShape.line?.dash),
      size: toOverlayTextSize(sourceShape.line?.widthPx),
      label: sourceShape.text?.plainText || undefined,
    },
  };
}

function createOverlayPresetGeometryShape(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
  points: Array<{ x: number; y: number }>,
  style?: {
    fill?: "none" | "solid";
    strokeOpacity?: number;
  },
): OverlayShape {
  const fill = style?.fill ?? (sourceShape.fill?.type === "none" ? "none" : "solid");
  return {
    id: shapeId,
    type: "line",
    x: sourceShape.bounds.x,
    y: pageOffsetY + sourceShape.bounds.y,
    rotation: degreesToRadians(sourceShape.rotation ?? 0),
    anchor: { type: "page" },
    props: {
      kind: "polyline",
      points: points.map((p) => ({ x: round(p.x), y: round(p.y) })),
      closed: true,
      arrowheadStart: toOverlayArrowhead(sourceShape.line?.beginArrow),
      arrowheadEnd: toOverlayArrowhead(sourceShape.line?.endArrow),
      fill,
      fillColor: getFillColor(sourceShape),
      fillOpacity: sourceShape.fill?.opacity,
      fillPattern: powerPointFillToOverlayPattern(sourceShape.fill),
      color: getStrokeColor(sourceShape),
      strokeOpacity: style?.strokeOpacity ?? (sourceShape.line?.noStroke ? 0 : sourceShape.line?.opacity),
      labelColor: "#111111",
      dash: toOverlayDash(sourceShape.line?.dash),
      size: toOverlayTextSize(sourceShape.line?.widthPx),
      label: sourceShape.text?.plainText || undefined,
    },
  };
}

function createOverlayArcShape(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
): OverlayShape {
  const rx = Math.max(0.5, sourceShape.bounds.w / 2);
  const ry = Math.max(0.5, sourceShape.bounds.h / 2);
  const isSector = sourceShape.geometry?.preset === "pie";
  return {
    id: shapeId,
    type: "arc",
    x: sourceShape.bounds.x,
    y: pageOffsetY + sourceShape.bounds.y,
    rotation: degreesToRadians(sourceShape.rotation ?? 0),
    anchor: { type: "page" },
    props: {
      kind: isSector ? "sector" : "arc",
      r: Math.max(rx, ry),
      rx,
      ry,
      startAngle: Math.PI,
      endAngle: 0,
      arrowheadStart: toOverlayArrowhead(sourceShape.line?.beginArrow),
      arrowheadEnd: toOverlayArrowhead(sourceShape.line?.endArrow),
      fill: isSector ? (sourceShape.fill?.type === "none" ? "none" : "solid") : "none",
      fillColor: isSector ? getFillColor(sourceShape) : undefined,
      fillOpacity: isSector ? sourceShape.fill?.opacity : undefined,
      color: getStrokeColor(sourceShape),
      strokeOpacity: sourceShape.line?.noStroke ? 0 : sourceShape.line?.opacity,
      dash: toOverlayDash(sourceShape.line?.dash),
      size: toOverlayTextSize(sourceShape.line?.widthPx),
    },
  };
}

function createOverlayGeoShape(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
): OverlayShape {
  const preset = sourceShape.geometry?.preset;
  const geo = toOverlayGeo(preset);
  const fill = sourceShape.fill?.type === "none" ? "none" : "solid";
  return {
    id: shapeId,
    type: "geo",
    x: sourceShape.bounds.x,
    y: pageOffsetY + sourceShape.bounds.y,
    rotation: degreesToRadians(sourceShape.rotation ?? 0),
    anchor: { type: "page" },
    props: {
      w: Math.max(1, sourceShape.bounds.w),
      h: Math.max(1, sourceShape.bounds.h),
      geo,
      radius: preset === "roundRect" ? round(Math.min(sourceShape.bounds.w, sourceShape.bounds.h) * 0.08) : undefined,
      fill,
      color: getStrokeColor(sourceShape),
      strokeOpacity: sourceShape.line?.noStroke ? 0 : sourceShape.line?.opacity,
      fillColor: getFillColor(sourceShape),
      fillOpacity: sourceShape.fill?.opacity,
      labelColor: "#111111",
      dash: toOverlayDash(sourceShape.line?.dash),
      size: toOverlayTextSize(sourceShape.line?.widthPx),
      apexX: geo === "triangle" ? powerPointTriangleApexX(sourceShape) : undefined,
      headLengthRatio: geo === "blockArrow" ? powerPointBlockArrowHeadLengthRatio(sourceShape) : undefined,
      shaftRatio: geo === "blockArrow" ? powerPointBlockArrowShaftRatio(sourceShape) : undefined,
      label: sourceShape.text?.plainText || undefined,
    },
  };
}

function createOverlayCustomGeometryShape(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
): OverlayLineShape[] {
  const customGeometry = sourceShape.geometry?.custom;
  const subpaths = customGeometry?.subpaths;
  if (subpaths && subpaths.length > 1) {
    return subpaths.map((subpath, index) => createOverlayCustomGeometryLineShape(
      sourceShape,
      index === 0 ? shapeId : `${shapeId}_${index - 1}`,
      pageOffsetY,
      normalizeCustomGeometrySubpathToBounds(subpath, customGeometry, sourceShape.bounds),
      subpath.closed,
    ));
  }

  const pathData = customGeometry?.pathData;
  if (!pathData) {
    return [];
  }
  const points = svgPathToPointList(pathData);
  if (points.length < 2) {
    return [];
  }
  return [createOverlayCustomGeometryLineShape(
    sourceShape,
    shapeId,
    pageOffsetY,
    normalizePointsToBounds(points, sourceShape.bounds),
    Boolean(customGeometry?.closed),
  )];
}

function createOverlayCustomGeometryLineShape(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
  points: Array<{ x: number; y: number }>,
  closed: boolean,
): OverlayLineShape {
  return {
    id: shapeId,
    type: "line",
    x: sourceShape.bounds.x,
    y: pageOffsetY + sourceShape.bounds.y,
    rotation: degreesToRadians(sourceShape.rotation ?? 0),
    anchor: { type: "page" },
    props: {
      kind: "polyline",
      points: points.map((point) => ({ x: round(point.x), y: round(point.y) })),
      closed,
      arrowheadStart: toOverlayArrowhead(sourceShape.line?.beginArrow),
      arrowheadEnd: toOverlayArrowhead(sourceShape.line?.endArrow),
      fill: sourceShape.fill?.type === "none" ? "none" : "solid",
      fillColor: getFillColor(sourceShape),
      fillOpacity: sourceShape.fill?.opacity,
      fillPattern: powerPointFillToOverlayPattern(sourceShape.fill),
      color: getStrokeColor(sourceShape),
      strokeOpacity: sourceShape.line?.noStroke ? 0 : sourceShape.line?.opacity,
      labelColor: "#111111",
      dash: toOverlayDash(sourceShape.line?.dash),
      size: toOverlayTextSize(sourceShape.line?.widthPx),
      label: sourceShape.text?.plainText || undefined,
    },
  };
}

function createOverlayTextShape(
  sourceShape: SlideRenderShape,
  shapeId: string,
  pageOffsetY: number,
): OverlayShape {
  return {
    id: shapeId,
    type: "text",
    x: sourceShape.bounds.x,
    y: pageOffsetY + sourceShape.bounds.y,
    rotation: degreesToRadians(sourceShape.rotation ?? 0),
    anchor: { type: "page" },
    props: {
      w: Math.max(8, sourceShape.bounds.w),
      h: Math.max(14, sourceShape.bounds.h),
      blocks: powerPointTextToBlocks(sourceShape.text, sourceShape.name),
      color: getPowerPointTextPrimaryColor(sourceShape.text) ?? "#111111",
      // `size` is only the coarse bucket used when no explicit size is stored;
      // `fontSize` (points, same unit PowerPoint reports) is what actually renders,
      // so the imported text keeps the size it had on the slide.
      fontSize: getPowerPointTextPrimaryFontSizePt(sourceShape.text),
      size: getPowerPointTextPrimarySize(sourceShape.text) ?? toOverlayTextSize(sourceShape.line?.widthPx),
    },
  };
}

function getLineLocalEndpoints(shape: SlideRenderShape): {
  start: { x: number; y: number };
  end: { x: number; y: number };
} {
  return {
    start: {
      x: shape.flip?.horizontal ? shape.bounds.w : 0,
      y: shape.flip?.vertical ? shape.bounds.h : 0,
    },
    end: {
      x: shape.flip?.horizontal ? 0 : shape.bounds.w,
      y: shape.flip?.vertical ? 0 : shape.bounds.h,
    },
  };
}

function isTextOnlyShape(shape: SlideRenderShape): boolean {
  return Boolean(shape.text?.plainText) &&
    shape.fill?.type === "none" &&
    (shape.line?.noStroke || !shape.line);
}

function isPowerPointPreviewImageKind(kind: PowerPointSourceShape["kind"]): boolean {
  return kind === "picture" || kind === "ole" || kind === "media" || kind === "zoom" || kind === "model3d";
}

function svgPathToOverlayLine(
  path: string,
  sourceShape: SlideRenderShape,
  pageOffsetY: number,
): { x: number; y: number; points: Array<{ x: number; y: number }> } | null {
  const rawPoints = svgPathToPointList(path);
  if (rawPoints.length < 2) {
    return null;
  }
  const local = rawPoints.map((point) => ({ x: point.x, y: point.y }));
  const absolute = rawPoints.map((point) => ({
    x: point.x - sourceShape.bounds.x,
    y: point.y - sourceShape.bounds.y,
  }));
  const normalized = normalizePointsToBounds(rawPoints, sourceShape.bounds);
  const candidates = [
    { x: sourceShape.bounds.x, y: pageOffsetY + sourceShape.bounds.y, points: local },
    { x: sourceShape.bounds.x, y: pageOffsetY + sourceShape.bounds.y, points: absolute },
    { x: sourceShape.bounds.x, y: pageOffsetY + sourceShape.bounds.y, points: normalized },
  ];
  const candidate = candidates.reduce((best, current) =>
    scorePointsInsideBounds(current.points, sourceShape.bounds) < scorePointsInsideBounds(best.points, sourceShape.bounds)
      ? current
      : best,
  );
  return {
    x: round(candidate.x),
    y: round(candidate.y),
    points: candidate.points.map((point) => ({ x: round(point.x), y: round(point.y) })),
  };
}

function svgPathToPointList(path: string): Array<{ x: number; y: number }> {
  try {
    const commands = parseSvgPath(path);
    const points: Array<{ x: number; y: number }> = [];
    let current = { x: 0, y: 0 };
    let subpathStart = { x: 0, y: 0 };
    for (const command of commands) {
      const type = command.type;
      const upper = type.toUpperCase();
      const relative = type !== upper;
      const args = command.args;
      const point = (x: number, y: number) => relative ? { x: current.x + x, y: current.y + y } : { x, y };
      if (upper === "M" || upper === "L" || upper === "T") {
        for (let index = 0; index + 1 < args.length; index += 2) {
          current = point(args[index]!, args[index + 1]!);
          points.push(current);
          if (upper === "M" && index === 0) {
            subpathStart = current;
          }
        }
      } else if (upper === "H") {
        for (const x of args) {
          current = relative ? { x: current.x + x, y: current.y } : { x, y: current.y };
          points.push(current);
        }
      } else if (upper === "V") {
        for (const y of args) {
          current = relative ? { x: current.x, y: current.y + y } : { x: current.x, y };
          points.push(current);
        }
      } else if (upper === "C") {
        for (let index = 0; index + 5 < args.length; index += 6) {
          current = point(args[index + 4]!, args[index + 5]!);
          points.push(current);
        }
      } else if (upper === "S" || upper === "Q") {
        for (let index = 0; index + 3 < args.length; index += 4) {
          current = point(args[index + 2]!, args[index + 3]!);
          points.push(current);
        }
      } else if (upper === "A") {
        for (let index = 0; index + 6 < args.length; index += 7) {
          current = point(args[index + 5]!, args[index + 6]!);
          points.push(current);
        }
      } else if (upper === "Z") {
        current = subpathStart;
        points.push(current);
      }
    }
    return points;
  } catch {
    return [];
  }
}

function normalizePointsToBounds(
  points: Array<{ x: number; y: number }>,
  bounds: SlideRenderShape["bounds"],
): Array<{ x: number; y: number }> {
  const extents = getPointExtents(points);
  const width = extents.maxX - extents.minX || 1;
  const height = extents.maxY - extents.minY || 1;
  return points.map((point) => ({
    x: ((point.x - extents.minX) / width) * Math.max(1, bounds.w),
    y: ((point.y - extents.minY) / height) * Math.max(1, bounds.h),
  }));
}

function scorePointsInsideBounds(points: Array<{ x: number; y: number }>, bounds: SlideRenderShape["bounds"]): number {
  return points.reduce((score, point) => {
    const xOverflow = Math.max(0, -point.x, point.x - Math.max(1, bounds.w));
    const yOverflow = Math.max(0, -point.y, point.y - Math.max(1, bounds.h));
    return score + xOverflow + yOverflow;
  }, 0);
}

function getPointExtents(points: Array<{ x: number; y: number }>): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function toOverlayGeo(preset: string | undefined): "rectangle" | "ellipse" | "triangle" | "diamond" | "pentagon" | "blockArrow" {
  switch (preset) {
    case "ellipse":
      return "ellipse";
    case "triangle":
      return "triangle";
    case "diamond":
      return "diamond";
    case "pentagon":
      return "pentagon";
    case "rightArrow":
    case "leftArrow":
    case "upArrow":
    case "downArrow":
      return "blockArrow";
    default:
      return "rectangle";
  }
}

function getStrokeColor(shape: SlideRenderShape): string {
  return shape.line?.color ?? "#111111";
}

function getFillColor(shape: SlideRenderShape): string {
  if ((shape.fill?.type === "solid" || shape.fill?.type === "gradient" || shape.fill?.type === "pattern") && shape.fill.color) {
    return shape.fill.color;
  }
  // Gradients and patterns are flattened to a solid fill; when PowerPoint reports
  // no flat colour for them, the first gradient stop is the closest stand-in.
  const firstStopColor = shape.fill?.stops?.find((stop) => stop.color)?.color;
  if (firstStopColor) {
    return firstStopColor;
  }
  return "#ffffff";
}

function powerPointTriangleApexX(shape: SlideRenderShape): number {
  const adjustment = shape.geometry?.adjustments?.adj ?? shape.geometry?.adjustments?.adj1;
  if (adjustment === undefined) {
    return Math.max(1, shape.bounds.w) / 2;
  }
  return round(Math.max(1, shape.bounds.w) * clamp(adjustment / 100000, 0, 1));
}

function powerPointBlockArrowHeadLengthRatio(shape: SlideRenderShape): number | undefined {
  const adjustment = shape.geometry?.adjustments?.adj ?? shape.geometry?.adjustments?.adj1;
  return adjustment === undefined ? undefined : clamp(adjustment / 100000, 0.18, 0.75);
}

function powerPointBlockArrowShaftRatio(shape: SlideRenderShape): number | undefined {
  const adjustment = shape.geometry?.adjustments?.adj2;
  return adjustment === undefined ? undefined : clamp(adjustment / 100000, 0.12, 0.9);
}

function powerPointFillToOverlayPattern(fill: PowerPointSourceFillStyle | undefined): "diagonalHatch" | undefined {
  return fill?.type === "pattern" ? "diagonalHatch" : undefined;
}

function toOverlayDash(dash: string | undefined): OverlayDash {
  if (!dash || dash === "solid") {
    return "solid";
  }
  return dash.includes("dot") ? "dotted" : "dashed";
}

function toOverlayArrowhead(value: string | undefined): OverlayArrowhead {
  if (!value || value === "none") {
    return "none";
  }
  if (value === "oval") {
    return "dot";
  }
  if (value === "bar") {
    return "bar";
  }
  return "arrow";
}

function toOverlayTextSize(widthPx: number | undefined): OverlayTextSize {
  if (widthPx === undefined || widthPx <= 1.5) {
    return "s";
  }
  if (widthPx <= 2.4) {
    return "m";
  }
  if (widthPx <= 4) {
    return "l";
  }
  return "xl";
}

function toPlainTextBlocks(text: string): OverlayTextBlock[] {
  const lines = text.split(/\r?\n/u);
  return lines.map((line) => ({
    type: "paragraph" as const,
    id: createId("p"),
    children: line ? [{ type: "text" as const, text: line }] : [],
  }));
}

function powerPointTextToBlocks(text: PowerPointSourceShape["text"] | undefined, fallbackText: string): OverlayTextBlock[] {
  if (!text?.segments?.length) {
    return toPlainTextBlocks(text?.plainText ?? fallbackText);
  }
  const paragraphs: ParagraphNode[] = [];
  const autoNumberCounters = new Map<string, number>();
  let currentParagraph: ParagraphNode | null = null;
  let atParagraphStart = true;

  const ensureParagraph = (segment: TextSegment) => {
    if (currentParagraph) {
      return currentParagraph;
    }
    currentParagraph = createPowerPointParagraphNode(segment);
    paragraphs.push(currentParagraph);
    return currentParagraph;
  };

  for (const segment of text.segments) {
    if (segment.isParagraphBreak) {
      ensureParagraph(segment);
      currentParagraph = null;
      atParagraphStart = true;
      continue;
    }

    const paragraph = ensureParagraph(segment);
    if (atParagraphStart) {
      const prefix = powerPointBulletPrefix(segment, autoNumberCounters);
      if (prefix) {
        appendInlineTextToParagraph(paragraph, prefix, powerPointBulletPrefixStyle(segment));
      }
      atParagraphStart = false;
    }

    const rawText = segment.isLineBreak ? "\n" : segment.text;
    appendInlineTextToParagraph(paragraph, rawText, powerPointTextSegmentStyle(segment));
  }
  if (paragraphs.length === 0 || paragraphs.every((paragraph) => paragraph.children.length === 0)) {
    return toPlainTextBlocks(text.plainText || fallbackText);
  }
  return paragraphs;
}

function createPowerPointParagraphNode(segment: TextSegment): ParagraphNode {
  const align = normalizePowerPointTextAlign(segment.style.align);
  const lineHeight = normalizeLineHeight(segment.style.lineSpacing);
  return {
    type: "paragraph",
    id: createId("p"),
    children: [],
    ...(align ? { align } : {}),
    ...(lineHeight ? { lineHeight } : {}),
  };
}

function normalizePowerPointTextAlign(value: string | undefined): TextAlign | undefined {
  switch (value) {
    case "left":
    case "center":
    case "right":
    case "justify":
      return value;
    case "ctr":
      return "center";
    case "r":
      return "right";
    case "justLow":
    case "dist":
    case "thaiDist":
      return "justify";
    default:
      return undefined;
  }
}

function powerPointBulletPrefix(segment: TextSegment, autoNumberCounters: Map<string, number>): string | null {
  const bullet = segment.bulletInfo;
  if (!bullet || bullet.none) {
    return null;
  }

  const level = Math.min(8, Math.max(0, Math.trunc(segment.paragraphLevel ?? 0)));
  const indent = "  ".repeat(level);
  if (bullet.char) {
    return `${indent}${bullet.char} `;
  }
  if (bullet.autoNumType) {
    const key = `${level}:${bullet.autoNumType}`;
    const nextNumber = autoNumberCounters.get(key) ?? Math.max(1, Math.trunc(bullet.autoNumStartAt ?? 1));
    autoNumberCounters.set(key, nextNumber + 1);
    return `${indent}${formatPowerPointAutoNumber(bullet.autoNumType, nextNumber)}`;
  }
  if (bullet.imageRelId || bullet.imageDataUrl) {
    return `${indent}* `;
  }
  return `${indent}• `;
}

function powerPointBulletPrefixStyle(segment: TextSegment): PowerPointInlineStyle {
  const bullet = segment.bulletInfo;
  return {
    ...(bullet?.color ? { color: bullet.color } : {}),
    ...(bullet?.fontFamily ? { fontFamily: bullet.fontFamily } : {}),
    ...(bullet?.sizePts ? { fontSize: round(bullet.sizePts) } : {}),
  };
}

function formatPowerPointAutoNumber(autoNumType: string, seqNum: number): string {
  switch (autoNumType) {
    case "arabicPeriod":
    case "arabicDbPeriod":
      return `${seqNum}. `;
    case "arabicParenR":
      return `${seqNum}) `;
    case "arabicParenBoth":
      return `(${seqNum}) `;
    case "arabicPlain":
    case "arabicDbPlain":
      return `${seqNum} `;
    case "alphaLcPeriod":
      return `${toPowerPointAlpha(seqNum, false)}. `;
    case "alphaUcPeriod":
      return `${toPowerPointAlpha(seqNum, true)}. `;
    case "alphaLcParenR":
      return `${toPowerPointAlpha(seqNum, false)}) `;
    case "alphaUcParenR":
      return `${toPowerPointAlpha(seqNum, true)}) `;
    case "alphaLcParenBoth":
      return `(${toPowerPointAlpha(seqNum, false)}) `;
    case "alphaUcParenBoth":
      return `(${toPowerPointAlpha(seqNum, true)}) `;
    case "romanLcPeriod":
      return `${toPowerPointRoman(seqNum, false)}. `;
    case "romanUcPeriod":
      return `${toPowerPointRoman(seqNum, true)}. `;
    case "romanLcParenR":
      return `${toPowerPointRoman(seqNum, false)}) `;
    case "romanUcParenR":
      return `${toPowerPointRoman(seqNum, true)}) `;
    case "romanLcParenBoth":
      return `(${toPowerPointRoman(seqNum, false)}) `;
    case "romanUcParenBoth":
      return `(${toPowerPointRoman(seqNum, true)}) `;
    default:
      return `${seqNum}. `;
  }
}

function toPowerPointAlpha(value: number, upper: boolean): string {
  let remaining = Math.max(1, Math.trunc(value));
  let result = "";
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode((upper ? 65 : 97) + (remaining % 26)) + result;
    remaining = Math.trunc(remaining / 26);
  }
  return result;
}

function toPowerPointRoman(value: number, upper: boolean): string {
  const romanValues = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const romanNumerals = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"];
  let remaining = Math.max(1, Math.min(Math.trunc(value), 3999));
  let result = "";
  for (let index = 0; index < romanValues.length; index += 1) {
    const romanValue = romanValues[index]!;
    while (remaining >= romanValue) {
      result += romanNumerals[index]!;
      remaining -= romanValue;
    }
  }
  return upper ? result : result.toLowerCase();
}

/**
 * A PowerPoint soft line break (`a:br`) stays inside its paragraph. The overlay
 * line model counts "one line per block plus one per `\n`", so the break is
 * carried as a newline inside the run rather than as a node of its own.
 */
function appendInlineTextToParagraph(
  paragraph: ParagraphNode,
  rawText: string,
  style: PowerPointInlineStyle,
): void {
  if (!rawText) {
    return;
  }
  paragraph.children.push({
    type: "text",
    text: rawText,
    ...(style.marks && style.marks.length > 0 ? { marks: style.marks } : {}),
    ...(style.color ? { color: style.color } : {}),
    ...(style.backgroundColor ? { backgroundColor: style.backgroundColor } : {}),
    ...(style.fontFamily ? { fontFamily: style.fontFamily } : {}),
    ...(style.fontSize !== undefined ? { fontSize: style.fontSize } : {}),
  });
}

function normalizeCustomGeometrySubpathToBounds(
  subpath: NonNullable<PowerPointSourceCustomGeometry["subpaths"]>[number],
  customGeometry: PowerPointSourceCustomGeometry,
  bounds: SlideRenderShape["bounds"],
): Array<{ x: number; y: number }> {
  const pathWidth = subpath.pathWidth ?? customGeometry.pathWidth;
  const pathHeight = subpath.pathHeight ?? customGeometry.pathHeight;
  if (pathWidth && pathHeight && pathWidth > 0 && pathHeight > 0) {
    return subpath.points.map((point) => ({
      x: (point.x / pathWidth) * Math.max(1, bounds.w),
      y: (point.y / pathHeight) * Math.max(1, bounds.h),
    }));
  }
  return normalizePointsToBounds(subpath.points, bounds);
}

/**
 * The point size a run renders at. Both parse paths hand this function points
 * already - the XML fallback reads `a:rPr/@sz / 100`, and the library path is
 * restated by `pptxTextElementInPoints` at the source-shape boundary - so the
 * nominal size passes straight through. Do not add a unit conversion here: the
 * unit belongs to the boundary, and duplicating it would double-convert one path.
 *
 * `normAutofit` shrinks text to fit its box, and that factor has to come with it.
 */
function powerPointRenderedFontSizePt(style: TextSegment["style"] | undefined): number | undefined {
  const fontSize = style?.fontSize;
  if (!fontSize || !Number.isFinite(fontSize) || fontSize <= 0) {
    return undefined;
  }
  const scale = style?.autoFitFontScale;
  const scaled = scale !== undefined && Number.isFinite(scale) && scale > 0 && scale <= 1
    ? fontSize * scale
    : fontSize;
  return round(scaled);
}

function powerPointTextSegmentStyle(segment: TextSegment): PowerPointInlineStyle {
  const marks: TextMark[] = [];
  const style = segment.style;
  if (style.bold) marks.push("bold");
  if (style.italic) marks.push("italic");
  if (style.underline || (style.underlineStyle && style.underlineStyle !== "none")) marks.push("underline");
  return {
    ...(marks.length > 0 ? { marks } : {}),
    ...(style.color ? { color: style.color } : {}),
    ...(style.highlightColor ? { backgroundColor: style.highlightColor } : {}),
    ...(style.fontFamily ? { fontFamily: style.fontFamily } : {}),
    ...(powerPointRenderedFontSizePt(style) !== undefined ? { fontSize: powerPointRenderedFontSizePt(style) } : {}),
  };
}

function getPowerPointTextPrimarySize(text: PowerPointSourceShape["text"] | undefined): OverlayTextSize | undefined {
  const fontSize = getPowerPointTextPrimaryFontSizePt(text);
  return fontSize ? fontSizeToOverlaySize(fontSize) : undefined;
}

function getPowerPointTextPrimaryFontSizePt(text: PowerPointSourceShape["text"] | undefined): number | undefined {
  return powerPointRenderedFontSizePt(text?.segments?.find((segment) => segment.style.fontSize)?.style);
}

function createOverlayTextLabelShape(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  parentId: string,
  size: OverlayTextSize,
): OverlayShape {
  return {
    id,
    type: "text",
    x: round(x),
    y: round(y),
    parentId,
    anchor: { type: "page" },
    props: {
      w: round(Math.max(1, w)),
      h: round(Math.max(1, h)),
      blocks: toPlainTextBlocks(text),
      color: "#111827",
      size,
    },
  };
}

function createOverlayLineShape(
  id: string,
  x: number,
  y: number,
  points: Array<{ x: number; y: number }>,
  parentId: string,
  color: string,
): OverlayShape {
  return {
    id,
    type: "line",
    x: round(x),
    y: round(y),
    parentId,
    anchor: { type: "page" },
    props: {
      kind: "polyline",
      points,
      closed: false,
      arrowheadStart: "none",
      arrowheadEnd: "none",
      fill: "none",
      color,
      labelColor: "#111827",
      dash: "solid",
      size: "s",
    },
  };
}

function getChartCategoryCount(chartData: PptxChartData): number {
  return Math.max(1, chartData.categories.length, ...chartData.series.map((series) => series.values.length));
}

function getChartValueBounds(chartData: PptxChartData): { min: number; max: number; range: number } {
  const values = chartData.series
    .flatMap((series) => series.values)
    .map(toChartNumber)
    .filter((value): value is number => value !== undefined);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;
  return { min, max, range };
}

function toChartNumber(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function chartValueToY(
  value: number,
  plot: { y: number; h: number },
  valueBounds: { min: number; max: number; range: number },
): number {
  return plot.y + ((valueBounds.max - value) / valueBounds.range) * plot.h;
}

function isLineChartType(chartType: string): boolean {
  return chartType === "line" || chartType === "line3D" || chartType === "scatter" || chartType === "radar";
}

function isPieChartType(chartType: string): boolean {
  return chartType === "pie" || chartType === "pie3D" || chartType === "doughnut" || chartType === "ofPie";
}

function getSmartArtDrawingBounds(shapes: PptxSmartArtDrawingShape[]): { x: number; y: number; w: number; h: number } | null {
  if (shapes.length === 0) {
    return null;
  }
  const left = Math.min(...shapes.map((shape) => shape.x));
  const top = Math.min(...shapes.map((shape) => shape.y));
  const right = Math.max(...shapes.map((shape) => shape.x + shape.width));
  const bottom = Math.max(...shapes.map((shape) => shape.y + shape.height));
  return {
    x: left,
    y: top,
    w: Math.max(1, right - left),
    h: Math.max(1, bottom - top),
  };
}

function powerPointTableToSigmaTable(
  table: PptxTableData,
  idPrefix: string,
  shapeWidth: number,
  shapeHeight: number,
): SigmaTableSpec {
  const columnCount = getPptxTableColumnCount(table);
  const columnWidthSum = table.columnWidths.reduce((sum, value) => sum + Math.max(0, value), 0);
  const columns = Array.from({ length: columnCount }, (_, index) => {
    const rawWidth = table.columnWidths[index];
    const fixedWidth = rawWidth !== undefined && columnWidthSum > 0
      ? Math.max(12, round(shapeWidth * (rawWidth / columnWidthSum)))
      : undefined;
    return {
      id: `${idPrefix}_col_${index + 1}`,
      width: fixedWidth ? { mode: "fixed" as const, value: fixedWidth } : { mode: "fr" as const, value: 1, min: 32 },
      ...(index === 0 && table.firstCol ? { role: "label" as const } : {}),
    };
  });
  const rowHeightSum = table.rows.reduce((sum, row) => sum + Math.max(0, row.height ?? 0), 0);
  const rowHeightScale = rowHeightSum > 0 ? shapeHeight / rowHeightSum : 1;
  const rows = table.rows.map((row, index) => {
    const fixedHeight = row.height ? Math.max(1, round(row.height * rowHeightScale)) : undefined;
    return {
      id: `${idPrefix}_row_${index + 1}`,
      height: fixedHeight
        ? { mode: "fixed" as const, value: fixedHeight }
        : { mode: "auto" as const, min: index === 0 && table.firstRowHeader ? 30 : 26 },
      role: index === 0 && table.firstRowHeader ? "header" as const : "body" as const,
    };
  });
  const defaultStyle = getDefaultTableCellStyle(table);

  return {
    version: 1,
    kind: "plain",
    columns,
    rows,
    cells: powerPointTableCellsToSigmaCells(table, idPrefix, rows, columns),
    grid: {
      borderColor: defaultStyle.borderColor,
      borderWidth: defaultStyle.borderWidth,
      borderStyle: defaultStyle.borderStyle,
      showOuterBorder: true,
      showInnerBorders: true,
    },
    defaultCellStyle: {
      align: defaultStyle.align,
      verticalAlign: defaultStyle.verticalAlign,
      paddingX: defaultStyle.paddingX,
      paddingY: defaultStyle.paddingY,
      color: defaultStyle.color,
      fontSize: defaultStyle.fontSize,
      fontWeight: defaultStyle.fontWeight,
    },
  };
}

function powerPointTableCellsToSigmaCells(
  table: PptxTableData,
  idPrefix: string,
  rows: SigmaTableSpec["rows"],
  columns: SigmaTableSpec["columns"],
): SigmaTableSpec["cells"] {
  return rows.flatMap((row, rowIndex) => {
    const pptxRow = table.rows[rowIndex];
    if (!pptxRow) {
      return [];
    }
    const cells: SigmaTableSpec["cells"] = [];
    let columnIndex = 0;
    for (let cellIndex = 0; cellIndex < pptxRow.cells.length && columnIndex < columns.length; cellIndex += 1) {
      const pptxCell = pptxRow.cells[cellIndex]!;
      const colSpan = Math.max(1, pptxCell.gridSpan ?? 1);
      const rowSpan = Math.max(1, pptxCell.rowSpan ?? 1);
      if (!pptxCell.hMerge && !pptxCell.vMerge) {
        const cellId = `${idPrefix}_cell_${rowIndex + 1}_${columnIndex + 1}`;
        cells.push({
          id: cellId,
          rowId: row.id,
          columnId: columns[columnIndex]!.id,
          ...(colSpan > 1 ? { colSpan } : {}),
          ...(rowSpan > 1 ? { rowSpan } : {}),
          content: powerPointTableCellContent(pptxCell.text, cellId, pptxCell.style),
          style: powerPointTableCellStyleToSigmaCellStyle(pptxCell.style),
        });
      }
      columnIndex += pptxCell.hMerge ? 0 : colSpan;
    }
    return cells;
  });
}

function powerPointTableCellContent(
  text: string,
  idPrefix: string,
  style: PptxTableCellStyle | undefined,
): SigmaTableSpec["cells"][number]["content"] {
  const lines = text.split(/\r?\n/u);
  const paragraphs = (lines.length > 0 ? lines : [""]).map((line, index) => ({
    type: "paragraph" as const,
    id: `${idPrefix}_p_${index + 1}`,
    children: powerPointTableTextToInlineNodes(line, style),
    ...(style?.align ? { align: style.align } : {}),
  }));
  return paragraphs;
}

function powerPointTableTextToInlineNodes(text: string, style: PptxTableCellStyle | undefined): InlineNode[] {
  if (!text) {
    return [];
  }
  const marks = [
    ...(style?.bold ? ["bold" as const] : []),
    ...(style?.italic ? ["italic" as const] : []),
    ...(style?.underline ? ["underline" as const] : []),
  ];
  return [{
    type: "text",
    text,
    ...(marks.length > 0 ? { marks } : {}),
    ...(style?.color ? { color: style.color } : {}),
    ...(style?.fontSize ? { fontSize: round(style.fontSize) } : {}),
  }];
}

function powerPointTableCellStyleToSigmaCellStyle(style: PptxTableCellStyle | undefined): SigmaTableSpec["cells"][number]["style"] {
  if (!style) {
    return undefined;
  }
  const result: NonNullable<SigmaTableSpec["cells"][number]["style"]> = {};
  if (style.align) result.align = style.align;
  if (style.vAlign) result.verticalAlign = style.vAlign;
  if (style.color) result.color = style.color;
  if (style.backgroundColor) result.backgroundColor = style.backgroundColor;
  if (style.fontSize) result.fontSize = round(style.fontSize);
  if (style.bold) result.fontWeight = "bold";
  const horizontalMargins = [style.marginLeft, style.marginRight].filter((value): value is number => typeof value === "number");
  const verticalMargins = [style.marginTop, style.marginBottom].filter((value): value is number => typeof value === "number");
  if (horizontalMargins.length > 0) result.paddingX = round(Math.max(...horizontalMargins));
  if (verticalMargins.length > 0) result.paddingY = round(Math.max(...verticalMargins));
  return Object.keys(result).length > 0 ? result : undefined;
}

function getDefaultTableCellStyle(table: PptxTableData): {
  align: NonNullable<SigmaTableSpec["defaultCellStyle"]["align"]>;
  verticalAlign: NonNullable<SigmaTableSpec["defaultCellStyle"]["verticalAlign"]>;
  paddingX: number;
  paddingY: number;
  color: string;
  fontSize: number;
  fontWeight: NonNullable<SigmaTableSpec["defaultCellStyle"]["fontWeight"]>;
  borderColor: string;
  borderWidth: number;
  borderStyle: NonNullable<SigmaTableSpec["grid"]["borderStyle"]>;
} {
  const firstStyle = table.rows.flatMap((row) => row.cells.map((cell) => cell.style)).find(Boolean);
  return {
    align: firstStyle?.align ?? "center",
    verticalAlign: firstStyle?.vAlign ?? "middle",
    paddingX: round(Math.max(firstStyle?.marginLeft ?? 6, firstStyle?.marginRight ?? 6)),
    paddingY: round(Math.max(firstStyle?.marginTop ?? 4, firstStyle?.marginBottom ?? 4)),
    color: firstStyle?.color ?? "#111827",
    fontSize: round(firstStyle?.fontSize ?? 13),
    fontWeight: firstStyle?.bold ? "bold" : "normal",
    borderColor: firstStyle?.borderColor ?? firstStyle?.borderTopColor ?? firstStyle?.borderBottomColor ?? firstStyle?.borderLeftColor ?? firstStyle?.borderRightColor ?? "#111827",
    borderWidth: round(firstStyle?.borderTopWidth ?? firstStyle?.borderBottomWidth ?? firstStyle?.borderLeftWidth ?? firstStyle?.borderRightWidth ?? 1),
    borderStyle: toSigmaTableBorderStyle(firstStyle?.borderDash ?? firstStyle?.borderTopDash ?? firstStyle?.borderBottomDash ?? firstStyle?.borderLeftDash ?? firstStyle?.borderRightDash),
  };
}

function toSigmaTableBorderStyle(value: string | undefined): NonNullable<SigmaTableSpec["grid"]["borderStyle"]> {
  if (!value || value === "solid") {
    return "solid";
  }
  if (value.includes("dot")) {
    return "dotted";
  }
  return "dashed";
}

function powerPointShapeId(slideIndex: number, shape: PowerPointSourceShape): string {
  return powerPointShapeIdFromSourceId(slideIndex, shape.sourceId || shape.name || `${shape.zIndex + 1}`);
}

function powerPointShapeIdFromSourceId(slideIndex: number, sourceId: string): string {
  return `ppt_shape_${slideIndex + 1}_${sanitizeId(sourceId)}`;
}

/**
 * The 0-based slide an imported shape id was minted for, or `undefined` if the id
 * did not come from this importer.
 *
 * This is the exact inverse of `powerPointShapeIdFromSourceId` above and must move
 * with it. It exists so the fidelity harness can attribute an imported shape to its
 * source slide from recorded provenance rather than inferring it from geometry:
 * `Math.floor(shape.y / stride)` is wrong for any shape authored outside its slide
 * bounds (pasteboard content) and for group children, and inferring it produced both
 * phantom "missing object" reports and, worse, missed genuinely dropped objects.
 *
 * Generated children append suffixes to their parent's id (`..._outer`, `..._ring_1`),
 * so they keep the prefix and resolve to the same slide.
 */
export function readPowerPointShapeSlideIndex(shapeId: string): number | undefined {
  const match = /^ppt_shape_(\d+)_/u.exec(shapeId);
  if (!match) {
    return undefined;
  }
  const oneBased = Number(match[1]);
  return Number.isInteger(oneBased) && oneBased >= 1 ? oneBased - 1 : undefined;
}

function powerPointAssetId(slideIndex: number, shape: PowerPointSourceShape): string {
  return `ppt_asset_${slideIndex + 1}_${sanitizeId(shape.sourceId || shape.name || `${shape.zIndex + 1}`)}`;
}

function powerPointRenderedAssetId(slideIndex: number, shape: PowerPointSourceShape): string {
  return `ppt_rendered_asset_${slideIndex + 1}_${sanitizeId(shape.sourceId || shape.name || `${shape.zIndex + 1}`)}`;
}

function getPaddedObjectBounds(shape: SlideRenderShape): { x: number; y: number; w: number; h: number } {
  const strokePadding = shape.line?.noStroke ? 0 : Math.max(6, (shape.line?.widthPx ?? 1) * 2);
  const effectPadding = 12;
  const padding = Math.ceil(Math.max(strokePadding, effectPadding));
  return {
    x: Math.max(0, round(shape.bounds.x - padding)),
    y: Math.max(0, round(shape.bounds.y - padding)),
    w: Math.max(1, round(shape.bounds.w + padding * 2)),
    h: Math.max(1, round(shape.bounds.h + padding * 2)),
  };
}

function wrapRenderedObjectSvg(
  fragment: string,
  bounds: { x: number; y: number; w: number; h: number },
): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${round(bounds.w)}" height="${round(bounds.h)}" viewBox="${round(bounds.x)} ${round(bounds.y)} ${round(bounds.w)} ${round(bounds.h)}">`,
    fragment,
    "</svg>",
  ].join("");
}

async function readSlidePaths(zip: JSZip, presentation: XmlValue, presentationPath: string): Promise<string[]> {
  const rels = await readRelationships(zip, "ppt/_rels/presentation.xml.rels");
  const slideIdList = getRecord(presentation, "p:sldIdLst");
  const slideIds = asArray(slideIdList["p:sldId"]);
  const paths = slideIds
    .map((slideId) => {
      const relId = readAttr(slideId, "r:id");
      const rel = relId ? rels.get(relId) : undefined;
      return rel ? resolvePartPath(presentationPath, rel.target) : "";
    })
    .filter(Boolean);
  if (paths.length > 0) {
    return paths;
  }

  return Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
    .sort((a, b) => naturalCompare(a, b));
}

function readPresentationSlideSize(presentation: XmlValue): { width: number; height: number } {
  const sldSz = getRecord(presentation, "p:sldSz");
  return {
    width: readNumberAttr(sldSz, "cx") ?? DEFAULT_SLIDE_SIZE_EMU.width,
    height: readNumberAttr(sldSz, "cy") ?? DEFAULT_SLIDE_SIZE_EMU.height,
  };
}

function stripPptxZipPath(path: string): string {
  return path.replace(/^\/+/u, "");
}

function pxToEmu(px: number): number {
  return px * EMU_PER_PX;
}

function emuToMm(emu: number): number {
  return emu / EMU_PER_MM;
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(svg))}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function dataUrlMimeType(dataUrl: string | undefined): string | undefined {
  if (!dataUrl) {
    return undefined;
  }
  const match = /^data:([^;,]+)[;,]/u.exec(dataUrl);
  return match?.[1];
}

function isDataUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^data:[^;,]+[;,]/u.test(value);
}

function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}
