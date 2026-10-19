import {
  MIN_PAGE_BODY_HEIGHT_MM,
  MM_TO_PX,
  normalizePageLayout,
} from "./page-layout";
import type { PageLayout } from "../model";

export type PageRunningRegionKind = "header" | "footer";

export const RUNNING_REGION_AUTO_HEIGHT_PADDING_PX = 2;

/** 中身の高さの揺れ (再描画・丸め) を「行が増えた」と取り違えないための幅。 */
const CONTENT_GROWTH_EPSILON_PX = 1;

/**
 * ヘッダー/フッターを編集し始めたときの大きさ。自動の伸縮はここを下限にする。
 *
 * 帯の高さは利用者がドラッグやページ設定で決めるもので、中身に合わせて勝手に縮めない。
 * 以前は編集に入るたびに中身へ合わせ直していたので、引き伸ばした帯がダブルクリックで
 * 元に戻り、中身より低い帯 (1 行より低いヘッダーや 0mm) はそもそも作れなかった。
 */
export interface RunningRegionFitBase {
  /** そのときの中身の高さ (px)。中身がこれより増えたときだけ帯を伸ばす。 */
  contentHeightPx: number;
  heightMm: number;
  /** その側の余白 (ヘッダーなら上、フッターなら下)。伸ばした帯を戻すときに余白も戻す。 */
  marginMm: number;
}

export function captureRunningRegionFitBase(
  layout: PageLayout,
  kind: PageRunningRegionKind,
  contentHeightPx: number,
): RunningRegionFitBase | null {
  const normalized = normalizePageLayout(layout);
  const region = normalized[kind];
  if (!region?.enabled || !Number.isFinite(contentHeightPx)) {
    return null;
  }
  return {
    contentHeightPx,
    heightMm: region.heightMm,
    marginMm: kind === "header" ? normalized.marginsMm.top : normalized.marginsMm.bottom,
  };
}

/**
 * 編集で中身が増えたら、はみ出さないように帯を伸ばす。中身が編集前の量に戻ったら、
 * 帯と余白も編集前 (`base`) に戻す。編集前の高さより低くはしない。
 */
export function fitRunningRegionToEditedContent(
  layout: PageLayout,
  kind: PageRunningRegionKind,
  contentHeightPx: number,
  base: RunningRegionFitBase,
): PageLayout {
  if (!Number.isFinite(contentHeightPx) || contentHeightPx < 0) {
    return layout;
  }

  const normalized = normalizePageLayout(layout);
  const region = normalized[kind];
  if (!region?.enabled) {
    return layout;
  }

  const grew = contentHeightPx > base.contentHeightPx + CONTENT_GROWTH_EPSILON_PX;
  const neededHeightMm = grew
    ? roundUpHalfMm((contentHeightPx + RUNNING_REGION_AUTO_HEIGHT_PADDING_PX) / MM_TO_PX)
    : 0;
  const maxHeightMm = Math.max(base.heightMm, getRunningRegionMaxHeightMm(normalized, kind));
  const heightMm = Math.min(Math.max(base.heightMm, neededHeightMm), maxHeightMm);
  if (heightMm === region.heightMm) {
    return layout;
  }

  const marginMm = Math.max(base.marginMm, roundUpHalfMm(region.offsetMm + heightMm));
  return {
    ...normalized,
    [kind]: {
      ...region,
      heightMm,
    },
    marginsMm: {
      ...normalized.marginsMm,
      ...(kind === "header" ? { top: marginMm } : { bottom: marginMm }),
    },
  };
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
