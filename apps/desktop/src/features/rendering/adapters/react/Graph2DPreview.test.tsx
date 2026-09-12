import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createGraph2DSpecPreset } from "@/lib/graph2d";

import { Graph2DPreview } from "./Graph2DPreview";

describe("Graph2DPreview CSS injection", () => {
  const INJECTED = "red;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:2147483647";

  function markupWithAxisColor(axisColor: unknown): string {
    const base = createGraph2DSpecPreset("line");
    return renderToStaticMarkup(
      <Graph2DPreview spec={{ ...base, axes: { ...base.axes, axisColor } as typeof base.axes } } staticMode />,
    );
  }

  it("drops an injected axis color instead of writing extra declarations", () => {
    expect(markupWithAxisColor(INJECTED)).not.toContain("position:fixed");
  });

  it("drops a non-string axis color, which React would stringify", () => {
    // `isGraph2DSpec` never checks this field's type, so it is the one graph color that can arrive
    // as something other than a string.
    expect(markupWithAxisColor([INJECTED])).not.toContain("position:fixed");
  });

  it("keeps a legitimate axis color", () => {
    expect(markupWithAxisColor("#1f2937")).toContain("#1f2937");
  });

  it("uses the default axis style when the stored color is rejected", () => {
    const base = createGraph2DSpecPreset("line");
    const html = renderToStaticMarkup(
      <Graph2DPreview
        spec={{ ...base, axes: { ...base.axes, axisColor: INJECTED } as typeof base.axes }}
        staticMode
      />,
    );

    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain(INJECTED);
  });

  it("drops injected axis stroke width and tick font size", () => {
    const base = createGraph2DSpecPreset("line");
    const html = renderToStaticMarkup(
      <Graph2DPreview
        spec={{
          ...base,
          axes: {
            ...base.axes,
            showTicks: true,
            axisStrokeWidth: "1;position:fixed;top:0;left:0;width:100vw;height:100vh",
            tickFontSize: "10;position:fixed;top:0;left:0;width:100vw;height:100vh",
          } as unknown as typeof base.axes,
        }}
        staticMode
      />,
    );

    expect(html).not.toContain("position:fixed");
  });
});

describe("Graph2DPreview rendering adapter", () => {
  it("renders the stored parameter pose in static output and refreshes cached paths after value changes", () => {
    const base = createGraph2DSpecPreset("line");
    const spec = { ...base, curves: [{ ...base.curves[0], expr: "s*x", exprTex: "s x" }],
      parameters: [{ id: "s", name: "s", value: 2, min: -3, max: 3, animation: { durationMs: 1000, loop: "repeat" as const, playOnPage: true } }],
    };
    const curvePath = (source: typeof spec) => {
      const html = renderToStaticMarkup(<Graph2DPreview spec={source} staticMode />);
      return /<path[^>]*d="([^"]+)"[^>]*data-testid="graph2d-curve"/.exec(html)?.[1]
        ?? /<path[^>]*data-testid="graph2d-curve"[^>]*d="([^"]+)"/.exec(html)?.[1];
    };
    const first = curvePath(spec);
    expect(first).toBeTruthy();
    expect(curvePath({ ...spec, parameters: [{ ...spec.parameters[0], value: -1 }] })).not.toBe(first);
    expect(curvePath(spec)).toBe(first);
    expect(spec.curves[0].expr).toBe("s*x");
  });

  it("renders tick label font sizes in points while keeping the SVG viewBox in pixels", () => {
    const base = createGraph2DSpecPreset("line");
    const spec = {
      ...base,
      axes: {
        ...base.axes,
        showTicks: true,
        tickFontSize: 10.5,
      },
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toContain("font-size:10.5pt");
    expect(html).toContain(`viewBox="0 0 ${spec.width} ${spec.height}"`);
  });

  it("sizes tick label foreignObjects from real font metrics instead of a fixed box", () => {
    const base = createGraph2DSpecPreset("line");
    const smallSpec = {
      ...base,
      axes: { ...base.axes, showTicks: true, tickFontSize: 9 },
    };
    const largeSpec = {
      ...base,
      axes: { ...base.axes, showTicks: true, tickFontSize: 48 },
    };

    const readTickBoxes = (html: string) => (
      [...html.matchAll(/<foreignObject[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"[^>]*class="graph2d-tex-label"/g)]
        .map((match) => ({ width: Number(match[1]), height: Number(match[2]) }))
    );

    const smallHtml = renderToStaticMarkup(<Graph2DPreview spec={smallSpec} />);
    const largeHtml = renderToStaticMarkup(<Graph2DPreview spec={largeSpec} />);
    const smallBoxes = readTickBoxes(smallHtml);
    const largeBoxes = readTickBoxes(largeHtml);

    expect(smallBoxes.length).toBeGreaterThan(0);
    expect(largeBoxes.length).toBe(smallBoxes.length);
    // The old implementation hardcoded 64x26 (x-axis) / 46x26 (y-axis) regardless of
    // `tickFontSize`, so a 48pt tick label (the graph settings maximum) would render past its own box
    // and get clipped by `.graph-shape { overflow: hidden }`. Every box must now grow with font
    // size instead of staying pinned to the small-font dimensions.
    for (let i = 0; i < smallBoxes.length; i += 1) {
      expect(largeBoxes[i].width).toBeGreaterThan(smallBoxes[i].width);
      expect(largeBoxes[i].height).toBeGreaterThan(smallBoxes[i].height);
    }
  });

  it("clips plotted content to the graph plot area", () => {
    const spec = createGraph2DSpecPreset("line");
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toContain("<clipPath");
    expect(html).toContain("graph2d-plot-clip-");
    expect(html).toContain("graph2d-graph-clip-");
    expect(html).toMatch(/class="graph2d-curves"[^>]*clip-path="url\(#graph2d-graph-clip-/);
    expect(html).toMatch(/class="graph2d-points"[^>]*clip-path="url\(#graph2d-graph-clip-/);
  });

  it("renders graph points with axis projection guides", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      points: [
        {
          id: "point_a",
          x: "1",
          y: "2",
          label: "A",
          color: "#dc2626",
          showXProjection: true,
          showYProjection: true,
        },
      ],
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toContain("graph2d-point-guides");
    expect(html).toContain('data-testid="graph2d-point-guide-x"');
    expect(html).toContain('data-testid="graph2d-point-guide-y"');
    expect(html).not.toContain("graph2d-point-label-tex");
  });

  it("renders open graph points with a hollow center and the point color as the outline", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      points: [
        {
          id: "point_open",
          x: "1",
          y: "2",
          color: "#dc2626",
          fill: "none" as const,
          radius: 3.6,
        },
      ],
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toContain("graph2d-point-open-halo");
    expect(html).toContain('r="5"');
    expect(html).toContain('r="3.6"');
    // 中身は白(色で塗りつぶさない)が、輪郭は点の指定色を使う。
    expect(html).toMatch(/<circle class="graph2d-point" cx="356" cy="80" r="3.6" fill="#ffffff" stroke="#dc2626"/);
    expect(html).toContain('stroke-width="2.4"');
  });

  it("keeps axis bounds and plotted graph bounds as separate clip areas", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      graphViewBox: {
        xMin: "-2",
        xMax: "2",
        yMin: "-2",
        yMax: "2",
      },
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toMatch(/<clipPath id="graph2d-plot-clip-[^"]+"><rect x="46" y="18" width="496" height="248"/);
    expect(html).toMatch(/<clipPath id="graph2d-graph-clip-[^"]+"><rect x="170" y="80" width="248" height="124"/);
  });

  it("clips axes to the graph display range without built-in axis labels", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      axes: {
        ...createGraph2DSpecPreset("line").axes,
        originLabel: "O",
      },
      graphViewBox: {
        xMin: "-2",
        xMax: "2",
        yMin: "1",
        yMax: "4",
      },
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);
    const axesGroup = html.match(/<g class="graph2d-axes">(.*?)<\/g>/)?.[1] ?? "";

    expect((axesGroup.match(/<line /g) ?? [])).toHaveLength(1);
    expect(axesGroup).toContain('x1="294"');
    expect(axesGroup).toContain('y1="111"');
    expect(axesGroup).toContain('y2="18"');
    expect(html).not.toContain("graph2d-axis-label-tex");
  });

  it("does not render the origin label inside the graph", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      axes: {
        ...createGraph2DSpecPreset("line").axes,
        originLabel: "O",
      },
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).not.toContain("graph2d-axis-label-tex");
    expect(html).not.toContain("graph2d-origin-label-tex");
  });

  it("renders explicit dashed textbook axis settings", () => {
    const lineSpec = createGraph2DSpecPreset("line");
    const spec = {
      ...lineSpec,
      axes: {
        ...lineSpec.axes,
        axisColor: "#0d0d0d",
        axisStrokeWidth: 0.85,
        axisDash: "dashed" as const,
      },
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toContain("stroke-dasharray:3 3");
    expect(html).toContain("stroke-width:0.85");
    expect(html).toContain("fill:#0d0d0d");
  });

  it("does not render formula labels inside the graph", () => {
    const spec = createGraph2DSpecPreset("line");
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).not.toContain("graph2d-legend");
  });

  it("renders x=f(y) curves with dash and stroke width settings", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      curves: [
        {
          ...createGraph2DSpecPreset("line").curves[0],
          mode: "xOfY" as const,
          expr: "y",
          label: "x = y",
          dash: "dotted" as const,
          strokeWidth: 3.4,
        },
      ],
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toContain('stroke-width="3.4"');
    expect(html).toContain('stroke-linecap="butt"');
    expect(html).toMatch(/stroke-dasharray="0 [^"]+"/);
    expect((html.match(/stroke-dasharray=/g) ?? [])).toHaveLength(1);
  });

  it("renders parametric curves", () => {
    const spec = createGraph2DSpecPreset("parametric");
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toContain('data-testid="graph2d-curve"');
    expect(html).not.toContain("graph2d-legend");
  });

  it("renders implicit curves", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      curves: [
        {
          id: "curve_implicit",
          expr: "x^2 - y^2 - 2*y",
          exprTex: "x^{2}-y^{2}-2y",
          label: "x^{2}-y^{2}-2y = 0",
          color: "#0d0d0d",
          mode: "implicit" as const,
          samples: 80,
        },
      ],
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toContain('data-testid="graph2d-curve"');
    expect(html).toContain('stroke="#0d0d0d"');
  });

  it("renders implicit equations with nonzero right-hand sides", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      viewBox: {
        xMin: "-5",
        xMax: "9",
        yMin: "-5",
        yMax: "5",
      },
      curves: [
        {
          id: "curve_implicit_nonzero",
          expr: "x^2 - 4*x + y^2 = 22",
          exprTex: "x^{2}-4x+y^{2}=22",
          label: "x^{2}-4x+y^{2}=22",
          color: "#0d0d0d",
          mode: "implicit" as const,
          samples: 90,
        },
      ],
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toContain('data-testid="graph2d-curve"');
    expect(html).not.toContain("graph2d-error-text");
  });

  it("shows a range warning instead of an evaluation error when curves are outside the display range", () => {
    const base = createGraph2DSpecPreset("line");
    const spec = {
      ...base,
      viewBox: {
        xMin: "-1",
        xMax: "1",
        yMin: "-1",
        yMax: "1",
      },
      curves: [
        {
          ...base.curves[0],
          expr: "x^2 + 5",
        },
      ],
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toContain("曲線が表示範囲の外にあります");
    expect(html).not.toContain("式を評価できません");
  });

  it("keeps the evaluation error for invalid curve expressions", () => {
    const base = createGraph2DSpecPreset("line");
    const spec = {
      ...base,
      curves: [
        {
          ...base.curves[0],
          expr: "sin(",
        },
      ],
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toContain("式を評価できません");
    expect(html).not.toContain("曲線が表示範囲の外にあります");
  });

  it("renders fill regions before curves", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      viewBox: {
        xMin: "-2",
        xMax: "2",
        yMin: "-2",
        yMax: "2",
      },
      axes: {
        ...createGraph2DSpecPreset("line").axes,
        showX: true,
        showY: true,
      },
      fills: [
        {
          id: "fill_quadrant",
          x: "1",
          y: "1",
        },
      ],
    };
    const html = renderToStaticMarkup(<Graph2DPreview spec={spec} staticMode />);

    expect(html).toContain("graph2d-fill-region");
    expect(html).toContain('fill-rule="evenodd"');
    expect(html.indexOf("graph2d-fill-region")).toBeLessThan(html.indexOf("graph2d-curves"));
  });
});
