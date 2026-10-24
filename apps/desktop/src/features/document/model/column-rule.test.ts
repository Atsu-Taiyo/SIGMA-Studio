import { describe, expect, it } from "vitest";
import { normalizeColumnRule } from "./column-rule";
import { getDefaultPageLayout, getPageMetrics, normalizePageLayout } from "../application/page-layout";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { sampleDocument } from "@/lib/sample-document";

describe("column rules", () => {
  it("preserves page-specific separators through document save/reload and metrics", () => {
    const rule = { style: "dotted" as const, widthPx: 2, color: "#123456" };
    const layout = normalizePageLayout({ flow: { columnCount: 2, pageColumnRules: [{ page: 2, rule }] } });
    const saved = JSON.stringify({ ...sampleDocument, pageLayout: layout });
    const reloaded = parseSigmaDocument(JSON.parse(saved));
    expect(getPageMetrics(reloaded.pageLayout).flow.pageColumnRules).toEqual([{ page: 2, rule }]);
    expect(reloaded.pageLayout?.flow.columnRule).toBeUndefined();
  });
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
