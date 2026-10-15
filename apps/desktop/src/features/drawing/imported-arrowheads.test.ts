import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { normalizeOverlaySnapshot, isValidOverlaySnapshot, type OverlayArrowShape } from "@/features/document";
import { OverlayShapeReadOnlyView } from "@/components/editor/overlay-canvas/shape-renderer";
import { getOverlayPreviewSvg } from "@/features/rendering/adapters/svg";
import { getShapeArrowheadPlan } from "./arrowhead-trim";
import { getShapeVisualBounds } from "./shape-visual-bounds";
import { hitTestShape } from "./shape-hit-test";

const arrow = (scale = 0.5): OverlayArrowShape => ({
  id: "imported_arrow", type: "arrow", x: 50, y: 60,
  props: { start: { x: 100, y: 0 }, end: { x: 0, y: 0 },
    arrowheadStart: "triangleNarrow", arrowheadEnd: "stealth", arrowheadScale: scale,
    strokeScale: 1, size: "m", fill: "none", color: "#123456", labelColor: "#123456", dash: "dashed", dashPattern: [4, 4] },
});

describe("imported native arrow heads", () => {
  it("retains direction, both kinds, head size and pen through JSON save/reload and both output renderers", () => {
    const saved = normalizeOverlaySnapshot(JSON.parse(JSON.stringify({ version: 1, shapes: [arrow()], assets: {} })));
    expect(saved.shapes[0]).toEqual(arrow());
    const shape = saved.shapes[0];
    const plan = getShapeArrowheadPlan(shape);
    expect(plan.start.spec?.kind).toBe("triangleNarrow");
    expect(plan.end.spec?.kind).toBe("stealth");
    const svg = getOverlayPreviewSvg({ overlaySnapshot: saved });
    const canvas = renderToStaticMarkup(createElement(OverlayShapeReadOnlyView, { shape, assets: {} }));
    for (const output of [svg, canvas]) {
      expect(output).toContain("triangleNarrow");
      expect(output).toContain("stealth");
      expect(output).toContain("auto-start-reverse");
    }
  });

  it("selects independently enlarged head ink without selecting empty space around it", () => {
    const shape = arrow(2);
    // The left-pointing filled head occupies x=50..98 and y=44..76.
    expect(hitTestShape(shape, { x: 92, y: 72 }, 0)).toBe(true);
    expect(hitTestShape(shape, { x: 92, y: 88 }, 0)).toBe(false);
    const bounds = getShapeVisualBounds(shape);
    expect(bounds.y).toBeLessThanOrEqual(44);
    expect(bounds.y + bounds.h).toBeGreaterThanOrEqual(76);
  });

  it.each([0, -1, Infinity, NaN, 101])("rejects invalid persisted head scale %s", (scale) => {
    expect(isValidOverlaySnapshot({ version: 1, shapes: [arrow(scale)], assets: {} })).toBe(false);
  });
});
