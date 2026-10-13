import { describe, expect, it } from "vitest";
import { isValidOverlaySnapshot, normalizeOverlaySnapshot, type OverlayAsset, type OverlayShape, type OverlaySnapshot } from "@/features/document";
import { convertSvgImageToSigma, decodeSvgDataUrl, isSvgImageAsset, SvgConversionError } from "./svg-to-sigma";

function fixture(body: string, attrs = ""): OverlaySnapshot {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" ${attrs}>${body}</svg>`;
  const asset: OverlayAsset = { id: "svg_asset", type: "image", props: { w: 200, h: 120, name: "装置図", mimeType: "image/svg+xml",
    isAnimated: false, src: `data:image/svg+xml,${encodeURIComponent(svg)}`, fileSize: svg.length } };
  const shape: OverlayShape = { id: "image", type: "image", x: 30, y: 50, props: { assetId: asset.id, w: 200, h: 120 } };
  return { version: 1, shapes: [shape], assets: { [asset.id]: asset } };
}

describe("SVG to SigmaDoc shapes", () => {
  it("converts editable lines, rectangles, filled triangles and both dash styles, and survives JSON reload", () => {
    const before = fixture(`<g stroke="#123456" fill="none" stroke-width="2">
      <line x1="20" y1="20" x2="80" y2="20" stroke-dasharray="8 6"/>
      <rect x="30" y="35" width="50" height="30" fill="#abcdef" fill-opacity="0.4"/>
      <polygon points="100,30 140,70 80,70" fill="#ff0000"/>
      <line x1="20" y1="90" x2="80" y2="90" stroke-dasharray="1 6"/>
      </g>`);
    const copy = structuredClone(before);
    const result = convertSvgImageToSigma(before, "image");
    expect(before).toEqual(copy);
    expect(result).toMatchObject({ convertedCount: 4, preservedCount: 0, selectedIds: ["image"] });
    expect(result.snapshot.shapes).toMatchObject([
      { id: "image", type: "group" },
      { type: "line", x: 50, y: 70, props: { points: [{ x: 0, y: 0 }, { x: 60, y: 0 }], color: "#123456", dash: "dashed", size: "m" } },
      { type: "geo", x: 60, y: 85, props: { geo: "rectangle", w: 50, h: 30, fill: "solid", fillColor: "#abcdef", fillOpacity: 0.4 } },
      { type: "geo", props: { geo: "triangle", fill: "solid", fillColor: "#ff0000" } },
      { type: "line", props: { dash: "dotted" } },
    ]);
    expect(result.snapshot.assets).toEqual({});
    const reloaded = normalizeOverlaySnapshot(JSON.parse(JSON.stringify(result.snapshot)));
    expect(isValidOverlaySnapshot(reloaded)).toBe(true);
    expect(reloaded).toEqual(result.snapshot);
  });

  it("preserves nonzero viewBox origin, scale, inline style and nested transforms", () => {
    const before = fixture('<g transform="translate(15,10) scale(2)"><rect x="20" y="15" width="10" height="10" style="fill: #00ff00; stroke: none"/></g>');
    before.assets.svg_asset.props.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 10 100 60"><g transform="translate(15,10) scale(2)"><rect x="20" y="15" width="10" height="10" style="fill: #00ff00; stroke: none"/></g></svg>');
    const result = convertSvgImageToSigma(before, "image");
    expect(result.snapshot.shapes).toMatchObject([{ id: "image", type: "geo", x: 120, y: 110,
      props: { w: 40, h: 40, fillColor: "#00ff00", strokeOpacity: 0 } }]);
  });

  it("converts text while keeping curves, markers and clipping in their original stack order", () => {
    const before = fixture(`<defs><clipPath id="clip"><rect width="100" height="100"/></clipPath>
      <marker id="arrow"><path d="M0 0 L5 3 L0 6 Z"/></marker></defs>
      <rect x="20" y="20" width="30" height="30"/>
      <g stroke="#333333"><path d="M30 50 Q50 90 80 50" fill="none"/>
      <path clip-path="url(#clip)" d="M20 30 L150 30"/>
      <line x1="30" y1="50" x2="90" y2="50" marker-end="url(#arrow)"/></g>
      <circle cx="140" cy="60" r="15"/>
      <text x="80" y="100">文字 &amp; <tspan>ラベル</tspan></text>`);
    const result = convertSvgImageToSigma(before, "image");
    expect(result).toMatchObject({ convertedCount: 3, preservedCount: 1, textCount: 1, mathCount: 0 });
    expect(result.snapshot.shapes.map((shape) => shape.type)).toEqual(["group", "geo", "image", "geo", "text"]);
    const fragments = Object.values(result.snapshot.assets).map((asset) => decodeSvgDataUrl(asset.props.src));
    expect(fragments[0]).toContain('<g stroke="#333333">');
    expect(fragments[0]).toContain('clip-path="url(#clip)"');
    expect(fragments[0]).toContain('<clipPath id="clip">');
    expect(result.snapshot.shapes.at(-1)).toMatchObject({ props: { blocks: [{ children: [{ type: "text", text: "文字 & " }, { type: "text", text: "ラベル" }] }] } });
    expect(fragments.join(" ")).not.toContain('<circle cx="140"');
    expect(isValidOverlaySnapshot(result.snapshot)).toBe(true);
  });

  it("converts relative and repeated path commands and independent open subpaths", () => {
    const result = convertSvgImageToSigma(fixture('<path fill="none" stroke="black" d="M20 20h20v20l-20 0z M80 20 100 20 100 40"/>'), "image");
    expect(result.convertedCount).toBe(2);
    expect(result.snapshot.shapes[1]).toMatchObject({ type: "line", props: { closed: true,
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }] } });
    expect(result.snapshot.shapes[2]).toMatchObject({ type: "line", props: { closed: false,
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }] } });
  });

  it("resolves relative text sizes through root, groups and tspan, and persists native inline math", () => {
    const before = fixture('<g font-size="1.25em"><text x="20" y="50" font-size="150%">質量 <tspan font-style="italic">m</tspan><tspan font-size="80%"> kg</tspan></text></g>', 'font-size="12pt"');
    const result = convertSvgImageToSigma(before, "image");
    expect(result).toMatchObject({ convertedCount: 1, textCount: 1, mathCount: 1, preservedCount: 0 });
    expect(result.snapshot.shapes[0]).toMatchObject({ type: "text", props: { fontSize: 22.5, blocks: [{ children: [
      { type: "text", text: "質量 " }, { type: "mathInline", tex: "m" }, { type: "text", text: " kg", fontSize: 18 },
    ] }] } });
    expect(normalizeOverlaySnapshot(JSON.parse(JSON.stringify(result.snapshot)))).toEqual(result.snapshot);
  });

  it("keeps group opacity compositing intact and never splits a compound fill with holes", () => {
    const result = convertSvgImageToSigma(fixture('<g opacity="0.5"><rect x="10" y="10" width="40" height="40"/><rect x="20" y="20" width="40" height="40"/></g><path d="M20 20h60v60h-60z M30 30h20v20h-20z" fill-rule="evenodd"/><circle cx="150" cy="60" r="10"/>'), "image");
    expect(result).toMatchObject({ convertedCount: 1, preservedCount: 1 });
    expect(decodeSvgDataUrl(Object.values(result.snapshot.assets)[0].props.src)).toContain('opacity="0.5"');
  });

  it("keeps shared assets and extension references, and retains the original id and body anchor", () => {
    const before = fixture('<rect x="20" y="20" width="30" height="30"/><circle cx="140" cy="60" r="15"/>');
    before.shapes[0].anchor = { type: "block", blockId: "p", dx: 10, dy: 20, line: { index: 0, dy: 20 } };
    before.shapes.push({ ...before.shapes[0], id: "other", x: 300 });
    before.extensions = { "test.assets": { original: "svg_asset" } };
    const result = convertSvgImageToSigma(before, "image");
    expect(result.snapshot.shapes[1].anchor).toEqual({ type: "block", blockId: "p", dx: 30, dy: 40, line: { index: 0, dy: 40 } });
    expect(result.snapshot.assets.svg_asset).toBe(before.assets.svg_asset);
    expect(result.snapshot.extensions).toEqual(before.extensions);
    expect(result.snapshot.shapes.at(-1)?.id).toBe("other");
  });

  it("preserves image rotation, reflection and opacity", () => {
    const before = fixture('<rect x="20" y="20" width="30" height="20"/>');
    before.shapes[0] = { ...before.shapes[0], rotation: Math.PI / 2, flipX: true, opacity: 0.4 };
    const result = convertSvgImageToSigma(before, "image");
    expect(result.snapshot.shapes[0]).toMatchObject({ id: "image", type: "geo", rotation: Math.PI / 2, flipX: true, opacity: 0.4 });
  });

  it.each([
    '<script>alert(1)</script>', '<rect width="30" height="30" onclick="alert(1)"/>',
    '<use href="https://example.com/x.svg"/>', '<rect width="30" height="30" fill="url(https://example.com/x)"/>',
    '<style>rect { fill: red }</style>',
  ])("rejects active content or external references without changing the image: %s", (body) => {
    const before = fixture(body), copy = structuredClone(before);
    expect(() => convertSvgImageToSigma(before, "image")).toThrow(SvgConversionError);
    expect(before).toEqual(copy);
  });

  it("leaves unsupported, malformed, oversized or cropped images intact", () => {
    for (const before of [fixture('<text>文字だけ</text>'), fixture('<path d="M0 0Q20 20 30 0"/>')]) {
      expect(() => convertSvgImageToSigma(before, "image")).toThrow(SvgConversionError);
      expect(before.shapes[0].type).toBe("image");
    }
    const cropped = fixture('<rect x="20" y="20" width="40" height="40"/>');
    if (cropped.shapes[0].type === "image") cropped.shapes[0].props.crop = { topLeft: { x: 0.2, y: 0 }, bottomRight: { x: 1, y: 1 } };
    expect(() => convertSvgImageToSigma(cropped, "image")).toThrow("cropped");
    expect(() => decodeSvgDataUrl('data:image/svg+xml;base64,!!!')).toThrow("source");
    expect(() => decodeSvgDataUrl('data:image/svg+xml,' + 'x'.repeat(1024 * 1024 + 1))).toThrow("source");
    expect(() => convertSvgImageToSigma(fixture('<rect'), "image")).toThrow("source");
  });

  it("recognizes base64 SVG with MIME parameters and preserves Unicode", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>図</text></svg>';
    const url = 'data:image/svg+xml;charset=utf-8;base64,' + btoa(Array.from(new TextEncoder().encode(svg), (n) => String.fromCharCode(n)).join(''));
    expect(decodeSvgDataUrl(url)).toBe(svg);
    const asset = fixture("").assets.svg_asset;
    expect(isSvgImageAsset({ ...asset, props: { ...asset.props, mimeType: null, src: url } })).toBe(true);
    expect(isSvgImageAsset(undefined)).toBe(false);
  });

  it("uses host-measured crops for residual SVG without covering every native part", () => {
    const before = fixture('<rect x="20" y="20" width="30" height="30"/><text x="100" y="90" stroke="red">ラベル</text>');
    const result = convertSvgImageToSigma(before, "image", undefined, (root) => {
      expect(root.tag).toBe("svg");
      expect(root.children).toEqual(expect.arrayContaining([expect.objectContaining({ tag: "text" })]));
      return { x: 90, y: 70, w: 60, h: 30 };
    });
    expect(result.snapshot.shapes[2]).toMatchObject({ type: "image", x: 120, y: 120, props: { w: 60, h: 30,
      crop: { topLeft: { x: 0.45, y: 70 / 120 }, bottomRight: { x: 0.75, y: 100 / 120 } } } });
    expect(isValidOverlaySnapshot(result.snapshot)).toBe(true);
  });
});
