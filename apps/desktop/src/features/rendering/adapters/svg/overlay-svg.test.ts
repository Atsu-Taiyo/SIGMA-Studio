import { describe, expect, it } from "vitest";

import type { OverlayShape } from "@/features/document";
import { createGraph3DSpecPreset } from "@/features/drawing";
import { buildGraph3DPresetNames } from "@/lib/graph3d-preset-names";
import { createTranslator } from "@/lib/i18n";

import {
  serializeOverlayPreviewSvg,
  serializeOverlaySvg,
  type OverlaySvgRenderers,
} from ".";

const renderers: OverlaySvgRenderers = {
  renderGraphHtml: (_spec, idSeed) => `<svg data-graph="${idSeed}"></svg>`,
  renderMathHtml: (tex) => `<span data-math="${tex}"></span>`,
  renderOverlayTextHtml: (blocks) => `<div data-overlay-text="${blocks.length}"></div>`,
  renderTableHtml: (_table, width, height) => `<div data-table="${width}x${height}"></div>`,
  renderChartSvg: (_data, spec, width, height) => `<g data-chart="${spec.kind}:${width}x${height}"></g>`,
};

interface ForeignObjectRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Pulls every `<foreignObject>`'s numeric x/y/width/height out of a serialized SVG. Text
 * shapes bleed their foreignObject rect by a font-size-derived margin (see
 * `getOverlayTextBleedPx` in overlay-svg.ts), so asserting on parsed numbers instead of a
 * literal string keeps these tests from needing an update every time that bleed constant is
 * retuned.
 */
function getForeignObjectRects(svg: string | undefined): ForeignObjectRect[] {
  if (!svg) {
    return [];
  }
  return [...svg.matchAll(/<foreignObject x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)" height="(-?[\d.]+)"/g)]
    .map((match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
    }));
}

describe("headless overlay SVG serializer", () => {
  it("exports a 3D teaching material through its derived static preview", () => {
    const shape: OverlayShape = {
      id: "shape_graph3d",
      type: "graph3dShape",
      x: 18,
      y: 26,
      rotation: Math.PI / 6,
      props: {
        w: 320,
        h: 220,
        spec: createGraph3DSpecPreset("revolution", buildGraph3DPresetNames(createTranslator("ja", "shape"))),
        previewAssetId: "asset_graph3d",
        previewSourceHash: "fnv1a32:test",
      },
    };
    const svg = serializeOverlaySvg(
      [shape],
      {
        asset_graph3d: {
          id: "asset_graph3d",
          type: "image",
          props: {
            w: 640,
            h: 440,
            name: "3D preview.png",
            isAnimated: false,
            mimeType: "image/png",
            src: "data:image/png;base64,AA==",
            fileSize: 1,
          },
        },
      },
      { width: 500, height: 400 },
      renderers,
    );

    expect(svg).toContain('<image x="18" y="26" width="320" height="220" href="data:image/png;base64,AA=="');
    expect(svg).toContain('data-graph3d-label="dimension_upper"');
    expect(svg).toContain('data-math="\\sqrt{3}"');
    expect(svg).toContain("transform=\"rotate(30 178 136)\"");
  });

  it("keeps geometry, label, and viewport output independent from React", () => {
    const rectangle: OverlayShape = {
      id: "shape_rect",
      type: "geo",
      x: 20,
      y: 30,
      props: {
        w: 100,
        h: 60,
        geo: "rectangle",
        fill: "none",
        color: "#123456",
        label: "AB",
        labelColor: "#654321",
        dash: "solid",
        size: "m",
      },
    };

    const svg = serializeOverlaySvg(
      [rectangle],
      {},
      { width: 200, height: 120, offsetX: 10, offsetY: 15 },
      renderers,
    );

    expect(svg).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 15 200 120" width="200" height="120">',
    );
    expect(svg).toContain(
      '<rect x="20" y="30" width="100" height="60" fill="transparent" stroke="#123456" stroke-width="2"',
    );
    expect(svg).toContain(
      '<text x="70" y="60" fill="#654321" stroke="none" text-anchor="middle" dominant-baseline="middle" font-size="18">AB</text>',
    );
  });

  it("delegates only math markup while retaining the canonical text frame", () => {
    const text: OverlayShape = {
      id: "shape_text",
      type: "text",
      x: 24,
      y: 36,
      props: {
        w: 80,
        h: 20,
        color: "#111827",
        size: "m",
        blocks: [{
            type: "paragraph", id: "overlay_svg_test_20",
            children: [{
              type: "mathInline",
              id: "math_1",
              tex: "x^2",
              display: "inline",
            }],
          }],
      },
    };

    const svg = serializeOverlaySvg(
      [text],
      {},
      { width: 160, height: 100 },
      renderers,
    );

    // Content box is unchanged (80x20 was already big enough for "x^2"); the foreignObject
    // rect is bled out by floor(16px font * 0.6em) = 10px on every side so print's clip at
    // width/height doesn't cut off glyphs that render slightly outside their content box.
    expect(getForeignObjectRects(svg)).toEqual([{ x: 14, y: 26, width: 100, height: 40 }]);
    // Second, independent guard against print clipping: Chromium drops glyphs that fall
    // outside a foreignObject rather than clipping them at paint time, so ink past the bleed
    // would be absent from the PDF entirely. Do not remove without replacing the mechanism.
    expect(svg).toContain('height="40" overflow="visible"');
    // The serializer owns the box — width, height, colour and font size — and delegates the text
    // itself to the renderer port, the same split the table already uses. What that port actually
    // emits (the body's static blocks, with the stylesheet inlined) is pinned where it is built,
    // in `OverlayTextBlocksView.test.tsx` and `rich-text-self-contained.test.ts`.
    expect(svg).toContain("width:80px;min-height:20px");
    expect(svg).toContain("font-size:12pt");
    expect(svg).toContain('<div data-overlay-text="1"></div>');
  });

  it("grows a text shape's foreignObject past a stale one-line stored height when richText has more lines", () => {
    const text: OverlayShape = {
      id: "shape_text_stale_height",
      type: "text",
      x: 10,
      y: 10,
      props: {
        // Stored height only accounts for a single line, e.g. left over from before more
        // lines were typed in. The wide stored width keeps this from wrapping by width, so
        // the six hard breaks alone should drive the effective height.
        w: 200,
        h: 16,
        color: "#111827",
        size: "m",
        blocks: [{
            type: "paragraph", id: "overlay_svg_test_21",
            children: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6" }],
          }],
      },
    };

    const svg = serializeOverlaySvg(
      [text],
      {},
      { width: 400, height: 300 },
      renderers,
    );

    const [rect] = getForeignObjectRects(svg);
    // 6 lines * 16px line height = 96px content height, well past the stale stored h:16.
    expect(rect.height).toBeGreaterThanOrEqual(96);
  });

  it("returns nothing for an overlay without a canonical snapshot", () => {
    expect(serializeOverlayPreviewSvg(
      {},
      { width: 100, height: 80 },
      renderers,
    )).toBeUndefined();
  });
});
