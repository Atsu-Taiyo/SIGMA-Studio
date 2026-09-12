import { tv } from "./validation-locale";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const MAX_AI_SVG_BYTES = 256 * 1024;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
// Static illustration subset. No DOM insertion, external resources, CSS, or recursive <use>.
const TAGS = new Set("svg g defs title desc path rect circle ellipse line polyline polygon text tspan clipPath mask marker linearGradient radialGradient stop".split(" "));
const ATTRIBUTES = new Set((
  "xmlns id viewBox width height x y x1 y1 x2 y2 cx cy r rx ry dx dy d points transform " +
  "fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset " +
  "opacity color font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline letter-spacing text-decoration " +
  "preserveAspectRatio vector-effect paint-order clip-path clip-rule clipPathUnits mask maskUnits maskContentUnits " +
  "marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient " +
  "gradientUnits gradientTransform spreadMethod fx fy fr offset stop-color stop-opacity xml:space role aria-label"
).split(" "));
type XmlNode = Record<string, unknown> & { ":@"?: Record<string, string> };

/** Validate the exact stored source; unsupported content is rejected, never silently removed. */
export function validateAiSvg(svg: string): { width: number; height: number } {
  if (!svg.trim() || new TextEncoder().encode(svg).length > MAX_AI_SVG_BYTES) {
    throw new Error(tv("svg.size"));
  }
  if (/<!|<\?/.test(svg) || (svg.match(/</g)?.length ?? 0) > 8192) {
    throw new Error(tv("svg.declarations"));
  }
  const valid = XMLValidator.validate(svg);
  if (valid !== true) throw new Error(tv("svg.xml", { detail: valid.err.msg }));
  const nodes = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false, parseAttributeValue: false, trimValues: false }).parse(svg) as XmlNode[];
  if (nodes.length !== 1 || !Array.isArray(nodes[0].svg)) throw new Error(tv("svg.root"));
  let count = 0;
  const walk = (entries: XmlNode[], depth: number) => {
    if (depth > 64) throw new Error(tv("svg.depth"));
    for (const entry of entries) {
      const tag = Object.keys(entry).find((key) => key !== ":@");
      if (tag === "#text") continue;
      if (!tag || !TAGS.has(tag) || (tag === "svg" && depth !== 0)) throw new Error(tv("svg.element", { tag }));
      if (++count > 4096) throw new Error(tv("svg.count"));
      for (const [name, value] of Object.entries(entry[":@"] ?? {})) {
        if (!ATTRIBUTES.has(name)) throw new Error(tv("svg.attribute", { name }));
        if (name === "xmlns") {
          if (value !== SVG_NAMESPACE || depth !== 0) throw new Error(tv("svg.namespace"));
          continue;
        }
        // Reject CSS escapes/comments and all URLs except literal local paint/clip references.
        const withoutLocalRefs = value.replace(/url\(\s*(['"]?)#[A-Za-z_][\w.-]*\1\s*\)/g, "");
        if (/[\\<>]|\/\*|url\s*\(|(?:https?|data|file|javascript):|@import|expression\s*\(/i.test(withoutLocalRefs)) {
          throw new Error(tv("svg.reference", { name }));
        }
      }
      walk(entry[tag] as XmlNode[], depth + 1);
    }
  };
  walk(nodes, 0);
  const attrs = nodes[0][":@"] ?? {};
  if (attrs.xmlns !== SVG_NAMESPACE) throw new Error(tv("svg.missingNamespace"));
  const viewBox = attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) {
    throw new Error(tv("svg.viewBox"));
  }
  const dimension = (value: string | undefined, fallback: number) => value === undefined ? fallback : /^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(value) ? Number(value.replace(/px$/, "")) : NaN;
  const width = dimension(attrs.width, viewBox[2]);
  const height = dimension(attrs.height, viewBox[3]);
  if (![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= 8192) || width * height > 25_000_000) {
    throw new Error(tv("svg.dimensions"));
  }
  return { width, height };
}

export function encodeAiSvg(svg: string): { src: string; fileSize: number; width: number; height: number } {
  const dimensions = validateAiSvg(svg);
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { ...dimensions, src: `data:image/svg+xml;base64,${btoa(binary)}`, fileSize: bytes.length };
}
