import { describe, expect, it } from "vitest";

import {
  exportOverlaySvg as legacyExportOverlaySvg,
  getOverlayPreviewSvg as legacyGetOverlayPreviewSvg,
} from "@/components/editor/overlay-canvas/svg-export";

import {
  exportOverlaySvg,
  getOverlayPreviewSvg,
} from ".";

describe("SVG rendering compatibility facade", () => {
  it("keeps the former component entrypoint on the rendering adapter", () => {
    expect(legacyExportOverlaySvg).toBe(exportOverlaySvg);
    expect(legacyGetOverlayPreviewSvg).toBe(getOverlayPreviewSvg);
  });
});
