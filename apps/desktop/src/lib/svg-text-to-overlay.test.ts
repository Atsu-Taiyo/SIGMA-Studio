import katex from "katex";
import { describe, expect, it } from "vitest";
import { isValidOverlaySnapshot, normalizeOverlaySnapshot } from "@/features/document";
import { SVG_IDENTITY, type SvgMatrix } from "@/features/drawing";
import { childrenOf, parseStaticSvg, resolvedAttrs } from "./svg-image-source";
import { svgTextToOverlay, type MeasureSvgOverlayText } from "./svg-text-to-overlay";

function label(body: string, attrs = '', matrix: SvgMatrix = SVG_IDENTITY, measure?: MeasureSvgOverlayText) {
  const node = childrenOf(parseStaticSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500"><text x="100" y="80" font-size="20" ${attrs}>${body}</text></svg>`))[0];
  let n = 0;
  return svgTextToOverlay(node, resolvedAttrs(node), matrix, () => `id_${++n}`, measure);
}
function inlines(shape: ReturnType<typeof label>) {
  const block = shape?.props.blocks[0];
  return block?.type === "paragraph" ? block.children : [];
}

describe("SVG text and math conversion", () => {
  it("keeps readable text, formatting, point sizes and anchors through canonical JSON reload", () => {
    const shape = label('永久<tspan fill="#ff0000" font-weight="bold" font-size="24">磁石</tspan>', 'text-anchor="middle" font-family="serif"');
    expect(shape).toMatchObject({ type: "text", props: { fontSize: 15, blocks: [{ align: "center", children: [
      { type: "text", text: "永久", fontFamily: "serif" }, { type: "text", text: "磁石", color: "#ff0000", marks: ["bold"], fontSize: 18 },
    ] }] } });
    expect(shape!.x + shape!.props.w / 2).toBe(100);
    const snapshot = { version: 1 as const, shapes: [shape!], assets: {} };
    const reloaded = normalizeOverlaySnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(isValidOverlaySnapshot(reloaded)).toBe(true);
    expect(reloaded).toEqual(snapshot);
  });

  it("stores Japanese prose and an italic physical quantity as text plus native inline math", () => {
    const shape = label('(張力 <tspan font-family="serif" font-style="italic">T</tspan>)');
    expect(inlines(shape)).toMatchObject([{ type: "text", text: "(張力 " }, { type: "mathInline", tex: "T", display: "inline", semanticRole: "variable" }, { type: "text", text: ")" }]);
  });

  it.each([
    ['J<tspan font-size="14" dy="5">1</tspan>', String.raw`\mathrm{J}_{1}`],
    ['x<tspan font-size="14" dy="-5">2</tspan>', String.raw`\mathrm{x}^{2}`],
    ['<tspan font-style="italic">V</tspan>(<tspan font-style="italic">z</tspan>)', 'V(z)'],
    ['<tspan font-style="italic">V</tspan><tspan font-size="14" dy="5">A</tspan><tspan dy="-5"> = </tspan><tspan font-style="italic">A</tspan>{<tspan font-style="italic">V</tspan>(<tspan font-style="italic">z</tspan>) − <tspan font-style="italic">V</tspan><tspan font-size="14" dy="5">L</tspan><tspan dy="-5">}</tspan>', String.raw`V_{\mathrm{A}} = A\{V(z) - V_{\mathrm{L}}\}`],
    ['F=ma', String.raw`\mathrm{F}=\mathrm{ma}`],
    ['α ≤ β', String.raw`\alpha  \le  \beta`],
    ['M<tspan font-size="14" baseline-shift="sub">2</tspan>', String.raw`\mathrm{M}_{2}`],
  ])("recognizes structured notation and produces valid editable TeX: %s", (svg, tex) => {
    const nodes = inlines(label(svg));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: "mathInline", tex });
    expect(() => katex.renderToString(tex, { throwOnError: true })).not.toThrow();
  });

  it.each(['V', '0', '+', '−', 'Voltage', 'version 2', '<tspan font-style="italic">Hello</tspan>'])('leaves ambiguous or ordinary labels as text: %s', (svg) => {
    expect(inlines(label(svg)).every((node) => node.type === "text")).toBe(true);
  });

  it("uses measured text/math dimensions and baseline at rotated, mirrored and end-aligned positions", () => {
    const measure: MeasureSvgOverlayText = () => ({ width: 40, height: 24, baseline: 18 });
    expect(label('抵抗', 'text-anchor="end"', SVG_IDENTITY, measure)).toMatchObject({ x: 60, y: 62, props: { w: 40, h: 24 } });
    expect(label('抵抗', '', [0, 1, -1, 0, 200, 0], measure)).toMatchObject({ x: 106, y: 108, rotation: expect.closeTo(Math.PI / 2, 10), props: { fontSize: 15, h: 24 } });
    expect(label('抵抗', '', [1, 0, 0, -1, 0, 200], measure)).toMatchObject({ x: 100, y: 114, flipY: true });
  });

  it("collapses SVG whitespace across run boundaries without joining words", () => {
    expect(inlines(label('  抵抗\n <tspan> R </tspan>  ')).map((node) => node.type === 'text' ? node.text : node.tex).join('')).toBe('抵抗 R');
    expect(inlines(label(' a  b ', 'xml:space="preserve"'))[0]).toMatchObject({ text: ' a  b ' });
  });

  it.each([
    ['a<tspan x="50">b</tspan>', '', SVG_IDENTITY],
    ['a<tspan dy="20">b</tspan>', '', SVG_IDENTITY],
    ['abc', 'stroke="red"', SVG_IDENTITY],
    ['abc', 'clip-path="url(#clip)"', SVG_IDENTITY],
    ['abc', '', [2, 0, 0, 1, 0, 0] as SvgMatrix],
    ['abc', '', [1, 0, 1, 1, 0, 0] as SvgMatrix],
  ])("preserves text when its layout or paint cannot be represented: %s", (body, attrs, matrix) => {
    expect(label(body, attrs, matrix)).toBeNull();
  });
});
