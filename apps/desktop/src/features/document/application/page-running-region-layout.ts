import {
  DEFAULT_PAGE_MARGINS_MM,
  expandMarginsForRunningRegions,
  MIN_PAGE_BODY_HEIGHT_MM,
  MM_TO_PX,
  normalizePageLayout,
} from "./page-layout";
import type { PageLayout } from "../model";

export type PageRunningRegionKind = "header" | "footer";

export const RUNNING_REGION_AUTO_HEIGHT_PADDING_PX = 2;

export function growRunningRegionToFitContent(
  layout: PageLayout,
  kind: PageRunningRegionKind,
  contentHeightPx: number,
): PageLayout {
  return fitRunningRegionToContent(layout, kind, contentHeightPx, { allowShrink: false });
}

export function fitRunningRegionToContent(
  layout: PageLayout,
  kind: PageRunningRegionKind,
  contentHeightPx: number,
  options: { allowShrink?: boolean } = {},
): PageLayout {
  if (!Number.isFinite(contentHeightPx) || contentHeightPx <= 0) {
    return layout;
  }

  const normalized = normalizePageLayout(layout);
  const region = normalized[kind];
  if (!region?.enabled) {
    return layout;
  }

  const neededHeightMm = roundUpHalfMm((contentHeightPx + RUNNING_REGION_AUTO_HEIGHT_PADDING_PX) / MM_TO_PX);
  const maxHeightMm = getRunningRegionMaxHeightMm(normalized, kind);
  if (maxHeightMm <= 0) {
    return layout;
  }

  const nextHeightMm = Math.min(Math.max(neededHeightMm, 3), maxHeightMm);
  if (!options.allowShrink && nextHeightMm <= region.heightMm) {
    return layout;
  }

  if (nextHeightMm === region.heightMm) {
    return layout;
  }

  return adjustMarginsForRunningRegionFit({
    ...normalized,
    [kind]: {
      ...region,
      heightMm: nextHeightMm,
    },
  }, kind, region.heightMm);
}

export function getRunningRegionMaxHeightMm(
  layout: PageLayout,
  kind: PageRunningRegionKind,
): number {
  const normalized = normalizePageLayout(layout);
  const region = normalized[kind];
  if (!region) {
    return 0;
  }

  if (kind === "header") {
    const maxBottomMm = normalized.pageSize.heightMm - normalized.marginsMm.bottom - MIN_PAGE_BODY_HEIGHT_MM;
    return Math.max(0, roundDownHalfMm(maxBottomMm - region.offsetMm));
  }

  const bottomMm = normalized.pageSize.heightMm - region.offsetMm;
  const minTopMm = normalized.marginsMm.top + MIN_PAGE_BODY_HEIGHT_MM;
  return Math.max(0, roundDownHalfMm(bottomMm - minTopMm));
}

function roundUpHalfMm(value: number): number {
  return Math.ceil(value * 2) / 2;
}

function roundDownHalfMm(value: number): number {
  return Math.floor(value * 2) / 2;
}

function adjustMarginsForRunningRegionFit(
  layout: PageLayout,
  kind: PageRunningRegionKind,
  previousHeightMm: number,
): PageLayout {
  const expanded = expandMarginsForRunningRegions(layout);
  const region = expanded[kind];
  if (!region) {
    return expanded;
  }

  if (kind === "header") {
    const previousBottomMm = region.offsetMm + previousHeightMm;
    const nextBottomMm = region.offsetMm + region.heightMm;
    const top = expanded.marginsMm.top <= previousBottomMm + 0.5
      ? Math.max(DEFAULT_PAGE_MARGINS_MM.top, nextBottomMm)
      : expanded.marginsMm.top;
    return {
      ...expanded,
      marginsMm: {
        ...expanded.marginsMm,
        top: roundUpHalfMm(top),
      },
    };
  }

  const previousTopDistanceMm = region.offsetMm + previousHeightMm;
  const nextTopDistanceMm = region.offsetMm + region.heightMm;
  const bottom = expanded.marginsMm.bottom <= previousTopDistanceMm + 0.5
    ? Math.max(DEFAULT_PAGE_MARGINS_MM.bottom, nextTopDistanceMm)
    : expanded.marginsMm.bottom;
  return {
    ...expanded,
    marginsMm: {
      ...expanded.marginsMm,
      bottom: roundUpHalfMm(bottom),
    },
  };
}
