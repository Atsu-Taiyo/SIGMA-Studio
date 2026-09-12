import { describe, expect, it } from "vitest";

import { DEFAULT_TEXT_SHAPE_WIDTH } from "@/features/drawing";
import { createSigmaDocAgentSession, executeSigmaDocAgentDraftTool } from "@/lib/ai/sigma-doc-agent-tools";
import { exportOverlaySvg, getOverlayPreviewSvg } from "@/features/rendering/adapters/svg";
import type { SigmaDocument } from "@/types/sigma-doc";

import { createGraphShapeProps, getGraphRenderLayout } from "./shapes/graph";
import { createTableShapeProps, insertTableColumn } from "./shapes/table";
import type { OverlayShape, OverlaySnapshot } from "./types";

interface ForeignObjectRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Pulls every `<foreignObject>`'s numeric x/y/width/height out of a serialized SVG. Text
 * shapes bleed their foreignObject rect by a font-size-derived margin (see
 * `getOverlayTextBleedPx` in overlay-svg.ts) and their effective height/width now follow
 * measured wrapped content, so asserting on parsed numbers instead of a literal string keeps
 * these tests from needing an update every time that padding or the estimator is retuned.
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

describe("overlay svg export", () => {
  it("derives a preview svg from snapshot-only overlays", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_rect",
          type: "geo",
          x: 20,
          y: 30,
          props: {
            w: 100,
            h: 60,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain("<svg");
    expect(svg).toContain("<rect");
    expect(svg).toContain('fill="transparent"');
  });

  it("exports callout outline and embedded rich text/math as one shape", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [{
        id: "callout_rich",
        type: "callout",
        x: 20,
        y: 30,
        props: {
          w: 160,
          h: 72,
          radius: 18,
          tail: {
            baseStart: { x: 36, y: 72 },
            baseEnd: { x: 68, y: 72 },
            tip: { x: 24, y: 104 },
          },
          blocks: [{
              type: "paragraph", id: "svg_export_test_24",
              children: [
                { type: "text", text: "式 " },
                {
                  type: "mathInline",
                  id: "math_1",
                  tex: "x^2",
                  display: "inline",
                },
              ],
            }],
          color: "#111111",
          size: "m",
          dash: "solid",
          strokeWidth: "m",
        },
      }],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain('<path transform="translate(20 30)"');
    // Bled out by `getOverlayTextBleedPx` (10px for this 16px font) and marked
    // `overflow="visible"`, matching the `text` shape branch: Chromium's PDF backend clips
    // `<foreignObject>` content at its declared box with no fallback, so descenders/accents on
    // the un-bled 136x48 box would silently vanish from print.
    expect(svg).toContain('<foreignObject x="22" y="32" width="156" height="68" overflow="visible">');
    expect(svg).toContain("data-sigma-doc-math-inline");
    expect(svg).toContain("x^2");
  });

  it("exports the callout outline with its own stroke width and dash", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [{
        id: "callout_stroked",
        type: "callout",
        x: 20,
        y: 30,
        props: {
          w: 160,
          h: 72,
          radius: 18,
          tail: {
            baseStart: { x: 36, y: 72 },
            baseEnd: { x: 68, y: 72 },
            tip: { x: 24, y: 104 },
          },
          blocks: [{ type: "paragraph", id: "svg_export_test_25", children: [] }],
          color: "#111111",
          size: "m",
          dash: "dashed",
          strokeWidth: "l",
        },
      }],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain('stroke-width="3"');
    expect(svg).toContain('stroke-dasharray="8 6"');
  });

  it("exports diagonal hatch fills for closed line shapes", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_hatch",
          type: "line",
          x: 10,
          y: 20,
          props: {
            kind: "polyline",
            points: [
              { x: 0, y: 0 },
              { x: 24, y: 0 },
              { x: 24, y: 24 },
              { x: 0, y: 24 },
            ],
            closed: true,
            fill: "solid",
            fillColor: "#ffffff",
            fillOpacity: 1,
            fillPattern: "diagonalHatch",
            color: "#0d0d0d",
            strokeOpacity: 0.82,
            dash: "solid",
            size: "s",
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain('<pattern id="fill-shape_hatch"');
    expect(svg).toContain('fill="url(#fill-shape_hatch)"');
    expect(svg).toContain('d="M -1 7 L 7 -1"');
  });

  it("escapes shape ids in arrow marker definitions and references", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: 'evil" onload="x<',
          type: "arrow",
          x: 0,
          y: 0,
          props: {
            start: { x: 0, y: 0 },
            end: { x: 80, y: 0 },
            arrowheadStart: "arrow",
            arrowheadEnd: "arrow",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain('id="arrowhead-evil&quot; onload=&quot;x&lt;-start"');
    expect(svg).toContain('marker-start="url(#arrowhead-evil&quot; onload=&quot;x&lt;-start)"');
    expect(svg).toContain("&quot;");
    expect(svg).not.toContain('onload="x"');
  });

  it("can export foreground and background overlay stack layers separately", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_background",
          type: "geo",
          x: 20,
          y: 30,
          stackLayer: "background",
          props: {
            w: 100,
            h: 60,
            geo: "rectangle",
            fill: "none",
            color: "#ef4444",
            labelColor: "#ef4444",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "shape_foreground",
          type: "geo",
          x: 40,
          y: 50,
          props: {
            w: 100,
            h: 60,
            geo: "rectangle",
            fill: "none",
            color: "#2563eb",
            labelColor: "#2563eb",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    const backgroundSvg = getOverlayPreviewSvg({ overlaySnapshot }, undefined, { stackLayer: "background" });
    const foregroundSvg = getOverlayPreviewSvg({ overlaySnapshot }, undefined, { stackLayer: "foreground" });

    expect(backgroundSvg).toContain("#ef4444");
    expect(backgroundSvg).not.toContain("#2563eb");
    expect(foregroundSvg).toContain("#2563eb");
    expect(foregroundSvg).not.toContain("#ef4444");
  });

  it("exports rotated overlay shapes with a centered svg transform", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_rotated_rect",
          type: "geo",
          x: 20,
          y: 30,
          rotation: Math.PI / 4,
          props: {
            w: 100,
            h: 60,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain('transform="rotate(45 70 60)"');
    expect(svg).toContain("<rect");
  });

  it("exports flipped overlay shapes around the same pivot as rotation", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_flipped_rect",
          type: "geo",
          x: 20,
          y: 30,
          flipX: true,
          props: {
            w: 100,
            h: 60,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain('transform="translate(70 60) scale(-1 1) translate(-70 -60)"');
  });

  it("turns a rotated arc around the centre of what it draws", () => {
    // 弧は「中心 − r」を保存するので参照箱は円全体 (100,100)-(200,200)、その中心は (150,150)。
    // 実際に描かれる 1/4 円の中心は (175,175) で、そこが回転軸。
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_rotated_arc",
          type: "arc",
          x: 100,
          y: 100,
          rotation: Math.PI / 2,
          props: {
            r: 50,
            startAngle: 0,
            endAngle: Math.PI / 2,
            color: "black",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain('transform="rotate(90 175 175)"');
  });

  it("exports extended geometry and arrow styles while skipping hidden shapes", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_hidden",
          type: "geo",
          x: 1,
          y: 1,
          hidden: true,
          props: {
            w: 10,
            h: 10,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "shape_triangle",
          type: "geo",
          x: 20,
          y: 30,
          opacity: 0.4,
          props: {
            w: 100,
            h: 60,
            geo: "triangle",
            apexX: 24,
            fill: "solid",
            color: "#2563eb",
            fillColor: "#bfdbfe",
            strokeOpacity: 0.7,
            fillOpacity: 0.35,
            labelColor: "#2563eb",
            dash: "dashed",
            size: "l",
            label: "A",
          },
        },
        {
          id: "shape_arrow",
          type: "arrow",
          x: 30,
          y: 120,
          props: {
            start: { x: 0, y: 0 },
            end: { x: 80, y: 0 },
            arrowheadStart: "dot",
            arrowheadEnd: "bar",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "dotted",
            size: "xl",
            label: "t",
          },
        },
        {
          id: "shape_arc",
          type: "arc",
          x: 160,
          y: 130,
          props: {
            r: 40,
            startAngle: 0,
            endAngle: Math.PI,
            arrowheadStart: "dot",
            arrowheadEnd: "arrow",
            color: "#dc2626",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "shape_curve",
          type: "line",
          x: 220,
          y: 120,
          props: {
            kind: "curve",
            points: [
              { x: 0, y: 0 },
              { x: 40, y: -28 },
              { x: 92, y: 12 },
            ],
            closed: false,
            arrowheadStart: "bar",
            arrowheadEnd: "arrow",
            color: "#111827",
            labelColor: "#111827",
            dash: "solid",
            size: "m",
            label: "c",
          },
        },
        {
          id: "shape_sector",
          type: "arc",
          x: 320,
          y: 130,
          props: {
            kind: "sector",
            r: 30,
            startAngle: 0,
            endAngle: Math.PI / 2,
            fill: "solid",
            fillColor: "#e5e7eb",
            fillOpacity: 0.35,
            color: "#111827",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "shape_block_arrow",
          type: "geo",
          x: 380,
          y: 50,
          rotation: Math.PI,
          props: {
            w: 120,
            h: 48,
            geo: "blockArrow",
            headLengthRatio: 0.42,
            shaftRatio: 0.5,
            fill: "solid",
            fillColor: "#bfdbfe",
            fillOpacity: 0.8,
            color: "#1d4ed8",
            labelColor: "#1d4ed8",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain("<polygon");
    expect(svg).toContain("<path");
    expect(svg).toContain("A 40 40");
    expect(svg).toContain('marker-start="url(#dot-shape_arc-start)"');
    expect(svg).toContain('marker-end="url(#arrowhead-shape_arc-end)"');
    expect(svg).toContain("M 350 160 L 380 160 A 30 30");
    expect(svg).toContain('fill="#e5e7eb"');
    expect(svg).toContain('opacity="0.4"');
    expect(svg).toContain('fill="#bfdbfe"');
    expect(svg).toContain('stroke-opacity="0.7"');
    expect(svg).toContain('fill-opacity="0.35"');
    expect(svg).toContain('stroke-dasharray="8 6"');
    // Only the heads a shape actually references are declared now. Every shape used to emit all
    // six markers in its own colour, so this assertion used to match the first one in the output;
    // the arc is the only shape here that asks for an arrow head.
    expect(svg).toContain(
      'd="M 1.5 1.5 L 7 4 L 1.5 6.5" fill="none" stroke="#dc2626" stroke-width="1.2" stroke-linecap="butt" stroke-linejoin="miter"',
    );
    expect(svg).not.toContain('id="arrowhead-shape_arrow-end"');
    expect(svg).not.toContain('stroke-linecap="round"');
    expect(svg).not.toContain('stroke-linejoin="round"');
    expect(svg).toContain('marker-start="url(#dot-shape_arrow-start)"');
    expect(svg).toContain('marker-end="url(#bar-shape_arrow-end)"');
    // The curve carries an `arrow` at its end, so it is drawn a stroke short of its stored end
    // point (312,132) and the head's own point takes that place. Only the ink moves — the exported
    // shape's coordinates are still the ones in the snapshot above.
    expect(svg).toContain('<path d="M 220 120 Q 258.51 93.04 308.15 129.12"');
    expect(svg).toContain('marker-start="url(#bar-shape_curve-start)"');
    expect(svg).toContain('marker-end="url(#arrowhead-shape_curve-end)"');
    expect(svg).toContain('transform="rotate(180 440 74)"');
    expect(svg).toContain('points="380,62');
    expect(svg).toContain('fill="#bfdbfe"');
    expect(svg).toContain(">A</text>");
    expect(svg).toContain(">t</text>");
    expect(svg).toContain(">c</text>");
    // The caption coordinates, pinned: the arrow's is the middle of its stored segment eight
    // pixels up, the curve's is `points[1]` rather than the geometric middle. The export used to
    // put an arrow's caption on `points[1]` too — its tip — which is not where the editor canvas
    // draws it; both now read the same anchor.
    expect(svg).toContain('<text x="70" y="112"');
    expect(svg).toContain('<text x="260" y="84"');
    expect(svg).not.toContain("shape_hidden");
  });

  it("exports group children with ancestor visibility and opacity applied", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "visible_group",
          type: "group",
          x: 20,
          y: 20,
          opacity: 0.5,
          props: { w: 80, h: 30 },
        },
        {
          id: "shape_blue",
          type: "geo",
          x: 20,
          y: 20,
          parentId: "visible_group",
          opacity: 0.5,
          props: {
            w: 30,
            h: 30,
            geo: "rectangle",
            fill: "none",
            color: "#2563eb",
            labelColor: "#2563eb",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "shape_green",
          type: "geo",
          x: 70,
          y: 20,
          parentId: "visible_group",
          props: {
            w: 30,
            h: 30,
            geo: "rectangle",
            fill: "none",
            color: "#16a34a",
            labelColor: "#16a34a",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "hidden_group",
          type: "group",
          x: 20,
          y: 80,
          hidden: true,
          props: { w: 80, h: 30 },
        },
        {
          id: "shape_hidden_red",
          type: "geo",
          x: 20,
          y: 80,
          parentId: "hidden_group",
          props: {
            w: 30,
            h: 30,
            geo: "rectangle",
            fill: "none",
            color: "#dc2626",
            labelColor: "#dc2626",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "shape_hidden_orange",
          type: "geo",
          x: 70,
          y: 80,
          parentId: "hidden_group",
          props: {
            w: 30,
            h: 30,
            geo: "rectangle",
            fill: "none",
            color: "#ea580c",
            labelColor: "#ea580c",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain('opacity="0.25"');
    expect(svg).toContain('opacity="0.5"');
    expect(svg).toContain('stroke="#2563eb"');
    expect(svg).toContain('stroke="#16a34a"');
    expect(svg).not.toContain("visible_group");
    expect(svg).not.toContain("#dc2626");
    expect(svg).not.toContain("#ea580c");
  });

  it("exports only shapes that intersect the requested page slice", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_page_1",
          type: "geo",
          x: 20,
          y: 30,
          props: {
            w: 100,
            h: 60,
            geo: "rectangle",
            fill: "none",
            color: "#2563eb",
            labelColor: "#2563eb",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "shape_page_2",
          type: "geo",
          x: 20,
          y: 1160,
          props: {
            w: 100,
            h: 60,
            geo: "rectangle",
            fill: "none",
            color: "#dc2626",
            labelColor: "#dc2626",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    const svg = exportOverlaySvg(overlaySnapshot.shapes, overlaySnapshot.assets, {
      width: 600,
      height: 900,
      offsetY: 1000,
    });

    expect(svg).toContain("#dc2626");
    expect(svg).not.toContain("#2563eb");
  });

  it("exports closed polylines as outline polygons", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_closed_polyline",
          type: "line",
          x: 10,
          y: 20,
          props: {
            kind: "polyline",
            points: [
              { x: 0, y: 0 },
              { x: 60, y: 0 },
              { x: 30, y: 40 },
            ],
            closed: true,
            arrowheadStart: "bar",
            arrowheadEnd: "arrow",
            color: "#111827",
            labelColor: "#111827",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain('<polygon points="10,20 70,20 40,60" fill="none" stroke="#111827"');
    expect(svg).not.toContain("<polyline");
    expect(svg).not.toContain('marker-start="url(');
    expect(svg).not.toContain('marker-end="url(');
  });

  it("exports filled closed polylines", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_filled_polyline",
          type: "line",
          x: 10,
          y: 20,
          props: {
            kind: "polyline",
            points: [
              { x: 0, y: 0 },
              { x: 60, y: 0 },
              { x: 30, y: 40 },
            ],
            closed: true,
            fill: "solid",
            fillColor: "#fde68a",
            fillOpacity: 0.5,
            color: "#111827",
            labelColor: "#111827",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain('<polygon points="10,20 70,20 40,60" fill="#fde68a" stroke="#111827"');
    expect(svg).toContain('fill-opacity="0.5"');
  });

  it("regenerates graph previews with static SVG labels from the snapshot", () => {
    const props = createGraphShapeProps("line");
    props.spec = {
      ...props.spec,
      axes: {
        ...props.spec.axes,
        showTicks: true,
        yTickStep: "1/2",
      },
      curves: props.spec.curves.map((curve) => ({
        ...curve,
        label: "y = \\dfrac{1}{2}x",
      })),
      annotations: [
        {
          id: "annotation_fraction",
          x: "0",
          y: "0",
          text: "\\dfrac{1}{2}",
        },
      ],
      fills: [
        {
          id: "fill_1",
          x: "1",
          y: "1",
          pattern: "dots",
        },
      ],
    };
    const graphShape = {
      id: "shape_graph",
      type: "graph2dShape" as const,
      x: 20,
      y: 30,
      rotation: Math.PI / 4,
      props,
    };
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [graphShape],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain("graph2d-fill-region");
    expect(svg).toContain("graph2d-fill-pattern");
    expect(svg).toContain("axis-arrow-shape_graph");
    expect(svg).toContain('class="graph2d-tex-label"');
    expect(svg?.match(/<foreignObject/g)).toHaveLength(1);
    expect(svg).not.toContain("class=\"katex\"");
    expect(svg).not.toContain("_R_");
    expect(svg).toContain("background:transparent");
    expect(svg).not.toContain("background:#ffffff");
    const layout = getGraphRenderLayout(graphShape);
    expect(svg).toContain(
      `<foreignObject x="${layout.renderBounds.x}" y="${layout.renderBounds.y}" width="${layout.renderBounds.w}" height="${layout.renderBounds.h}">`,
    );
    expect(svg).toContain(`transform="rotate(45 ${graphShape.x + props.w / 2} ${graphShape.y + props.h / 2})"`);
  });

  it("exports text shape inline math with the same wrapper classes as the live editor", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_label",
          type: "text",
          x: 80,
          y: 96,
          props: {
            w: 120,
            h: 24,
            color: "#111827",
            fontSize: 10.5,
            size: "s",
            blocks: [
                {
                  type: "paragraph", id: "svg_export_test_26",
                  children: [
                    {
                      type: "mathInline",
                      id: "math_label",
                      tex: "s",
                      display: "inline",
                      marks: ["underline", "boxed"],
                      backgroundColor: "#f6e500",
                      fontFamily: '"HG丸ｺﾞｼｯｸM-PRO", sans-serif',
                      fontSize: 13.333,
                      boxedPaddingY: 1,
                    },
                  ],
                },
              ],
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain('class="inline-math-node"');
    expect(svg).toContain('class="math-preview math-preview-inline"');
    expect(svg).toContain('data-sigma-doc-math-inline=""');
    // Both renderers now emit the boxed metadata the live editor carries.
    expect(svg).toContain('class="boxed-text boxed-inline-math"');
    expect(svg).toContain('data-sigma-doc-boxed-padding-y="1"');
    expect(svg).toContain('class="sigma-underline-run"');
    // `contenteditable` was a Tiptap-era leftover of the string serializer; the live static view
    // has never emitted it, and it means nothing in an exported SVG.
    expect(svg).not.toContain("contenteditable");
    expect(svg).toContain("background-color:#f6e500");
    expect(svg).toContain("font-family:&quot;HG丸ｺﾞｼｯｸM-PRO&quot;, sans-serif");
    expect(svg).toContain("font-size:10.5pt;line-height:1");
    expect(svg).toContain("font-size:13.333pt");
    // A run that contains math is underlined with a bottom border, not `text-decoration`:
    // Chromium cannot draw the decoration between a glyph and a formula. Mirrors the
    // `.sigma-underline-run:has(.math-preview)` rule so the exported SVG matches the live DOM
    // whether it is viewed standalone or injected back into the app.
    expect(svg).toContain("border-bottom:1.25px solid currentColor");
    expect(svg).not.toContain("text-decoration-line:underline");
    // The boxed frame mirrors `.boxed-text`, custom properties and all, so a variant or
    // tone attribute still resolves wherever the stylesheet is present.
    expect(svg).toContain("border:var(--boxed-text-border-width, 1px) var(--boxed-text-border-style, solid) var(--boxed-text-border-color, currentColor)");
    expect(svg).toContain("align-items:baseline");
    expect(svg).not.toContain("align-items:center");
  });

  it("keeps fixed-width text wrapping in SVG export", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_fixed_wrapped_text",
          type: "text",
          x: 30,
          y: 40,
          props: {
            w: 72,
            h: 48,
            color: "#111827",
            size: "m",
            blocks: [{
                type: "paragraph", id: "svg_export_test_27",
                children: [{ type: "text", text: "固定幅の長いテキストはエディタと同じ幅で折り返す" }],
              }],
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    // The box is the stored one — width the user set, height the DOM measured — and the exported
    // markup wraps inside it at that width. The foreignObject rect bleeds by floor(16*0.6) = 10px
    // on every side so a glyph that overflows the box is not clipped by the PDF backend.
    expect(getForeignObjectRects(svg)).toEqual([{ x: 20, y: 30, width: 92, height: 68 }]);
    expect(svg).toContain("width:72px;min-height:48px");
    // The wrapping rules now travel with the content box the blocks are drawn in, because that is
    // the element the stylesheet puts them on — the export inlines the same rule rather than
    // writing a second one onto the shape's outer div.
    expect(svg).toContain('class="overlay-text-shape-content" style="overflow-wrap:anywhere;white-space:pre-wrap"');
  });

  it("exports legacy sub-minimum text shapes at the editor fallback bounds", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_legacy_subminimum_text",
          type: "text",
          x: 24,
          y: 36,
          props: {
            w: 2,
            h: 1,
            color: "#111827",
            size: "m",
            blocks: [{
                type: "paragraph", id: "svg_export_test_28",
                children: [{ type: "text", text: "旧" }],
              }],
          },
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    // Content box is unchanged (a single CJK glyph still fits on one 16px line even at the
    // 8px stored/minimum width); only the foreignObject rect grows, bled by 10px on every
    // side.
    expect(getForeignObjectRects(svg)).toEqual([{ x: 14, y: 26, width: 28, height: 36 }]);
    expect(svg).toContain("width:8px;min-height:16px");
  });

  it("exports a tool-created text shape at the default width and one line", () => {
    const session = createSigmaDocAgentSession({ document: createTextToolTestDocument(), selectedId: "p_1" });
    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_measured_export",
      kind: "text",
      x: 20,
      y: 30,
      text: "あいうえおかきくけこ",
    });
    expect(result.ok).toBe(true);
    const shape = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((item) => item.id === "shape_measured_export");
    expect(shape?.type).toBe("text");
    if (!shape || shape.type !== "text") {
      throw new Error("tool-created text shape missing");
    }

    const svg = exportOverlaySvg([shape], {}, { width: 400, height: 300 });

    expect(shape.props).toMatchObject({ w: DEFAULT_TEXT_SHAPE_WIDTH, h: 16 });
    // The stored box is what the shape draws at; the foreignObject rect is bled by 10px on
    // every side.
    expect(getForeignObjectRects(svg)).toEqual([
      { x: 10, y: 20, width: DEFAULT_TEXT_SHAPE_WIDTH + 20, height: 36 },
    ]);
    expect(svg).toContain(`width:${DEFAULT_TEXT_SHAPE_WIDTH}px;min-height:16px`);
    expect(svg).toContain("overflow:visible");
  });

  it("exports a narrow tool text shape at the editor minimum box", () => {
    const session = createSigmaDocAgentSession({ document: createTextToolTestDocument(), selectedId: "p_1" });
    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_fixed_export",
      kind: "text",
      x: 24,
      y: 36,
      text: "固定",
      w: 5,
    });
    expect(result.ok).toBe(true);
    const shape = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((item) => item.id === "shape_fixed_export");
    expect(shape?.type).toBe("text");
    if (!shape || shape.type !== "text") {
      throw new Error("tool-created fixed text shape missing");
    }

    const svg = exportOverlaySvg([shape], {}, { width: 400, height: 300 });

    // The requested 5x7 box is clamped to the 8px minimum width and to one 16px line box; the
    // foreignObject rect adds the 10px bleed on every side. Wrapping no longer changes the stored
    // geometry — the width is the user's and the DOM writes the height back.
    expect(getForeignObjectRects(svg)).toEqual([{ x: 14, y: 26, width: 28, height: 36 }]);
    expect(svg).toContain("width:8px;min-height:16px");
  });

  /**
   * A shape holding the body blocks it gained. The export carries no stylesheet, so what has to
   * survive is the typography itself — a bare `blockquote` would take a 40px UA indent and reflow
   * the figure away from what the canvas draws.
   */
  it("exports a text shape's quote, code block and rule with their typography inline", () => {
    const shape: OverlayShape = {
      id: "shape_body_blocks",
      type: "text",
      x: 20,
      y: 30,
      rotation: 0,
      props: {
        w: 240,
        h: 120,
        color: "#111827",
        size: "m",
        blocks: [
          {
            type: "quote",
            id: "quote_1",
            blocks: [{ type: "paragraph", id: "quote_p", children: [{ type: "text", text: "引用" }] }],
          },
          { type: "codeBlock", id: "code_1", children: [{ type: "text", text: "code" }] },
          { type: "divider", id: "divider_1" },
        ],
      },
    };

    const svg = exportOverlaySvg([shape], {}, { width: 400, height: 300 });

    expect(svg).toContain("引用");
    expect(svg).toMatch(/<blockquote[^>]*style="[^"]*border-left:3px solid/);
    expect(svg).toMatch(/<pre[^>]*style="[^"]*background:#f7f8fa/);
    expect(svg).toMatch(/<hr[^>]*style="[^"]*border-top:1px solid/);
  });

  it("exports table shapes with inline math content and no rotation transform", () => {
    const tableProps = createTableShapeProps("plain", 240, 120);
    tableProps.table.defaultCellStyle.fontSize = 12.5;
    tableProps.table.grid.lineOverrides = [
      {
        axis: "vertical",
        beforeColumnId: tableProps.table.columns[1].id,
        style: {
          borderStyle: "dotted",
          borderWidth: 3,
        },
      },
      {
        axis: "horizontal",
        beforeRowId: tableProps.table.rows[1].id,
        style: {
          borderStyle: "double",
          borderWidth: 3,
        },
      },
      {
        axis: "horizontal",
        edge: "bottom",
        style: {
          visible: false,
        },
      },
    ];
    tableProps.table.cells[0] = {
      ...tableProps.table.cells[0],
      content: [
        {
          type: "paragraph",
          id: "table_p_math",
          children: [
            { type: "text", text: "f'(x)=" },
            {
              type: "mathInline",
              id: "table_math_1",
              tex: "\\frac{1-\\log x}{x^2}",
              display: "inline",
              marks: ["boxed"],
              backgroundColor: "#f6e500",
              fontFamily: '"Yu Mincho", serif',
              fontSize: 14,
              boxedPaddingY: 4,
            },
          ],
          align: "center",
        },
      ],
    };
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_table",
          type: "tableShape",
          x: 20,
          y: 30,
          rotation: Math.PI / 4,
          props: tableProps,
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain("font-size:12.5pt");

    expect(svg).toContain("<table");
    expect(svg).toContain("table-layout:fixed;background:transparent;border:0");
    expect(svg).not.toContain("table-layout:fixed;background:#ffffff");
    expect(svg).toContain('<foreignObject x="17" y="27" width="246" height="126">');
    expect(svg).toContain("padding:3px");
    // React escapes the apostrophe as an entity; the rendered glyph is the same.
    expect(svg).toContain("f&#x27;(x)=");
    expect(svg).toContain("ML__mfrac");
    expect(svg).toContain("background-color:#f6e500");
    expect(svg).toContain("font-family:&quot;Yu Mincho&quot;, serif");
    expect(svg).toContain("font-size:14pt");
    // The boxed math is a run segment, so it takes the height-target branch of
    // `document-surface.css` — baseline anchored (PR #223), not centred.
    expect(svg).toContain('data-boxed-run-height-target="true"');
    expect(svg).toContain("align-items:baseline");
    expect(svg).not.toContain("align-items:center;vertical-align:baseline;line-height:normal");
    expect(svg).toContain("border-right:3px dotted #111827");
    // The `double` boundary is drawn by the overlay layer, not by the cell edges.
    expect(svg).toContain("border-top:3px double #111827");
    // On the boundary between the first and second row: `<table height=120>` with three `auto` rows
    // of 34/32/32 resolves them to 41.63/39.18/39.18, and the line is centred on 41.63 (its own 3px
    // width taken off the top). It used to be drawn at 32.5 — centred on 34, the row height before
    // the shape's height was distributed — which put it 8px above the cell edge it stands in for,
    // because the browser had stretched the rows to fill the table and nothing here can measure
    // that. `overlay-output-read-model.test.ts` pins the resolved totals.
    expect(svg).toContain("top:40.13265306122449px");
    expect(svg).toContain("pointer-events:none");
    expect(svg).toContain("z-index:3");
    expect(svg).toContain("border-bottom:0");
    expect(svg).not.toContain("rotate(45");
  });

  it("keeps exported table layout fixed when inserted auto columns exist", () => {
    const tableProps = createTableShapeProps("plain", 240, 120);
    tableProps.table = insertTableColumn(tableProps.table, 1);
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_table",
          type: "tableShape",
          x: 20,
          y: 30,
          rotation: 0,
          props: tableProps,
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain("table-layout:fixed");
    expect(svg).not.toContain("table-layout:auto");
  });

  // The exported SVG is not only injected as HTML: `AiEditPanel` turns it into an
  // `image/svg+xml` data URI and rasterises it. XML attribute matching is case-sensitive, so
  // React's `rowSpan`/`colSpan` casing would be ignored there and every merged cell would
  // collapse to one column.
  it("writes table span attributes in the casing an XML parser accepts", () => {
    const tableProps = createTableShapeProps("plain", 240, 120);
    tableProps.table.cells[0] = { ...tableProps.table.cells[0], colSpan: 2, rowSpan: 2 };
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_table",
          type: "tableShape",
          x: 20,
          y: 30,
          rotation: 0,
          props: tableProps,
        },
      ],
      assets: {},
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain('colspan="2"');
    expect(svg).toContain('rowspan="2"');
    expect(svg).not.toContain("colSpan=");
    expect(svg).not.toContain("rowSpan=");
  });

  it("does not export unresolved Storage placeholders as image hrefs", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_image",
          type: "image",
          x: 20,
          y: 30,
          props: {
            assetId: "asset_image",
            w: 160,
            h: 90,
          },
        },
      ],
      assets: {
        asset_image: {
          id: "asset_image",
          type: "image",
          props: {
            w: 640,
            h: 360,
            name: "figure.png",
            isAnimated: false,
            mimeType: "image/png",
            src: "sigma-doc-storage://asset_image",
            fileSize: 12345,
            storage: {
              kind: "remote-asset",
              storageKey: "workspace/file/asset_image.png",
              assetId: "asset_image",
            },
          },
        },
      },
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain("<svg");
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("sigma-doc-storage://");
  });

  it("exports image shapes with crop clipping instead of aspect-ratio meet", () => {
    const overlaySnapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_image",
          type: "image",
          x: 20,
          y: 30,
          props: {
            assetId: "asset_image",
            w: 160,
            h: 90,
            crop: {
              topLeft: { x: 0.1, y: 0.2 },
              bottomRight: { x: 0.9, y: 0.8 },
            },
          },
        },
      ],
      assets: {
        asset_image: {
          id: "asset_image",
          type: "image",
          props: {
            w: 640,
            h: 360,
            name: "figure.png",
            isAnimated: false,
            mimeType: "image/png",
            src: "data:image/png;base64,AAAA",
            fileSize: 4,
          },
        },
      },
    };

    const svg = getOverlayPreviewSvg({ overlaySnapshot });

    expect(svg).toContain("<clipPath");
    expect(svg).toContain("<image");
    expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).not.toContain("xMidYMid meet");
  });
});

function createTextToolTestDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_svg_text_tool",
    metadata: { title: "SVG text tool" },
    content: [{
      type: "paragraph",
      id: "p_1",
      children: [{ type: "text", text: "基準本文" }],
    }],
    outputProfiles: {
      student: { showSolutions: false, showHints: false },
      teacher: { showSolutions: true, showHints: true },
      answerBook: { onlySolutions: true, includeAnswers: true },
    },
  };
}
