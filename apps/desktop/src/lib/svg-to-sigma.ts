import { normalizeOverlayGroups, pruneUnusedOverlayAssets, type OverlayAnchor, type OverlayAsset, type OverlayBounds, type OverlayShape, type OverlaySnapshot } from "@/features/document";
import { flipShapesAround, getCroppedImageLayout, getShapesSelectionBounds, MIN_IMAGE_CROP_RATIO, multiplySvgMatrices, parseSvgTransform, rotateShapesAround, svgNumbers, svgPrimitiveToShapes, type SvgMarkerDefinition, type SvgMarkerLookup, type SvgMatrix } from "@/features/drawing";
import { createId } from "./id";
import { svgFontSizePx, svgTextToOverlay, type MeasureSvgOverlayText } from "./svg-text-to-overlay";
import { childrenOf, decodeSvgDataUrl, parseStaticSvg, resolvedAttrs, svgViewport, tagOf, SvgConversionError, type SvgFragmentNode, type XmlNode } from "./svg-image-source";
export { decodeSvgDataUrl, SvgConversionError } from "./svg-image-source";

const INHERITED = new Set(("fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset " +
  "color font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline letter-spacing text-decoration visibility marker-start marker-mid marker-end xml:space").split(" "));

export function isSvgImageAsset(asset: OverlayAsset | undefined): boolean {
  return Boolean(asset && (asset.props.mimeType === "image/svg+xml" || /^data:image\/svg\+xml[;,]/i.test(asset.props.src)));
}

function escapeXml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function serialize(node: XmlNode): string {
  const tag = tagOf(node);
  if (tag === "#text") return escapeXml(String(node[tag]));
  const attrs = Object.entries(node[":@"] ?? {}).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join("");
  return `<${tag}${attrs}>${childrenOf(node).map(serialize).join("")}</${tag}>`;
}
function measurementNode(node: XmlNode): SvgFragmentNode {
  return { tag: tagOf(node), attrs: { ...node[":@"] }, children: childrenOf(node).map((child) => tagOf(child) === "#text" ? String(child["#text"]) : measurementNode(child)) };
}
const inheritedOf = (attrs: Record<string, string>) => Object.fromEntries(Object.entries(attrs).filter(([key]) => INHERITED.has(key)));
/** Markers whose drawing and geometry are plain numbers; a marker that is anything else stays SVG. */
function markerDefinition(node: XmlNode, inherited: Record<string, string>): SvgMarkerDefinition | null {
  try {
    const attrs = resolvedAttrs(node);
    if (attrs.preserveAspectRatio && !/^xMidYMid(?:\s+meet)?$/.test(attrs.preserveAspectRatio.trim())) return null;
    const number = (value: string | undefined, fallback: number) => {
      const numbers = svgNumbers(value ?? String(fallback));
      if (numbers.length !== 1) throw new Error("number");
      return numbers[0];
    };
    const markerWidth = number(attrs.markerWidth, 3), markerHeight = number(attrs.markerHeight, 3);
    const viewBox = attrs.viewBox ? svgNumbers(attrs.viewBox) : [0, 0, markerWidth, markerHeight];
    if (viewBox.length !== 4 || viewBox[2] <= 0 || viewBox[3] <= 0 || markerWidth <= 0 || markerHeight <= 0) return null;
    const painted = { ...inherited, ...inheritedOf(attrs) };
    return { viewBox: viewBox as [number, number, number, number], markerWidth, markerHeight,
      refX: number(attrs.refX, 0), refY: number(attrs.refY, 0), orient: attrs.orient ?? "0", userSpace: attrs.markerUnits === "userSpaceOnUse",
      primitives: childrenOf(node).filter((child) => !["#text", "title", "desc"].includes(tagOf(child)))
        .map((child) => ({ tag: tagOf(child), attrs: { ...painted, ...resolvedAttrs(child) } })) };
  } catch { return null; }
}
function collectMarkers(root: XmlNode, inherited: Record<string, string>): SvgMarkerLookup {
  const markers = new Map<string, SvgMarkerDefinition>();
  const visit = (node: XmlNode) => {
    const tag = tagOf(node), id = node[":@"]?.id;
    if (tag === "marker") {
      const definition = id ? markerDefinition(node, inherited) : null;
      if (id && definition) markers.set(id, definition);
    } else if (tag === "defs" || tag === "g") childrenOf(node).forEach(visit);
  };
  childrenOf(root).forEach(visit);
  return (id) => markers.get(id);
}
function shiftedAnchor(anchor: OverlayAnchor | undefined, dx: number, dy: number): OverlayAnchor | undefined {
  if (anchor?.type === "block") return { ...anchor, dy: anchor.dy + dy, ...(anchor.dx === undefined ? {} : { dx: anchor.dx + dx }),
    ...(anchor.line ? { line: { ...anchor.line, dy: anchor.line.dy + dy } } : {}) };
  if (anchor?.type === "shape") return { ...anchor, dx: anchor.dx + dx, dy: anchor.dy + dy };
  return anchor;
}

/** Replace one SVG image atomically. Unrepresentable fragments retain their SVG and stack order. */
export function convertSvgImageToSigma(
  snapshot: OverlaySnapshot,
  shapeId: string,
  source?: string,
  measureFragment?: (root: SvgFragmentNode) => OverlayBounds | null,
  measureText?: MeasureSvgOverlayText,
): { snapshot: OverlaySnapshot; selectedIds: string[]; convertedCount: number; preservedCount: number; textCount: number; mathCount: number } {
  const image = snapshot.shapes.find((shape): shape is Extract<OverlayShape, { type: "image" }> => shape.id === shapeId && shape.type === "image");
  const asset = image && snapshot.assets[image.props.assetId];
  if (!image || !isSvgImageAsset(asset)) throw new SvgConversionError("source");
  const root = parseStaticSvg(source ?? decodeSvgDataUrl(asset!.props.src));
  const rootAttrs = resolvedAttrs(root);
  const { width, height, viewBox } = svgViewport(rootAttrs, asset!.props);
  const aspect = rootAttrs.preserveAspectRatio ?? "xMidYMid meet";
  if (aspect !== "none" && !/^x(Min|Mid|Max)Y(Min|Mid|Max)(?:\s+meet)?$/.test(aspect)) throw new SvgConversionError("unsupported");
  let sx = width / viewBox[2], sy = height / viewBox[3];
  if (aspect !== "none") sx = sy = Math.min(sx, sy);
  const alignX = aspect.includes("xMax") ? 1 : aspect.includes("xMid") ? 0.5 : 0;
  const alignY = aspect.includes("YMax") ? 1 : aspect.includes("YMid") ? 0.5 : 0;
  const viewport: SvgMatrix = [sx, 0, 0, sy, -viewBox[0] * sx + (width - viewBox[2] * sx) * alignX,
    -viewBox[1] * sy + (height - viewBox[3] * sy) * alignY];
  // The canvas draws the whole SVG at `layout` (relative to the image) and clips it to the image's frame, which is how a
  // crop, or a frame of another aspect, shows only part of it. Only that window of the SVG is on the page.
  const layout = getCroppedImageLayout(image, asset);
  const kx = layout.width / width, ky = layout.height / height;
  const placement = multiplySvgMatrices([kx, 0, 0, ky, image.x + layout.x, image.y + layout.y], viewport);
  const visible = { left: Math.max(0, -layout.x / kx), top: Math.max(0, -layout.y / ky),
    right: Math.min(width, (image.props.w - layout.x) / kx), bottom: Math.min(height, (image.props.h - layout.y) / ky) };
  const whole = visible.left < 1e-4 && visible.top < 1e-4 && width - visible.right < 1e-4 && height - visible.bottom < 1e-4;
  const frame = { left: image.x, top: image.y, right: image.x + image.props.w, bottom: image.y + image.props.h };
  const wrap = (node: XmlNode, ancestors: XmlNode[]) => ancestors.reduceRight((child, ancestor) => ({ g: [child], ":@": ancestor[":@"] }), node);
  const definitions: XmlNode[] = [];
  const collectDefinitions = (node: XmlNode, ancestors: XmlNode[]) => {
    if (tagOf(node) === "defs") definitions.push(wrap(node, ancestors));
    else if (tagOf(node) === "g") childrenOf(node).forEach((child) => collectDefinitions(child, [...ancestors, node]));
  };
  childrenOf(root).forEach((node) => collectDefinitions(node, []));
  const markers = collectMarkers(root, inheritedOf(rootAttrs));
  const shapes: OverlayShape[] = [];
  const assets = { ...snapshot.assets };
  let convertedCount = 0, preservedCount = 0;
  let pending: XmlNode[] = [];
  let fragmentBytes = 0;
  const flush = () => {
    if (!pending.length) return;
    const fragmentRoot: XmlNode = { svg: [...definitions, ...pending], ":@": { ...root[":@"], width: String(width), height: String(height) } };
    const fragment = serialize(fragmentRoot);
    const bytes = new TextEncoder().encode(fragment);
    const measured = measureFragment?.(measurementNode(fragmentRoot));
    const box = measured && [measured.x, measured.y, measured.w, measured.h].every(Number.isFinite) && measured.w > 0 && measured.h > 0
      ? { left: measured.x, top: measured.y, right: measured.x + measured.w, bottom: measured.y + measured.h } : null;
    const clip = box && { left: Math.max(visible.left, box.left), top: Math.max(visible.top, box.top),
      right: Math.min(visible.right, box.right), bottom: Math.min(visible.bottom, box.bottom) };
    const shows = clip && clip.right > clip.left && clip.bottom > clip.top;
    // Nothing of this fragment falls inside the crop. A whole image keeps its fragment as before.
    if (clip && !shows && !whole) { pending = []; return; }
    // A crop narrower than the editor's minimum would be ignored, so a hairline fragment gets a little blank room.
    const room = (low: number, high: number, size: number) => {
      const least = size * MIN_IMAGE_CROP_RATIO * 1.5;
      if (high - low >= least) return [low, high];
      const start = Math.min(Math.max(0, (low + high) / 2 - least / 2), size - least);
      return [start, start + least];
    };
    const [left, right] = shows ? room(clip.left, clip.right, width) : [visible.left, visible.right];
    const [top, bottom] = shows ? room(clip.top, clip.bottom, height) : [visible.top, visible.bottom];
    fragmentBytes += bytes.length;
    if (fragmentBytes > 8 * 1024 * 1024 || preservedCount >= 256) throw new SvgConversionError("unsupported");
    const id = createId("overlay_asset");
    assets[id] = { id, type: "image", props: { ...asset!.props, w: width, h: height,
      name: `${asset!.props.name} (SVG)`, storage: undefined,
      src: `data:image/svg+xml;base64,${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`, fileSize: bytes.length } };
    const everything = left <= 0 && top <= 0 && right >= width && bottom >= height;
    shapes.push({ id: createId("overlay_shape"), type: "image", x: image.x + layout.x + left * kx, y: image.y + layout.y + top * ky, rotation: 0,
      props: { assetId: id, w: (right - left) * kx, h: (bottom - top) * ky,
        ...(everything ? {} : { crop: { topLeft: { x: left / width, y: top / height }, bottomRight: { x: right / width, y: bottom / height } } }) } });
    preservedCount++;
    pending = [];
  };
  const preserve = (node: XmlNode, ancestors: XmlNode[]) => {
    pending.push(wrap(node, ancestors));
    // Small measured fragments leave native parts reachable after ungrouping.
    if (measureFragment) flush();
  };
  const walk = (node: XmlNode, inherited: Record<string, string>, matrix: SvgMatrix, ancestors: XmlNode[]) => {
    const tag = tagOf(node);
    if (["#text", "defs", "title", "desc"].includes(tag)) return;
    const own = resolvedAttrs(node), attrs = { ...inherited, ...own };
    if (attrs.display === "none") return;
    let transformed: SvgMatrix;
    try {
      transformed = multiplySvgMatrices(matrix, parseSvgTransform(own.transform));
      if (own["font-size"]) attrs["font-size"] = String(svgFontSizePx(own["font-size"], svgFontSizePx(inherited["font-size"], 16)));
    }
    catch { preserve(node, ancestors); return; }
    const containerEffect = ["opacity", "clip-path", "mask", "visibility"].some((key) => own[key] && !["1", "none", "visible"].includes(own[key]));
    if (tag === "g" && !containerEffect) {
      const nextInherited = Object.fromEntries(Object.entries(attrs).filter(([key]) => INHERITED.has(key)));
      childrenOf(node).forEach((child) => walk(child, nextInherited, transformed, [...ancestors, node]));
      return;
    }
    const text = tag === "text" && attrs.visibility !== "hidden" ? svgTextToOverlay(node, attrs, transformed, () => createId("svg_text"), measureText) : null;
    let converted = text ? [text] : tag === "g" || attrs.visibility === "hidden" ? null : svgPrimitiveToShapes(tag, attrs, transformed, () => createId("overlay_shape"), markers);
    // SVG clips at its viewport, and a crop narrows it; native shapes cannot reproduce a clipped primitive.
    const bounds = converted && getShapesSelectionBounds(converted);
    if (bounds && (bounds.x < frame.left - 1 || bounds.y < frame.top - 1 || bounds.x + bounds.w > frame.right + 1 || bounds.y + bounds.h > frame.bottom + 1)) {
      // Clear of a cropped frame by more than its stroke can reach (half the width, times the miter limit), so none of it shows.
      const strokeWidth = Number.parseFloat(attrs["stroke-width"] ?? "1");
      const reach = Math.max(1, 2 * (Number.isFinite(strokeWidth) ? strokeWidth : 1) * Math.hypot(transformed[0], transformed[1]));
      if (!whole && (bounds.x > frame.right + reach || bounds.y > frame.bottom + reach || bounds.x + bounds.w < frame.left - reach || bounds.y + bounds.h < frame.top - reach)) return;
      converted = null;
    }
    if (!converted?.length) { preserve(node, ancestors); return; }
    const opacity = Number(own.opacity ?? 1);
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) { preserve(node, ancestors); return; }
    flush();
    if (shapes.length + converted.length > 4096) throw new SvgConversionError("unsupported");
    shapes.push(...converted.map((shape) => ({ ...shape, ...(opacity === 1 ? {} : { opacity }) })));
    convertedCount += converted.length;
  };
  // A root compositing/clip effect must stay intact, just as a group effect must.
  if (rootAttrs.display === "none" || ["opacity", "clip-path", "mask", "visibility"].some((key) => rootAttrs[key] && !["1", "none", "visible"].includes(rootAttrs[key]))) throw new SvgConversionError("unsupported");
  const inherited = inheritedOf(rootAttrs);
  try { inherited["font-size"] = String(svgFontSizePx(rootAttrs["font-size"], 16)); }
  catch { throw new SvgConversionError("unsupported"); }
  const rootMatrix = multiplySvgMatrices(placement, parseSvgTransform(rootAttrs.transform));
  childrenOf(root).forEach((node) => walk(node, inherited, rootMatrix, []));
  flush();
  if (!convertedCount) throw new SvgConversionError("unsupported");
  const pivot = { x: image.x + image.props.w / 2, y: image.y + image.props.h / 2 };
  let placed = shapes;
  if (image.flipX) placed = flipShapesAround(placed, pivot, "horizontal");
  if (image.flipY) placed = flipShapesAround(placed, pivot, "vertical");
  if (image.rotation) placed = rotateShapesAround(placed, pivot, image.rotation);
  const anchored = placed.map((shape) => ({ ...shape, anchor: shiftedAnchor(image.anchor, shape.x - image.x, shape.y - image.y) }));
  const bounds = getShapesSelectionBounds(anchored)!;
  const replacements: OverlayShape[] = anchored.length === 1
    ? [{ ...anchored[0], id: image.id, parentId: image.parentId, stackLayer: image.stackLayer, opacity: (image.opacity ?? 1) * (anchored[0].opacity ?? 1) }]
    : [{ id: image.id, type: "group", x: bounds.x, y: bounds.y, parentId: image.parentId, stackLayer: image.stackLayer,
      opacity: image.opacity, anchor: shiftedAnchor(image.anchor, bounds.x - image.x, bounds.y - image.y),
      props: { w: bounds.w, h: bounds.h, name: asset!.props.name } }, ...anchored.map((shape) => ({ ...shape, parentId: image.id }))];
  const nextShapes = normalizeOverlayGroups(snapshot.shapes.flatMap((shape) => shape.id === image.id ? replacements : [shape]));
  const next = pruneUnusedOverlayAssets({ ...snapshot, shapes: nextShapes, assets });
  const texts = anchored.filter((shape) => shape.type === "text");
  return { snapshot: next, selectedIds: [image.id], convertedCount, preservedCount, textCount: texts.length,
    mathCount: texts.reduce((sum, shape) => sum + shape.props.blocks.reduce((n, block) => n + (block.type === "paragraph" ? block.children.filter((child) => child.type === "mathInline").length : 0), 0), 0) };
}
