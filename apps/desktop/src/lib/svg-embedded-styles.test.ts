// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import {
  collectFontFamilies,
  collectSvgClassNames,
  cssRuleMentionsClass,
  normalizeSvgMarkupForImage,
  prepareSvgForImage,
} from "./svg-embedded-styles";

const GRAPH_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50">',
  '<foreignObject x="0" y="0" width="100" height="50">',
  '<div xmlns="http://www.w3.org/1999/xhtml" class="graph2d-container  ">',
  '<svg class="graph2d-svg"><g class="graph2d-axes"><line x1="0" y1="25" x2="100" y2="25"></line></g></svg>',
  "</div></foreignObject></svg>",
].join("");

afterEach(() => {
  document.head.innerHTML = "";
});

describe("collectSvgClassNames", () => {
  it("reads every class token, including ones inside foreignObject HTML", () => {
    expect([...collectSvgClassNames(GRAPH_SVG)].sort()).toEqual(["graph2d-axes", "graph2d-container", "graph2d-svg"]);
  });
});

describe("cssRuleMentionsClass", () => {
  it("keeps rules for the classes the SVG uses and skips the rest", () => {
    const used = new Set(["graph2d-axes"]);
    expect(cssRuleMentionsClass(".graph2d-axes line { stroke: #30343b; }", used)).toBe(true);
    expect(cssRuleMentionsClass("@media print { .graph2d-axes line { stroke: black; } }", used)).toBe(true);
    expect(cssRuleMentionsClass(".toolbar button { margin: .5em; }", used)).toBe(false);
  });
});

describe("collectFontFamilies", () => {
  it("reads family lists and the family at the end of the font shorthand", () => {
    const families = collectFontFamilies([
      ".katex { font: normal 1.21em KaTeX_Main, \"Times New Roman\", serif; }",
      ".text { font-family: \"M PLUS 1p\", sans-serif; }",
    ].join("\n"));
    expect(families).toEqual(new Set(["katex_main", "times new roman", "serif", "m plus 1p", "sans-serif"]));
  });
});

describe("normalizeSvgMarkupForImage", () => {
  it("gives the nested graph <svg> the SVG namespace, which an SVG image needs to draw it", () => {
    const normalized = normalizeSvgMarkupForImage(GRAPH_SVG);
    expect(normalized).toContain('<svg xmlns="http://www.w3.org/2000/svg" class="graph2d-svg">');
    // 名前空間を持つ外側の <svg> と、XHTML の <div> はそのまま。
    expect(normalized.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"')).toBe(true);
    expect(normalized.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g)).toHaveLength(2);
    expect(normalized).toContain('<div xmlns="http://www.w3.org/1999/xhtml"');
  });

  it("gives MathML its namespace and leaves text that only mentions a tag alone", () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">&lt;svg&gt;<math><mi>x</mi></math></div></foreignObject></svg>';
    const normalized = normalizeSvgMarkupForImage(markup);
    expect(normalized).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML">');
    expect(normalized).toContain("&lt;svg&gt;");
  });

  it("returns the input when it is not an SVG", () => {
    expect(normalizeSvgMarkupForImage("<div>text</div>")).toBe("<div>text</div>");
  });
});

describe("prepareSvgForImage", () => {
  it("puts the page rules the SVG needs inside it, so it draws the same as an image", async () => {
    const style = document.createElement("style");
    style.textContent = ".graph2d-axes line { stroke: #30343b; stroke-width: 1.2; } .unrelated-toolbar { color: red; }";
    document.head.append(style);

    const result = await prepareSvgForImage(GRAPH_SVG);

    expect(result).toMatch(/^<svg [^>]*viewBox="0 0 100 50"[^>]*><style><!\[CDATA\[/);
    expect(result).toContain(".graph2d-axes line");
    expect(result).toContain("#30343b");
    expect(result).not.toContain("unrelated-toolbar");
    expect(result).toContain("<line");
  });

  it("adds no stylesheet to an SVG drawn only with attributes", async () => {
    const plain = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#000"></rect></svg>';
    expect(await prepareSvgForImage(plain)).not.toContain("<style>");
  });
});
