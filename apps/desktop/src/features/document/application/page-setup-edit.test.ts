import { describe, expect, it } from "vitest";

import type { PageLayout } from "../model";
import { getDefaultPageLayout } from "./page-layout";
import {
  applyPageMarginPreset,
  getActivePageMarginPreset,
  setPageMarginMm,
  setRunningRegionEnabled,
  setRunningRegionGeometryMm,
} from "./page-setup-edit";

function layoutWithHeader(heightMm: number, offsetMm: number, marginTop: number): PageLayout {
  const layout = getDefaultPageLayout();
  return {
    ...layout,
    marginsMm: { ...layout.marginsMm, top: marginTop },
    header: { ...layout.header!, enabled: true, heightMm, offsetMm },
  };
}

describe("page setup edits", () => {
  it("shrinks a shown header to fit a narrower top margin instead of refusing the margin", () => {
    // 以前は上余白に 10mm を入れても、適用でヘッダーの下端 (19.5mm) まで押し戻されていた。
    const next = setPageMarginMm(layoutWithHeader(14.5, 5, 19.5), "top", 10);

    expect(next.marginsMm.top).toBe(10);
    expect(next.header).toMatchObject({ offsetMm: 5, heightMm: 5 });
  });

  it("moves the header to the paper edge when the margin is narrower than its offset", () => {
    const next = setPageMarginMm(layoutWithHeader(8, 5, 13), "top", 3);

    expect(next.marginsMm.top).toBe(3);
    expect(next.header).toMatchObject({ offsetMm: 3, heightMm: 0 });
  });

  it("lets the margin go to zero", () => {
    const next = setPageMarginMm(layoutWithHeader(8, 5, 13), "top", 0);

    expect(next.marginsMm.top).toBe(0);
    expect(next.header).toMatchObject({ offsetMm: 0, heightMm: 0 });
  });

  it("does not touch a hidden header", () => {
    const layout = getDefaultPageLayout();
    const next = setPageMarginMm(layout, "top", 2);

    expect(next.marginsMm.top).toBe(2);
    expect(next.header).toBe(layout.header);
  });

  it("pushes the margin when the header grows past it", () => {
    const next = setRunningRegionGeometryMm(layoutWithHeader(8, 5, 18), "header", { heightMm: 20 });

    expect(next.header?.heightMm).toBe(20);
    expect(next.marginsMm.top).toBe(25);
  });

  it("keeps a margin aligned to the header edge aligned when the header shrinks", () => {
    const next = setRunningRegionGeometryMm(layoutWithHeader(14.5, 5, 19.5), "header", { heightMm: 0 });

    expect(next.header?.heightMm).toBe(0);
    expect(next.marginsMm.top).toBe(5);
  });

  it("keeps a wider margin when the header shrinks inside it", () => {
    const next = setRunningRegionGeometryMm(layoutWithHeader(8, 5, 18), "header", { heightMm: 4 });

    expect(next.marginsMm.top).toBe(18);
  });

  it("couples the footer with the bottom margin", () => {
    const defaults = getDefaultPageLayout();
    const layout: PageLayout = {
      ...defaults,
      marginsMm: { ...defaults.marginsMm, bottom: 13 },
      footer: { ...defaults.footer!, enabled: true, heightMm: 8, offsetMm: 5 },
    };

    expect(setRunningRegionGeometryMm(layout, "footer", { offsetMm: 10 }).marginsMm.bottom).toBe(18);
    expect(setPageMarginMm(layout, "bottom", 7).footer).toMatchObject({ offsetMm: 5, heightMm: 2 });
  });

  it("makes room for a header when it is turned on, and keeps the margin when it is turned off", () => {
    const layout = getDefaultPageLayout();
    const shown = setRunningRegionEnabled(
      { ...layout, marginsMm: { ...layout.marginsMm, top: 6 } },
      "header",
      true,
    );

    expect(shown.header?.enabled).toBe(true);
    expect(shown.marginsMm.top).toBe(13);
    const hidden = setRunningRegionEnabled(shown, "header", false);
    expect(hidden.header?.enabled).toBe(false);
    expect(hidden.marginsMm.top).toBe(13);
  });

  it("applies margin presets through the same coupling", () => {
    const next = applyPageMarginPreset(layoutWithHeader(14.5, 5, 19.5), "narrow");

    expect(next.marginsMm).toEqual({ top: 10, right: 10, bottom: 10, left: 10 });
    expect(next.header?.heightMm).toBe(5);
    expect(getActivePageMarginPreset(next)).toBe("narrow");
    expect(getActivePageMarginPreset(getDefaultPageLayout())).toBe("standard");
    expect(getActivePageMarginPreset(layoutWithHeader(8, 5, 11))).toBeNull();
  });
});
