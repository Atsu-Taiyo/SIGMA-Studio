import { describe, expect, it } from "vitest";

import type { PageLayout } from "../model";
import { getDefaultPageLayout, MM_TO_PX } from "./page-layout";
import {
  captureRunningRegionFitBase,
  fitRunningRegionToEditedContent,
} from "./page-running-region-layout";

function withHeader(heightMm: number, offsetMm = 5, marginTop = 18): PageLayout {
  const layout = getDefaultPageLayout();
  return {
    ...layout,
    marginsMm: { ...layout.marginsMm, top: marginTop },
    header: { ...layout.header!, enabled: true, heightMm, offsetMm },
  };
}

describe("running region fit to edited content", () => {
  it("records the size the user chose, not the content's height", () => {
    const base = captureRunningRegionFitBase(withHeader(4), "header", 30);

    expect(base).toEqual({ contentHeightPx: 30, heightMm: 4, marginMm: 18 });
    expect(captureRunningRegionFitBase(getDefaultPageLayout(), "header", 30)).toBeNull();
  });

  it("keeps a band lower than its text while the text does not grow", () => {
    // 1 行より低いヘッダー (0mm も) は、利用者が選んだ大きさとして残す。
    const layout = withHeader(0, 5, 5);
    const base = captureRunningRegionFitBase(layout, "header", 28)!;

    expect(fitRunningRegionToEditedContent(layout, "header", 28.5, base)).toBe(layout);
  });

  it("grows the band and its margin when a line is added", () => {
    const layout = withHeader(8, 5, 13);
    const base = captureRunningRegionFitBase(layout, "header", 28)!;

    const next = fitRunningRegionToEditedContent(layout, "header", 12 * MM_TO_PX, base);

    // 12mm の文字 + 2px の余裕を 0.5mm 刻みで切り上げる。
    expect(next.header?.heightMm).toBe(13);
    expect(next.marginsMm.top).toBe(18);
  });

  it("does not move a margin that is already wider than the grown band", () => {
    const layout = withHeader(8, 5, 30);
    const base = captureRunningRegionFitBase(layout, "header", 28)!;

    const next = fitRunningRegionToEditedContent(layout, "header", 12 * MM_TO_PX, base);

    expect(next.header?.heightMm).toBe(13);
    expect(next.marginsMm.top).toBe(30);
  });

  it("returns to the chosen size and margin when the added lines are removed", () => {
    const layout = withHeader(8, 5, 13);
    const base = captureRunningRegionFitBase(layout, "header", 28)!;
    const grown = fitRunningRegionToEditedContent(layout, "header", 20 * MM_TO_PX, base);

    const shrunk = fitRunningRegionToEditedContent(grown, "header", 28, base);

    expect(shrunk.header?.heightMm).toBe(8);
    expect(shrunk.marginsMm.top).toBe(13);
  });

  it("grows a footer upward by widening the bottom margin", () => {
    const defaults = getDefaultPageLayout();
    const layout: PageLayout = {
      ...defaults,
      marginsMm: { ...defaults.marginsMm, bottom: 10 },
      footer: { ...defaults.footer!, enabled: true, heightMm: 5, offsetMm: 5 },
    };
    const base = captureRunningRegionFitBase(layout, "footer", 10)!;

    const next = fitRunningRegionToEditedContent(layout, "footer", 10 * MM_TO_PX, base);

    expect(next.footer?.heightMm).toBe(11);
    expect(next.marginsMm.bottom).toBe(16);
  });

  it("stops growing before the body would get shorter than its minimum", () => {
    const layout = withHeader(5, 4, 9);
    const base = captureRunningRegionFitBase(layout, "header", 10)!;

    const next = fitRunningRegionToEditedContent(layout, "header", 600 * MM_TO_PX, base);

    expect(next.header?.heightMm).toBe(245);
    expect(next.marginsMm.top).toBe(249);
  });
});
