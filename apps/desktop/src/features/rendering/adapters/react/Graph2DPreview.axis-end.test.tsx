// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OVERLAY_ARROWHEADS, type Graph2DSpec, type GraphAxes } from "@/features/document";
import {
  arrowheadPathData,
  getArrowheadMarkerSpec,
  getArrowheadTrimInStrokes,
  type ArrowheadMarkerSpec,
} from "@/features/rendering/core";
import { createGraph2DSpecPreset } from "@/lib/graph2d";

import { Graph2DPreview } from "./Graph2DPreview";

const HEADS = OVERLAY_ARROWHEADS.filter((head) => head !== "none");
const AXES = ["x", "y"] as const;
const FIELD = { x: "xAxisEndStyle", y: "yAxisEndStyle" } as const;

function render(axes: Partial<GraphAxes>, kind: "line" | "numberLine" = "line") {
  const base: Graph2DSpec = createGraph2DSpecPreset(kind);
  const html = renderToStaticMarkup(
    <Graph2DPreview spec={{ ...base, axes: { ...base.axes, showX: true, showY: true, ...axes } }} staticMode />,
  );
  const svg = new DOMParser().parseFromString(html, "text/html").querySelector("svg")!;
  const clip = svg.querySelector('clipPath[id^="graph2d-graph-clip-"] rect')!;
  const lines = Array.from(svg.querySelectorAll(".graph2d-axes line"));
  const number = (element: Element, name: string) => Number(element.getAttribute(name));
  // The x axis is the horizontal line, the y axis the vertical one.
  const line = {
    x: lines.find((candidate) => candidate.getAttribute("y1") === candidate.getAttribute("y2")) ?? null,
    y: lines.find((candidate) => candidate.getAttribute("x1") === candidate.getAttribute("x2")) ?? null,
  };
  return {
    svg,
    markers: Array.from(svg.querySelectorAll("marker")),
    marker: {
      x: svg.querySelector('marker[data-axis="x"]'),
      y: svg.querySelector('marker[data-axis="y"]'),
    },
    line,
    lines,
    clip: {
      top: number(clip, "y"),
      right: number(clip, "x") + number(clip, "width"),
    },
    number,
  };
}

function headSpec(head: string): ArrowheadMarkerSpec {
  const spec = getArrowheadMarkerSpec(head);
  if (!spec) throw new Error(`no spec for ${head}`);
  return spec;
}

describe("2D graph axis ends", () => {
  it("draws both axes of a graph that never chose an end with the default arrow", () => {
    const { marker, line } = render({});

    for (const axis of AXES) {
      expect(marker[axis]?.getAttribute("data-axis-end")).toBe("arrow");
      expect(line[axis]?.getAttribute("marker-end")).toBe(`url(#${marker[axis]?.id})`);
    }
    expect(marker.x?.id).not.toBe(marker.y?.id);
  });

  it("gives each axis the end chosen for it", () => {
    const { marker, line } = render({ xAxisEndStyle: "openArrow", yAxisEndStyle: "dot" });

    expect(marker.x?.getAttribute("data-axis-end")).toBe("openArrow");
    expect(marker.y?.getAttribute("data-axis-end")).toBe("dot");
    expect(line.x?.getAttribute("marker-end")).toBe(`url(#${marker.x?.id})`);
    expect(line.y?.getAttribute("marker-end")).toBe(`url(#${marker.y?.id})`);
  });

  it("leaves the other axis on the default when only one axis chose an end", () => {
    const { marker } = render({ yAxisEndStyle: "bar" });

    expect(marker.x?.getAttribute("data-axis-end")).toBe("arrow");
    expect(marker.y?.getAttribute("data-axis-end")).toBe("bar");
  });

  it.each(HEADS)("draws %s from the same outline table as a line's endpoint", (head) => {
    const spec = headSpec(head);
    const { marker: markers } = render({ xAxisEndStyle: head });
    const marker = markers.x;

    expect(marker?.getAttribute("data-axis-end")).toBe(head);
    expect(Number(marker?.getAttribute("markerWidth"))).toBe(spec.markerWidth);
    expect(Number(marker?.getAttribute("markerHeight"))).toBe(spec.markerHeight);
    expect(Number(marker?.getAttribute("refY"))).toBe(spec.refY);
    expect(marker?.getAttribute("markerUnits")).toBe("strokeWidth");

    if (spec.geometry.kind === "circle") {
      const circle = marker?.querySelector("circle");
      expect(Number(circle?.getAttribute("r"))).toBe(spec.geometry.r);
      return;
    }
    const ink = marker?.querySelector("path");
    expect(ink?.getAttribute("d")).toBe(arrowheadPathData(spec.geometry));
    if (spec.geometry.filled) {
      expect(ink?.classList.contains("graph2d-axis-arrow-open")).toBe(false);
    } else {
      // An open head is a stroke, not a fill: a filled chevron would read as a triangle.
      expect(ink?.classList.contains("graph2d-axis-arrow-open")).toBe(true);
      expect(Number(ink?.getAttribute("stroke-width"))).toBe(spec.geometry.strokeWidth);
    }
  });

  it.each(HEADS)("puts the point of %s on the edge of the display range on either axis", (head) => {
    const spec = headSpec(head);
    const strokeWidth = 2;
    // The other axis carries a different end, so a mix-up between the two plans would show.
    const { marker, line, clip, number } = render({
      xAxisEndStyle: head,
      yAxisEndStyle: head,
      axisStrokeWidth: strokeWidth,
    });
    const reach = (axis: "x" | "y") => (spec.tipX - Number(marker[axis]?.getAttribute("refX"))) * strokeWidth;

    expect(number(line.x!, "x2") + reach("x")).toBeCloseTo(clip.right, 6);
    expect(number(line.y!, "y2") - reach("y")).toBeCloseTo(clip.top, 6);
    // …and the line still stops where the head covers it, rather than at the point.
    expect(clip.right - number(line.x!, "x2")).toBeCloseTo(getArrowheadTrimInStrokes(head) * strokeWidth, 6);
    expect(number(line.y!, "y2") - clip.top).toBeCloseTo(getArrowheadTrimInStrokes(head) * strokeWidth, 6);
  });

  it("trims each axis by its own end", () => {
    const strokeWidth = 2;
    const { line, clip, number } = render({ xAxisEndStyle: "bar", yAxisEndStyle: "triangle", axisStrokeWidth: strokeWidth });

    expect(clip.right - number(line.x!, "x2")).toBeCloseTo(getArrowheadTrimInStrokes("bar") * strokeWidth, 6);
    expect(number(line.y!, "y2") - clip.top).toBeCloseTo(getArrowheadTrimInStrokes("triangle") * strokeWidth, 6);
  });

  it.each(AXES)("can draw the %s axis with no end while the other keeps one", (axis) => {
    const other = axis === "x" ? "y" : "x";
    const { svg, marker, line, clip, number } = render({ [FIELD[axis]]: "none" });

    expect(marker[axis]).toBeNull();
    expect(line[axis]?.hasAttribute("marker-end")).toBe(false);
    expect(marker[other]?.getAttribute("data-axis-end")).toBe("arrow");
    expect(svg.querySelectorAll("[marker-end]")).toHaveLength(1);
    // Nothing to make room for, so that axis runs all the way to the edge.
    if (axis === "x") {
      expect(number(line.x!, "x2")).toBe(clip.right);
    } else {
      expect(number(line.y!, "y2")).toBe(clip.top);
    }
  });

  it("falls back to the default end for a name this build does not know", () => {
    const { marker } = render({
      xAxisEndStyle: "rocket" as GraphAxes["xAxisEndStyle"],
      yAxisEndStyle: "rocket" as GraphAxes["yAxisEndStyle"],
    });

    expect(marker.x?.getAttribute("data-axis-end")).toBe("arrow");
    expect(marker.y?.getAttribute("data-axis-end")).toBe("arrow");
  });

  it("colours a filled end with fill and an open end with stroke", () => {
    const { marker } = render({ xAxisEndStyle: "triangle", yAxisEndStyle: "openArrow", axisColor: "#1d4ed8" });
    const filled = marker.x?.querySelector("path");
    const open = marker.y?.querySelector("path");

    expect(filled?.getAttribute("style")).toContain("fill:#1d4ed8");
    expect(open?.getAttribute("style")).toContain("stroke:#1d4ed8");
    expect(open?.getAttribute("style")).not.toContain("fill:");
  });

  it("gives a number line's one axis the x axis's end and nothing for y", () => {
    const { markers, marker, lines } = render({ xAxisEndStyle: "dot", yAxisEndStyle: "bar" }, "numberLine");

    expect(markers).toHaveLength(1);
    expect(marker.x?.getAttribute("data-axis-end")).toBe("dot");
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute("marker-end")).toBe(`url(#${marker.x?.id})`);
  });

  it("draws no marker for an axis that is hidden", () => {
    const { markers, marker } = render({ showY: false, yAxisEndStyle: "bar" });

    expect(markers).toHaveLength(1);
    expect(marker.y).toBeNull();
  });

  it("trims the axis by the width the stylesheet actually draws it at", () => {
    // The trim is measured in stroke widths. Without a stored width the axis is drawn at whatever
    // `.graph2d-axes line` says, so the renderer's own copy of that number has to agree with it.
    const css = readFileSync(path.resolve(import.meta.dirname, "../../../../app/document-surface.css"), "utf8");
    const rule = css.match(/\.graph2d-axes line\s*\{([^}]*)\}/)?.[1] ?? "";
    const cssWidth = Number(rule.match(/stroke-width:\s*([\d.]+)/)?.[1]);
    const { line, clip, number } = render({ xAxisEndStyle: "arrow" });

    expect(cssWidth).toBeGreaterThan(0);
    expect(clip.right - number(line.x!, "x2")).toBeCloseTo(getArrowheadTrimInStrokes("arrow") * cssWidth, 6);
  });
});
