import type { PageLayout } from "../model";
import { enablePageRunningRegion } from "./page-layout-resize";
import { DEFAULT_PAGE_MARGINS_MM } from "./page-layout";
import type { PageRunningRegionKind } from "./page-running-region-layout";

/**
 * ページ設定ダイアログで 1 つの値を変えたときの規則。ヘッダー/フッターと本文の余白は
 * 同じ境界を共有しているので、片方だけを変えると「適用」で黙って戻されていた
 * (上余白を 10mm にしても、ヘッダーの下端 19.5mm まで押し戻される)。値を変えた時点で
 * もう片方も合わせ、ダイアログに見えている値がそのまま適用されるようにする。
 */

export type PageMarginSide = "top" | "right" | "bottom" | "left";

export type PageMarginPresetId = "standard" | "narrow" | "wide";

export const PAGE_MARGIN_PRESETS_MM: Record<PageMarginPresetId, Record<PageMarginSide, number>> = {
  standard: { ...DEFAULT_PAGE_MARGINS_MM },
  narrow: { top: 10, right: 10, bottom: 10, left: 10 },
  wide: { top: 25, right: 25, bottom: 25, left: 25 },
};

const MARGIN_SIDE_OF_REGION: Record<PageRunningRegionKind, "top" | "bottom"> = {
  header: "top",
  footer: "bottom",
};

/** 用紙の端から、帯の本文側の辺までの距離。本文の余白はこれより狭くできない。 */
export function getRunningRegionReachMm(layout: PageLayout, kind: PageRunningRegionKind): number {
  const region = layout[kind];
  return region ? region.offsetMm + region.heightMm : 0;
}

/**
 * 余白を 1 辺だけ変える。上 (下) の余白を表示中のヘッダー (フッター) より狭くしたら、
 * 帯をその余白に収まるまで縮める (まず高さ、足りなければ用紙の端からの位置も)。
 */
export function setPageMarginMm(layout: PageLayout, side: PageMarginSide, valueMm: number): PageLayout {
  const value = clampNonnegative(valueMm);
  const next: PageLayout = {
    ...layout,
    marginsMm: { ...layout.marginsMm, [side]: value },
  };
  const kind = side === "top" ? "header" : side === "bottom" ? "footer" : null;
  const region = kind ? next[kind] : undefined;
  if (!kind || !region?.enabled || getRunningRegionReachMm(next, kind) <= value) {
    return next;
  }
  const offsetMm = Math.min(region.offsetMm, value);
  return {
    ...next,
    [kind]: { ...region, offsetMm, heightMm: roundTenth(value - offsetMm) },
  };
}

export function applyPageMarginPreset(layout: PageLayout, preset: PageMarginPresetId): PageLayout {
  const margins = PAGE_MARGIN_PRESETS_MM[preset];
  return (["top", "right", "bottom", "left"] as const).reduce(
    (current, side) => setPageMarginMm(current, side, margins[side]),
    layout,
  );
}

export function getActivePageMarginPreset(layout: PageLayout): PageMarginPresetId | null {
  const match = (Object.keys(PAGE_MARGIN_PRESETS_MM) as PageMarginPresetId[]).find((preset) => (
    (["top", "right", "bottom", "left"] as const).every((side) => (
      Math.abs(layout.marginsMm[side] - PAGE_MARGIN_PRESETS_MM[preset][side]) < 0.01
    ))
  ));
  return match ?? null;
}

/**
 * ヘッダー/フッターの位置・高さを変える。帯が本文の余白まで届いたら余白を押し広げる。
 * 余白が帯の辺にぴったり揃っていたなら、帯を縮めたときも余白が付いてくる
 * (紙面で帯の辺をドラッグしたときと同じ動き)。
 */
export function setRunningRegionGeometryMm(
  layout: PageLayout,
  kind: PageRunningRegionKind,
  patch: { offsetMm?: number; heightMm?: number },
): PageLayout {
  const region = layout[kind];
  if (!region) {
    return layout;
  }
  const side = MARGIN_SIDE_OF_REGION[kind];
  const previousReachMm = getRunningRegionReachMm(layout, kind);
  const nextRegion = {
    ...region,
    ...(patch.offsetMm === undefined ? {} : { offsetMm: clampNonnegative(patch.offsetMm) }),
    ...(patch.heightMm === undefined ? {} : { heightMm: clampNonnegative(patch.heightMm) }),
  };
  const next: PageLayout = { ...layout, [kind]: nextRegion };
  if (!region.enabled) {
    return next;
  }
  const marginMm = layout.marginsMm[side];
  const reachMm = getRunningRegionReachMm(next, kind);
  const aligned = Math.abs(marginMm - previousReachMm) < 0.01;
  return {
    ...next,
    marginsMm: {
      ...next.marginsMm,
      [side]: aligned ? reachMm : Math.max(marginMm, reachMm),
    },
  };
}

/** 表示を入れたら、帯が本文に重ならないよう余白を帯の辺まで広げる。切っても余白はそのまま。 */
export function setRunningRegionEnabled(
  layout: PageLayout,
  kind: PageRunningRegionKind,
  enabled: boolean,
): PageLayout {
  const region = layout[kind];
  if (!region || region.enabled === enabled) {
    return layout;
  }
  if (!enabled) {
    return { ...layout, [kind]: { ...region, enabled: false } };
  }
  const next = enablePageRunningRegion(layout, kind);
  const side = MARGIN_SIDE_OF_REGION[kind];
  return {
    ...next,
    marginsMm: {
      ...next.marginsMm,
      [side]: Math.max(next.marginsMm[side], getRunningRegionReachMm(next, kind)),
    },
  };
}

function clampNonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function roundTenth(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}
