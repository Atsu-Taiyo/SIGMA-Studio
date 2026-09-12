import { describe, expect, it } from "vitest";

import { getDefaultPageLayout, MM_TO_PX } from "@/lib/page-layout";
import { fitRunningRegionToContent, growRunningRegionToFitContent } from "@/lib/page-running-region-layout";
import type { PageLayout } from "@/types/sigma-doc";

describe("running region auto height", () => {
  it("grows an enabled header to fit measured content", () => {
    const layout: PageLayout = {
      ...getDefaultPageLayout(),
      header: {
        ...getDefaultPageLayout().header!,
        enabled: true,
        heightMm: 5,
        offsetMm: 4,
      },
    };

    const next = growRunningRegionToFitContent(layout, "header", 12 * MM_TO_PX);

    expect(next.header?.heightMm).toBe(13);
    expect(next.marginsMm.top).toBe(18);
  });

  it("does not shrink when content is shorter than the current region", () => {
    const layout: PageLayout = {
      ...getDefaultPageLayout(),
      footer: {
        ...getDefaultPageLayout().footer!,
        enabled: true,
        heightMm: 14,
        offsetMm: 4,
      },
    };

    const next = growRunningRegionToFitContent(layout, "footer", 5 * MM_TO_PX);

    expect(next).toBe(layout);
  });

  it("shrinks a header when content height decreases and shrinking is allowed", () => {
    const layout: PageLayout = {
      ...getDefaultPageLayout(),
      marginsMm: {
        ...getDefaultPageLayout().marginsMm,
        top: 29,
      },
      header: {
        ...getDefaultPageLayout().header!,
        enabled: true,
        heightMm: 24,
        offsetMm: 5,
      },
    };

    const next = fitRunningRegionToContent(layout, "header", 6 * MM_TO_PX, { allowShrink: true });

    expect(next.header?.heightMm).toBe(7);
    expect(next.marginsMm.top).toBe(18);
  });

  it("clamps growth so the minimum body height remains available", () => {
    const layout: PageLayout = {
      ...getDefaultPageLayout(),
      marginsMm: {
        ...getDefaultPageLayout().marginsMm,
        bottom: 250,
      },
      header: {
        ...getDefaultPageLayout().header!,
        enabled: true,
        heightMm: 8,
        offsetMm: 5,
      },
    };

    const next = growRunningRegionToFitContent(layout, "header", 60 * MM_TO_PX);

    expect(next.header?.heightMm).toBe(12);
    expect(next.marginsMm.top).toBe(18);
  });
});
