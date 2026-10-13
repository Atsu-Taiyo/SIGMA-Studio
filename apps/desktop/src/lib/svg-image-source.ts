import { XMLParser, XMLValidator } from "fast-xml-parser";
import { svgNumbers } from "@/features/drawing";

export type XmlNode = Record<string, unknown> & { ":@"?: Record<string, string> };
/** Validated static nodes for a host's optional SVG bounds measurement. */
export interface SvgFragmentNode { tag: string; attrs: Record<string, string>; children: (SvgFragmentNode | string)[] }
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_BYTES = 256 * 1024;
const TAGS = new Set("svg g defs title desc path rect circle ellipse line polyline polygon text tspan clipPath mask marker linearGradient radialGradient stop".split(" "));
const ATTRS = new Set(("xmlns id viewBox width height x y x1 y1 x2 y2 cx cy r rx ry dx dy d points transform style " +
  "fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset " +
  "opacity color font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline baseline-shift letter-spacing text-decoration " +
  "preserveAspectRatio vector-effect paint-order clip-path clip-rule clipPathUnits mask maskUnits maskContentUnits " +
  "marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient " +
  "gradientUnits gradientTransform spreadMethod fx fy fr offset stop-color stop-opacity xml:space role aria-label display visibility").split(" "));
export type SvgConversionFailure = "source" | "unsupported" | "cropped";
export class SvgConversionError extends Error {
  constructor(public readonly reason: SvgConversionFailure) { super(reason); }
}

export function decodeSvgDataUrl(source: string): string {
  const match = /^data:image\/svg\+xml((?:;[^,]*)?),([\s\S]*)$/i.exec(source);
  if (!match || match[2].length > MAX_BYTES * 4) throw new SvgConversionError("source");
  try {
    const text = /;base64(?:;|$)/i.test(match[1])
      ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0)))
      : decodeURIComponent(match[2]);
    if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error("size");
    return text;
  } catch { throw new SvgConversionError("source"); }
}

export function tagOf(node: XmlNode): string { return Object.keys(node).find((key) => key !== ":@") ?? ""; }
export function childrenOf(node: XmlNode): XmlNode[] { return Array.isArray(node[tagOf(node)]) ? node[tagOf(node)] as XmlNode[] : []; }
export function resolvedAttrs(node: XmlNode): Record<string, string> {
  const attrs = { ...node[":@"] };
  for (const declaration of (attrs.style ?? "").split(";")) {
    if (!declaration.trim()) continue;
    const match = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(declaration);
    if (!match || !ATTRS.has(match[1]) || match[1] === "style" || /!important/i.test(match[2])) throw new SvgConversionError("unsupported");
    attrs[match[1]] = match[2];
  }
  delete attrs.style;
  return attrs;
}

export function parseStaticSvg(svg: string): XmlNode {
  // Parse a bounded static subset, without DOM insertion or external entity/resource loading.
  const source = svg.replace(/^\s*<\?xml[^?]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  if (new TextEncoder().encode(source).length > MAX_BYTES || (source.match(/</g)?.length ?? 0) > 8192 || /<!|<\?/.test(source) || XMLValidator.validate(source) !== true) throw new SvgConversionError("source");
  const nodes = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false,
    parseAttributeValue: false, trimValues: false }).parse(source) as XmlNode[];
  const roots = nodes.filter((node) => tagOf(node) !== "#text");
  if (roots.length !== 1 || tagOf(roots[0]) !== "svg" || roots[0][":@"]?.xmlns !== SVG_NAMESPACE) throw new SvgConversionError("source");
  let count = 0;
  const validate = (node: XmlNode, depth: number) => {
    const tag = tagOf(node);
    if (tag === "#text") return;
    if (++count > 4096 || depth > 64 || !TAGS.has(tag) || (tag === "svg" && depth > 0)) throw new SvgConversionError("unsupported");
    for (const [key, value] of Object.entries(node[":@"] ?? {})) {
      const withoutLocalReferences = value.replace(/url\(\s*(['"]?)#[A-Za-z_][\w.-]*\1\s*\)/g, "");
      if (!ATTRS.has(key) || (key === "xmlns" && value !== SVG_NAMESPACE) || /[\\<>]|\/\*|url\s*\(|(?:https?|data|file|javascript):|@import|expression\s*\(/i.test(key === "xmlns" ? "" : withoutLocalReferences)) throw new SvgConversionError("unsupported");
    }
    resolvedAttrs(node);
    childrenOf(node).forEach((child) => validate(child, depth + 1));
  };
  validate(roots[0], 0);
  return roots[0];
}

export function svgViewport(attrs: Record<string, string>, fallback?: { w: number; h: number }) {
  const box = attrs.viewBox ? svgNumbers(attrs.viewBox) : null;
  if (box && (box.length !== 4 || box[2] <= 0 || box[3] <= 0)) throw new SvgConversionError("source");
  const dimension = (value: string | undefined, alternative: number | undefined) => {
    const n = svgNumbers(value?.replace(/px$/, "") ?? String(alternative));
    if (n.length !== 1 || n[0] <= 0 || n[0] > 8192) throw new SvgConversionError("source");
    return n[0];
  };
  const width = dimension(attrs.width, box?.[2] ?? fallback?.w), height = dimension(attrs.height, box?.[3] ?? fallback?.h);
  return { width, height, viewBox: box ?? [0, 0, width, height] };
}

/** Keep a pasted SVG's intrinsic aspect ratio without starting a raster image decoder. */
export function getSvgImageDimensions(source: string): { width: number; height: number } | null {
  try {
    const { width, height } = svgViewport(resolvedAttrs(parseStaticSvg(decodeSvgDataUrl(source))));
    return { width, height };
  } catch { return null; }
}
