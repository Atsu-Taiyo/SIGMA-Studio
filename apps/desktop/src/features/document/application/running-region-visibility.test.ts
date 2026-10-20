import { describe, expect, it } from "vitest";

import type { PageLayout } from "../model";
import { normalizePageLayout } from "./page-layout";
import {
  describeRunningRegionPageExceptions,
  getRunningRegionPageRange,
  isRunningRegionShownOnPage,
  setRunningRegionPageRange,
  setRunningRegionShownOnPage,
} from "./running-region-visibility";

function layoutWithHeader(patch: Partial<NonNullable<PageLayout["header"]>> = {}): PageLayout {
  return normalizePageLayout({ header: { enabled: true, ...patch } });
}

const shownPages = (layout: PageLayout, count: number) => (
  Array.from({ length: count }, (_, index) => isRunningRegionShownOnPage(layout.header, index + 1))
);

describe("running region page visibility", () => {
  it("shows the band on every page unless it is switched off", () => {
    const header = layoutWithHeader().header;

    expect([1, 2, 3].map((page) => isRunningRegionShownOnPage(header, page))).toEqual([true, true, true]);
    expect(isRunningRegionShownOnPage(undefined, 1)).toBe(false);
    expect(isRunningRegionShownOnPage({ ...header!, enabled: false }, 2)).toBe(false);
  });

  it("hides page 1 through showOnFirstPage and later pages through hiddenPages", () => {
    const layout = layoutWithHeader({ showOnFirstPage: false, hiddenPages: [3] });

    expect(shownPages(layout, 4)).toEqual([false, true, false, true]);
  });

  it("shows the first page only by switching the later pages' default off", () => {
    const layout = layoutWithHeader({ showOnLaterPages: false });

    expect(shownPages(layout, 4)).toEqual([true, false, false, false]);
    // ページが増えても、あとのページへ自然に効く。
    expect(isRunningRegionShownOnPage(layout.header, 500)).toBe(false);
  });

  it("lists the exceptions to the later pages' default, whichever way the default points", () => {
    const hiddenDefault = layoutWithHeader({ showOnLaterPages: false, shownPages: [4] });

    expect(shownPages(hiddenDefault, 5)).toEqual([true, false, false, true, false]);
    expect(isRunningRegionShownOnPage(layoutWithHeader({ hiddenPages: [4] }).header, 4)).toBe(false);
  });

  it("folds a 1 in a list into showOnFirstPage and drops the list that does not apply", () => {
    const hidden = layoutWithHeader({ hiddenPages: [1, 3] }).header;
    const shown = layoutWithHeader({ showOnLaterPages: false, shownPages: [1, 3] }).header;
    const unusedList = layoutWithHeader({ hiddenPages: [2], shownPages: [5] }).header;

    expect(hidden).toMatchObject({ showOnFirstPage: false, hiddenPages: [3] });
    expect(shown).toMatchObject({ showOnFirstPage: true, showOnLaterPages: false, shownPages: [3] });
    expect(unusedList).toMatchObject({ hiddenPages: [2] });
    expect(unusedList).not.toHaveProperty("shownPages");
  });
});

describe("running region page range", () => {
  it("names the three groups and reads page-by-page exceptions as none of them", () => {
    expect(getRunningRegionPageRange(layoutWithHeader().header)).toBe("all");
    expect(getRunningRegionPageRange(layoutWithHeader({ showOnLaterPages: false }).header)).toBe("firstOnly");
    expect(getRunningRegionPageRange(layoutWithHeader({ showOnFirstPage: false }).header)).toBe("exceptFirst");
    expect(getRunningRegionPageRange(layoutWithHeader({ hiddenPages: [3] }).header)).toBeNull();
    expect(getRunningRegionPageRange(layoutWithHeader({ showOnLaterPages: false, shownPages: [3] }).header)).toBeNull();
    expect(getRunningRegionPageRange(layoutWithHeader({ showOnFirstPage: false, showOnLaterPages: false }).header)).toBeNull();
    expect(getRunningRegionPageRange(undefined)).toBeNull();
  });

  it("sets a group by writing the first page and the later pages' default, without a list of every page", () => {
    const base = layoutWithHeader();
    const firstOnly = setRunningRegionPageRange(base, "header", "firstOnly");

    expect(firstOnly.header).toMatchObject({ showOnFirstPage: true, showOnLaterPages: false });
    expect(firstOnly.header).not.toHaveProperty("hiddenPages");
    expect(shownPages(firstOnly, 6)).toEqual([true, false, false, false, false, false]);

    const exceptFirst = setRunningRegionPageRange(firstOnly, "header", "exceptFirst");
    expect(exceptFirst.header?.showOnFirstPage).toBe(false);
    expect(exceptFirst.header).not.toHaveProperty("showOnLaterPages");
    expect(shownPages(exceptFirst, 3)).toEqual([false, true, true]);

    expect(setRunningRegionPageRange(exceptFirst, "header", "all").header).toMatchObject({ showOnFirstPage: true });
    expect(setRunningRegionPageRange(base, "header", "all")).toBe(base);
  });

  it("drops the page-by-page exceptions when a group is chosen, and keeps the page's own content", () => {
    const base = layoutWithHeader({
      hiddenPages: [2, 5],
      pageContents: [{ page: 3, blocks: [{ type: "paragraph", id: "own", children: [{ type: "text", text: "3ページ" }] }] }],
    });
    const all = setRunningRegionPageRange(base, "header", "all");

    expect(all.header).not.toHaveProperty("hiddenPages");
    expect(all.header?.pageContents).toHaveLength(1);
    expect(setRunningRegionPageRange(base, "footer", "firstOnly").footer).toMatchObject({ showOnLaterPages: false });
  });

  it("summarises the exceptions for the page-by-page state only", () => {
    const hidden = layoutWithHeader({ showOnFirstPage: false, hiddenPages: [3] }).header;
    const shown = layoutWithHeader({ showOnLaterPages: false, shownPages: [4] }).header;

    expect(describeRunningRegionPageExceptions(hidden, 5)).toEqual({ kind: "hidden", pages: [1, 3] });
    expect(describeRunningRegionPageExceptions(shown, 5)).toEqual({ kind: "shown", pages: [1, 4] });
    expect(describeRunningRegionPageExceptions(layoutWithHeader().header, 5)).toBeNull();
    expect(describeRunningRegionPageExceptions(layoutWithHeader({ showOnLaterPages: false }).header, 5)).toBeNull();
  });
});

describe("switching one page", () => {
  it("switches one later page off and back on without touching the others", () => {
    const base = layoutWithHeader();
    const hidden = setRunningRegionShownOnPage(base, "header", 3, false, 5);
    const hiddenTwice = setRunningRegionShownOnPage(hidden, "header", 2, false, 5);

    expect(hidden.header?.hiddenPages).toEqual([3]);
    expect(hiddenTwice.header?.hiddenPages).toEqual([2, 3]);
    expect(hiddenTwice.header?.showOnFirstPage).toBe(true);

    const shown = setRunningRegionShownOnPage(hiddenTwice, "header", 3, true, 5);
    expect(shown.header?.hiddenPages).toEqual([2]);
    // 最後の 1 ページを戻すとキーごと消える (保存した教材に空配列を残さない)。
    expect(setRunningRegionShownOnPage(shown, "header", 2, true, 5).header).not.toHaveProperty("hiddenPages");
  });

  it("writes page 1 to showOnFirstPage, the same value the page setup dialog edits", () => {
    const base = layoutWithHeader();
    const hidden = setRunningRegionShownOnPage(base, "header", 1, false, 3);

    expect(hidden.header?.showOnFirstPage).toBe(false);
    expect(hidden.header).not.toHaveProperty("hiddenPages");
    expect(setRunningRegionShownOnPage(hidden, "header", 1, true, 3).header?.showOnFirstPage).toBe(true);
  });

  it("adds a page to the shown list when the later pages' default is off, and removes it again", () => {
    const firstOnly = setRunningRegionPageRange(layoutWithHeader(), "header", "firstOnly");
    const withFourth = setRunningRegionShownOnPage(firstOnly, "header", 4, true, 6);

    expect(withFourth.header?.shownPages).toEqual([4]);
    expect(shownPages(withFourth, 5)).toEqual([true, false, false, true, false]);
    expect(getRunningRegionPageRange(withFourth.header)).toBeNull();

    const back = setRunningRegionShownOnPage(withFourth, "header", 4, false, 6);
    expect(back.header).not.toHaveProperty("shownPages");
    expect(getRunningRegionPageRange(back.header)).toBe("firstOnly");
  });

  it("returns the same layout when nothing changes, and drops marks beyond the page count", () => {
    const base = layoutWithHeader({ hiddenPages: [2, 9] });

    expect(setRunningRegionShownOnPage(base, "header", 2, false, 4)).toBe(base);
    expect(setRunningRegionShownOnPage(base, "header", 3, false, 4).header?.hiddenPages).toEqual([2, 3]);
    expect(setRunningRegionShownOnPage(base, "footer", 2, false, 4)).not.toBe(base);
    expect(setRunningRegionShownOnPage(base, "header", 0, false, 4)).toBe(base);
  });
});

describe("page list normalization", () => {
  it("keeps only positive whole page numbers, sorted and without duplicates", () => {
    const header = normalizePageLayout({
      header: { enabled: true, hiddenPages: [5, 2, 2, 0, -1, 1.5, Number.NaN, 3] as number[] },
    }).header;

    expect(header?.hiddenPages).toEqual([2, 3, 5]);
  });

  it("omits the keys when nothing is listed or the value is not a list, and the default later-pages flag", () => {
    const header = normalizePageLayout({
      header: { enabled: true, hiddenPages: [], shownPages: "2" as unknown as number[] },
    }).header;

    expect(header).not.toHaveProperty("hiddenPages");
    expect(header).not.toHaveProperty("shownPages");
    expect(header).not.toHaveProperty("showOnLaterPages");
    expect(layoutWithHeader({ showOnLaterPages: true }).header).not.toHaveProperty("showOnLaterPages");
  });
});
