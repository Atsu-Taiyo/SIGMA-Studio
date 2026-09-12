import { describe, expect, it } from "vitest";

import type { PageLayout } from "../model";
import {
  enablePageRunningRegion,
  getRunningRegionBoundsMm,
  resizeHorizontalMarginsLayout,
  resizeRunningRegionLayout,
  roundHalfMm,
  roundMm,
} from "./page-layout-resize";

describe("page layout resize model", () => {
  it("resolves header and footer bounds in top-origin page coordinates", () => {
    const layout = createLayout();

    expect(getRunningRegionBoundsMm(layout, "header")).toEqual({
      topMm: 5,
      bottomMm: 13,
    });
    expect(getRunningRegionBoundsMm(layout, "footer")).toEqual({
      topMm: 284,
      bottomMm: 292,
    });
    expect(getRunningRegionBoundsMm({
      ...layout,
      header: undefined,
    }, "header")).toEqual({
      topMm: 0,
      bottomMm: 0,
    });
  });

  it("enables a running region while clamping invalid stored dimensions", () => {
    const layout = createLayout();
    const result = enablePageRunningRegion({
      ...layout,
      header: {
        ...layout.header!,
        enabled: false,
        offsetMm: -2,
        heightMm: 0,
      },
    }, "header");

    expect(result.header).toEqual({
      ...layout.header,
      enabled: true,
      offsetMm: 0,
      heightMm: 1,
    });
    expect(result.footer).toBe(layout.footer);
  });

  it("clamps header and footer growth to preserve the minimum body height", () => {
    const layout = createLayout();
    const header = resizeRunningRegionLayout({
      baseLayout: layout,
      kind: "header",
      edge: "end",
      startTopMm: 5,
      startBottomMm: 13,
    }, 1_000);
    const footer = resizeRunningRegionLayout({
      baseLayout: layout,
      kind: "footer",
      edge: "start",
      startTopMm: 284,
      startBottomMm: 292,
    }, -1_000);

    expect(header.header).toMatchObject({
      offsetMm: 5,
      heightMm: 242,
    });
    expect(header.marginsMm.top).toBe(247);
    expect(
      header.pageSize.heightMm
        - header.marginsMm.top
        - header.marginsMm.bottom,
    ).toBe(30);

    expect(footer.footer).toMatchObject({
      offsetMm: 5,
      heightMm: 242,
    });
    expect(footer.marginsMm.bottom).toBe(247);
    expect(
      footer.pageSize.heightMm
        - footer.marginsMm.top
        - footer.marginsMm.bottom,
    ).toBe(30);
  });

  it("keeps a resized running region at least three millimeters high", () => {
    const layout = createLayout();
    const header = resizeRunningRegionLayout({
      baseLayout: layout,
      kind: "header",
      edge: "start",
      startTopMm: 5,
      startBottomMm: 13,
    }, 1_000);
    const footer = resizeRunningRegionLayout({
      baseLayout: layout,
      kind: "footer",
      edge: "end",
      startTopMm: 284,
      startBottomMm: 292,
    }, -1_000);

    expect(header.header).toMatchObject({
      offsetMm: 10,
      heightMm: 3,
    });
    expect(header.marginsMm.top).toBe(13);
    expect(footer.footer).toMatchObject({
      offsetMm: 10,
      heightMm: 3,
    });
    expect(footer.marginsMm.bottom).toBe(13);
  });

  it("clamps left and right margins to a sixty millimeter content width", () => {
    const layout = createLayout();
    const left = resizeHorizontalMarginsLayout({
      baseLayout: layout,
      edge: "left",
      startLeftMm: 15,
      startRightMm: 15,
    }, 1_000);
    const right = resizeHorizontalMarginsLayout({
      baseLayout: layout,
      edge: "right",
      startLeftMm: 15,
      startRightMm: 15,
    }, -1_000);

    expect(left.marginsMm).toMatchObject({
      left: 135,
      right: 15,
    });
    expect(right.marginsMm).toMatchObject({
      left: 15,
      right: 135,
    });
    expect(
      layout.pageSize.widthMm
        - left.marginsMm.left
        - left.marginsMm.right,
    ).toBe(60);
    expect(
      layout.pageSize.widthMm
        - right.marginsMm.left
        - right.marginsMm.right,
    ).toBe(60);
  });

  it("rounds layout dimensions to half-millimeter increments", () => {
    expect(roundMm(7.24)).toBe(7);
    expect(roundMm(7.26)).toBe(7.5);
    expect(roundHalfMm(7.26)).toBe(7.5);

    const layout = createLayout();
    expect(resizeHorizontalMarginsLayout({
      baseLayout: layout,
      edge: "left",
      startLeftMm: 15,
      startRightMm: 15,
    }, 0.26).marginsMm.left).toBe(15.5);
  });
});

function createLayout(): PageLayout {
  return {
    preset: "custom",
    orientation: "portrait",
    pageSize: {
      widthMm: 210,
      heightMm: 297,
    },
    marginsMm: {
      top: 20,
      right: 15,
      bottom: 20,
      left: 15,
    },
    flow: {
      type: "columns",
      columnCount: 1,
      columnGapMm: 8,
    },
    header: {
      enabled: true,
      heightMm: 8,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [],
    },
    footer: {
      enabled: true,
      heightMm: 8,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [],
    },
  };
}
