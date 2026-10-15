import { describe, expect, it } from "vitest";
import { isValidOverlaySnapshot, normalizeOverlaySnapshot, type OverlayAsset, type OverlayShape, type OverlaySnapshot } from "@/features/document";
import { convertSvgImageToSigma, decodeSvgDataUrl, isSvgImageAsset, SvgConversionError } from "./svg-to-sigma";
import { getSvgImageDimensions } from "./svg-image-source";

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

  it("leaves unsupported, malformed or oversized images intact", () => {
    for (const before of [fixture('<text>文字だけ</text>'), fixture('<path d="M0 0Q20 20 30 0"/>')]) {
      expect(() => convertSvgImageToSigma(before, "image")).toThrow(SvgConversionError);
      expect(before.shapes[0].type).toBe("image");
    }
    expect(() => decodeSvgDataUrl('data:image/svg+xml;base64,!!!')).toThrow("source");
    expect(() => decodeSvgDataUrl('data:image/svg+xml,' + 'x'.repeat(1024 * 1024 + 1))).toThrow("source");
    expect(() => convertSvgImageToSigma(fixture('<rect'), "image")).toThrow("source");
  });

  it("converts a 500×460 SVG in a rounded 440×405 frame using the displayed cover scale", () => {
    const before = fixture('<rect x="100" y="100" width="40" height="30"/>', 'width="500" height="460"');
    before.assets.svg_asset.props = { ...before.assets.svg_asset.props, w: 500, h: 460,
      src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 460"><rect x="100" y="100" width="40" height="30"/></svg>') };
    if (before.shapes[0].type !== "image") throw new Error("fixture");
    before.shapes[0].props = { ...before.shapes[0].props, w: 440, h: 405 };
    const result = convertSvgImageToSigma(before, "image");
    const scale = 405 / 460;
    expect(result).toMatchObject({ convertedCount: 1, preservedCount: 0 });
    expect(result.snapshot.shapes[0].x).toBeCloseTo(30 + (440 - 500 * scale) / 2 + 100 * scale);
    expect(result.snapshot.shapes[0].y).toBeCloseTo(50 + 100 * scale);
    expect(result.snapshot.shapes[0]).toMatchObject({ type: "geo", props: { w: expect.closeTo(40 * scale), h: expect.closeTo(30 * scale) } });
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
    expect(result.snapshot.shapes[2]).toMatchObject({ type: "image", x: 120, y: 120, props: { w: 60, h: 30 } });
    expect(decodeSvgDataUrl(Object.values(result.snapshot.assets)[0].props.src)).toContain('viewBox="90 70 60 30"');
    expect(isValidOverlaySnapshot(result.snapshot)).toBe(true);
  });
});

describe("SVG conversion uses the visible crop", () => {
  function cropped() {
    const before = fixture('<rect x="60" y="20" width="30" height="30"/><rect x="20" y="20" width="40" height="40"/><circle cx="180" cy="30" r="5"/>');
    if (before.shapes[0].type !== "image") throw new Error("fixture");
    before.shapes[0].props = { ...before.shapes[0].props, w: 100, h: 120,
      crop: { topLeft: { x: 0.25, y: 0 }, bottomRight: { x: 0.75, y: 1 } } };
    return before;
  }

  it("converts visible parts, clips crossing parts and omits hidden parts in stack order", () => {
    const before = cropped(), copy = structuredClone(before);
    const result = convertSvgImageToSigma(before, "image", undefined, (root) => {
      const rect = root.children.find((child) => typeof child !== "string" && child.tag === "rect");
      return rect ? { x: 19, y: 19, w: 42, h: 42 } : { x: 174, y: 24, w: 12, h: 12 };
    });
    expect(before).toEqual(copy);
    expect(result).toMatchObject({ convertedCount: 1, preservedCount: 1 });
    expect(result.snapshot.shapes).toMatchObject([
      { id: "image", type: "group" },
      { type: "geo", x: 40, y: 70, props: { w: 30, h: 30 } },
      { type: "image", x: 30, y: 69, props: { w: 11, h: 42 } },
    ]);
    const residual = Object.values(result.snapshot.assets)[0];
    expect(residual.props).toMatchObject({ w: 11, h: 42 });
    expect(decodeSvgDataUrl(residual.props.src)).toContain('viewBox="50 19 11 42"');
    expect(normalizeOverlaySnapshot(JSON.parse(JSON.stringify(result.snapshot)))).toEqual(result.snapshot);
  });

  it("retains the visible window when host measurement is unavailable", () => {
    const result = convertSvgImageToSigma(cropped(), "image");
    expect(result).toMatchObject({ convertedCount: 1, preservedCount: 1 });
    expect(result.snapshot.shapes[2]).toMatchObject({ type: "image", x: 30, y: 50, props: { w: 100, h: 120 } });
    expect(decodeSvgDataUrl(Object.values(result.snapshot.assets)[0].props.src)).toContain('viewBox="50 0 100 120"');
  });

  it("keeps sub-minimum-width fragments cropped without revealing hidden pixels", () => {
    const result = convertSvgImageToSigma(cropped(), "image", undefined, () => ({ x: 49, y: 20, w: 2, h: 40 }));
    expect(result.snapshot.shapes[2]).toMatchObject({ type: "image", x: 30, y: 70, props: { w: 1, h: 40 } });
    expect(result.snapshot.shapes[2].props).not.toHaveProperty("crop");
    expect(decodeSvgDataUrl(Object.values(result.snapshot.assets)[0].props.src)).toContain('viewBox="50 20 1 40"');
  });

  it("preserves crop placement through rotation, reflection and body anchoring", () => {
    const before = cropped();
    before.shapes[0] = { ...before.shapes[0], rotation: Math.PI, flipX: true,
      anchor: { type: "block", blockId: "p", dx: 5, dy: 10, line: { index: 0, dy: 10 } } };
    const result = convertSvgImageToSigma(before, "image");
    const rect = result.snapshot.shapes.find((shape) => shape.type === "geo")!;
    expect(rect.x).toBeCloseTo(40);
    expect(rect.y).toBeCloseTo(120);
    expect(rect.anchor).toEqual({ type: "block", blockId: "p", dx: 15, dy: 80, line: { index: 0, dy: 80 } });
    expect(normalizeOverlaySnapshot(JSON.parse(JSON.stringify(result.snapshot)))).toEqual(result.snapshot);
  });

  it("retains viewBox and inherited styling in the cropped residual SVG", () => {
    const before = fixture("");
    before.assets.svg_asset.props.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 10 100 60" fill="blue"><g fill="red"><rect x="20" y="20" width="20" height="10"/><path d="M50 20 Q60 30 70 20"/></g></svg>');
    const result = convertSvgImageToSigma(before, "image");
    const residual = decodeSvgDataUrl(Object.values(result.snapshot.assets)[0].props.src);
    expect(residual).toContain('viewBox="10 10 100 60"');
    expect(residual).toContain('width="100" height="60" x="0" y="0"');
    expect(residual).toContain('fill="blue"');
    expect(residual).toContain('<g fill="red">');
    expect(isValidOverlaySnapshot(result.snapshot)).toBe(true);
  });

  it("preserves percentage-based residual geometry in its original nested viewport", () => {
    const before = fixture('<defs><linearGradient id="gradient" gradientUnits="userSpaceOnUse" x2="100%"><stop offset="0" stop-color="black"/><stop offset="1" stop-color="white"/></linearGradient></defs><rect x="60" y="20" width="30" height="30"/><rect x="10%" y="20" width="40%" height="40" fill="url(#gradient)"/>');
    if (before.shapes[0].type !== "image") throw new Error("fixture");
    before.shapes[0].props = { ...before.shapes[0].props, w: 100, h: 120,
      crop: { topLeft: { x: 0.25, y: 0 }, bottomRight: { x: 0.75, y: 1 } } };
    const result = convertSvgImageToSigma(before, "image", undefined, () => ({ x: 20, y: 20, w: 80, h: 40 }));
    const asset = Object.values(result.snapshot.assets)[0];
    const residual = decodeSvgDataUrl(asset.props.src);
    expect(residual).toContain('viewBox="50 20 50 40"');
    expect(residual).toContain('viewBox="0 0 200 120" width="200" height="120"');
    expect(residual).toContain('x2="100%"');
    expect(getSvgImageDimensions(asset.props.src)).toEqual({ width: 50, height: 40 });
  });

  it.each(['<script>alert(1)</script>', '<image href="https://example.com/image.png"/>'])
    ("validates nested viewport contents: %s", (body) => {
      const before = fixture(`<rect x="50" y="20" width="30" height="30"/><svg width="100" height="100">${body}</svg>`);
      expect(() => convertSvgImageToSigma(before, "image")).toThrow(SvgConversionError);
      expect(before.shapes).toHaveLength(1);
    });
});
