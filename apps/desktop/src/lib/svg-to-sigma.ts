import { normalizeOverlayGroups, pruneUnusedOverlayAssets, type OverlayAnchor, type OverlayAsset, type OverlayBounds, type OverlayShape, type OverlaySnapshot } from "@/features/document";
import { flipShapesAround, getImageCoverCrop, getShapesSelectionBounds, multiplySvgMatrices, parseSvgTransform, rotateShapesAround, svgPrimitiveToShapes, type SvgMatrix } from "@/features/drawing";
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
  const crop = getImageCoverCrop(image, asset);
  if (Math.abs(crop.topLeft.x) + Math.abs(crop.topLeft.y) + Math.abs(crop.bottomRight.x - 1) + Math.abs(crop.bottomRight.y - 1) > 1e-7) throw new SvgConversionError("cropped");
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
  const placement = multiplySvgMatrices([image.props.w / width, 0, 0, image.props.h / height, image.x, image.y], viewport);
  const wrap = (node: XmlNode, ancestors: XmlNode[]) => ancestors.reduceRight((child, ancestor) => ({ g: [child], ":@": ancestor[":@"] }), node);
  const definitions: XmlNode[] = [];
  const collectDefinitions = (node: XmlNode, ancestors: XmlNode[]) => {
    if (tagOf(node) === "defs") definitions.push(wrap(node, ancestors));
    else if (tagOf(node) === "g") childrenOf(node).forEach((child) => collectDefinitions(child, [...ancestors, node]));
  };
  childrenOf(root).forEach((node) => collectDefinitions(node, []));
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
    fragmentBytes += bytes.length;
    if (fragmentBytes > 8 * 1024 * 1024 || preservedCount >= 256) throw new SvgConversionError("unsupported");
    const id = createId("overlay_asset");
    assets[id] = { id, type: "image", props: { ...asset!.props, w: width, h: height,
      name: `${asset!.props.name} (SVG)`, storage: undefined,
      src: `data:image/svg+xml;base64,${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`, fileSize: bytes.length } };
    const measured = measureFragment?.(measurementNode(fragmentRoot));
    const bounds = measured && [measured.x, measured.y, measured.w, measured.h].every(Number.isFinite) && measured.w > 0 && measured.h > 0
      ? { x: Math.max(0, measured.x), y: Math.max(0, measured.y),
        right: Math.min(width, measured.x + measured.w), bottom: Math.min(height, measured.y + measured.h) } : null;
    const clipped = bounds && bounds.right > bounds.x && bounds.bottom > bounds.y ? bounds : null;
    shapes.push({ id: createId("overlay_shape"), type: "image", x: image.x + (clipped?.x ?? 0) * image.props.w / width,
      y: image.y + (clipped?.y ?? 0) * image.props.h / height, rotation: 0,
      props: { assetId: id, w: clipped ? (clipped.right - clipped.x) * image.props.w / width : image.props.w,
        h: clipped ? (clipped.bottom - clipped.y) * image.props.h / height : image.props.h,
        ...(clipped ? { crop: { topLeft: { x: clipped.x / width, y: clipped.y / height }, bottomRight: { x: clipped.right / width, y: clipped.bottom / height } } } : {}) } });
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
    let converted = text ? [text] : tag === "g" || attrs.visibility === "hidden" ? null : svgPrimitiveToShapes(tag, attrs, transformed, () => createId("overlay_shape"));
    // SVG clips at its viewport; native shapes cannot reproduce a clipped primitive.
    const bounds = converted && getShapesSelectionBounds(converted);
    if (bounds && (bounds.x < image.x - 1 || bounds.y < image.y - 1 || bounds.x + bounds.w > image.x + image.props.w + 1 || bounds.y + bounds.h > image.y + image.props.h + 1)) converted = null;
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
  const inherited = Object.fromEntries(Object.entries(rootAttrs).filter(([key]) => INHERITED.has(key)));
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
