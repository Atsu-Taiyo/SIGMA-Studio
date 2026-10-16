// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import type { OverlayShape, SigmaDocument } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";

import { runSvgConversionTask } from "./svg-conversion-task";

const HAIRLINE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><line x1="10" y1="50" x2="190" y2="50" stroke="#111111" stroke-width="0.75"/><rect x="20" y="60" width="40" height="20" fill="none" stroke="#111111" stroke-width="2"/></svg>';

function documentWith(shapes: OverlayShape[]): SigmaDocument {
  return {
    ...structuredClone(sampleDocument),
    pageLayout: {
      ...structuredClone(sampleDocument.pageLayout),
      overlay: {
        overlaySnapshot: {
          version: 1, shapes,
          assets: { svg: { id: "svg", type: "image", props: { w: 200, h: 100, name: "図", mimeType: "image/svg+xml", isAnimated: false, fileSize: HAIRLINE.length, src: `data:image/svg+xml;base64,${btoa(HAIRLINE)}` } } },
        },
      },
    },
  } as SigmaDocument;
}

describe("the hidden print page's conversion for convert_svg_image", () => {
  it("converts the one image with the AI's line sizes (a hairline becomes 細)", async () => {
    const result = await runSvgConversionTask(documentWith([{ id: "figure", type: "image", x: 0, y: 0, props: { assetId: "svg", w: 200, h: 100 } } as OverlayShape]), "figure");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conversion.shapes[0]).toMatchObject({ id: "figure", type: "group" });
    const sizes = result.conversion.shapes.flatMap((shape) => (shape.type === "line" || shape.type === "geo" ? [shape.props.size] : []));
    expect(sizes).toEqual(["s", "m"]);
  });

  it("reports a shape that is not an SVG image instead of converting it", async () => {
    await expect(runSvgConversionTask(documentWith([]), "figure")).resolves.toEqual({ ok: false, error: "source" });
  });
});
