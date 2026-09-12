import { describe, expect, it } from "vitest";
import { normalizeColumnRule } from "./column-rule";
import { getDefaultPageLayout, getPageMetrics, normalizePageLayout } from "../application/page-layout";

describe("column rules", () => {
  it("keeps the page rule through normalization and repeated page metrics", () => {
    const rule = { style: "double" as const, widthPx: 4, color: "#123456" };
    const layout = getDefaultPageLayout();
    layout.flow = { ...layout.flow, columnCount: 3, columnRule: rule };
    expect(normalizePageLayout(layout).flow.columnRule).toEqual(rule);
    expect(getPageMetrics(layout).flow.columnRule).toEqual(rule);
    expect(normalizePageLayout().flow.columnRule).toBeUndefined();
  });
  it("makes double lines visible and rejects unsafe styles and colors at the editing boundary", () => {
    expect(normalizeColumnRule({ style: "double", widthPx: 1, color: "#123456" })?.widthPx).toBe(3);
    expect(normalizeColumnRule({ style: "url(x)", widthPx: 1, color: "#123456" })).toBeUndefined();
    expect(normalizeColumnRule({ style: "solid", widthPx: Infinity, color: "red;position:fixed" }))
      .toEqual({ style: "solid", widthPx: 1, color: "#111111" });
  });
});
