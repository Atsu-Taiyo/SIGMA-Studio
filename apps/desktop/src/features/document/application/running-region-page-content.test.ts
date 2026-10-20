import { describe, expect, it } from "vitest";

import type { PageLayout, RichBlock } from "../model";
import { normalizePageLayout, pageRunningRegionHasContentOnPage } from "./page-layout";
import {
  clearRunningRegionPageContents,
  getRunningRegionBlocksForPage,
  hasRunningRegionPageContent,
  listRunningRegionContentPages,
  replaceRunningRegionPageContentBlocks,
  setRunningRegionPageContentEnabled,
} from "./running-region-page-content";

const paragraph = (id: string, text: string): RichBlock => ({ type: "paragraph", id, children: [{ type: "text", text }] });
const textOf = (blocks: readonly RichBlock[]) => blocks.map((block) => (
  block.type === "paragraph" ? block.children.map((child) => ("text" in child ? child.text : "")).join("") : ""
)).join("\n");

function layoutWithHeader(patch: Partial<NonNullable<PageLayout["header"]>> = {}): PageLayout {
  return normalizePageLayout({
    header: { enabled: true, blocks: [paragraph("shared", "共通のヘッダー")], ...patch },
  });
}

describe("running region page content", () => {
  it("uses the shared text on every page that has no content of its own", () => {
    const header = layoutWithHeader().header!;

    expect([1, 2, 7].map((page) => textOf(getRunningRegionBlocksForPage(header, page)))).toEqual([
      "共通のヘッダー", "共通のヘッダー", "共通のヘッダー",
    ]);
    expect(listRunningRegionContentPages(header)).toEqual([]);
  });

  it("starts a page's own content from a copy of the shared text, so nothing starts empty", () => {
    const base = layoutWithHeader();
    const own = setRunningRegionPageContentEnabled(base, "header", 2, true, 4);

    expect(hasRunningRegionPageContent(own.header, 2)).toBe(true);
    expect(textOf(getRunningRegionBlocksForPage(own.header!, 2))).toBe("共通のヘッダー");
    // 写しなので、あとで片方を書き換えてももう片方は変わらない。
    expect(getRunningRegionBlocksForPage(own.header!, 2)).not.toBe(own.header!.blocks);
    expect(getRunningRegionBlocksForPage(own.header!, 2)).toEqual(own.header!.blocks);
    expect(setRunningRegionPageContentEnabled(own, "header", 2, true, 4)).toBe(own);
  });

  it("rewrites only that page's text and leaves the shared text and the other pages alone", () => {
    const base = setRunningRegionPageContentEnabled(
      setRunningRegionPageContentEnabled(layoutWithHeader(), "header", 2, true, 4),
      "header",
      3,
      true,
      4,
    );
    const edited = replaceRunningRegionPageContentBlocks(base, "header", 2, [paragraph("shared", "2ページ目だけ")]);

    expect(textOf(getRunningRegionBlocksForPage(edited.header!, 2))).toBe("2ページ目だけ");
    expect(textOf(getRunningRegionBlocksForPage(edited.header!, 3))).toBe("共通のヘッダー");
    expect(textOf(edited.header!.blocks)).toBe("共通のヘッダー");
    expect(listRunningRegionContentPages(edited.header)).toEqual([2, 3]);
    // 専用の中身を持たないページへの書き戻しは何もしない (共通の文字を壊さない)。
    expect(replaceRunningRegionPageContentBlocks(base, "header", 4, [paragraph("x", "x")])).toBe(base);
  });

  it("goes back to the shared text, throwing the page's own text away", () => {
    const own = replaceRunningRegionPageContentBlocks(
      setRunningRegionPageContentEnabled(layoutWithHeader(), "header", 2, true, 4),
      "header",
      2,
      [paragraph("shared", "捨てられる")],
    );
    const shared = setRunningRegionPageContentEnabled(own, "header", 2, false, 4);

    expect(shared.header).not.toHaveProperty("pageContents");
    expect(textOf(getRunningRegionBlocksForPage(shared.header!, 2))).toBe("共通のヘッダー");
    expect(setRunningRegionPageContentEnabled(shared, "header", 2, false, 4)).toBe(shared);
  });

  it("keeps the contents ordered by page, drops those beyond the page count and clears them all", () => {
    const base = layoutWithHeader();
    const three = setRunningRegionPageContentEnabled(base, "header", 3, true, 6);
    const threeAndTwo = setRunningRegionPageContentEnabled(three, "header", 2, true, 6);

    expect(listRunningRegionContentPages(threeAndTwo.header)).toEqual([2, 3]);
    expect(listRunningRegionContentPages(setRunningRegionPageContentEnabled(threeAndTwo, "header", 4, true, 3).header)).toEqual([2, 3]);
    expect(clearRunningRegionPageContents(threeAndTwo, "header").header).not.toHaveProperty("pageContents");
    expect(setRunningRegionPageContentEnabled(base, "footer", 0, true, 3)).toBe(base);
  });

  it("draws nothing on a page whose own text is empty even though the shared text is not", () => {
    const own = replaceRunningRegionPageContentBlocks(
      setRunningRegionPageContentEnabled(layoutWithHeader(), "header", 2, true, 4),
      "header",
      2,
      [paragraph("shared", "")],
    );

    expect(pageRunningRegionHasContentOnPage(own.header, 1)).toBe(true);
    expect(pageRunningRegionHasContentOnPage(own.header, 2)).toBe(false);
  });
});

describe("pageContents normalization", () => {
  it("keeps one entry per page, in page order, and drops what is not a page's text", () => {
    const header = normalizePageLayout({
      header: {
        enabled: true,
        pageContents: [
          { page: 4, blocks: [paragraph("d", "4")] },
          { page: 2, blocks: [paragraph("b", "古い")] },
          { page: 2, blocks: [paragraph("b", "新しい")] },
          { page: 0, blocks: [paragraph("z", "0")] },
          { page: 3, blocks: "x" as unknown as RichBlock[] },
          { page: 5.5, blocks: [] },
        ],
      },
    }).header;

    expect(header?.pageContents?.map((content) => content.page)).toEqual([2, 4]);
    expect(textOf(header!.pageContents![0].blocks)).toBe("新しい");
  });

  it("omits the key when there is nothing to keep", () => {
    expect(normalizePageLayout({ header: { enabled: true, pageContents: [] } }).header).not.toHaveProperty("pageContents");
    expect(normalizePageLayout({ header: { enabled: true, pageContents: "x" as never } }).header).not.toHaveProperty("pageContents");
  });
});
