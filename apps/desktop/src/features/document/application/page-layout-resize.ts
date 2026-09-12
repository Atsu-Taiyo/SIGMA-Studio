import type { PageLayout } from "../model";
import { MIN_PAGE_BODY_HEIGHT_MM, mmToPx } from "./page-layout";
import type { PageRunningRegionKind } from "./page-running-region-layout";

export type PageRunningRegionResizeEdge = "start" | "end";
export type PageHorizontalMarginResizeEdge = "left" | "right";

export interface PageRunningRegionResizeInput {
  kind: PageRunningRegionKind;
  edge: PageRunningRegionResizeEdge;
  startTopMm: number;
  startBottomMm: number;
  baseLayout: PageLayout;
}

export interface PageHorizontalMarginResizeInput {
  edge: PageHorizontalMarginResizeEdge;
  startLeftMm: number;
  startRightMm: number;
  baseLayout: PageLayout;
}

export function enablePageRunningRegion(
  layout: PageLayout,
  kind: PageRunningRegionKind,
): PageLayout {
  const current = layout[kind];
  if (!current) {
    return layout;
  }

  return {
    ...layout,
    [kind]: {
      ...current,
      enabled: true,
      offsetMm: Math.max(0, current.offsetMm),
      heightMm: Math.max(1, current.heightMm),
    },
  };
}

export function getRunningRegionBoundsMm(
  layout: PageLayout,
  kind: PageRunningRegionKind,
): { topMm: number; bottomMm: number } {
  const region = layout[kind];
  if (!region) {
    return { topMm: 0, bottomMm: 0 };
  }

  if (kind === "header") {
    return {
      topMm: region.offsetMm,
      bottomMm: region.offsetMm + region.heightMm,
    };
  }

  const bottomMm = layout.pageSize.heightMm - region.offsetMm;
  return {
    topMm: bottomMm - region.heightMm,
    bottomMm,
  };
}

export function resizeRunningRegionLayout(
  drag: PageRunningRegionResizeInput,
  deltaMm: number,
): PageLayout {
  const { baseLayout, kind } = drag;
  const minHeightMm = 3;
  const pageHeightMm = baseLayout.pageSize.heightMm;
  let topMm = drag.startTopMm;
  let bottomMm = drag.startBottomMm;

  if (kind === "header") {
    const maxBottomMm = Math.max(
      minHeightMm,
      pageHeightMm - baseLayout.marginsMm.bottom - MIN_PAGE_BODY_HEIGHT_MM,
    );
    if (drag.edge === "start") {
      topMm = clampNumber(
        drag.startTopMm + deltaMm,
        0,
        Math.min(bottomMm - minHeightMm, maxBottomMm - minHeightMm),
      );
    } else {
      bottomMm = clampNumber(
        drag.startBottomMm + deltaMm,
        topMm + minHeightMm,
        maxBottomMm,
      );
    }
  } else {
    const minTopMm = Math.min(
      pageHeightMm - minHeightMm,
      baseLayout.marginsMm.top + MIN_PAGE_BODY_HEIGHT_MM,
    );
    if (drag.edge === "start") {
      topMm = clampNumber(
        drag.startTopMm + deltaMm,
        minTopMm,
        bottomMm - minHeightMm,
      );
    } else {
      bottomMm = clampNumber(
        drag.startBottomMm + deltaMm,
        topMm + minHeightMm,
        pageHeightMm,
      );
    }
  }

  const current = baseLayout[kind];
  if (!current) {
    return baseLayout;
  }

  const nextRegion = kind === "header"
    ? {
        ...current,
        offsetMm: roundMm(topMm),
        heightMm: roundMm(bottomMm - topMm),
      }
    : {
        ...current,
        offsetMm: roundMm(pageHeightMm - bottomMm),
        heightMm: roundMm(bottomMm - topMm),
      };

  return alignMarginToRunningRegionBoundary({
    ...baseLayout,
    [kind]: nextRegion,
  }, kind);
}

export function alignMarginToRunningRegionBoundary(
  layout: PageLayout,
  kind: PageRunningRegionKind,
): PageLayout {
  const bounds = getRunningRegionBoundsMm(layout, kind);
  return {
    ...layout,
    marginsMm: {
      ...layout.marginsMm,
      ...(kind === "header"
        ? { top: roundMm(bounds.bottomMm) }
        : { bottom: roundMm(layout.pageSize.heightMm - bounds.topMm) }),
    },
  };
}

export function resizeHorizontalMarginsLayout(
  drag: PageHorizontalMarginResizeInput,
  deltaMm: number,
): PageLayout {
  const { baseLayout } = drag;
  const minContentWidthMm = Math.min(60, baseLayout.pageSize.widthMm / 2);
  let leftMm = drag.startLeftMm;
  let rightMm = drag.startRightMm;

  if (drag.edge === "left") {
    leftMm = clampNumber(
      drag.startLeftMm + deltaMm,
      0,
      Math.max(0, baseLayout.pageSize.widthMm - drag.startRightMm - minContentWidthMm),
    );
  } else {
    rightMm = clampNumber(
      drag.startRightMm - deltaMm,
      0,
      Math.max(0, baseLayout.pageSize.widthMm - drag.startLeftMm - minContentWidthMm),
    );
  }

  return {
    ...baseLayout,
    marginsMm: {
      ...baseLayout.marginsMm,
      left: roundMm(leftMm),
      right: roundMm(rightMm),
    },
  };
}

export function clampNumber(value: number, min: number, max: number): number {
  const safeMax = Math.max(min, max);
  return Math.min(safeMax, Math.max(min, value));
}

export function roundMm(value: number): number {
  return Math.round(value * 2) / 2;
}

export function roundHalfMm(value: number): number {
  return roundMm(value);
}

/**
 * The overlay coordinate space of a running region, in px.
 *
 * The editing band and the displayed region used to compute this separately and disagreed by the
 * page sheet's 2px border. Nobody noticed because the overlay was an SVG string whose `viewBox`
 * scaled the difference away — but a React overlay places shapes at absolute px, so the same shape
 * would sit in two places depending on whether the band was open. Both surfaces read this.
 */
export function getRunningRegionOverlaySize(
  contentWidthPx: number,
  region: { heightMm: number } | undefined,
): { heightPx: number; widthPx: number } {
  return {
    heightPx: mmToPx(region?.heightMm ?? 0),
    widthPx: Math.max(0, contentWidthPx),
  };
}
