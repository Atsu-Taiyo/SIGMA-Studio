import { describe, expect, it } from "vitest";

import {
  createRunningRegionFieldValues,
  DEFAULT_PAGE_NUMBER_START,
  findRunningRegionFields,
  getRunningRegionPageNumbers,
  MAX_PAGE_NUMBER_START,
  normalizePageNumberStart,
  renderRunningRegionTemplateText,
} from "./running-region-fields";

const values = { title: "小テスト", page: 3, total: 12 };

describe("running region fields", () => {
  it("finds the braced fields and the slash shorthand (with spaces after the slash)", () => {
    expect(findRunningRegionFields("{title} - {page}/ total")).toEqual([
      { start: 0, end: 7, field: "title" },
      { start: 10, end: 16, field: "page" },
      { start: 16, end: 23, field: "total" },
    ]);
  });

  it("replaces only the fields and keeps every other character, spaces included", () => {
    expect(renderRunningRegionTemplateText("第1回   {title}    p.{page}/{total}", values))
      .toBe("第1回   小テスト    p.3/12");
    expect(renderRunningRegionTemplateText("{pages} {Page}", values)).toBe("{pages} {Page}");
  });
});

describe("page number start", () => {
  it("counts from 1 by default, so the last page and the total are the physical count", () => {
    expect(getRunningRegionPageNumbers(1, 5)).toEqual({ page: 1, total: 5 });
    expect(getRunningRegionPageNumbers(5, 5, undefined)).toEqual({ page: 5, total: 5 });
    expect(getRunningRegionPageNumbers(5, 5, 1)).toEqual({ page: 5, total: 5 });
  });

  it("starts at 0 for a cover page: 5 physical pages read 0..4 and the total is the last number", () => {
    expect([1, 2, 3, 4, 5].map((page) => getRunningRegionPageNumbers(page, 5, 0))).toEqual([
      { page: 0, total: 4 },
      { page: 1, total: 4 },
      { page: 2, total: 4 },
      { page: 3, total: 4 },
      { page: 4, total: 4 },
    ]);
  });

  it("shifts both numbers by the same offset for any start", () => {
    expect(getRunningRegionPageNumbers(1, 5, 5)).toEqual({ page: 5, total: 9 });
    expect(getRunningRegionPageNumbers(5, 5, 5)).toEqual({ page: 9, total: 9 });
    expect(getRunningRegionPageNumbers(1, 1, 0)).toEqual({ page: 0, total: 0 });
  });

  it("ignores an invalid start rather than shifting by it", () => {
    expect(getRunningRegionPageNumbers(2, 4, -1)).toEqual({ page: 2, total: 4 });
    expect(getRunningRegionPageNumbers(2, 4, 1.5)).toEqual({ page: 2, total: 4 });
    expect(getRunningRegionPageNumbers(2, 4, Number.NaN)).toEqual({ page: 2, total: 4 });
  });

  it("builds the field values with the title kept and renders the 'page/total' footer", () => {
    const fieldValues = createRunningRegionFieldValues("小テスト", 5, 5, 0);
    expect(fieldValues).toEqual({ title: "小テスト", page: 4, total: 4 });
    expect(renderRunningRegionTemplateText("{page}/{total}", fieldValues)).toBe("4/4");
    expect(renderRunningRegionTemplateText("{page}/{total}", createRunningRegionFieldValues("", 1, 5, 0))).toBe("0/4");
  });

  it("accepts 0 through 9999 integers and falls back to the default for everything else", () => {
    expect(DEFAULT_PAGE_NUMBER_START).toBe(1);
    expect(normalizePageNumberStart(0)).toBe(0);
    expect(normalizePageNumberStart(7)).toBe(7);
    expect(normalizePageNumberStart(MAX_PAGE_NUMBER_START)).toBe(9999);
    for (const invalid of [-1, 10000, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null, undefined, {}, true]) {
      expect(normalizePageNumberStart(invalid)).toBe(1);
    }
  });
});
