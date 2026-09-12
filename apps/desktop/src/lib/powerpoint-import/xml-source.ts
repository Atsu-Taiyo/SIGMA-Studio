
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import type  {
  PptxChartData,
  PptxSmartArtData,
  PptxSmartArtDrawingShape,
  PptxTableCellStyle,
  PptxTableData,
  TextSegment,
} from "pptx-viewer-core";


export const EMU_PER_INCH = 914400;

export const EMU_PER_PX = EMU_PER_INCH / 96;

export const CHART_SERIES_COLORS = ["#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47"];

export const DEFAULT_SCHEME_COLORS: Record<string, string> = {
  dk1: "#111111",
  lt1: "#ffffff",
  dk2: "#1f2937",
  lt2: "#f8fafc",
  accent1: "#4472C4",
  accent2: "#ED7D31",
  accent3: "#A5A5A5",
  accent4: "#FFC000",
  accent5: "#5B9BD5",
  accent6: "#70AD47",
  hlink: "#0563C1",
  folHlink: "#954F72",
};

export const DEFAULT_COLOR_MAP: Record<string, string> = {
  bg1: "lt1",
  tx1: "dk1",
  bg2: "lt2",
  tx2: "dk2",
};

export const OOXML_REPEATED_ELEMENT_NAMES = new Set([
  "Relationship",
  "Override",
  "Default",
  "p:sp",
  "p:pic",
  "p:cxnSp",
  "p:grpSp",
  "p:graphicFrame",
  "p:oleObj",
  "p:control",
  "p:video",
  "p:audio",
  "p14:media",
  "a:p",
  "a:r",
  "a:fld",
  "a:br",
  "a:gs",
  "a:gd",
  "a:cxn",
  "a:path",
  "a:moveTo",
  "a:lnTo",
  "a:quadBezTo",
  "a:cubicBezTo",
  "a:arcTo",
  "a:close",
  "a:pt",
  "a:tr",
  "a:tc",
  "a:gridCol",
  "c:ser",
  "c:pt",
  "c:dPt",
  "c:dLbl",
  "c:trendline",
  "c:errBars",
  "dgm:pt",
  "dgm:cxn",
]);


export const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (name, _jpath, _isLeafNode, isAttribute) => !isAttribute && OOXML_REPEATED_ELEMENT_NAMES.has(name),
});


export interface Relationship {
  id: string;
  type: string;
  target: string;
  targetMode?: string;
}


export interface PowerPointSourceShape {
  sourceId: string;
  parentSourceId?: string;
  name: string;
  kind:
    | "background"
    | "shape"
    | "line"
    | "connector"
    | "textBox"
    | "picture"
    | "table"
    | "group"
    | "chart"
    | "smartArt"
    | "ole"
    | "media"
    | "ink"
    | "zoom"
    | "model3d"
    | "unknown";
  geometry?: {
    preset?: string;
    raw?: string;
    adjustments?: Record<string, number>;
    custom?: PowerPointSourceCustomGeometry;
  };
  zIndex: number;
  bounds: {
    x: number;
    y: number;
    w: number;
    h: number;
    unit: "px";
  };
  boundsEmu: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  rotation?: number;
  skew?: {
    x?: number;
    y?: number;
  };
  flip?: {
    horizontal?: boolean;
    vertical?: boolean;
  };
  hidden?: boolean;
  opacity?: number;
  nonVisual?: PowerPointSourceNonVisualProperties;
  placeholder?: PowerPointSourcePlaceholder;
  line?: PowerPointSourceLineStyle;
  fill?: PowerPointSourceFillStyle;
  text?: {
    plainText: string;
    paragraphs: string[];
    style?: unknown;
    segments?: TextSegment[];
    inheritedPlaceholderStyle?: unknown;
  };
  picture?: {
    relationshipId?: string;
    target?: string;
    mimeType?: string;
    fileSize?: number;
    crop?: PowerPointSourceImageCrop;
    altText?: string;
    cropShape?: string;
    effects?: unknown;
    tile?: unknown;
  };
  background?: {
    type: "solid" | "image" | "gradient" | "pattern";
    color?: string;
    raw?: unknown;
  };
  table?: {
    data: PptxTableData;
    rowCount: number;
    columnCount: number;
  };
  chart?: {
    data: PptxChartData;
    chartType: string;
    categoryCount: number;
    seriesCount: number;
  };
  smartArt?: {
    data: PptxSmartArtData;
    layoutType?: string;
    nodeCount: number;
    drawingShapeCount: number;
  };
  ink?: {
    paths: Array<{
      path: string;
      color?: string;
      width?: number;
      opacity?: number;
    }>;
    tool?: string;
  };
  media?: {
    mediaType?: string;
    mediaPath?: string;
    mediaMimeType?: string;
    posterFramePath?: string;
    trimStartMs?: number;
    trimEndMs?: number;
    autoPlay?: boolean;
    loop?: boolean;
    volume?: number;
  };
  ole?: {
    objectType?: string;
    progId?: string;
    fileName?: string;
    mimeType?: string;
    byteSize?: number;
    showAsIcon?: boolean;
    isLinked?: boolean;
    externalPath?: string;
  };
  model3d?: {
    modelPath?: string;
    modelMimeType?: string;
    posterImage?: string;
  };
  inheritedFrom?: {
    kind: "slideMaster" | "slideLayout";
    path?: string;
    name?: string;
    masterPath?: string;
  };
  model?: {
    library: "pptx-viewer-core";
    elementId: string;
    elementType: string;
    hidden?: boolean;
    opacity?: number;
    skew?: {
      x?: number;
      y?: number;
    };
    actionClick?: unknown;
    actionHover?: unknown;
    locks?: unknown;
    extLstXml?: unknown;
    nonVisual?: PowerPointSourceNonVisualProperties;
    placeholder?: PowerPointSourcePlaceholder;
    shapeType?: string;
    shapeStyle?: unknown;
    shapeAdjustments?: unknown;
    adjustmentHandles?: unknown;
    connector?: unknown;
    textStyle?: unknown;
    textSegments?: unknown;
    textProperties?: unknown;
    tableData?: unknown;
    chartData?: unknown;
    smartArtData?: unknown;
    animations?: unknown;
    elementData?: unknown;
    rawXml?: unknown;
    imagePath?: string;
    crop?: PowerPointSourceImageCrop;
  };
  conversionCandidate?: PowerPointConversionCandidate;
  raw?: {
    drawingElement: string;
    xml?: unknown;
    relationships?: Array<{
      id: string;
      type: string;
      target: string;
      targetMode?: string;
      resolvedTarget?: string;
    }>;
  };
}


export interface PowerPointSourceLineStyle {
  color?: string;
  opacity?: number;
  widthPx?: number;
  dash?: string;
  beginArrow?: string;
  endArrow?: string;
  connectionStart?: PowerPointConnectorConnection;
  connectionEnd?: PowerPointConnectorConnection;
  noStroke?: boolean;
}


export interface PowerPointSourceNonVisualProperties {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  hidden?: boolean;
  macro?: string;
  decorative?: boolean;
  locks?: unknown;
  raw?: unknown;
}


export interface PowerPointSourcePlaceholder {
  type?: string;
  index?: string;
  size?: string;
  orientation?: string;
  hasCustomPrompt?: boolean;
  raw?: unknown;
}


export interface PowerPointConnectorConnection {
  shapeId?: string;
  targetSourceId?: string;
  connectionSiteIndex?: number;
  sigmaShapeId?: string;
}


export interface PowerPointSourceFillStyle {
  type: "none" | "solid" | "gradient" | "pattern" | "unknown";
  color?: string;
  opacity?: number;
  raw?: string;
  stops?: Array<{
    position?: number;
    color?: string;
    opacity?: number;
  }>;
  pattern?: {
    preset?: string;
    foregroundColor?: string;
    backgroundColor?: string;
  };
}


export interface PowerPointSourceImageCrop {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}


export interface PowerPointSourceCustomGeometry {
  pathData?: string;
  pathWidth?: number;
  pathHeight?: number;
  closed?: boolean;
  subpaths?: Array<{
    points: Array<{ x: number; y: number }>;
    closed: boolean;
    pathWidth?: number;
    pathHeight?: number;
  }>;
  pointCount?: number;
  approximatedCurve?: boolean;
  unsupportedCommands?: string[];
  guideList?: unknown;
  adjustHandles?: unknown;
  connectionSites?: unknown;
  textRect?: unknown;
  pathList?: unknown;
}


export interface PowerPointConversionCandidate {
  sigmaKind: "geo" | "arrow" | "line" | "polyline" | "arc" | "text" | "image" | "table" | "group" | "unsupported";
  confidence: "high" | "medium" | "low";
  reason: string;
}


export interface SlideRenderShape extends PowerPointSourceShape {
  imageDataUrl?: string;
}


export interface PowerPointColorContext {
  colorScheme: Record<string, string>;
  colorMap: Record<string, string>;
}


export async function collectSlideShapesWithXmlInheritance(
  zip: JSZip,
  slidePath: string,
  slideXml: string,
  spTree: XmlRecord,
  slideRels: Map<string, Relationship>,
  colorContext: PowerPointColorContext,
): Promise<SlideRenderShape[]> {
  const inheritedShapes: SlideRenderShape[] = [];
  const layoutRel = findRelationshipByType(slideRels, "slideLayout");
  const layoutPath = layoutRel ? resolvePartPath(slidePath, layoutRel.target) : undefined;
  const layoutXml = layoutPath ? await readZipText(zip, layoutPath) : null;
  const layoutRels = layoutPath ? await readRelationships(zip, relationshipPathForPart(layoutPath)) : new Map<string, Relationship>();
  const masterRel = findRelationshipByType(layoutRels, "slideMaster");
  const masterPath = layoutPath && masterRel ? resolvePartPath(layoutPath, masterRel.target) : undefined;
  const masterXml = masterPath ? await readZipText(zip, masterPath) : null;

  if (masterPath && masterXml) {
    const masterShapes = await collectShapesFromXmlPart(zip, masterPath, masterXml, colorContext);
    inheritedShapes.push(...tagInheritedXmlShapes(masterShapes, {
      kind: "slideMaster",
      path: masterPath,
      name: readCommonSlideDataName(masterXml),
    }, -2900));
  }
  if (layoutPath && layoutXml) {
    const layoutShapes = await collectShapesFromXmlPart(zip, layoutPath, layoutXml, colorContext);
    inheritedShapes.push(...tagInheritedXmlShapes(layoutShapes, {
      kind: "slideLayout",
      path: layoutPath,
      name: readCommonSlideDataName(layoutXml),
      masterPath,
    }, -1900));
  }
  const inheritedPlaceholderStyles = collectPlaceholderTextStyles(inheritedShapes);
  const slideShapes = await collectSlideShapes(zip, slidePath, slideXml, spTree, slideRels, colorContext);

  return [
    ...inheritedShapes,
    ...applyInheritedPlaceholderTextStyles(slideShapes, inheritedPlaceholderStyles),
  ];
}


export async function collectShapesFromXmlPart(
  zip: JSZip,
  partPath: string,
  xml: string,
  colorContext: PowerPointColorContext,
): Promise<SlideRenderShape[]> {
  const rels = await readRelationships(zip, relationshipPathForPart(partPath));
  const parsed = parseXmlRecord(xml);
  const root = getPowerPointSlideLikeRoot(parsed);
  const spTree = getRecord(getRecord(root, "p:cSld"), "p:spTree");
  return collectSlideShapes(zip, partPath, xml, spTree, rels, colorContext);
}


export function getPowerPointSlideLikeRoot(parsed: XmlRecord): XmlValue {
  return parsed["p:sld"] ?? parsed["p:sldLayout"] ?? parsed["p:sldMaster"] ?? {};
}


export function tagInheritedXmlShapes(
  shapes: SlideRenderShape[],
  inheritedFrom: NonNullable<PowerPointSourceShape["inheritedFrom"]>,
  zIndexOffset: number,
): SlideRenderShape[] {
  const sourceIdPrefix = `${inheritedFrom.kind}_${sanitizeId(inheritedFrom.path || inheritedFrom.name || "unknown")}`;
  return shapes.map((shape) => ({
    ...shape,
    sourceId: `${sourceIdPrefix}_${shape.sourceId}`,
    zIndex: zIndexOffset + shape.zIndex,
    inheritedFrom,
  }));
}


export function collectPlaceholderTextStyles(shapes: SlideRenderShape[]): Map<string, Record<string, unknown>> {
  const styles = new Map<string, Record<string, unknown>>();
  for (const shape of shapes) {
    const key = powerPointPlaceholderKey(shape.placeholder);
    if (!key || !shape.text?.segments?.length) {
      continue;
    }
    const style = shape.text.segments.find((segment) => Object.keys(segment.style ?? {}).length > 0)?.style;
    if (style && Object.keys(style).length > 0 && !styles.has(key)) {
      styles.set(key, { ...style });
    }
  }
  return styles;
}


export function applyInheritedPlaceholderTextStyles(
  shapes: SlideRenderShape[],
  inheritedStyles: Map<string, Record<string, unknown>>,
): SlideRenderShape[] {
  if (inheritedStyles.size === 0) {
    return shapes;
  }
  return shapes.map((shape) => {
    const key = powerPointPlaceholderKey(shape.placeholder);
    const inheritedStyle = key ? inheritedStyles.get(key) : undefined;
    if (!inheritedStyle || !shape.text?.segments?.length) {
      return shape;
    }
    return {
      ...shape,
      text: {
        ...shape.text,
        inheritedPlaceholderStyle: inheritedStyle,
        segments: shape.text.segments.map((segment) => ({
          ...segment,
          style: {
            ...inheritedStyle,
            ...segment.style,
          },
        })),
      },
    };
  });
}


export function powerPointPlaceholderKey(placeholder: PowerPointSourcePlaceholder | undefined): string | undefined {
  if (!placeholder) {
    return undefined;
  }
  return `${placeholder.type ?? "body"}:${placeholder.index ?? ""}`;
}


export function findRelationshipByType(relationships: Map<string, Relationship>, typeSuffix: string): Relationship | undefined {
  return [...relationships.values()].find((relationship) => relationship.type.endsWith(`/${typeSuffix}`));
}


export function readCommonSlideDataName(xml: string): string | undefined {
  const match = /<p:cSld\b[^>]*\bname="([^"]+)"/u.exec(xml);
  return match ? decodeXmlAttribute(match[1]!) : undefined;
}


export function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}


export function createPptxNonVisualMetadata(value: unknown): PowerPointSourceNonVisualProperties | undefined {
  const cNvPr = findFirstXmlRecordByKey(value, "p:cNvPr");
  if (!cNvPr) {
    return undefined;
  }
  const locks = findFirstXmlRecordByKeys(value, ["a:spLocks", "a:cxnSpLocks", "a:picLocks", "a:grpSpLocks", "a:graphicFrameLocks"]);
  return stripUndefinedFields({
    id: readAttr(cNvPr, "id"),
    name: readAttr(cNvPr, "name"),
    title: readAttr(cNvPr, "title"),
    description: readAttr(cNvPr, "descr"),
    hidden: readOptionalBooleanAttr(cNvPr, "hidden"),
    macro: readAttr(cNvPr, "macro"),
    decorative: readOptionalBooleanAttr(cNvPr, "decorative"),
    locks: locks ? jsonSafeValue(locks) : undefined,
    raw: jsonSafeValue(cNvPr),
  });
}


export function createPptxPlaceholderMetadata(value: unknown): PowerPointSourcePlaceholder | undefined {
  const placeholder = findFirstXmlRecordByKey(value, "p:ph");
  if (!placeholder) {
    return undefined;
  }
  return stripUndefinedFields({
    type: readAttr(placeholder, "type"),
    index: readAttr(placeholder, "idx"),
    size: readAttr(placeholder, "sz"),
    orientation: readAttr(placeholder, "orient"),
    hasCustomPrompt: readOptionalBooleanAttr(placeholder, "hasCustomPrompt"),
    raw: jsonSafeValue(placeholder),
  });
}


export function findFirstXmlRecordByKeys(value: unknown, keys: string[]): XmlRecord | undefined {
  for (const key of keys) {
    const found = findFirstXmlRecordByKey(value, key);
    if (found) {
      return found;
    }
  }
  return undefined;
}


export function findFirstXmlRecordByKey(value: unknown, key: string): XmlRecord | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findFirstXmlRecordByKey(child, key);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = value[key];
  if (isRecord(direct)) {
    return direct;
  }
  for (const child of Object.values(value)) {
    const found = findFirstXmlRecordByKey(child, key);
    if (found) {
      return found;
    }
  }
  return undefined;
}


export function getPptxTableColumnCount(table: PptxTableData): number {
  const widthCount = table.columnWidths.length;
  const rowCellCount = table.rows.reduce((max, row) => {
    let count = 0;
    for (const cell of row.cells) {
      if (cell.hMerge) {
        continue;
      }
      count += Math.max(1, cell.gridSpan ?? 1);
    }
    return Math.max(max, count);
  }, 0);
  return Math.max(1, widthCount, rowCellCount);
}


export async function readXmlChartData(
  zip: JSZip,
  slidePath: string,
  rels: Map<string, Relationship>,
  graphicData: XmlRecord,
  colorContext: PowerPointColorContext,
): Promise<PptxChartData | undefined> {
  const chartRelId = readAttr(getRecord(graphicData, "c:chart"), "r:id");
  const rel = chartRelId ? rels.get(chartRelId) : undefined;
  const chartPath = rel ? resolvePartPath(slidePath, rel.target) : undefined;
  const chartXml = chartPath ? await readZipText(zip, chartPath) : null;
  if (!chartXml) {
    return undefined;
  }
  const chartSpace = getRecord(parseXmlRecord(chartXml), "c:chartSpace");
  const chart = getRecord(chartSpace, "c:chart");
  const plotArea = getRecord(chart, "c:plotArea");
  const chartRels = chartPath ? await readRelationships(zip, relationshipPathForPart(chartPath)) : new Map<string, Relationship>();
  const chartNode = findFirstChartTypeNode(plotArea);
  if (!chartNode) {
    return undefined;
  }
  const series = asArray(chartNode.node["c:ser"])
    .map((ser, index) => readXmlChartSeries(getRecordFromValue(ser), index, colorContext))
    .filter((item): item is NonNullable<ReturnType<typeof readXmlChartSeries>> => Boolean(item));
  if (series.length === 0) {
    return undefined;
  }
  const categories = series.find((item) => item.categories.length > 0)?.categories ?? [];
  return {
    chartType: chartNode.chartType,
    title: readXmlChartTitle(getRecord(chart, "c:title")),
    categories,
    series: series.map((item) => stripUndefinedFields({
      name: item.name,
      values: item.values,
      color: item.color,
      marker: item.marker,
      dataPoints: item.dataPoints,
      dataLabels: item.dataLabels,
      trendlines: item.trendlines,
      errBars: item.errBars,
      explosion: item.explosion,
    })),
    colorPalette: series.map((item, index) => item.color ?? CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]!),
    grouping: readAttr(getRecord(chartNode.node, "c:grouping"), "val"),
    style: readXmlChartStyle(chart, plotArea),
    axes: readXmlChartAxes(plotArea),
    externalData: await readXmlChartExternalData(zip, chartPath, chart, chartRels),
    rawXml: chartXml,
    sourcePath: chartPath,
    chartPartPath: chartPath,
    chartRelationshipId: chartRelId,
  } as unknown as PptxChartData;
}


export function findFirstChartTypeNode(plotArea: XmlRecord): { chartType: string; node: XmlRecord } | undefined {
  const chartTypes = [
    ["c:barChart", "bar"],
    ["c:lineChart", "line"],
    ["c:pieChart", "pie"],
    ["c:doughnutChart", "doughnut"],
    ["c:scatterChart", "scatter"],
    ["c:areaChart", "area"],
    ["c:radarChart", "radar"],
    ["c:bubbleChart", "bubble"],
    ["c:bar3DChart", "bar3D"],
    ["c:line3DChart", "line3D"],
    ["c:pie3DChart", "pie3D"],
    ["c:area3DChart", "area3D"],
  ] as const;
  for (const [key, chartType] of chartTypes) {
    const node = getRecord(plotArea, key);
    if (Object.keys(node).length > 0) {
      return { chartType, node };
    }
  }
  return undefined;
}


export function readXmlChartSeries(
  series: XmlRecord,
  index: number,
  colorContext: PowerPointColorContext,
): {
  name: string;
  categories: string[];
  values: number[];
  color?: string;
  marker?: unknown;
  dataPoints?: unknown;
  dataLabels?: unknown;
  trendlines?: unknown;
  errBars?: unknown;
  explosion?: number;
} | null {
  const values = readXmlChartNumericValues(getRecord(series, "c:val"));
  if (values.length === 0) {
    return null;
  }
  const name = readXmlChartSeriesName(getRecord(series, "c:tx")) || `Series ${index + 1}`;
  return stripUndefinedFields({
    name,
    categories: readXmlChartCategoryValues(getRecord(series, "c:cat")),
    values,
    color: readXmlChartSeriesColor(series, colorContext),
    marker: readXmlChartMarker(getRecord(series, "c:marker"), colorContext),
    dataPoints: readXmlChartDataPoints(series, colorContext),
    dataLabels: readXmlChartDataLabels(getRecord(series, "c:dLbls")),
    trendlines: readXmlChartTrendlines(series, colorContext),
    errBars: readXmlChartErrBars(series),
    explosion: readNumberAttr(getRecord(series, "c:explosion"), "val"),
  });
}


export function readXmlChartTitle(title: XmlRecord): string | undefined {
  const text = collectChartTextValues(title).join("") || collectDrawingTextValues(title).join("");
  return text || undefined;
}


export function readXmlChartSeriesName(tx: XmlRecord): string | undefined {
  return collectChartTextValues(tx).join("") || collectDrawingTextValues(tx).join("") || undefined;
}


export function readXmlChartCategoryValues(cat: XmlRecord): string[] {
  const strings = collectChartTextValues(cat);
  if (strings.length > 0) {
    return strings;
  }
  return readXmlChartNumericValues(cat).map((value) => String(value));
}


export function readXmlChartNumericValues(container: XmlRecord): number[] {
  return collectChartPointValues(container)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}


export function collectChartTextValues(container: XmlValue): string[] {
  return collectChartPointValues(container).filter((value) => value.length > 0);
}


export function collectChartPointValues(container: XmlValue): string[] {
  const values: string[] = [];
  const visit = (value: XmlValue): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const point = value["c:pt"];
    if (point !== undefined) {
      for (const item of asArray(point)) {
        const text = readXmlTextValue(getRecordFromValue(item)["c:v"]);
        if (text) {
          values.push(text);
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "c:pt") {
        continue;
      }
      if (key.startsWith("@_")) {
        continue;
      }
      visit(child);
    }
  };
  visit(container);
  return values;
}


export function readXmlChartSeriesColor(series: XmlRecord, colorContext: PowerPointColorContext): string | undefined {
  const shapeProperties = getRecord(series, "c:spPr");
  return readColor(shapeProperties, colorContext);
}


export function readXmlChartShapeProps(node: XmlRecord, colorContext: PowerPointColorContext): Record<string, unknown> | undefined {
  if (Object.keys(node).length === 0) {
    return undefined;
  }
  const line = readLineStyle(getRecord(node, "a:ln"), colorContext);
  const fill = readFillStyle(node, colorContext);
  const props = stripUndefinedFields({
    fillColor: fill?.type === "solid" ? fill.color : undefined,
    strokeColor: line?.color,
    strokeWidth: line?.widthPx,
    strokeDashStyle: line?.dash,
  });
  return Object.keys(props).length > 0 ? props : undefined;
}


export function readXmlChartMarker(marker: XmlRecord, colorContext: PowerPointColorContext): Record<string, unknown> | undefined {
  if (Object.keys(marker).length === 0) {
    return undefined;
  }
  const result = stripUndefinedFields({
    symbol: readAttr(getRecord(marker, "c:symbol"), "val") ?? "auto",
    size: readNumberAttr(getRecord(marker, "c:size"), "val"),
    spPr: readXmlChartShapeProps(getRecord(marker, "c:spPr"), colorContext),
  });
  return Object.keys(result).length > 0 ? result : undefined;
}


export function readXmlChartDataPoints(series: XmlRecord, colorContext: PowerPointColorContext): unknown[] | undefined {
  const dataPoints = asArray(series["c:dPt"])
    .map((value) => {
      const point = getRecordFromValue(value);
      return stripUndefinedFields({
        idx: readNumberAttr(getRecord(point, "c:idx"), "val"),
        spPr: readXmlChartShapeProps(getRecord(point, "c:spPr"), colorContext),
        explosion: readNumberAttr(getRecord(point, "c:explosion"), "val"),
        invertIfNegative: readOptionalBooleanAttr(getRecord(point, "c:invertIfNegative"), "val"),
        marker: readXmlChartMarker(getRecord(point, "c:marker"), colorContext),
      });
    })
    .filter((point) => point.idx !== undefined || Object.keys(point).length > 0);
  return dataPoints.length > 0 ? dataPoints : undefined;
}


export function readXmlChartDataLabels(labels: XmlRecord): unknown[] | undefined {
  const dataLabels = asArray(labels["c:dLbl"])
    .map((value) => {
      const label = getRecordFromValue(value);
      return stripUndefinedFields({
        idx: readNumberAttr(getRecord(label, "c:idx"), "val"),
        showVal: readOptionalBooleanAttr(getRecord(label, "c:showVal"), "val"),
        showCatName: readOptionalBooleanAttr(getRecord(label, "c:showCatName"), "val"),
        showSerName: readOptionalBooleanAttr(getRecord(label, "c:showSerName"), "val"),
        showPercent: readOptionalBooleanAttr(getRecord(label, "c:showPercent"), "val"),
        showLegendKey: readOptionalBooleanAttr(getRecord(label, "c:showLegendKey"), "val"),
        showBubbleSize: readOptionalBooleanAttr(getRecord(label, "c:showBubbleSize"), "val"),
        position: readAttr(getRecord(label, "c:dLblPos"), "val"),
        text: readXmlChartTitle(getRecord(label, "c:tx")),
      });
    })
    .filter((label) => label.idx !== undefined || Object.keys(label).length > 0);
  return dataLabels.length > 0 ? dataLabels : undefined;
}


export function readXmlChartDataLabelOptions(labels: XmlRecord): Record<string, unknown> | undefined {
  if (Object.keys(labels).length === 0) {
    return undefined;
  }
  const result = stripUndefinedFields({
    showValue: readOptionalBooleanAttr(getRecord(labels, "c:showVal"), "val"),
    showCategory: readOptionalBooleanAttr(getRecord(labels, "c:showCatName"), "val"),
    showSeriesName: readOptionalBooleanAttr(getRecord(labels, "c:showSerName"), "val"),
    showPercent: readOptionalBooleanAttr(getRecord(labels, "c:showPercent"), "val"),
    showLegendKey: readOptionalBooleanAttr(getRecord(labels, "c:showLegendKey"), "val"),
    position: readAttr(getRecord(labels, "c:dLblPos"), "val"),
  });
  return Object.keys(result).length > 0 ? result : undefined;
}


export function readXmlChartTrendlines(series: XmlRecord, colorContext: PowerPointColorContext): unknown[] | undefined {
  const trendlines = asArray(series["c:trendline"])
    .map((value) => {
      const trendline = getRecordFromValue(value);
      const shapeProps = readXmlChartShapeProps(getRecord(trendline, "c:spPr"), colorContext);
      return stripUndefinedFields({
        trendlineType: readAttr(getRecord(trendline, "c:trendlineType"), "val") ?? "linear",
        order: readNumberAttr(getRecord(trendline, "c:order"), "val"),
        period: readNumberAttr(getRecord(trendline, "c:period"), "val"),
        forward: readNumberAttr(getRecord(trendline, "c:forward"), "val"),
        backward: readNumberAttr(getRecord(trendline, "c:backward"), "val"),
        intercept: readNumberAttr(getRecord(trendline, "c:intercept"), "val"),
        displayRSq: readOptionalBooleanAttr(getRecord(trendline, "c:dispRSqr"), "val"),
        displayEq: readOptionalBooleanAttr(getRecord(trendline, "c:dispEq"), "val"),
        color: typeof shapeProps?.strokeColor === "string" ? shapeProps.strokeColor : undefined,
        spPr: shapeProps,
      });
    })
    .filter((trendline) => Object.keys(trendline).length > 0);
  return trendlines.length > 0 ? trendlines : undefined;
}


export function readXmlChartErrBars(series: XmlRecord): unknown[] | undefined {
  const errBars = asArray(series["c:errBars"])
    .map((value) => {
      const err = getRecordFromValue(value);
      return stripUndefinedFields({
        direction: readAttr(getRecord(err, "c:errDir"), "val"),
        barType: readAttr(getRecord(err, "c:errBarType"), "val"),
        valType: readAttr(getRecord(err, "c:errValType"), "val"),
        val: readNumberAttr(getRecord(err, "c:val"), "val"),
      });
    })
    .filter((err) => Object.keys(err).length > 0);
  return errBars.length > 0 ? errBars : undefined;
}


export function readXmlChartStyle(chart: XmlRecord, plotArea: XmlRecord): Record<string, unknown> | undefined {
  const legend = getRecord(chart, "c:legend");
  const title = getRecord(chart, "c:title");
  const chartTypeNode = findFirstChartTypeNode(plotArea)?.node;
  const dataLabelOptions = chartTypeNode ? readXmlChartDataLabelOptions(findXmlChartDataLabelNode(chartTypeNode)) : undefined;
  const style = stripUndefinedFields({
    hasLegend: Object.keys(legend).length > 0,
    legendPosition: readAttr(getRecord(legend, "c:legendPos"), "val"),
    hasTitle: Object.keys(title).length > 0,
    hasGridlines: chartPlotAreaHasGridlines(plotArea) || undefined,
    hasDataLabels: dataLabelOptions ? true : undefined,
    dataLabels: dataLabelOptions,
  });
  return Object.keys(style).length > 0 ? style : undefined;
}


export function findXmlChartDataLabelNode(chartTypeNode: XmlRecord): XmlRecord {
  const direct = getRecord(chartTypeNode, "c:dLbls");
  if (Object.keys(direct).length > 0) {
    return direct;
  }
  for (const series of asArray(chartTypeNode["c:ser"])) {
    const labels = getRecord(getRecordFromValue(series), "c:dLbls");
    if (Object.keys(labels).length > 0) {
      return labels;
    }
  }
  return {};
}


export function chartPlotAreaHasGridlines(plotArea: XmlRecord): boolean {
  return ["c:catAx", "c:valAx", "c:dateAx", "c:serAx"].some((axisKey) =>
    asArray(plotArea[axisKey]).some((axis) => {
      const node = getRecordFromValue(axis);
      return hasXmlKey(node, "c:majorGridlines") || hasXmlKey(node, "c:minorGridlines");
    }),
  );
}


export function readXmlChartAxes(plotArea: XmlRecord): unknown[] | undefined {
  const axes = [
    ...asArray(plotArea["c:catAx"]).map((axis) => readXmlChartAxis("catAx", getRecordFromValue(axis))),
    ...asArray(plotArea["c:valAx"]).map((axis) => readXmlChartAxis("valAx", getRecordFromValue(axis))),
    ...asArray(plotArea["c:dateAx"]).map((axis) => readXmlChartAxis("dateAx", getRecordFromValue(axis))),
    ...asArray(plotArea["c:serAx"]).map((axis) => readXmlChartAxis("serAx", getRecordFromValue(axis))),
  ].filter((axis) => Object.keys(axis).length > 1);
  return axes.length > 0 ? axes : undefined;
}


export function readXmlChartAxis(axisType: "catAx" | "valAx" | "dateAx" | "serAx", axis: XmlRecord): Record<string, unknown> {
  const scaling = getRecord(axis, "c:scaling");
  const numFmt = getRecord(axis, "c:numFmt");
  return stripUndefinedFields({
    axisType,
    axisId: readNumberAttr(getRecord(axis, "c:axId"), "val"),
    crossAxisId: readNumberAttr(getRecord(axis, "c:crossAx"), "val"),
    axPos: readAttr(getRecord(axis, "c:axPos"), "val"),
    numFmt: Object.keys(numFmt).length > 0 ? stripUndefinedFields({
      formatCode: readAttr(numFmt, "formatCode"),
      sourceLinked: readOptionalBooleanAttr(numFmt, "sourceLinked"),
    }) : undefined,
    min: readNumberAttr(getRecord(scaling, "c:min"), "val"),
    max: readNumberAttr(getRecord(scaling, "c:max"), "val"),
    logBase: readNumberAttr(getRecord(scaling, "c:logBase"), "val"),
    logScale: hasXmlKey(scaling, "c:logBase") || undefined,
    majorUnit: readNumberAttr(getRecord(axis, "c:majorUnit"), "val"),
    minorUnit: readNumberAttr(getRecord(axis, "c:minorUnit"), "val"),
    tickLblPos: readAttr(getRecord(axis, "c:tickLblPos"), "val"),
    deleted: readOptionalBooleanAttr(getRecord(axis, "c:delete"), "val"),
    majorGridlines: hasXmlKey(axis, "c:majorGridlines") || undefined,
    minorGridlines: hasXmlKey(axis, "c:minorGridlines") || undefined,
    titleText: readXmlChartTitle(getRecord(axis, "c:title")),
  });
}


export async function readXmlChartExternalData(
  zip: JSZip,
  chartPath: string | undefined,
  chartSpace: XmlRecord,
  chartRels: Map<string, Relationship>,
): Promise<Record<string, unknown> | undefined> {
  const externalData = getRecord(chartSpace, "c:externalData");
  const relId = readAttr(externalData, "r:id");
  if (!relId || !chartPath) {
    return undefined;
  }
  const rel = chartRels.get(relId);
  const targetPath = rel
    ? rel.targetMode === "External" ? rel.target : resolvePartPath(chartPath, rel.target)
    : undefined;
  const embeddedBytes = targetPath && rel?.targetMode !== "External"
    ? await zip.file(targetPath)?.async("uint8array")
    : undefined;
  return stripUndefinedFields({
    relId,
    targetPath,
    autoUpdate: readOptionalBooleanAttr(getRecord(externalData, "c:autoUpdate"), "val"),
    embeddedWorkbookData: embeddedBytes,
    embeddedWorkbookByteLength: embeddedBytes?.byteLength,
  });
}


export function collectDrawingTextValues(container: XmlValue): string[] {
  const values: string[] = [];
  const visit = (value: XmlValue): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const text = readXmlTextValue(value["a:t"]);
    if (text) {
      values.push(text);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("@_") || key === "a:t") {
        continue;
      }
      visit(child);
    }
  };
  visit(container);
  return values;
}


export async function readXmlSmartArtData(
  zip: JSZip,
  slidePath: string,
  rels: Map<string, Relationship>,
  graphicData: XmlRecord,
): Promise<PptxSmartArtData | undefined> {
  const dataRelId = readAttr(getRecord(graphicData, "dgm:relIds"), "r:dm");
  const layoutRelId = readAttr(getRecord(graphicData, "dgm:relIds"), "r:lo");
  const drawingRelId = readAttr(getRecord(graphicData, "dgm:relIds"), "r:dr");
  const colorsRelId = readAttr(getRecord(graphicData, "dgm:relIds"), "r:cs");
  const styleRelId = readAttr(getRecord(graphicData, "dgm:relIds"), "r:qs");
  const dataRel = dataRelId ? rels.get(dataRelId) : undefined;
  const layoutRel = layoutRelId ? rels.get(layoutRelId) : undefined;
  const drawingRel = drawingRelId ? rels.get(drawingRelId) : undefined;
  const colorsRel = colorsRelId ? rels.get(colorsRelId) : undefined;
  const styleRel = styleRelId ? rels.get(styleRelId) : undefined;
  const dataPath = dataRel ? resolvePartPath(slidePath, dataRel.target) : undefined;
  const dataXml = dataPath ? await readZipText(zip, dataPath) : null;
  if (!dataXml) {
    return undefined;
  }
  const dataModel = getRecord(parseXmlRecord(dataXml), "dgm:dataModel");
  const nodes = readXmlSmartArtNodes(dataModel);
  if (nodes.length === 0) {
    return undefined;
  }
  const layoutPath = layoutRel ? resolvePartPath(slidePath, layoutRel.target) : undefined;
  const drawingPath = drawingRel ? resolvePartPath(slidePath, drawingRel.target) : undefined;
  const colorsPath = colorsRel ? resolvePartPath(slidePath, colorsRel.target) : undefined;
  const stylePath = styleRel ? resolvePartPath(slidePath, styleRel.target) : undefined;
  const layoutXml = layoutPath ? await readZipText(zip, layoutPath) : null;
  const layoutType = layoutPath ? smartArtLayoutTypeFromPath(layoutPath) : undefined;
  return stripUndefinedFields({
    layoutType,
    resolvedLayoutType: layoutType,
    nodes,
    connections: readXmlSmartArtConnections(dataModel),
    drawingShapes: drawingPath ? await readXmlSmartArtDrawingShapes(zip, drawingPath) : undefined,
    layout: layoutXml && layoutPath ? readXmlSmartArtLayout(layoutXml, layoutPath) : undefined,
    colorTransform: colorsPath ? await readXmlSmartArtColorTransform(zip, colorsPath) : undefined,
    quickStyle: stylePath ? await readXmlSmartArtQuickStyle(zip, stylePath) : undefined,
    dataRelId,
    drawingRelId,
    colorsRelId,
    styleRelId,
    rawXml: dataXml,
    sourcePath: dataPath,
    drawingPath,
    layoutPath,
    colorsPath,
    stylePath,
  }) as unknown as PptxSmartArtData;
}


export function readXmlSmartArtLayout(xml: string, path: string): Record<string, unknown> | undefined {
  const layout = getRecord(parseXmlRecord(xml), "dgm:layoutDef");
  const result = stripUndefinedFields({
    name: readAttr(layout, "title") ?? readAttr(layout, "uniqueId") ?? smartArtLayoutTypeFromPath(path),
    uniqueId: readAttr(layout, "uniqueId"),
    minVersion: readAttr(layout, "minVer"),
    category: readAttr(layout, "cat"),
    rawXml: xml,
    sourcePath: path,
  });
  return Object.keys(result).length > 0 ? result : undefined;
}


export async function readXmlSmartArtColorTransform(zip: JSZip, path: string): Promise<Record<string, unknown> | undefined> {
  const xml = await readZipText(zip, path);
  if (!xml) {
    return undefined;
  }
  const colors = getRecord(parseXmlRecord(xml), "dgm:colorsDef");
  const fillColors = collectXmlColors(colors, ["dgm:fillClrLst"]);
  const lineColors = collectXmlColors(colors, ["dgm:linClrLst"]);
  const allColors = collectXmlColors(colors);
  const result = stripUndefinedFields({
    name: readAttr(colors, "title") ?? readAttr(colors, "uniqueId"),
    uniqueId: readAttr(colors, "uniqueId"),
    fillColors: fillColors.length > 0 ? fillColors : allColors.length > 0 ? allColors : undefined,
    lineColors: lineColors.length > 0 ? lineColors : undefined,
    rawXml: xml,
    sourcePath: path,
  });
  return Object.keys(result).length > 0 ? result : undefined;
}


export async function readXmlSmartArtQuickStyle(zip: JSZip, path: string): Promise<Record<string, unknown> | undefined> {
  const xml = await readZipText(zip, path);
  if (!xml) {
    return undefined;
  }
  const style = getRecord(parseXmlRecord(xml), "dgm:styleDef");
  const result = stripUndefinedFields({
    name: readAttr(style, "title") ?? readAttr(style, "uniqueId"),
    uniqueId: readAttr(style, "uniqueId"),
    minVersion: readAttr(style, "minVer"),
    effectIntensity: readAttr(style, "effect") ?? readAttr(style, "effectIntensity"),
    rawXml: xml,
    sourcePath: path,
  });
  return Object.keys(result).length > 0 ? result : undefined;
}


export function collectXmlColors(container: XmlValue, pathFilter?: string[]): string[] {
  const colors: string[] = [];
  const visit = (value: XmlValue, path: string[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, path));
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const pathMatches = !pathFilter || pathFilter.some((filter) => path.includes(filter));
    if (pathMatches) {
      const hex = readAttr(getRecord(value, "a:srgbClr"), "val");
      if (hex) {
        const normalized = normalizeHexColor(hex);
        if (normalized) {
          colors.push(normalized);
        }
      }
      const scheme = readAttr(getRecord(value, "a:schemeClr"), "val");
      if (scheme) {
        colors.push(scheme);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("@_") || key === "#text") {
        continue;
      }
      visit(child, [...path, key]);
    }
  };
  visit(container, []);
  return [...new Set(colors)];
}


export async function readXmlSmartArtDrawingShapes(zip: JSZip, drawingPath: string): Promise<PptxSmartArtDrawingShape[] | undefined> {
  const xml = await readZipText(zip, drawingPath);
  if (!xml) {
    return undefined;
  }
  const entries = collectDrawingChildrenInXmlOrder(xml);
  const shapes = entries
    .filter((entry) => entry.type === "p:sp")
    .map((entry, index) => readXmlSmartArtDrawingShape(entry.node, index))
    .filter((shape): shape is PptxSmartArtDrawingShape => Boolean(shape));
  return shapes.length > 0 ? shapes : undefined;
}


export function readXmlSmartArtDrawingShape(node: XmlRecord, index: number): PptxSmartArtDrawingShape | null {
  const nv = getRecord(node, "p:nvSpPr");
  const cNvPr = getRecord(nv, "p:cNvPr");
  const spPr = getRecord(node, "p:spPr");
  const bounds = readBounds(getRecord(spPr, "a:xfrm"));
  if (bounds.px.w <= 0 || bounds.px.h <= 0) {
    return null;
  }
  const colorContext = { colorScheme: DEFAULT_SCHEME_COLORS, colorMap: DEFAULT_COLOR_MAP };
  const fill = readFillStyle(spPr, colorContext);
  const line = readLineStyle(getRecord(spPr, "a:ln"), colorContext);
  const text = readTextBody(getRecord(node, "p:txBody"), colorContext);
  return stripUndefinedFields({
    id: readAttr(cNvPr, "id") ?? `drawing_${index + 1}`,
    shapeType: readGeometryPreset(spPr, false, false) ?? "rect",
    x: bounds.px.x,
    y: bounds.px.y,
    width: bounds.px.w,
    height: bounds.px.h,
    rotation: readRotation(getRecord(spPr, "a:xfrm")) || undefined,
    fillColor: fill?.type === "solid" ? fill.color : undefined,
    strokeColor: line?.color,
    strokeWidth: line?.widthPx,
    text: text.plainText || readAttr(cNvPr, "name"),
    fontColor: getPowerPointTextPrimaryColor(text),
  }) as PptxSmartArtDrawingShape;
}


export function readXmlSmartArtNodes(dataModel: XmlRecord): PptxSmartArtData["nodes"] {
  const pointList = getRecord(dataModel, "dgm:ptLst");
  const points = pointList["dgm:pt"];
  const allNodes = asArray(points)
    .map((point, index) => readXmlSmartArtNode(getRecordFromValue(point), index))
    .filter((node): node is PptxSmartArtData["nodes"][number] => Boolean(node));
  if (allNodes.length === 0) {
    return [];
  }
  const childrenByParent = new Map<string, PptxSmartArtData["nodes"]>();
  for (const connection of readXmlSmartArtConnections(dataModel)) {
    if (!connection.sourceId || !connection.destId) {
      continue;
    }
    const list = childrenByParent.get(connection.sourceId) ?? [];
    const child = allNodes.find((node) => node.id === connection.destId);
    if (child) {
      list.push({ ...child, parentId: connection.sourceId });
      childrenByParent.set(connection.sourceId, list);
    }
  }
  const childIds = new Set([...childrenByParent.values()].flat().map((node) => node.id));
  return allNodes
    .filter((node) => !childIds.has(node.id))
    .map((node) => ({ ...node, children: childrenByParent.get(node.id) }));
}


export function readXmlSmartArtNode(point: XmlRecord, index: number): PptxSmartArtData["nodes"][number] | null {
  const id = readAttr(point, "modelId") ?? readAttr(point, "id") ?? `node_${index + 1}`;
  const text = collectDrawingTextValues(point).join("") || readAttr(point, "type") || `Node ${index + 1}`;
  return stripUndefinedFields({
    id,
    text,
    nodeType: readAttr(point, "type"),
  }) as PptxSmartArtData["nodes"][number];
}


export function readXmlSmartArtConnections(dataModel: XmlRecord): NonNullable<PptxSmartArtData["connections"]> {
  const connectionList = getRecord(dataModel, "dgm:cxnLst");
  const connections = connectionList["dgm:cxn"];
  return asArray(connections)
    .map((connection) => {
      const node = getRecordFromValue(connection);
      return stripUndefinedFields({
        sourceId: readAttr(node, "srcId"),
        destId: readAttr(node, "destId"),
        type: readAttr(node, "type"),
        srcOrd: readNumberAttr(node, "srcOrd"),
        destOrd: readNumberAttr(node, "destOrd"),
      });
    })
    .filter((connection) => Object.keys(connection).length > 0) as NonNullable<PptxSmartArtData["connections"]>;
}


export function smartArtLayoutTypeFromPath(path: string): string | undefined {
  const match = /layout(?:s)?\/([^/.]+)\.xml$/iu.exec(path);
  return match?.[1];
}


export async function collectSlideShapes(
  zip: JSZip,
  slidePath: string,
  slideXml: string,
  spTree: XmlRecord,
  rels: Map<string, Relationship>,
  colorContext: PowerPointColorContext,
): Promise<SlideRenderShape[]> {
  const shapes: SlideRenderShape[] = [];
  const entries = collectDrawingChildrenInXmlOrder(slideXml);
  const drawingEntries = entries.length > 0 ? entries : collectDrawingChildren(spTree);
  for (let zIndex = 0; zIndex < drawingEntries.length; zIndex += 1) {
    const entry = drawingEntries[zIndex]!;
    shapes.push(...await parseDrawingElementTree(zip, slidePath, rels, entry.type, entry.node, zIndex, colorContext));
  }
  return shapes;
}


export async function parseDrawingElementTree(
  zip: JSZip,
  slidePath: string,
  rels: Map<string, Relationship>,
  elementType: string,
  node: XmlRecord,
  zIndex: number,
  colorContext: PowerPointColorContext,
  parentSourceId?: string,
): Promise<SlideRenderShape[]> {
  const shape = await parseDrawingElement(zip, slidePath, rels, elementType, node, zIndex, colorContext, parentSourceId);
  if (!shape) {
    return [];
  }
  if (elementType !== "p:grpSp") {
    return [shape];
  }

  const shapes: SlideRenderShape[] = [shape];
  const groupTransform = readXmlGroupTransform(node);
  const childEntries = collectDrawingChildren(node);
  for (let childIndex = 0; childIndex < childEntries.length; childIndex += 1) {
    const child = childEntries[childIndex]!;
    const childShapes = await parseDrawingElementTree(zip, slidePath, rels, child.type, child.node, zIndex + (childIndex + 1) / 1000, colorContext, shape.sourceId);
    shapes.push(...childShapes.map((childShape) => transformSourceShapeByGroup(childShape, groupTransform)));
  }
  return shapes;
}


export async function parseDrawingElement(
  zip: JSZip,
  slidePath: string,
  rels: Map<string, Relationship>,
  elementType: string,
  node: XmlRecord,
  zIndex: number,
  colorContext: PowerPointColorContext,
  parentSourceId?: string,
): Promise<SlideRenderShape | null> {
  if (elementType === "p:graphicFrame") {
    const nv = getRecord(node, "p:nvGraphicFramePr");
    const cNvPr = getRecord(nv, "p:cNvPr");
    const frameBounds = readBounds(getRecord(node, "p:xfrm"));
    const graphicDataUri = readAttr(getRecord(getRecord(node, "a:graphic"), "a:graphicData"), "uri");
    const graphicData = getRecord(getRecord(node, "a:graphic"), "a:graphicData");
    const tableData = graphicDataUri?.includes("/table")
      ? readXmlTableData(getRecord(graphicData, "a:tbl"), colorContext)
      : undefined;
    const bounds = tableData
      ? withPowerPointTableIntrinsicSize(frameBounds, getRecord(graphicData, "a:tbl"))
      : frameBounds;
    const chartData = graphicDataUri?.includes("/chart")
      ? await readXmlChartData(zip, slidePath, rels, graphicData, colorContext)
      : undefined;
    const smartArtData = graphicDataUri?.includes("/diagram")
      ? await readXmlSmartArtData(zip, slidePath, rels, graphicData)
      : undefined;
    const kind = graphicDataUri?.includes("/table") ? "table" : graphicDataUri?.includes("/chart") ? "chart" : graphicDataUri?.includes("/diagram") ? "smartArt" : "unknown";
    const nonVisual = createPptxNonVisualMetadata(node);
    const placeholder = createPptxPlaceholderMetadata(node);
    const sourceId = readAttr(cNvPr, "id") || `graphicFrame_${zIndex + 1}`;
    return {
      sourceId,
      ...(parentSourceId ? { parentSourceId } : {}),
      name: readAttr(cNvPr, "name") || `GraphicFrame ${zIndex + 1}`,
      kind,
      zIndex,
      bounds: bounds.px,
      boundsEmu: bounds.emu,
      ...(nonVisual ? { nonVisual } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(tableData ? {
        table: {
          data: tableData,
          rowCount: tableData.rows.length,
          columnCount: getPptxTableColumnCount(tableData),
        },
      } : {}),
      ...(chartData ? {
        chart: {
          data: chartData,
          chartType: chartData.chartType,
          categoryCount: chartData.categories.length,
          seriesCount: chartData.series.length,
        },
      } : {}),
      ...(smartArtData ? {
        smartArt: {
          data: smartArtData,
          layoutType: smartArtData.resolvedLayoutType ?? smartArtData.layoutType,
          nodeCount: countSmartArtNodes(smartArtData.nodes),
          drawingShapeCount: smartArtData.drawingShapes?.length ?? 0,
        },
      } : {}),
      conversionCandidate: createConversionCandidate(kind, undefined, undefined, ""),
    };
  }

  if (elementType === "p:grpSp") {
    const nv = getRecord(node, "p:nvGrpSpPr");
    const cNvPr = getRecord(nv, "p:cNvPr");
    const bounds = readBounds(getRecord(getRecord(node, "p:grpSpPr"), "a:xfrm"));
    const nonVisual = createPptxNonVisualMetadata(node);
    const placeholder = createPptxPlaceholderMetadata(node);
    const sourceId = readAttr(cNvPr, "id") || `group_${zIndex + 1}`;
    return {
      sourceId,
      ...(parentSourceId ? { parentSourceId } : {}),
      name: readAttr(cNvPr, "name") || `Group ${zIndex + 1}`,
      kind: "group",
      zIndex,
      bounds: bounds.px,
      boundsEmu: bounds.emu,
      ...(nonVisual ? { nonVisual } : {}),
      ...(placeholder ? { placeholder } : {}),
      conversionCandidate: { sigmaKind: "group", confidence: "medium", reason: "PowerPoint group maps to a Sigma overlay group with editable child shapes when XML fallback parsing is used." },
    };
  }

  const isConnector = elementType === "p:cxnSp";
  const isPicture = elementType === "p:pic";
  const nvRoot = isConnector ? "p:nvCxnSpPr" : isPicture ? "p:nvPicPr" : "p:nvSpPr";
  const nv = getRecord(node, nvRoot);
  const cNvPr = getRecord(nv, "p:cNvPr");
  const spPr = getRecord(node, "p:spPr");
  const xfrm = getRecord(spPr, "a:xfrm");
  const bounds = readBounds(xfrm);
  const geometryPreset = readGeometryPreset(spPr, isConnector, isPicture);
  const geometryAdjustments = readPresetGeometryAdjustments(spPr);
  const customGeometry = readCustomGeometry(spPr);
  const text = readTextBody(getRecord(node, "p:txBody"), colorContext);
  let line = readLineStyle(getRecord(spPr, "a:ln"), colorContext);
  if (isConnector) {
    line = withXmlConnectorConnections(line, getRecord(nv, "p:cNvCxnSpPr"));
  }
  const fill = readFillStyle(spPr, colorContext);
  const rotation = readRotation(xfrm);
  const flip = readFlip(xfrm);
  const sourceId = readAttr(cNvPr, "id") || `${elementType}_${zIndex + 1}`;
  const name = readAttr(cNvPr, "name") || `${elementType} ${zIndex + 1}`;
  const nonVisual = createPptxNonVisualMetadata(node);
  const placeholder = createPptxPlaceholderMetadata(node);
  const kind = isPicture
    ? "picture"
    : isConnector
      ? "connector"
      : text.plainText && isTextBoxPreset(geometryPreset)
        ? "textBox"
        : isLinePreset(geometryPreset)
          ? "line"
          : "shape";
  const shape: SlideRenderShape = {
    sourceId,
    ...(parentSourceId ? { parentSourceId } : {}),
    name,
    kind,
    geometry: customGeometry
      ? { preset: "custom", raw: "a:custGeom", custom: customGeometry }
      : geometryPreset ? { preset: geometryPreset, ...(geometryAdjustments ? { adjustments: geometryAdjustments } : {}) } : undefined,
    zIndex,
    bounds: bounds.px,
    boundsEmu: bounds.emu,
    ...(rotation !== 0 ? { rotation } : {}),
    ...(flip ? { flip } : {}),
    ...(nonVisual ? { nonVisual } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(line ? { line } : {}),
    ...(fill ? { fill } : {}),
    ...(text.plainText ? { text } : {}),
    conversionCandidate: createConversionCandidate(kind, customGeometry ? "custom" : geometryPreset, line, text.plainText, customGeometry),
  };

  if (isPicture) {
    const blipFill = getRecord(node, "p:blipFill");
    const embedId = readAttr(getRecord(blipFill, "a:blip"), "r:embed");
    const rel = embedId ? rels.get(embedId) : undefined;
    const target = rel ? resolvePartPath(slidePath, rel.target) : undefined;
    const media = target ? zip.file(target) : null;
    const mediaBytes = media ? await media.async("uint8array") : null;
    const mimeType = target ? imageMimeType(target) : undefined;
    const crop = readSourceRectCrop(getRecord(blipFill, "a:srcRect"));
    const blip = getRecord(blipFill, "a:blip");
    const opacity = readBlipOpacity(blip);
    if (opacity !== undefined) {
      shape.opacity = opacity;
    }
    shape.picture = {
      relationshipId: embedId,
      target,
      mimeType,
      fileSize: mediaBytes?.byteLength,
      crop,
      altText: readAttr(cNvPr, "descr") ?? readAttr(cNvPr, "title"),
      cropShape: geometryPreset === "picture" ? undefined : geometryPreset,
      effects: readBlipEffects(blip),
      tile: readBlipFillMode(blipFill),
    };
    if (mediaBytes && mimeType) {
      shape.imageDataUrl = `data:${mimeType};base64,${bytesToBase64(mediaBytes)}`;
    }
  }

  return shape;
}


export type PresetGeometryPoint = { x: number; y: number };


export function createEllipseArcPoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  startAngle: number,
  endAngle: number,
  segments: number,
): PresetGeometryPoint[] {
  const points: PresetGeometryPoint[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = startAngle + (endAngle - startAngle) * (index / segments);
    points.push({
      x: round(cx + rx * Math.cos(angle)),
      y: round(cy + ry * Math.sin(angle)),
    });
  }
  return points;
}


export function createEllipseOutlinePoints(w: number, h: number, segments = 40): PresetGeometryPoint[] {
  return createEllipseArcPoints(w / 2, h / 2, w / 2, h / 2, -Math.PI / 2, Math.PI * 1.5, segments)
    .slice(0, -1);
}


export function appendCubicBezierPoints(
  points: PresetGeometryPoint[],
  control1: PresetGeometryPoint,
  control2: PresetGeometryPoint,
  end: PresetGeometryPoint,
  segments = 8,
): void {
  const start = points.at(-1);
  if (!start) {
    points.push(end);
    return;
  }

  for (let index = 1; index <= segments; index += 1) {
    const t = index / segments;
    const inverse = 1 - t;
    points.push({
      x: round(
        inverse ** 3 * start.x
        + 3 * inverse ** 2 * t * control1.x
        + 3 * inverse * t ** 2 * control2.x
        + t ** 3 * end.x,
      ),
      y: round(
        inverse ** 3 * start.y
        + 3 * inverse ** 2 * t * control1.y
        + 3 * inverse * t ** 2 * control2.y
        + t ** 3 * end.y,
      ),
    });
  }
}


export function computeDonutOutlinePointSets(
  w: number,
  h: number,
  adjustments?: Record<string, number>,
): { outer: PresetGeometryPoint[]; inner: PresetGeometryPoint[] } {
  const rawThickness = adjustments?.adj ?? adjustments?.adj1;
  const thicknessRatio = clamp(rawThickness === undefined ? 0.25 : rawThickness / 100000, 0.05, 0.45);
  const innerScale = 1 - thicknessRatio * 2;
  return {
    outer: createEllipseOutlinePoints(w, h),
    inner: createEllipseOutlinePoints(w * innerScale, h * innerScale)
      .map((point) => ({
        x: round(point.x + w * thicknessRatio),
        y: round(point.y + h * thicknessRatio),
      })),
  };
}


export function ooxmlPresetAngleToRadians(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : value / 60000 * Math.PI / 180;
}


export function normalizePositiveArcEnd(start: number, end: number): number {
  const fullTurn = Math.PI * 2;
  let sweep = (end - start) % fullTurn;
  if (sweep <= 0) {
    sweep += fullTurn;
  }
  return start + sweep;
}


// Compute geometry points for OOXML preset shapes
// Returns an array of points in local coordinates (0..w, 0..h), or null if unsupported
export function computePresetGeometryPoints(
  preset: string | undefined,
  w: number,
  h: number,
  adjustments?: Record<string, number>
): PresetGeometryPoint[] | null {
  if (!preset) return null;

  const adj = adjustments?.adj ?? adjustments?.adj1;
  const adj2 = adjustments?.adj2;

  // Helper to normalize adjustment values from PowerPoint's 100000-unit scale
  const normalizeAdj = (value: number | undefined, defaultVal: number = 0.5): number => {
    return value === undefined ? defaultVal : clamp(value / 100000, 0, 1);
  };

  // Regular polygons using trigonometry
  const createRegularPolygon = (sides: number): PresetGeometryPoint[] => {
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2;
    const points: PresetGeometryPoint[] = [];
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * 2 * Math.PI - Math.PI / 2;
      points.push({
        x: round(cx + radius * Math.cos(angle)),
        y: round(cy + radius * Math.sin(angle)),
      });
    }
    return points;
  };

  switch (preset) {
    // Regular polygons
    case "hexagon":
      return createRegularPolygon(6);
    case "octagon":
      return createRegularPolygon(8);
    case "heptagon":
      return createRegularPolygon(7);

    // Stars
    case "star4":
    case "star5":
    case "star6":
    case "star7":
    case "star8":
    case "star10":
    case "star12":
    case "star16":
    case "star24":
    case "star32": {
      const sides = parseInt(preset.substring(4), 10);
      if (isNaN(sides) || sides < 4) return null;
      const cx = w / 2;
      const cy = h / 2;
      const outerRadius = Math.min(w, h) / 2;
      const innerRadiusRatio = normalizeAdj(adj, 0.5);
      const innerRadius = outerRadius * innerRadiusRatio;
      const points: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < sides * 2; i++) {
        const isOuter = i % 2 === 0;
        const radius = isOuter ? outerRadius : innerRadius;
        const angle = (i / (sides * 2)) * 2 * Math.PI - Math.PI / 2;
        points.push({
          x: round(cx + radius * Math.cos(angle)),
          y: round(cy + radius * Math.sin(angle)),
        });
      }
      return points;
    }

    // Chevron shape
    case "chevron": {
      const points: Array<{ x: number; y: number }> = [];
      const w3 = w / 3;
      points.push({ x: 0, y: 0 });
      points.push({ x: w - w3, y: 0 });
      points.push({ x: w, y: h / 2 });
      points.push({ x: w - w3, y: h });
      points.push({ x: 0, y: h });
      points.push({ x: w3, y: h / 2 });
      return points;
    }

    // Heart shape (approximation)
    case "heart": {
      const points: PresetGeometryPoint[] = [{ x: w / 2, y: h }];
      // Trace one continuous outline: tip -> left lobe -> notch -> right lobe -> tip.
      appendCubicBezierPoints(points, { x: w * 0.34, y: h * 0.82 }, { x: 0, y: h * 0.62 }, { x: w * 0.04, y: h * 0.36 });
      appendCubicBezierPoints(points, { x: w * 0.06, y: h * 0.08 }, { x: w * 0.34, y: 0 }, { x: w * 0.5, y: h * 0.26 });
      appendCubicBezierPoints(points, { x: w * 0.66, y: 0 }, { x: w * 0.94, y: h * 0.08 }, { x: w * 0.96, y: h * 0.36 });
      appendCubicBezierPoints(points, { x: w, y: h * 0.62 }, { x: w * 0.66, y: h * 0.82 }, { x: w / 2, y: h });
      return points;
    }

    // Cloud shape (approximation with bumps)
    // Cloud shape (approximation with bumps)
    case "cloud": {
      // Simplified cloud shape - hexagon with rounded bumps
      const points: PresetGeometryPoint[] = [];
      const centerX = w / 2;
      const centerY = h / 2;

      // Create cloud using simple 12-point star pattern (avoiding self-intersection)
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * 2 * Math.PI - Math.PI / 2;

        // Alternate between outer and inner radius for bumpy effect
        const isOuter = i % 2 === 0;
        const radius = isOuter ? Math.min(w, h) * 0.48 : Math.min(w, h) * 0.35;

        points.push({
          x: round(centerX + radius * Math.cos(angle)),
          y: round(centerY + radius * Math.sin(angle)),
        });
      }

      return points;
    }

    case "moon": {
      const outerRadius = 0.5;
      const innerRadius = 0.42;
      const innerCenterX = 0.68;
      const centerOffset = innerCenterX - outerRadius;
      const intersectionX = (
        outerRadius ** 2 - innerRadius ** 2 + centerOffset ** 2
      ) / (2 * centerOffset);
      const outerAngle = Math.acos(intersectionX / outerRadius);
      const innerAngle = Math.acos((intersectionX - centerOffset) / innerRadius);
      const points = createEllipseArcPoints(
        w / 2,
        h / 2,
        w / 2,
        h / 2,
        -outerAngle,
        outerAngle - Math.PI * 2,
        10,
      );
      points.push(...createEllipseArcPoints(
        w * innerCenterX,
        h / 2,
        w * innerRadius,
        h * innerRadius,
        innerAngle,
        Math.PI * 2 - innerAngle,
        8,
      ).slice(1));
      return points;
    }

    case "sun": {
      const points: PresetGeometryPoint[] = [];
      const cx = w / 2;
      const cy = h / 2;
      const outerRadiusX = w / 2;
      const outerRadiusY = h / 2;
      const innerRadiusX = w * 0.34;
      const innerRadiusY = h * 0.34;
      for (let index = 0; index < 16; index += 1) {
        const angle = -Math.PI / 2 + index * Math.PI / 8;
        const isRayTip = index % 2 === 0;
        points.push({
          x: round(cx + (isRayTip ? outerRadiusX : innerRadiusX) * Math.cos(angle)),
          y: round(cy + (isRayTip ? outerRadiusY : innerRadiusY) * Math.sin(angle)),
        });
      }
      return points;
    }

    case "teardrop": {
      const points: PresetGeometryPoint[] = [{ x: w, y: 0 }];
      appendCubicBezierPoints(points, { x: w, y: h * 0.55 }, { x: w * 0.78, y: h }, { x: w * 0.46, y: h });
      appendCubicBezierPoints(points, { x: w * 0.18, y: h }, { x: 0, y: h * 0.78 }, { x: 0, y: h * 0.5 });
      appendCubicBezierPoints(points, { x: 0, y: h * 0.22 }, { x: w * 0.22, y: 0 }, { x: w * 0.5, y: 0 });
      appendCubicBezierPoints(points, { x: w * 0.7, y: 0 }, { x: w * 0.88, y: 0 }, { x: w, y: 0 }, 6);
      return points;
    }

    case "lightningBolt":
      return [
        { x: w * 0.56, y: 0 },
        { x: w * 0.12, y: h * 0.56 },
        { x: w * 0.42, y: h * 0.52 },
        { x: w * 0.25, y: h },
        { x: w * 0.9, y: h * 0.35 },
        { x: w * 0.57, y: h * 0.39 },
        { x: w * 0.82, y: 0 },
      ];

    case "smileyFace":
      // Facial features are not representable as one polyline; preserve the circular face.
      return createEllipseOutlinePoints(w, h);

    case "homePlate":
      return [
        { x: 0, y: 0 },
        { x: w * 0.72, y: 0 },
        { x: w, y: h / 2 },
        { x: w * 0.72, y: h },
        { x: 0, y: h },
      ];

    case "cube":
      return [
        { x: w * 0.25, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h * 0.75 },
        { x: w * 0.75, y: h },
        { x: 0, y: h },
        { x: 0, y: h * 0.25 },
      ];

    // Plus/cross shape
    case "plus":
    case "mathPlus": {
      const cx = w / 2;
      const cy = h / 2;
      const armWidth = w * 0.2;
      const armHeight = h * 0.2;
      return [
        { x: cx - armWidth, y: cy - armHeight },
        { x: cx - armWidth, y: cy - h * 0.5 },
        { x: cx + armWidth, y: cy - h * 0.5 },
        { x: cx + armWidth, y: cy - armHeight },
        { x: cx + w * 0.5, y: cy - armHeight },
        { x: cx + w * 0.5, y: cy + armHeight },
        { x: cx + armWidth, y: cy + armHeight },
        { x: cx + armWidth, y: cy + h * 0.5 },
        { x: cx - armWidth, y: cy + h * 0.5 },
        { x: cx - armWidth, y: cy + armHeight },
        { x: cx - w * 0.5, y: cy + armHeight },
        { x: cx - w * 0.5, y: cy - armHeight },
      ];
    }

    // Wedge callout shapes (rectangle/ellipse + triangle tail)
    case "wedgeRectCallout": {
      const tailPosRatio = normalizeAdj(adj, 0.5);
      const tailWidthRatio = normalizeAdj(adj2, 0.1);
      const tailX = w * tailPosRatio;
      const tailWidth = Math.min(w * tailWidthRatio, tailX, w - tailX);

      return [
        { x: w * 0.05, y: 0 },
        { x: w * 0.95, y: 0 },
        { x: w * 0.95, y: h * 0.85 },
        { x: tailX + tailWidth, y: h * 0.85 },
        { x: tailX, y: h },
        { x: tailX - tailWidth, y: h * 0.85 },
        { x: w * 0.05, y: h * 0.85 },
      ];
    }

    case "wedgeEllipseCallout": {
      const tailPosRatio = normalizeAdj(adj, 0.5);
      const tailX = w * tailPosRatio;
      const cx = w / 2;
      const cy = h * 0.4;
      const rx = w * 0.45;
      const ry = h * 0.35;
      const tailWidth = Math.min(w * 0.1, rx * 0.3);
      const baseCenterX = clamp(tailX, cx - rx + tailWidth, cx + rx - tailWidth);
      const rightBaseX = baseCenterX + tailWidth;
      const leftBaseX = baseCenterX - tailWidth;
      const rightBaseAngle = Math.acos(clamp((rightBaseX - cx) / rx, -1, 1));
      const leftBaseAngle = Math.acos(clamp((leftBaseX - cx) / rx, -1, 1));
      const points = createEllipseArcPoints(cx, cy, rx, ry, 0, rightBaseAngle, 8);
      points.push({ x: tailX, y: h });
      points.push(...createEllipseArcPoints(cx, cy, rx, ry, leftBaseAngle, Math.PI * 2, 24));
      return points;
    }

    // Brackets/braces (approximation with curves)
    case "leftBracket": {
      const thickness = Math.min(w * 0.22, h * 0.08);
      return [
        { x: w, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: h },
        { x: w, y: h },
        { x: w, y: h - thickness },
        { x: thickness, y: h - thickness },
        { x: thickness, y: thickness },
        { x: w, y: thickness },
      ];
    }

    case "rightBracket": {
      const thickness = Math.min(w * 0.22, h * 0.08);
      return [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
        { x: 0, y: h - thickness },
        { x: w - thickness, y: h - thickness },
        { x: w - thickness, y: thickness },
        { x: 0, y: thickness },
      ];
    }

    case "leftBrace": {
      const thickness = w * 0.25;
      const outerShoulderX = w * 0.28;
      const innerShoulderX = outerShoulderX + thickness;
      const points: PresetGeometryPoint[] = [{ x: round(w - thickness), y: 0 }];

      appendCubicBezierPoints(points, { x: w * 0.48, y: 0 }, { x: outerShoulderX, y: h * 0.12 }, { x: outerShoulderX, y: h * 0.3 }, 4);
      appendCubicBezierPoints(points, { x: outerShoulderX, y: h * 0.4 }, { x: 0, y: h * 0.41 }, { x: 0, y: h * 0.5 }, 4);
      appendCubicBezierPoints(points, { x: 0, y: h * 0.59 }, { x: outerShoulderX, y: h * 0.6 }, { x: outerShoulderX, y: h * 0.7 }, 4);
      appendCubicBezierPoints(points, { x: outerShoulderX, y: h * 0.88 }, { x: w * 0.48, y: h }, { x: w - thickness, y: h }, 4);

      points.push({ x: round(w), y: round(h) });
      appendCubicBezierPoints(points, { x: w * 0.77, y: h }, { x: innerShoulderX, y: h * 0.88 }, { x: innerShoulderX, y: h * 0.7 }, 4);
      appendCubicBezierPoints(points, { x: innerShoulderX, y: h * 0.6 }, { x: thickness, y: h * 0.59 }, { x: thickness, y: h * 0.5 }, 4);
      appendCubicBezierPoints(points, { x: thickness, y: h * 0.41 }, { x: innerShoulderX, y: h * 0.4 }, { x: innerShoulderX, y: h * 0.3 }, 4);
      appendCubicBezierPoints(points, { x: innerShoulderX, y: h * 0.12 }, { x: w * 0.77, y: 0 }, { x: w, y: 0 }, 4);
      return points;
    }

    case "rightBrace": {
      return computePresetGeometryPoints("leftBrace", w, h)
        ?.map((point) => ({ x: round(w - point.x), y: point.y })) ?? null;
    }

    // Math operators
    case "mathMinus": {
      const cx = w / 2;
      const cy = h / 2;
      const barWidth = w * 0.6;
      const barHeight = h * 0.15;
      return [
        { x: cx - barWidth, y: cy - barHeight },
        { x: cx + barWidth, y: cy - barHeight },
        { x: cx + barWidth, y: cy + barHeight },
        { x: cx - barWidth, y: cy + barHeight },
      ];
    }

    case "mathMultiply": {
      const cx = w / 2;
      const cy = h / 2;
      const armLen = Math.min(w, h) * 0.35;
      const thickness = Math.min(w, h) * 0.1;
      // X shape made of two crossing rectangles
      const points: Array<{ x: number; y: number }> = [];
      // This is approximate - return a crossing pattern
      points.push({ x: cx - armLen, y: cy - thickness });
      points.push({ x: cx - thickness, y: cy - armLen });
      points.push({ x: cx + thickness, y: cy - armLen });
      points.push({ x: cx + armLen, y: cy - thickness });
      points.push({ x: cx + armLen, y: cy + thickness });
      points.push({ x: cx + thickness, y: cy + armLen });
      points.push({ x: cx - thickness, y: cy + armLen });
      points.push({ x: cx - armLen, y: cy + thickness });
      return points;
    }

    case "mathDivide": {
      const cx = w / 2;
      const cy = h / 2;
      const dotRadius = h * 0.08;
      const barWidth = w * 0.6;
      const barHeight = h * 0.08;
      // Top dot, horizontal line, bottom dot
      return [
        { x: cx - dotRadius, y: h * 0.2 },
        { x: cx + dotRadius, y: h * 0.2 },
        { x: cx + dotRadius, y: cy - barHeight },
        { x: cx + barWidth, y: cy - barHeight },
        { x: cx + barWidth, y: cy + barHeight },
        { x: cx - barWidth, y: cy + barHeight },
        { x: cx - barWidth, y: cy - barHeight },
        { x: cx - dotRadius, y: cy - barHeight },
        { x: cx - dotRadius, y: h * 0.8 },
        { x: cx + dotRadius, y: h * 0.8 },
      ];
    }

    case "mathEqual": {
      const cx = w / 2;
      const cy = h / 2;
      const barWidth = w * 0.6;
      const barHeight = h * 0.1;
      const gap = h * 0.15;
      return [
        { x: cx - barWidth, y: cy - gap - barHeight },
        { x: cx + barWidth, y: cy - gap - barHeight },
        { x: cx + barWidth, y: cy - gap },
        { x: cx - barWidth, y: cy - gap },
        { x: cx - barWidth, y: cy + gap },
        { x: cx + barWidth, y: cy + gap },
        { x: cx + barWidth, y: cy + gap + barHeight },
        { x: cx - barWidth, y: cy + gap + barHeight },
      ];
    }

    // Flowchart shapes
    case "flowChartDecision": {
      return [
        { x: w / 2, y: 0 },
        { x: w, y: h / 2 },
        { x: w / 2, y: h },
        { x: 0, y: h / 2 },
      ];
    }

    case "flowChartProcess": {
      return [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ];
    }

    case "flowChartTerminator": {
      // Rounded rectangle - simple polyline
      const rc = Math.min(w, h) * 0.2;
      return [
        { x: rc, y: 0 },
        { x: w - rc, y: 0 },
        { x: w, y: rc },
        { x: w, y: h - rc },
        { x: w - rc, y: h },
        { x: rc, y: h },
        { x: 0, y: h - rc },
        { x: 0, y: rc },
      ];
    }

    case "flowChartDocument": {
      const waveHeight = h * 0.1;
      const points: Array<{ x: number; y: number }> = [];
      points.push({ x: 0, y: 0 });
      points.push({ x: w, y: 0 });
      points.push({ x: w, y: h - waveHeight });
      // Wavy bottom
      for (let i = 1; i <= 8; i++) {
        const x = w * (1 - i / 8);
        const y = h - waveHeight + waveHeight * Math.sin((i / 8) * Math.PI);
        points.push({ x: round(x), y: round(y) });
      }
      points.push({ x: 0, y: h - waveHeight });
      return points;
    }

    case "flowChartPredefinedProcess": {
      const sideInset = w * 0.1;
      return [
        { x: sideInset, y: 0 },
        { x: w - sideInset, y: 0 },
        { x: w, y: h * 0.5 },
        { x: w - sideInset, y: h },
        { x: sideInset, y: h },
        { x: 0, y: h * 0.5 },
      ];
    }

    // Arc-like filled presets represented as editable closed polylines.
    case "donut": {
      const { outer, inner } = computeDonutOutlinePointSets(w, h, adjustments);
      return [...outer, ...inner.slice().reverse()];
    }

    case "blockArc": {
      const start = ooxmlPresetAngleToRadians(adjustments?.adj1, Math.PI);
      const end = normalizePositiveArcEnd(start, ooxmlPresetAngleToRadians(adjustments?.adj2, 0));
      const thickness = clamp((adjustments?.adj3 ?? 25000) / 100000, 0.05, 0.45);
      const innerScale = 1 - thickness * 2;
      const outer = createEllipseArcPoints(w / 2, h / 2, w / 2, h / 2, start, end, 24);
      const inner = createEllipseArcPoints(w / 2, h / 2, w / 2 * innerScale, h / 2 * innerScale, end, start, 24);
      return [...outer, ...inner];
    }

    case "chord": {
      const start = ooxmlPresetAngleToRadians(adjustments?.adj1, Math.PI);
      const end = normalizePositiveArcEnd(start, ooxmlPresetAngleToRadians(adjustments?.adj2, 0));
      return createEllipseArcPoints(w / 2, h / 2, w / 2, h / 2, start, end, 32);
    }

    // These presets have dedicated overlay arc behavior.
    case "pie":
    case "arc":
      return null;

    // Unsupported presets
    default:
      return null;
  }
}


export function getPowerPointTextPrimaryColor(text: PowerPointSourceShape["text"] | undefined): string | undefined {
  return text?.segments?.find((segment) => segment.style.color)?.style.color;
}


export function countSmartArtNodes(nodes: PptxSmartArtData["nodes"]): number {
  return flattenSmartArtNodes(nodes).length;
}


export function flattenSmartArtNodes(nodes: PptxSmartArtData["nodes"]): PptxSmartArtData["nodes"] {
  return nodes.flatMap((node) => [node, ...flattenSmartArtNodes(node.children ?? [])]);
}


export function readXmlTableData(tableNode: XmlRecord, colorContext: PowerPointColorContext): PptxTableData | undefined {
  if (Object.keys(tableNode).length === 0) {
    return undefined;
  }
  const tableProperties = getRecord(tableNode, "a:tblPr");
  const rawColumnWidths = asArray(getRecord(tableNode, "a:tblGrid")["a:gridCol"])
    .map((column) => readNumberAttr(getRecordFromValue(column), "w") ?? 0);
  const totalColumnWidth = rawColumnWidths.reduce((sum, value) => sum + Math.max(0, value), 0);
  const columnWidths = rawColumnWidths.length > 0
    ? rawColumnWidths.map((value) => totalColumnWidth > 0 ? value / totalColumnWidth : 1 / rawColumnWidths.length)
    : [];
  const rows = asArray(tableNode["a:tr"]).map((rowValue) => {
    const row = getRecordFromValue(rowValue);
    return {
      height: emuToPx(readNumberAttr(row, "h") ?? 0) || undefined,
      cells: asArray(row["a:tc"]).map((cellValue) => readXmlTableCell(getRecordFromValue(cellValue), colorContext)),
    };
  });
  if (rows.length === 0) {
    return undefined;
  }
  return stripUndefinedFields({
    rows,
    columnWidths: columnWidths.length > 0 ? columnWidths : inferXmlTableColumnWidths(rows),
    bandedRows: readOptionalBooleanAttr(tableProperties, "bandRow"),
    bandedColumns: readOptionalBooleanAttr(tableProperties, "bandCol"),
    firstRowHeader: readOptionalBooleanAttr(tableProperties, "firstRow"),
    lastRow: readOptionalBooleanAttr(tableProperties, "lastRow"),
    firstCol: readOptionalBooleanAttr(tableProperties, "firstCol"),
    lastCol: readOptionalBooleanAttr(tableProperties, "lastCol"),
    rtl: readOptionalBooleanAttr(tableProperties, "rtl"),
    tableStyleId: readXmlTextValue(tableProperties["a:tblStyleId"]),
  }) as PptxTableData;
}


export function withPowerPointTableIntrinsicSize(
  bounds: ReturnType<typeof readBounds>,
  tableNode: XmlRecord,
): ReturnType<typeof readBounds> {
  const intrinsicSize = readPowerPointTableIntrinsicSize(tableNode);
  if (!intrinsicSize) {
    return bounds;
  }
  return boundsFromEmu({
    ...bounds.emu,
    w: intrinsicSize.w ?? bounds.emu.w,
    h: intrinsicSize.h ?? bounds.emu.h,
  });
}


export function readPowerPointTableIntrinsicSize(value: unknown): { w?: number; h?: number } | undefined {
  const direct = getRecordFromUnknown(value);
  const tableNode = hasXmlKey(direct, "a:tblGrid") || hasXmlKey(direct, "a:tr")
    ? direct
    : findFirstXmlRecordByKey(value, "a:tbl");
  if (!tableNode) {
    return undefined;
  }
  const width = asArray(getRecord(tableNode, "a:tblGrid")["a:gridCol"])
    .reduce<number>((sum, column) => sum + Math.max(0, readNumberAttr(column, "w") ?? 0), 0);
  const height = asArray(tableNode["a:tr"])
    .reduce<number>((sum, row) => sum + Math.max(0, readNumberAttr(row, "h") ?? 0), 0);
  return width > 0 || height > 0
    ? {
        ...(width > 0 ? { w: width } : {}),
        ...(height > 0 ? { h: height } : {}),
      }
    : undefined;
}


export function inferXmlTableColumnWidths(rows: PptxTableData["rows"]): number[] {
  const columnCount = Math.max(1, ...rows.map((row) => row.cells.reduce((sum, cell) => (
    cell.hMerge ? sum : sum + Math.max(1, cell.gridSpan ?? 1)
  ), 0)));
  return Array.from({ length: columnCount }, () => 1 / columnCount);
}


export function readXmlTableCell(cell: XmlRecord, colorContext: PowerPointColorContext): PptxTableData["rows"][number]["cells"][number] {
  const cellProperties = getRecord(cell, "a:tcPr");
  const textBody = readTextBody(getRecord(cell, "a:txBody"), colorContext);
  const firstTextStyle = textBody.segments?.find((segment) => Object.keys(segment.style ?? {}).length > 0)?.style;
  const style = readXmlTableCellStyle(cellProperties, firstTextStyle, colorContext);
  return stripUndefinedFields({
    text: textBody.plainText,
    style,
    gridSpan: readNumberAttr(cell, "gridSpan"),
    rowSpan: readNumberAttr(cell, "rowSpan"),
    hMerge: readOptionalBooleanAttr(cell, "hMerge"),
    vMerge: readOptionalBooleanAttr(cell, "vMerge"),
    extraAttributes: readRawXmlAttributes(cellProperties, new Set(["anchor", "vert", "marL", "marR", "marT", "marB"])),
  }) as PptxTableData["rows"][number]["cells"][number];
}


export function readXmlTableCellStyle(
  cellProperties: XmlRecord,
  firstTextStyle: TextSegment["style"] | undefined,
  colorContext: PowerPointColorContext,
): PptxTableCellStyle | undefined {
  const fill = readFillStyle(cellProperties, colorContext);
  const borders = readXmlTableCellBorders(cellProperties, colorContext);
  const marginLeft = readTableCellMargin(cellProperties, "marL");
  const marginRight = readTableCellMargin(cellProperties, "marR");
  const marginTop = readTableCellMargin(cellProperties, "marT");
  const marginBottom = readTableCellMargin(cellProperties, "marB");
  const style = stripUndefinedFields({
    fontSize: firstTextStyle?.fontSize,
    bold: firstTextStyle?.bold,
    italic: firstTextStyle?.italic,
    underline: firstTextStyle?.underline,
    color: firstTextStyle?.color,
    backgroundColor: fill?.color,
    fillMode: fill?.type === "none" ? "none" : fill?.type === "gradient" ? "gradient" : fill?.type === "pattern" ? "pattern" : fill?.type === "solid" ? "solid" : undefined,
    gradientFillStops: fill?.stops?.map((stop) => ({
      color: stop.color ?? "#000000",
      position: stop.position ?? 0,
      ...(stop.opacity !== undefined ? { opacity: stop.opacity } : {}),
    })),
    patternFillPreset: fill?.pattern?.preset,
    patternFillForeground: fill?.pattern?.foregroundColor,
    patternFillBackground: fill?.pattern?.backgroundColor,
    align: readXmlTableParagraphAlign(firstTextStyle?.align),
    vAlign: readXmlTableVerticalAlign(readAttr(cellProperties, "anchor")),
    textDirection: readAttr(cellProperties, "vert"),
    marginLeft,
    marginRight,
    marginTop,
    marginBottom,
    ...borders,
  }) as PptxTableCellStyle;
  return Object.keys(style).length > 0 ? style : undefined;
}


export function readXmlTableCellBorders(cellProperties: XmlRecord, colorContext: PowerPointColorContext): Partial<PptxTableCellStyle> {
  const top = readXmlTableBorder(getRecord(cellProperties, "a:lnT"), colorContext);
  const bottom = readXmlTableBorder(getRecord(cellProperties, "a:lnB"), colorContext);
  const left = readXmlTableBorder(getRecord(cellProperties, "a:lnL"), colorContext);
  const right = readXmlTableBorder(getRecord(cellProperties, "a:lnR"), colorContext);
  const diagDown = readXmlTableBorder(getRecord(cellProperties, "a:lnTlToBr"), colorContext);
  const diagUp = readXmlTableBorder(getRecord(cellProperties, "a:lnBlToTr"), colorContext);
  return stripUndefinedFields({
    borderTopWidth: top?.widthPx,
    borderTopColor: top?.color,
    borderTopDash: top?.dash,
    borderBottomWidth: bottom?.widthPx,
    borderBottomColor: bottom?.color,
    borderBottomDash: bottom?.dash,
    borderLeftWidth: left?.widthPx,
    borderLeftColor: left?.color,
    borderLeftDash: left?.dash,
    borderRightWidth: right?.widthPx,
    borderRightColor: right?.color,
    borderRightDash: right?.dash,
    borderDiagDownWidth: diagDown?.widthPx,
    borderDiagDownColor: diagDown?.color,
    borderDiagUpWidth: diagUp?.widthPx,
    borderDiagUpColor: diagUp?.color,
  });
}


export function readXmlTableBorder(lineNode: XmlRecord, colorContext: PowerPointColorContext): PowerPointSourceLineStyle | undefined {
  if (Object.keys(lineNode).length === 0) {
    return undefined;
  }
  const line = readLineStyle(lineNode, colorContext);
  if (line?.noStroke) {
    return { noStroke: true, widthPx: 0 };
  }
  return line;
}


export function readTableCellMargin(cellProperties: XmlRecord, attr: string): number | undefined {
  const direct = readNumberAttr(cellProperties, attr);
  if (direct !== undefined) {
    return round(emuToPx(direct));
  }
  const marginNode = getRecord(getRecord(cellProperties, "a:tcMar"), `a:${attr}`);
  const nodeValue = readNumberAttr(marginNode, "w");
  return nodeValue === undefined ? undefined : round(emuToPx(nodeValue));
}


export function readXmlTableParagraphAlign(value: unknown): PptxTableCellStyle["align"] | undefined {
  switch (value) {
    case "left":
    case "center":
    case "right":
    case "justify":
      return value;
    default:
      return undefined;
  }
}


export function readXmlTableVerticalAlign(value: string | undefined): PptxTableCellStyle["vAlign"] | undefined {
  switch (value) {
    case "t":
    case "top":
      return "top";
    case "b":
    case "bottom":
      return "bottom";
    case "ctr":
    case "middle":
      return "middle";
    default:
      return undefined;
  }
}


export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}


export async function readRelationships(zip: JSZip, relsPath: string): Promise<Map<string, Relationship>> {
  const xml = await readZipText(zip, relsPath);
  const result = new Map<string, Relationship>();
  if (!xml) {
    return result;
  }
  const root = parseXmlRecord(xml).Relationships;
  const relationships = getRecordFromValue(root).Relationship;
  for (const rel of asArray(relationships)) {
    const id = readAttr(rel, "Id");
    const target = readAttr(rel, "Target");
    if (!id || !target) {
      continue;
    }
    result.set(id, {
      id,
      target,
      type: readAttr(rel, "Type") ?? "",
      targetMode: readAttr(rel, "TargetMode"),
    });
  }
  return result;
}


export function collectDrawingChildren(spTree: XmlRecord): Array<{ type: string; node: XmlRecord }> {
  const children: Array<{ type: string; node: XmlRecord }> = [];
  for (const [key, value] of Object.entries(spTree)) {
    if (key !== "p:sp" && key !== "p:cxnSp" && key !== "p:pic" && key !== "p:grpSp" && key !== "p:graphicFrame") {
      continue;
    }
    for (const node of asArray(value)) {
      if (isRecord(node)) {
        children.push({ type: key, node });
      }
    }
  }
  return children;
}


export function collectDrawingChildrenInXmlOrder(slideXml: string): Array<{ type: string; node: XmlRecord }> {
  const treeMatch = /<p:spTree\b[\s\S]*?<\/p:spTree>/u.exec(slideXml);
  if (!treeMatch) {
    return [];
  }

  const treeXml = treeMatch[0];
  const entries: Array<{ type: string; node: XmlRecord }> = [];
  const pattern = /<(p:(?:sp|cxnSp|pic|grpSp|graphicFrame))\b[\s\S]*?<\/\1>/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(treeXml))) {
    const type = match[1]!;
    const parsed = parseXmlRecord(match[0]);
    const node = getRecord(parsed, type);
    if (Object.keys(node).length > 0) {
      entries.push({ type, node });
    }
  }
  return entries;
}


export function readBounds(xfrm: XmlRecord): {
  emu: { x: number; y: number; w: number; h: number };
  px: { x: number; y: number; w: number; h: number; unit: "px" };
} {
  const off = getRecord(xfrm, "a:off");
  const ext = getRecord(xfrm, "a:ext");
  const emu = {
    x: readNumberAttr(off, "x") ?? 0,
    y: readNumberAttr(off, "y") ?? 0,
    w: readNumberAttr(ext, "cx") ?? 0,
    h: readNumberAttr(ext, "cy") ?? 0,
  };
  return boundsFromEmu(emu);
}


export function boundsFromEmu(emu: { x: number; y: number; w: number; h: number }): {
  emu: { x: number; y: number; w: number; h: number };
  px: { x: number; y: number; w: number; h: number; unit: "px" };
} {
  return {
    emu,
    px: {
      x: round(emuToPx(emu.x)),
      y: round(emuToPx(emu.y)),
      w: round(emuToPx(emu.w)),
      h: round(emuToPx(emu.h)),
      unit: "px",
    },
  };
}


export interface PowerPointGroupTransform {
  offset: { x: number; y: number };
  childOffset: { x: number; y: number };
  scale: { x: number; y: number };
}


export function readXmlGroupTransform(node: XmlRecord): PowerPointGroupTransform {
  const xfrm = getRecord(getRecord(node, "p:grpSpPr"), "a:xfrm");
  const offset = getRecord(xfrm, "a:off");
  const ext = getRecord(xfrm, "a:ext");
  const childOffset = getRecord(xfrm, "a:chOff");
  const childExt = getRecord(xfrm, "a:chExt");
  const extWidth = readNumberAttr(ext, "cx") ?? 0;
  const extHeight = readNumberAttr(ext, "cy") ?? 0;
  const childWidth = readNumberAttr(childExt, "cx") ?? 0;
  const childHeight = readNumberAttr(childExt, "cy") ?? 0;
  return {
    offset: {
      x: readNumberAttr(offset, "x") ?? 0,
      y: readNumberAttr(offset, "y") ?? 0,
    },
    childOffset: {
      x: readNumberAttr(childOffset, "x") ?? 0,
      y: readNumberAttr(childOffset, "y") ?? 0,
    },
    scale: {
      x: extWidth > 0 && childWidth > 0 ? extWidth / childWidth : 1,
      y: extHeight > 0 && childHeight > 0 ? extHeight / childHeight : 1,
    },
  };
}


export function transformSourceShapeByGroup(
  shape: SlideRenderShape,
  transform: PowerPointGroupTransform,
): SlideRenderShape {
  const emu = {
    x: transform.offset.x + (shape.boundsEmu.x - transform.childOffset.x) * transform.scale.x,
    y: transform.offset.y + (shape.boundsEmu.y - transform.childOffset.y) * transform.scale.y,
    w: shape.boundsEmu.w * Math.abs(transform.scale.x),
    h: shape.boundsEmu.h * Math.abs(transform.scale.y),
  };
  const bounds = boundsFromEmu(emu);
  const lineScale = (Math.abs(transform.scale.x) + Math.abs(transform.scale.y)) / 2;
  return {
    ...shape,
    bounds: bounds.px,
    boundsEmu: bounds.emu,
    ...(shape.line?.widthPx !== undefined ? {
      line: {
        ...shape.line,
        widthPx: round(shape.line.widthPx * lineScale),
      },
    } : {}),
  };
}


export function readGeometryPreset(spPr: XmlRecord, isConnector: boolean, isPicture: boolean): string | undefined {
  if (isPicture) {
    return "picture";
  }
  const preset = readAttr(getRecord(spPr, "a:prstGeom"), "prst");
  if (preset) {
    return preset;
  }
  return isConnector ? "line" : "rect";
}


export function readPresetGeometryAdjustments(spPr: XmlRecord): Record<string, number> | undefined {
  const avLst = getRecord(getRecord(spPr, "a:prstGeom"), "a:avLst");
  const adjustments: Record<string, number> = {};
  for (const guide of asArray(avLst["a:gd"])) {
    const node = getRecordFromValue(guide);
    const name = readAttr(node, "name");
    const value = readAdjustmentGuideValue(readAttr(node, "fmla"));
    if (name && value !== undefined) {
      adjustments[name] = value;
    }
  }
  return Object.keys(adjustments).length > 0 ? adjustments : undefined;
}


export function readAdjustmentGuideValue(formula: string | undefined): number | undefined {
  if (!formula) {
    return undefined;
  }
  const match = /^val\s+(-?\d+(?:\.\d+)?)$/u.exec(formula.trim());
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}


export function readCustomGeometry(spPr: XmlRecord): PowerPointSourceCustomGeometry | undefined {
  const custom = getRecord(spPr, "a:custGeom");
  if (Object.keys(custom).length === 0) {
    return undefined;
  }
  const pathList = getRecord(custom, "a:pathLst");
  const paths = asArray(pathList["a:path"])
    .map((path) => readCustomGeometryPath(getRecordFromValue(path)))
    .filter((path): path is NonNullable<ReturnType<typeof readCustomGeometryPath>> => Boolean(path));
  const pathData = paths.map((path) => path.pathData).filter(Boolean).join(" ");
  const subpaths = paths
    .filter((path) => path.points.length >= 2)
    .map((path) => ({
      points: path.points,
      closed: path.closed,
      pathWidth: path.pathWidth,
      pathHeight: path.pathHeight,
    }));
  const pointCount = paths.reduce((sum, path) => sum + path.pointCount, 0);
  const firstPath = paths[0];
  const unsupportedCommands = Array.from(new Set(paths.flatMap((path) => path.unsupportedCommands)));
  return stripUndefinedFields({
    pathData: pathData || undefined,
    pathWidth: firstPath?.pathWidth,
    pathHeight: firstPath?.pathHeight,
    closed: paths.some((path) => path.closed),
    subpaths: subpaths.length > 0 ? subpaths : undefined,
    pointCount: pointCount || undefined,
    approximatedCurve: paths.some((path) => path.approximatedCurve) || undefined,
    unsupportedCommands: unsupportedCommands.length > 0 ? unsupportedCommands : undefined,
    guideList: jsonSafeValue(getRecord(custom, "a:gdLst")),
    adjustHandles: jsonSafeValue(getRecord(custom, "a:ahLst")),
    connectionSites: jsonSafeValue(getRecord(custom, "a:cxnLst")),
    textRect: jsonSafeValue(getRecord(custom, "a:rect")),
    pathList: jsonSafeValue(getRecord(custom, "a:pathLst")),
  });
}


export function readCustomGeometryPath(path: XmlRecord): {
  pathData: string;
  points: Array<{ x: number; y: number }>;
  pathWidth?: number;
  pathHeight?: number;
  closed: boolean;
  pointCount: number;
  approximatedCurve: boolean;
  unsupportedCommands: string[];
} | null {
  const pathWidth = readNumberAttr(path, "w");
  const pathHeight = readNumberAttr(path, "h");
  const commands: string[] = [];
  const pathPoints: Array<{ x: number; y: number }> = [];
  let pointCount = 0;
  let closed = false;
  let approximatedCurve = false;
  const unsupportedCommands: string[] = [];
  let currentPoint: { x: number; y: number } | null = null;
  let subpathStart: { x: number; y: number } | null = null;
  const pushPointCommand = (prefix: "M" | "L", point: { x: number; y: number }) => {
    commands.push(`${prefix} ${point.x} ${point.y}`);
    pathPoints.push(point);
    currentPoint = point;
    if (prefix === "M") {
      subpathStart = point;
    }
    pointCount += 1;
  };
  for (const [key, value] of Object.entries(path)) {
    if (!key.startsWith("a:")) {
      continue;
    }
    for (const item of asArray(value)) {
      const command = getRecordFromValue(item);
      if (key === "a:moveTo") {
        const point = readCustomGeometryPoint(getRecord(command, "a:pt"));
        if (point) {
          pushPointCommand("M", point);
        }
      } else if (key === "a:lnTo") {
        const point = readCustomGeometryPoint(getRecord(command, "a:pt"));
        if (point) {
          pushPointCommand("L", point);
        }
      } else if (key === "a:close") {
        commands.push("Z");
        closed = true;
        const startPoint = subpathStart as { x: number; y: number } | null;
        if (startPoint) {
          currentPoint = startPoint;
          const lastPoint = pathPoints[pathPoints.length - 1];
          if (!lastPoint || lastPoint.x !== startPoint.x || lastPoint.y !== startPoint.y) {
            pathPoints.push(startPoint);
          }
        }
      } else if (key === "a:quadBezTo") {
        const points = asArray(command["a:pt"])
          .map((point) => readCustomGeometryPoint(getRecordFromValue(point)))
          .filter((point): point is { x: number; y: number } => Boolean(point));
        if (currentPoint && points.length >= 2) {
          for (const point of sampleQuadraticBezier(currentPoint, points[0]!, points[1]!)) {
            pushPointCommand("L", point);
          }
          approximatedCurve = true;
        }
      } else if (key === "a:cubicBezTo") {
        const points = asArray(command["a:pt"])
          .map((point) => readCustomGeometryPoint(getRecordFromValue(point)))
          .filter((point): point is { x: number; y: number } => Boolean(point));
        if (currentPoint && points.length >= 3) {
          for (const point of sampleCubicBezier(currentPoint, points[0]!, points[1]!, points[2]!)) {
            pushPointCommand("L", point);
          }
          approximatedCurve = true;
        }
      } else if (key === "a:arcTo") {
        const points = currentPoint ? sampleOoxmlArc(currentPoint, command) : [];
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
  }
  return commands.length > 0 ? {
    pathData: commands.join(" "),
    points: pathPoints,
    pathWidth,
    pathHeight,
    closed,
    pointCount,
    approximatedCurve,
    unsupportedCommands,
  } : null;
}


export function sampleQuadraticBezier(
  start: { x: number; y: number },
  control: { x: number; y: number },
  end: { x: number; y: number },
): Array<{ x: number; y: number }> {
  return Array.from({ length: 16 }, (_, index) => {
    const t = (index + 1) / 16;
    const mt = 1 - t;
    return {
      x: round(mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x),
      y: round(mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y),
    };
  });
}


export function sampleCubicBezier(
  start: { x: number; y: number },
  control1: { x: number; y: number },
  control2: { x: number; y: number },
  end: { x: number; y: number },
): Array<{ x: number; y: number }> {
  return Array.from({ length: 24 }, (_, index) => {
    const t = (index + 1) / 24;
    const mt = 1 - t;
    return {
      x: round(mt * mt * mt * start.x + 3 * mt * mt * t * control1.x + 3 * mt * t * t * control2.x + t * t * t * end.x),
      y: round(mt * mt * mt * start.y + 3 * mt * mt * t * control1.y + 3 * mt * t * t * control2.y + t * t * t * end.y),
    };
  });
}


export function sampleOoxmlArc(
  start: { x: number; y: number },
  command: XmlRecord,
): Array<{ x: number; y: number }> {
  const radiusX = readNumberAttr(command, "wR");
  const radiusY = readNumberAttr(command, "hR");
  const startAngle = readOoxmlAngleAttr(command, "stAng");
  const sweepAngle = readOoxmlAngleAttr(command, "swAng");
  const explicitEndpoint = readOoxmlArcEndpoint(command);
  if (radiusX === undefined || radiusY === undefined || radiusX === 0 || radiusY === 0) {
    if (explicitEndpoint) {
      return [explicitEndpoint];
    }
    if (startAngle === undefined || sweepAngle === undefined) {
      return [start];
    }
    const resolvedRadiusX = radiusX ?? 0;
    const resolvedRadiusY = radiusY ?? 0;
    const endRadians = degreesToRadians(startAngle + sweepAngle);
    const startRadians = degreesToRadians(startAngle);
    return [{
      x: round(start.x + resolvedRadiusX * (Math.cos(endRadians) - Math.cos(startRadians))),
      y: round(start.y + resolvedRadiusY * (Math.sin(endRadians) - Math.sin(startRadians))),
    }];
  }
  if (startAngle === undefined || sweepAngle === undefined) {
    if (explicitEndpoint) {
      return [explicitEndpoint];
    }
    return [];
  }
  const startRadians = degreesToRadians(startAngle);
  const center = {
    x: start.x - radiusX * Math.cos(startRadians),
    y: start.y - radiusY * Math.sin(startRadians),
  };
  const segmentCount = Math.max(4, Math.min(32, Math.ceil(Math.abs(sweepAngle) / 15)));
  return Array.from({ length: segmentCount }, (_, index) => {
    const t = (index + 1) / segmentCount;
    const angle = degreesToRadians(startAngle + sweepAngle * t);
    return {
      x: round(center.x + radiusX * Math.cos(angle)),
      y: round(center.y + radiusY * Math.sin(angle)),
    };
  });
}


export function readOoxmlArcEndpoint(command: XmlRecord): { x: number; y: number } | null {
  const end = getRecord(command, "a:end");
  const nestedPoint = getRecord(end, "a:pt");
  const point = Object.keys(nestedPoint).length > 0 ? nestedPoint : end;
  const x = readNumberAttr(point, "x");
  const y = readNumberAttr(point, "y");
  return x === undefined || y === undefined ? null : { x, y };
}


export function readOoxmlAngleAttr(node: XmlRecord, name: string): number | undefined {
  const value = readNumberAttr(node, name);
  return value === undefined ? undefined : value / 60000;
}


export function readCustomGeometryPoint(point: XmlRecord): { x: number; y: number } | null {
  const x = readNumberAttr(point, "x");
  const y = readNumberAttr(point, "y");
  if (x === undefined || y === undefined) {
    return null;
  }
  return {
    x,
    y,
  };
}


export function extractTextFromOmml(ommlValue: XmlValue): string {
  const ommlNode = getRecordFromValue(ommlValue);
  const textElements = findAllXmlElementsByKey(ommlNode, "m:t");
  return textElements.map((elem) => readXmlTextValue(elem)).join("");
}


export function findAllXmlElementsByKey(obj: XmlValue, key: string): XmlValue[] {
  const results: XmlValue[] = [];

  function search(current: XmlValue): void {
    if (!current || typeof current !== "object") {
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        search(item);
      }
    } else {
      for (const [objKey, value] of Object.entries(current)) {
        if (objKey === key) {
          if (Array.isArray(value)) {
            results.push(...value);
          } else {
            results.push(value);
          }
        }
        search(value);
      }
    }
  }

  search(obj);
  return results;
}


export function readTextBody(txBody: XmlRecord, colorContext: PowerPointColorContext): { plainText: string; paragraphs: string[]; segments?: TextSegment[] } {
  const paragraphNodes = asArray(txBody["a:p"]);
  const paragraphs = paragraphNodes
    .map(readParagraphText)
    .filter((text) => text.length > 0);
  const fontScale = readPowerPointAutoFitFontScale(txBody);
  const segments = paragraphNodes
    .flatMap((paragraph, index) => readParagraphTextSegments(paragraph, colorContext, index))
    .map((segment) => (fontScale === undefined
      ? segment
      : { ...segment, style: { ...segment.style, autoFitFontScale: fontScale } }));
  return {
    plainText: paragraphs.join("\n"),
    paragraphs,
    ...(segments.length > 0 ? { segments } : {}),
  };
}


/**
 * `a:normAutofit/@fontScale` is how PowerPoint shrinks overflowing text to fit its
 * box (hundred-thousandths, so 62500 = 62.5%). Ignoring it renders the text at its
 * nominal size and spills it out of the shape.
 */
export function readPowerPointAutoFitFontScale(txBody: XmlRecord): number | undefined {
  const normAutofit = getRecord(getRecord(txBody, "a:bodyPr"), "a:normAutofit");
  const fontScale = readNumberAttr(normAutofit, "fontScale");
  if (fontScale === undefined) {
    return undefined;
  }
  const scale = fontScale / 100000;
  return Number.isFinite(scale) && scale > 0 && scale <= 1 ? scale : undefined;
}


export function readParagraphText(paragraph: XmlValue): string {
  const node = getRecordFromValue(paragraph);
  const texts: string[] = [];
  for (const child of asPowerPointTextChildren(node)) {
    if (child.type === "a:br") {
      texts.push("\n");
    } else if (child.type === "m:oMath") {
      const ommlText = extractTextFromOmml(child.value);
      if (ommlText) {
        texts.push(ommlText);
      }
    } else {
      const run = getRecordFromValue(child.value);
      const runText = readXmlTextValue(run["a:t"]);
      if (runText) {
        texts.push(runText);
      }
    }
  }
  return texts.join("");
}


export function readParagraphTextSegments(paragraph: XmlValue, colorContext: PowerPointColorContext, paragraphIndex: number): TextSegment[] {
  const node = getRecordFromValue(paragraph);
  const paragraphProperties = getRecord(node, "a:pPr");
  const paragraphStyle = readPowerPointTextStyle(paragraphProperties, colorContext);
  const paragraphLevel = readNumberAttr(paragraphProperties, "lvl") ?? 0;
  const bulletInfo = readPowerPointBulletInfo(paragraphProperties, colorContext);
  const segments: TextSegment[] = [];
  const pushText = (text: string, style: Record<string, unknown>, isLineBreak = false) => {
    segments.push({
      text,
      isLineBreak,
      isParagraphBreak: false,
      paragraphIndex,
      paragraphLevel,
      bulletInfo,
      style,
    } as unknown as TextSegment);
  };

  for (const child of asPowerPointTextChildren(node)) {
    if (child.type === "a:br") {
      pushText("\n", paragraphStyle, true);
      continue;
    }
    if (child.type === "m:oMath") {
      const ommlText = extractTextFromOmml(child.value);
      if (ommlText) {
        pushText(ommlText, paragraphStyle);
      }
      continue;
    }
    const run = getRecordFromValue(child.value);
    const runText = child.type === "a:fld"
      ? readXmlTextValue(run["a:t"])
      : readXmlTextValue(run["a:t"]);
    if (!runText) {
      continue;
    }
    const runStyle = readPowerPointTextStyle(getRecord(run, "a:rPr"), colorContext);
    pushText(runText, { ...paragraphStyle, ...runStyle });
  }
  if (segments.length > 0) {
    segments.push({
      text: "",
      isLineBreak: false,
      isParagraphBreak: true,
      paragraphIndex,
      paragraphLevel,
      bulletInfo,
      style: paragraphStyle,
    } as unknown as TextSegment);
  }
  return segments;
}


export function readPowerPointBulletInfo(properties: XmlRecord, colorContext: PowerPointColorContext): TextSegment["bulletInfo"] | undefined {
  if (hasXmlKey(properties, "a:buNone")) {
    return { none: true } as TextSegment["bulletInfo"];
  }
  const char = readAttr(getRecord(properties, "a:buChar"), "char");
  const autoNum = getRecord(properties, "a:buAutoNum");
  const imageBullet = getRecord(properties, "a:buBlip");
  const font = getRecord(properties, "a:buFont");
  const bulletColor = readPowerPointBulletColor(properties, colorContext);
  const bulletSize = readPowerPointBulletSize(properties);
  const bulletInfo = stripUndefinedFields({
    char,
    autoNumType: readAttr(autoNum, "type"),
    autoNumStartAt: readNumberAttr(autoNum, "startAt"),
    imageRelId: readAttr(getRecord(imageBullet, "a:blip"), "r:embed") ?? readAttr(getRecord(imageBullet, "a:blip"), "r:link"),
    color: bulletColor,
    fontFamily: readAttr(font, "typeface"),
    sizePts: bulletSize,
    none: undefined,
  });
  return Object.keys(bulletInfo).length > 0 ? bulletInfo as TextSegment["bulletInfo"] : undefined;
}


export function readPowerPointBulletColor(properties: XmlRecord, colorContext: PowerPointColorContext): string | undefined {
  const color = readColor(getRecord(properties, "a:buClr"), colorContext);
  if (color) {
    return color;
  }
  return hasXmlKey(properties, "a:buClrTx") ? readColor(properties, colorContext) : undefined;
}


export function readPowerPointBulletSize(properties: XmlRecord): number | undefined {
  const explicitPoints = readNumberAttr(getRecord(properties, "a:buSzPts"), "val");
  if (explicitPoints !== undefined) {
    return explicitPoints / 100;
  }
  const percentage = readNumberAttr(getRecord(properties, "a:buSzPct"), "val");
  return percentage === undefined ? undefined : percentage / 1000;
}


export function asPowerPointTextChildren(node: XmlRecord): Array<{ type: string; value: XmlValue }> {
  const children: Array<{ type: string; value: XmlValue }> = [];
  for (const [key, value] of Object.entries(node)) {
    if (key !== "a:r" && key !== "a:fld" && key !== "a:br" && key !== "m:oMath") {
      continue;
    }
    for (const item of asArray(value)) {
      children.push({ type: key, value: item });
    }
  }
  return children;
}


export function readPowerPointTextStyle(properties: XmlRecord, colorContext: PowerPointColorContext): Record<string, unknown> {
  const color = readColor(properties, colorContext);
  const fontSize = readNumberAttr(properties, "sz");
  return stripUndefinedFields({
    bold: readOptionalBooleanAttr(properties, "b"),
    italic: readOptionalBooleanAttr(properties, "i"),
    underline: hasPowerPointUnderline(properties),
    color,
    fontSize: fontSize === undefined ? undefined : fontSize / 100,
    fontFamily: readAttr(getRecord(properties, "a:latin"), "typeface") ?? readAttr(getRecord(properties, "a:ea"), "typeface"),
    align: readAttr(properties, "algn"),
    lineSpacing: readPowerPointLineSpacing(properties),
  });
}


export function hasPowerPointUnderline(properties: XmlRecord): boolean | undefined {
  const underline = readAttr(properties, "u");
  if (underline === undefined) {
    return undefined;
  }
  return underline !== "none";
}


export function readPowerPointLineSpacing(properties: XmlRecord): string | undefined {
  const spacing = getRecord(getRecord(properties, "a:lnSpc"), "a:spcPct");
  const value = readNumberAttr(spacing, "val");
  return value === undefined ? undefined : String(value / 100000);
}


export function readLineStyle(ln: XmlRecord, colorContext: PowerPointColorContext): PowerPointSourceLineStyle | undefined {
  if (Object.keys(ln).length === 0) {
    return undefined;
  }
  if (hasXmlKey(ln, "a:noFill")) {
    return { noStroke: true };
  }
  return {
    color: readColor(ln, colorContext) ?? "#111111",
    widthPx: round(emuToPx(readNumberAttr(ln, "w") ?? 9525)),
    dash: readAttr(getRecord(ln, "a:prstDash"), "val") ?? undefined,
    beginArrow: readAttr(getRecord(ln, "a:tailEnd"), "type") ?? undefined,
    endArrow: readAttr(getRecord(ln, "a:headEnd"), "type") ?? undefined,
    opacity: readAlpha(ln),
  };
}


export function readFillStyle(spPr: XmlRecord, colorContext: PowerPointColorContext): PowerPointSourceFillStyle | undefined {
  if (hasXmlKey(spPr, "a:noFill")) {
    return { type: "none" };
  }
  const solid = getRecord(spPr, "a:solidFill");
  if (Object.keys(solid).length > 0) {
    return {
      type: "solid",
      color: readColor(solid, colorContext) ?? "#ffffff",
      opacity: readAlpha(solid),
    };
  }
  const grad = getRecord(spPr, "a:gradFill");
  if (Object.keys(grad).length > 0) {
    const stops = readGradientStops(grad, colorContext);
    return {
      type: "gradient",
      color: stops[0]?.color ?? readColor(grad, colorContext),
      opacity: stops[0]?.opacity,
      stops: stops.length > 0 ? stops : undefined,
      raw: "a:gradFill",
    };
  }
  const pattern = getRecord(spPr, "a:pattFill");
  if (Object.keys(pattern).length > 0) {
    const patternFill = readPatternFill(pattern, colorContext);
    return {
      type: "pattern",
      color: patternFill.foregroundColor ?? patternFill.backgroundColor,
      pattern: patternFill,
      raw: "a:pattFill",
    };
  }
  return undefined;
}


export function readGradientStops(gradFill: XmlRecord, colorContext: PowerPointColorContext): NonNullable<PowerPointSourceFillStyle["stops"]> {
  const stopList = getRecord(gradFill, "a:gsLst");
  return asArray(stopList["a:gs"])
    .map((value) => {
      const stop = getRecordFromValue(value);
      return stripUndefinedFields({
        position: readOoxmlFractionAttr(stop, "pos"),
        color: readColor(stop, colorContext),
        opacity: readAlpha(stop),
      });
    })
    .filter((stop) => stop.color || stop.position !== undefined || stop.opacity !== undefined);
}


export function readPatternFill(pattern: XmlRecord, colorContext: PowerPointColorContext): NonNullable<PowerPointSourceFillStyle["pattern"]> {
  return stripUndefinedFields({
    preset: readAttr(pattern, "prst") ?? "pct5",
    foregroundColor: readColor(getRecord(pattern, "a:fgClr"), colorContext) ?? "#000000",
    backgroundColor: readColor(getRecord(pattern, "a:bgClr"), colorContext) ?? "#ffffff",
  });
}


export function readColor(container: XmlRecord, colorContext: PowerPointColorContext): string | undefined {
  const directNode = getRecord(container, "a:srgbClr");
  const direct = normalizeHexColor(readAttr(directNode, "val"));
  if (direct) {
    return applyOoxmlColorTransforms(direct, directNode);
  }
  const schemeNode = getRecord(container, "a:schemeClr");
  const scheme = readAttr(schemeNode, "val");
  if (scheme) {
    return applyOoxmlColorTransforms(resolveSchemeColor(scheme, colorContext), schemeNode);
  }
  const sysNode = getRecord(container, "a:sysClr");
  const sys = normalizeHexColor(readAttr(sysNode, "lastClr"));
  if (sys) {
    return applyOoxmlColorTransforms(sys, sysNode);
  }
  const solid = getRecord(container, "a:solidFill");
  if (Object.keys(solid).length > 0) {
    return readColor(solid, colorContext);
  }
  const gradientStop = asArray(getRecord(container, "a:gs"))
    .find((value) => isRecord(value) && Object.keys(value).length > 0);
  return isRecord(gradientStop) ? readColor(gradientStop, colorContext) : undefined;
}


export function readAlpha(container: XmlRecord): number | undefined {
  const colorNode = [
    getRecord(container, "a:srgbClr"),
    getRecord(container, "a:schemeClr"),
    getRecord(container, "a:sysClr"),
  ].find((node) => Object.keys(node).length > 0) ?? container;
  const alpha = readNumberAttr(getRecord(colorNode, "a:alpha"), "val") ?? readNumberAttr(getRecord(container, "a:alpha"), "val");
  return alpha === undefined ? undefined : clamp(alpha / 100000, 0, 1);
}


export function readRotation(xfrm: XmlRecord): number {
  return round((readNumberAttr(xfrm, "rot") ?? 0) / 60000);
}


export function readFlip(xfrm: XmlRecord): PowerPointSourceShape["flip"] | undefined {
  const horizontal = readBooleanAttr(xfrm, "flipH");
  const vertical = readBooleanAttr(xfrm, "flipV");
  return horizontal || vertical ? { horizontal, vertical } : undefined;
}


export function readSourceRectCrop(srcRect: XmlRecord): PowerPointSourceImageCrop | undefined {
  const crop = {
    left: readOoxmlFractionAttr(srcRect, "l"),
    top: readOoxmlFractionAttr(srcRect, "t"),
    right: readOoxmlFractionAttr(srcRect, "r"),
    bottom: readOoxmlFractionAttr(srcRect, "b"),
  };
  return Object.values(crop).some((value) => value !== undefined) ? crop : undefined;
}


export function readBlipOpacity(blip: XmlRecord): number | undefined {
  const alphaModFix = readNumberAttr(getRecord(blip, "a:alphaModFix"), "amt");
  if (alphaModFix !== undefined) {
    return clamp(alphaModFix / 100000, 0, 1);
  }
  const alphaMod = readNumberAttr(getRecord(blip, "a:alphaMod"), "amt");
  if (alphaMod !== undefined) {
    return clamp(alphaMod / 100000, 0, 1);
  }
  const alphaReplace = readNumberAttr(getRecord(blip, "a:alphaRepl"), "a");
  if (alphaReplace !== undefined) {
    return clamp(alphaReplace / 100000, 0, 1);
  }
  return undefined;
}


export function readBlipEffects(blip: XmlRecord): unknown {
  const effectKeys = [
    "a:alphaBiLevel",
    "a:alphaCeiling",
    "a:alphaFloor",
    "a:alphaInv",
    "a:alphaMod",
    "a:alphaModFix",
    "a:alphaRepl",
    "a:biLevel",
    "a:blur",
    "a:clrChange",
    "a:clrRepl",
    "a:duotone",
    "a:fillOverlay",
    "a:grayscl",
    "a:hsl",
    "a:lum",
    "a:tint",
  ];
  const effects: Record<string, unknown> = {};
  for (const key of effectKeys) {
    const value = blip[key];
    if (value !== undefined) {
      effects[key] = jsonSafeValue(value);
    }
  }
  return Object.keys(effects).length > 0 ? effects : undefined;
}


export function readBlipFillMode(blipFill: XmlRecord): unknown {
  const tile = getRecord(blipFill, "a:tile");
  if (Object.keys(tile).length > 0) {
    return stripUndefinedFields({
      mode: "tile",
      offsetX: readNumberAttr(tile, "tx"),
      offsetY: readNumberAttr(tile, "ty"),
      scaleX: readOoxmlFractionAttr(tile, "sx"),
      scaleY: readOoxmlFractionAttr(tile, "sy"),
      flip: readAttr(tile, "flip"),
      alignment: readAttr(tile, "algn"),
      raw: jsonSafeValue(tile),
    });
  }

  const stretch = getRecord(blipFill, "a:stretch");
  if (Object.keys(stretch).length > 0) {
    return stripUndefinedFields({
      mode: "stretch",
      fillRect: readBlipFillRect(getRecord(stretch, "a:fillRect")),
      raw: jsonSafeValue(stretch),
    });
  }
  return undefined;
}


export function readBlipFillRect(fillRect: XmlRecord): { left?: number; top?: number; right?: number; bottom?: number } | undefined {
  const rect = stripUndefinedFields({
    left: readOoxmlFractionAttr(fillRect, "l"),
    top: readOoxmlFractionAttr(fillRect, "t"),
    right: readOoxmlFractionAttr(fillRect, "r"),
    bottom: readOoxmlFractionAttr(fillRect, "b"),
  });
  return Object.keys(rect).length > 0 ? rect : undefined;
}


export function withXmlConnectorConnections(
  line: PowerPointSourceLineStyle | undefined,
  cNvCxnSpPr: XmlRecord,
): PowerPointSourceLineStyle | undefined {
  const connectionStart = readXmlConnectorConnection(getRecord(cNvCxnSpPr, "a:stCxn"));
  const connectionEnd = readXmlConnectorConnection(getRecord(cNvCxnSpPr, "a:endCxn"));
  if (!connectionStart && !connectionEnd) {
    return line;
  }
  return {
    ...(line ?? {}),
    ...(connectionStart ? { connectionStart } : {}),
    ...(connectionEnd ? { connectionEnd } : {}),
  };
}


export function readXmlConnectorConnection(node: XmlRecord): PowerPointConnectorConnection | undefined {
  const shapeId = readAttr(node, "id");
  const connectionSiteIndex = readNumberAttr(node, "idx");
  if (!shapeId && connectionSiteIndex === undefined) {
    return undefined;
  }
  return stripUndefinedFields({
    shapeId,
    targetSourceId: shapeId,
    connectionSiteIndex,
  });
}


export function readOoxmlFractionAttr(value: XmlValue, key: string): number | undefined {
  const numberValue = readNumberAttr(value, key);
  if (numberValue === undefined) {
    return undefined;
  }
  return clamp01(numberValue > 1 ? numberValue / 100000 : numberValue);
}


export function readBooleanAttr(value: XmlValue, key: string): boolean {
  const text = readAttr(value, key);
  return text === "1" || text === "true";
}


export function readOptionalBooleanAttr(value: XmlValue, key: string): boolean | undefined {
  const text = readAttr(value, key);
  if (text === undefined) {
    return undefined;
  }
  return text === "1" || text === "true";
}


export function createConversionCandidate(
  kind: PowerPointSourceShape["kind"],
  preset: string | undefined,
  line: PowerPointSourceLineStyle | undefined,
  text: string,
  customGeometry?: PowerPointSourceCustomGeometry,
): PowerPointConversionCandidate {
  if (kind === "picture") {
    return { sigmaKind: "image", confidence: "high", reason: "PowerPoint picture maps to a Sigma overlay image asset." };
  }
  if (kind === "background") {
    return { sigmaKind: "geo", confidence: "high", reason: "PowerPoint slide background maps to a Sigma background-layer overlay shape." };
  }
  if (kind === "table") {
    return { sigmaKind: "table", confidence: "high", reason: "PowerPoint graphicFrame table maps to a Sigma editable tableShape." };
  }
  if (kind === "group") {
    return { sigmaKind: "group", confidence: "high", reason: "PowerPoint group maps to a Sigma overlay group with editable child shapes." };
  }
  if (kind === "chart") {
    return { sigmaKind: "group", confidence: "medium", reason: "PowerPoint chart data maps to an editable Sigma overlay group when chartData is available; exact rendering metadata is preserved." };
  }
  if (kind === "smartArt") {
    return { sigmaKind: "group", confidence: "medium", reason: "PowerPoint SmartArt nodes/drawing shapes map to an editable Sigma overlay group when smartArtData is available; exact rendering metadata is preserved." };
  }
  if (kind === "ink") {
    return { sigmaKind: "polyline", confidence: "medium", reason: "PowerPoint ink strokes map to editable Sigma freehand line shapes; pressure metadata is preserved separately when available." };
  }
  if (kind === "ole") {
    return { sigmaKind: "image", confidence: "medium", reason: "PowerPoint OLE object maps to a preview image with embedded object metadata preserved for AI and future editing." };
  }
  if (kind === "media") {
    return { sigmaKind: "image", confidence: "medium", reason: "PowerPoint media object maps to a poster-frame image with media playback metadata preserved." };
  }
  if (kind === "zoom") {
    return { sigmaKind: "image", confidence: "medium", reason: "PowerPoint Zoom object maps to a thumbnail image with target slide/section metadata preserved." };
  }
  if (kind === "model3d") {
    return { sigmaKind: "image", confidence: "medium", reason: "PowerPoint 3D model maps to a poster/preview image with model metadata preserved." };
  }
  if (text && kind === "textBox") {
    return { sigmaKind: "text", confidence: "high", reason: "PowerPoint text body maps to a Sigma overlay text shape." };
  }
  if (kind === "connector" || kind === "line" || isLinePreset(preset)) {
    return {
      sigmaKind: line?.beginArrow || line?.endArrow ? "arrow" : "line",
      confidence: "high",
      reason: "PowerPoint connector/line geometry maps to Sigma line or arrow shape.",
    };
  }
  if (preset === "arc" || preset === "pie") {
    return { sigmaKind: "arc", confidence: "medium", reason: "PowerPoint arc or sector preset maps to a Sigma arc shape." };
  }
  if (preset === "custom" && customGeometry?.pathData) {
    return { sigmaKind: "polyline", confidence: "medium", reason: "PowerPoint custom geometry path is preserved and simple numeric line paths map to editable Sigma polyline shapes." };
  }
  if (computePresetGeometryPoints(preset, 1, 1)) {
    return { sigmaKind: "polyline", confidence: "medium", reason: "PowerPoint preset geometry maps to an editable Sigma polyline shape." };
  }
  if (preset === "rect" || preset === "roundRect" || preset === "ellipse" || preset === "triangle" || preset === "diamond") {
    return { sigmaKind: "geo", confidence: "high", reason: "PowerPoint preset geometry maps to a Sigma geo shape." };
  }
  return { sigmaKind: "unsupported", confidence: "low", reason: "PowerPoint geometry is preserved as source metadata for future conversion." };
}


export function isTextBoxPreset(preset: string | undefined): boolean {
  return !preset || preset === "rect";
}


export function isLinePreset(preset: string | undefined): boolean {
  return preset === "line" || preset === "straightConnector1";
}


export function resolveSchemeColor(value: string, colorContext: PowerPointColorContext): string {
  const mapped = colorContext.colorMap[value] ?? DEFAULT_COLOR_MAP[value] ?? value;
  return colorContext.colorScheme[mapped] ?? colorContext.colorScheme[value] ?? DEFAULT_SCHEME_COLORS[mapped] ?? DEFAULT_SCHEME_COLORS[value] ?? "#111111";
}


export function applyOoxmlColorTransforms(color: string, node: XmlRecord): string {
  const rgb = parseHexColor(color);
  if (!rgb) {
    return color;
  }

  let transformed = rgb;
  const tint = readOoxmlPercentChild(node, "a:tint");
  if (tint !== undefined) {
    transformed = mixRgb(transformed, { r: 255, g: 255, b: 255 }, 1 - tint);
  }
  const shade = readOoxmlPercentChild(node, "a:shade");
  if (shade !== undefined) {
    transformed = mixRgb({ r: 0, g: 0, b: 0 }, transformed, shade);
  }

  const lumMod = readOoxmlPercentChild(node, "a:lumMod");
  const lumOff = readOoxmlPercentChild(node, "a:lumOff");
  if (lumMod !== undefined || lumOff !== undefined) {
    transformed = applyRgbLuminanceTransform(transformed, lumMod ?? 1, lumOff ?? 0);
  }

  return rgbToHex(transformed);
}


export function readOoxmlPercentChild(node: XmlRecord, key: string): number | undefined {
  const value = readNumberAttr(getRecord(node, key), "val");
  return value === undefined ? undefined : clamp(value / 100000, 0, 2);
}


export function normalizeHexColor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim().replace(/^#/u, "");
  return /^[0-9a-f]{6}$/iu.test(trimmed) ? `#${trimmed.toUpperCase()}` : undefined;
}


export function parseHexColor(color: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHexColor(color);
  if (!normalized) {
    return null;
  }
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}


export function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}


export function mixRgb(
  from: { r: number; g: number; b: number },
  to: { r: number; g: number; b: number },
  amount: number,
): { r: number; g: number; b: number } {
  const clamped = clamp(amount, 0, 1);
  return {
    r: from.r + (to.r - from.r) * clamped,
    g: from.g + (to.g - from.g) * clamped,
    b: from.b + (to.b - from.b) * clamped,
  };
}


export function applyRgbLuminanceTransform(
  rgb: { r: number; g: number; b: number },
  lumMod: number,
  lumOff: number,
): { r: number; g: number; b: number } {
  const hsl = rgbToHsl(rgb);
  hsl.l = clamp01(hsl.l * lumMod + lumOff);
  return hslToRgb(hsl);
}


export function rgbToHsl(rgb: { r: number; g: number; b: number }): { h: number; s: number; l: number } {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l };
  }
  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const h = max === r
    ? ((g - b) / delta + (g < b ? 6 : 0)) / 6
    : max === g
      ? ((b - r) / delta + 2) / 6
      : ((r - g) / delta + 4) / 6;
  return { h, s, l };
}


export function hslToRgb(hsl: { h: number; s: number; l: number }): { r: number; g: number; b: number } {
  if (hsl.s === 0) {
    const gray = hsl.l * 255;
    return { r: gray, g: gray, b: gray };
  }
  const q = hsl.l < 0.5 ? hsl.l * (1 + hsl.s) : hsl.l + hsl.s - hsl.l * hsl.s;
  const p = 2 * hsl.l - q;
  return {
    r: hueToRgb(p, q, hsl.h + 1 / 3) * 255,
    g: hueToRgb(p, q, hsl.h) * 255,
    b: hueToRgb(p, q, hsl.h - 1 / 3) * 255,
  };
}


export function hueToRgb(p: number, q: number, t: number): number {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}


export function relationshipPathForPart(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  const dir = slash >= 0 ? partPath.slice(0, slash) : "";
  const file = slash >= 0 ? partPath.slice(slash + 1) : partPath;
  return `${dir}/_rels/${file}.rels`;
}


export function resolvePartPath(sourcePartPath: string, target: string): string {
  if (/^[a-z]+:/iu.test(target)) {
    return target;
  }
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  const slash = sourcePartPath.lastIndexOf("/");
  const base = slash >= 0 ? sourcePartPath.slice(0, slash + 1) : "";
  const segments = `${base}${target}`.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join("/");
}


export async function readZipText(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  return file ? file.async("text") : null;
}


export function parseXmlRecord(xml: string): XmlRecord {
  const parsed = parser.parse(xml);
  return isRecord(parsed) ? parsed : {};
}


export type XmlValue = string | number | boolean | XmlRecord | XmlValue[] | null | undefined;

export interface XmlRecord {
  [key: string]: XmlValue;
}


export function getRecord(parent: XmlValue, key: string): XmlRecord {
  const record = getRecordFromValue(parent);
  return getRecordFromValue(record[key]);
}


export function getRecordFromValue(value: XmlValue): XmlRecord {
  if (Array.isArray(value)) {
    return getRecordFromValue(value[0]);
  }
  return isRecord(value) ? value : {};
}


export function getRecordFromUnknown(value: unknown): XmlRecord {
  return isRecord(value) ? value : {};
}


export function asArray(value: XmlValue): XmlValue[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}


export function readAttr(value: XmlValue, key: string): string | undefined {
  const record = getRecordFromValue(value);
  const direct = record[`@_${key}`] ?? record[key];
  return direct === undefined || direct === null ? undefined : String(direct);
}


export function readRawXmlAttributes(value: XmlValue, excludedKeys = new Set<string>()): Record<string, string> | undefined {
  const record = getRecordFromValue(value);
  const attributes: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    if (!key.startsWith("@_")) {
      continue;
    }
    const attrName = key.slice(2);
    if (excludedKeys.has(attrName) || rawValue === undefined || rawValue === null) {
      continue;
    }
    attributes[attrName] = String(rawValue);
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}


export function readNumberAttr(value: XmlValue, key: string): number | undefined {
  const text = readAttr(value, key);
  if (text === undefined) {
    return undefined;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}


export function readTextValue(value: XmlValue): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}


export function readXmlTextValue(value: XmlValue): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const record = getRecordFromValue(value);
  return readTextValue(record["#text"]);
}


export function isRecord(value: unknown): value is XmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


export function hasXmlKey(value: XmlRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}


export function emuToPx(emu: number): number {
  return emu / EMU_PER_PX;
}


export function round(value: number, precision = 3): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}


export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}


export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}


export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}


export function jsonSafeValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}


export function stripUndefinedFields<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}


export function imageMimeType(path: string): string | undefined {
  if (/\.png$/iu.test(path)) return "image/png";
  if (/\.jpe?g$/iu.test(path)) return "image/jpeg";
  if (/\.gif$/iu.test(path)) return "image/gif";
  if (/\.webp$/iu.test(path)) return "image/webp";
  if (/\.svg$/iu.test(path)) return "image/svg+xml";
  return undefined;
}


export function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}