import { describe, expect, it } from "vitest";

import { shouldDispatchSearchQuery } from "./search-query-dispatch";

describe("shouldDispatchSearchQuery", () => {
  it("stays silent while the search box has never held a query", () => {
    expect(shouldDispatchSearchQuery(null, "")).toBe(false);
  });

  it("notifies when a query appears", () => {
    expect(shouldDispatchSearchQuery(null, "三角形")).toBe(true);
  });

  it("stays silent when the same query is evaluated again", () => {
    expect(shouldDispatchSearchQuery("三角形", "三角形")).toBe(false);
    expect(shouldDispatchSearchQuery("", "")).toBe(false);
  });

  it("notifies when the query changes or is cleared", () => {
    expect(shouldDispatchSearchQuery("三角形", "四角形")).toBe(true);
    expect(shouldDispatchSearchQuery("三角形", "")).toBe(true);
  });
});
