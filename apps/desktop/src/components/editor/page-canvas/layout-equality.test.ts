import { describe, expect, it } from "vitest";

import { getPageMetrics, normalizePageLayout } from "@/lib/page-layout";
import { samePageMetrics } from "./layout-equality";

describe("samePageMetrics", () => {
  it("treats independently normalized layouts with the same geometry as equal", () => {
    const input = {
      preset: "A4" as const,
      orientation: "portrait" as const,
      marginsMm: { top: 14, right: 16, bottom: 14, left: 16 },
      flow: { type: "columns" as const, columnCount: 2, columnGapMm: 10 },
    };

    expect(samePageMetrics(
      getPageMetrics(normalizePageLayout(input)),
      getPageMetrics(normalizePageLayout(input)),
    )).toBe(true);
  });

  it("detects page geometry changes", () => {
    const base = getPageMetrics(normalizePageLayout({
      marginsMm: { top: 14, right: 16, bottom: 14, left: 16 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 10 },
    }));
    const changedMargin = getPageMetrics(normalizePageLayout({
      marginsMm: { top: 15, right: 16, bottom: 14, left: 16 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 10 },
    }));
    const changedColumns = getPageMetrics(normalizePageLayout({
      marginsMm: { top: 14, right: 16, bottom: 14, left: 16 },
      flow: { type: "columns", columnCount: 3, columnGapMm: 10 },
    }));

    expect(samePageMetrics(base, changedMargin)).toBe(false);
    expect(samePageMetrics(base, changedColumns)).toBe(false);
  });
});
