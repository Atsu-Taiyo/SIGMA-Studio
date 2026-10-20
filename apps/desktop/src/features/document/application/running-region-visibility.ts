import type { PageLayout, PageRunningRegion } from "../model";
import type { PageRunningRegionKind } from "./page-running-region-layout";

/**
 * ヘッダー/フッターをそのページに出すか。
 *
 * 紙面の編集面・静的な描画 (ビューア・サムネイル)・PDF が同じ答えを使う。1 ページ目は
 * `showOnFirstPage`、2 ページ目以降は既定 (`showOnLaterPages`) と、既定と逆にするページの一覧
 * (`hiddenPages` / `shownPages`) が決める。「先頭ページのみ」は、2 ページ目以降の既定を「出さない」
 * にしたもの — ページが増えても、あとのページへ自然に効く。
 */
export function isRunningRegionShownOnPage(
  region: PageRunningRegion | undefined,
  pageNumber: number,
): boolean {
  if (!region?.enabled) {
    return false;
  }
  if (pageNumber <= 1) {
    return region.showOnFirstPage;
  }
  if (region.showOnLaterPages === false) {
    return region.shownPages?.includes(pageNumber) ?? false;
  }
  return !region.hiddenPages?.includes(pageNumber);
}

/** 設定のまとまり。例外のページが無いとき、どのページに出すか。 */
export type RunningRegionPageRange = "all" | "firstOnly" | "exceptFirst";

/**
 * いまの設定が、まとまりのどれか。ページごとの例外があるときや、どのページにも出さないときは
 * `null` (どれにも当てはまらない = 画面は「ページごとの設定」と読む)。
 */
export function getRunningRegionPageRange(region: PageRunningRegion | undefined): RunningRegionPageRange | null {
  if (!region || region.hiddenPages?.length || region.shownPages?.length) {
    return null;
  }
  const later = region.showOnLaterPages !== false;
  if (region.showOnFirstPage && later) {
    return "all";
  }
  if (region.showOnFirstPage) {
    return "firstOnly";
  }
  return later ? "exceptFirst" : null;
}

/**
 * まとまりで切り替える。ページごとの例外は捨てる (まとまりが優先)。ページ専用の中身は残す。
 * 「先頭ページのみ」は、2 ページ目以降の既定を「出さない」にする (ページが増えても効く)。
 */
export function setRunningRegionPageRange(
  layout: PageLayout,
  kind: PageRunningRegionKind,
  range: RunningRegionPageRange,
): PageLayout {
  const region = layout[kind];
  if (!region || getRunningRegionPageRange(region) === range) {
    return layout;
  }

  const next = { ...region };
  delete next.hiddenPages;
  delete next.shownPages;
  delete next.showOnLaterPages;
  next.showOnFirstPage = range !== "exceptFirst";
  if (range === "firstOnly") {
    next.showOnLaterPages = false;
  }
  return { ...layout, [kind]: next };
}

/**
 * 設定が「ページごと」のときの読み上げ用の要約: 出していないページ、または (2 ページ目以降を既定で
 * 出さないときは) 出すページ。まとまりのどれかのときは `null` (一覧は要らない)。
 */
export function describeRunningRegionPageExceptions(
  region: PageRunningRegion | undefined,
  totalPages: number,
): { kind: "hidden" | "shown"; pages: number[] } | null {
  if (!region || getRunningRegionPageRange(region) !== null) {
    return null;
  }

  const pages = Array.from({ length: Math.max(0, totalPages) }, (_, index) => index + 1);
  if (region.showOnLaterPages === false) {
    return { kind: "shown", pages: pages.filter((page) => isRunningRegionShownOnPage({ ...region, enabled: true }, page)) };
  }
  return { kind: "hidden", pages: pages.filter((page) => !isRunningRegionShownOnPage({ ...region, enabled: true }, page)) };
}

/**
 * 1 ページぶんの表示/非表示を切り替える。
 *
 * 1 ページ目は `showOnFirstPage` に書く (ページ設定の「先頭ページ」と同じ値)。2 ページ目以降は、
 * 既定と逆にするページの一覧へ足し引きする。`totalPages` を渡すと、いまのページ数より先の番号
 * (本文を減らして残った古い印) を片付ける。
 */
export function setRunningRegionShownOnPage(
  layout: PageLayout,
  kind: PageRunningRegionKind,
  pageNumber: number,
  shown: boolean,
  totalPages?: number,
): PageLayout {
  const region = layout[kind];
  if (!region || !Number.isInteger(pageNumber) || pageNumber < 1) {
    return layout;
  }
  if (isRunningRegionShownOnPage({ ...region, enabled: true }, pageNumber) === shown) {
    return layout;
  }

  const next = { ...region };
  if (pageNumber === 1) {
    next.showOnFirstPage = shown;
    return { ...layout, [kind]: next };
  }

  const defaultShown = region.showOnLaterPages !== false;
  const key = defaultShown ? "hiddenPages" : "shownPages";
  const exceptions = new Set(region[key] ?? []);
  // 既定どおりにするなら一覧から外し、既定と逆にするなら一覧へ足す。
  if (shown === defaultShown) {
    exceptions.delete(pageNumber);
  } else {
    exceptions.add(pageNumber);
  }
  const pages = [...exceptions]
    .filter((page) => totalPages === undefined || page <= totalPages)
    .sort((left, right) => left - right);
  if (pages.length > 0) {
    next[key] = pages;
  } else {
    delete next[key];
  }
  return { ...layout, [kind]: next };
}
