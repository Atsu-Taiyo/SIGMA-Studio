import { describe, expect, it } from "vitest";
import { encodeAiSvg, MAX_AI_SVG_BYTES, validateAiSvg } from "./svg-image";
import { isAllowedAiOverlayAssetSource } from "./sigma-doc-edit-schema";

const wrap = (body: string, attributes = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320" ${attributes}>${body}</svg>`;

describe("AI static SVG images", () => {
  it("preserves Japanese source and local gradients, clips, labels and curves", () => {
    const svg = wrap('<defs><linearGradient id="paint"><stop offset="0" stop-color="red"/></linearGradient></defs><path d="M0 0 Q50 80 100 0" fill="url(#paint)"/><text x="50" y="100">半径 &amp; 面積</text>');
    const image = encodeAiSvg(svg);
    expect(image).toMatchObject({ width: 640, height: 320 });
    expect(Buffer.from(image.src.split(',')[1], 'base64').toString()).toBe(svg);
    expect(isAllowedAiOverlayAssetSource(image.src)).toBe(true);
  });

  it.each([
    '<script>alert(1)</script>', '<foreignObject/>', '<image href="https://example.com/x"/>',
    '<use href="#cycle"/>', '<animate attributeName="fill"/>', '<style>text{fill:red}</style>',
    '<rect onload="alert(1)"/>', '<rect style="fill:red"/>',
    '<rect fill="url(https://example.com/x)"/>', '<rect fill="u&#114;l(https://example.com/x)"/>',
    '<rect fill="u\\72l(#x)"/>', '<rect xmlns="http://www.w3.org/1999/xhtml"/>',
    '<rect xmlns:evil="https://example.com"/>', '<rect evil:fill="red"/>',
    '<rect/><!---->', '<![CDATA[<script/>]]>', '<rect></circle>',
  ])("rejects unsupported content without allowing bypass through stored assets: %s", (body) => {
    const svg = wrap(body);
    expect(() => validateAiSvg(svg)).toThrow();
    expect(isAllowedAiOverlayAssetSource(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)).toBe(false);
  });

  it.each([
    '<svg/>', wrap('', 'width="100%"'), wrap('', 'height="0"'), wrap('', 'width="9000"'),
    wrap('', 'width="8192" height="8192"'), wrap('').replace('640 320', '-1 320'),
    '<?xml version="1.0"?>' + wrap(''), '<!DOCTYPE svg>' + wrap(''), wrap('') + wrap(''),
    wrap('<g>'.repeat(65) + '</g>'.repeat(65)), wrap('<rect/>'.repeat(4096)),
    wrap('x'.repeat(MAX_AI_SVG_BYTES)),
  ])("rejects invalid document structure and resource budgets", (svg) => {
    expect(() => validateAiSvg(svg)).toThrow();
  });
});
