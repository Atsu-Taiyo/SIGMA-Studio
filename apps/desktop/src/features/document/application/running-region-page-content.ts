import type { PageLayout, PageRunningRegion, RichBlock } from "../model";
import type { PageRunningRegionKind } from "./page-running-region-layout";

/**
 * そのページに出す文字。ページ専用の中身があればそれ、無ければ共通の `blocks`。
 * 紙面・プレビュー・PDF・検索が同じ答えを使う。
 */
export function getRunningRegionBlocksForPage(
  region: PageRunningRegion,
  pageNumber: number,
): RichBlock[] {
  return region.pageContents?.find((content) => content.page === pageNumber)?.blocks ?? region.blocks;
}

/** そのページが、共通の中身ではなくページ専用の中身を持っているか。 */
export function hasRunningRegionPageContent(
  region: PageRunningRegion | undefined,
  pageNumber: number,
): boolean {
  return Boolean(region?.pageContents?.some((content) => content.page === pageNumber));
}

/** ページ専用の中身を持つページ番号 (昇順)。 */
export function listRunningRegionContentPages(region: PageRunningRegion | undefined): number[] {
  return (region?.pageContents ?? []).map((content) => content.page);
}

/**
 * そのページだけ中身を変える/共通に戻す。
 *
 * 変えるときは、いまの共通の中身を写してから始める (空から書かせない)。共通に戻すと、そのページ専用の
 * 文字は捨てる。`totalPages` を渡すと、いまのページ数より先の専用の中身 (本文を減らして残ったもの)
 * も片付ける。
 */
export function setRunningRegionPageContentEnabled(
  layout: PageLayout,
  kind: PageRunningRegionKind,
  pageNumber: number,
  enabled: boolean,
  totalPages?: number,
): PageLayout {
  const region = layout[kind];
  if (!region || !Number.isInteger(pageNumber) || pageNumber < 1) {
    return layout;
  }
  if (hasRunningRegionPageContent(region, pageNumber) === enabled) {
    return layout;
  }

  const others = (region.pageContents ?? []).filter((content) => content.page !== pageNumber);
  const contents = enabled
    ? [...others, { page: pageNumber, blocks: structuredClone(region.blocks) }]
    : others;
  return withPageContents(layout, kind, contents, totalPages);
}

/** ページ専用の文字を書き換える (そのページが専用の中身を持っているときだけ)。 */
export function replaceRunningRegionPageContentBlocks(
  layout: PageLayout,
  kind: PageRunningRegionKind,
  pageNumber: number,
  blocks: RichBlock[],
): PageLayout {
  const region = layout[kind];
  if (!region || !hasRunningRegionPageContent(region, pageNumber)) {
    return layout;
  }

  const contents = (region.pageContents ?? []).map((content) => (
    content.page === pageNumber ? { ...content, blocks } : content
  ));
  return withPageContents(layout, kind, contents);
}

/** ページごとの中身をすべてやめて、共通の中身に戻す。 */
export function clearRunningRegionPageContents(layout: PageLayout, kind: PageRunningRegionKind): PageLayout {
  return withPageContents(layout, kind, []);
}

function withPageContents(
  layout: PageLayout,
  kind: PageRunningRegionKind,
  contents: NonNullable<PageRunningRegion["pageContents"]>,
  totalPages?: number,
): PageLayout {
  const region = layout[kind];
  if (!region) {
    return layout;
  }

  const pageContents = contents
    .filter((content) => totalPages === undefined || content.page <= totalPages)
    .sort((left, right) => left.page - right.page);
  const next = { ...region };
  if (pageContents.length > 0) {
    next.pageContents = pageContents;
  } else {
    delete next.pageContents;
  }
  return { ...layout, [kind]: next };
}
