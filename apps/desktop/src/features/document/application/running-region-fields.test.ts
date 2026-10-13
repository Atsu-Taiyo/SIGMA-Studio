import { describe, expect, it } from "vitest";

import { findRunningRegionFields, renderRunningRegionTemplateText } from "./running-region-fields";

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
