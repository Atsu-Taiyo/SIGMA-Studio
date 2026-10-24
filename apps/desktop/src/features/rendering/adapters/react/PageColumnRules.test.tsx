import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getPageMetrics, normalizePageLayout } from "@/features/document";
import { PageColumnRules } from "./PageColumnRules";

describe("page column separators on every output surface", () => {
  it("inherits the document rule unless the page overrides it, including no line", () => {
    const metrics = getPageMetrics(normalizePageLayout({ flow: {
      columnCount: 3,
      columnRule: { style: "double", widthPx: 3, color: "#111111" },
      pageColumnRules: [
        { page: 1, rule: { style: "dotted", widthPx: 1, color: "#123456" } },
        { page: 3, rule: { style: "none", widthPx: 1, color: "#111111" } },
      ],
    } }));
    const page = (pageNumber: number) => renderToStaticMarkup(<PageColumnRules metrics={metrics} pageNumber={pageNumber} />);
    expect(page(1)).toContain("--column-rule-style:dotted");
    expect(page(1).match(/<span/g)).toHaveLength(2);
    expect(page(2)).toContain("--column-rule-style:double");
    expect(page(3)).toBe("");
    expect(page(4)).toContain("--column-rule-style:double");
  });
});
