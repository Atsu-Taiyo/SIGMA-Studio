import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { normalizePageLayout } from "@/lib/page-layout";
import { createTranslator } from "@/lib/i18n";

import { RunningRegionOptions } from "./running-region-options";

const NOOP = () => {};

function render(kind: "header" | "footer", layoutPatch: Parameters<typeof normalizePageLayout>[0]) {
  const layout = normalizePageLayout(layoutPatch);
  const region = layout[kind]!;
  return renderToStaticMarkup(
    <RunningRegionOptions
      kind={kind}
      label={kind === "header" ? "ヘッダー" : "フッター"}
      region={region}
      bandRef={{ current: null }}
      pageNumber={2}
      totalPages={4}
      title="小テスト"
      editing={false}
      shownOnPage
      ownContent={false}
      onShownOnPageChange={NOOP}
      onPageRangeChange={NOOP}
      onOwnContentChange={NOOP}
      onClearOwnContents={NOOP}
    />,
  );
}

describe("RunningRegionOptions", () => {
  it("renders only the round button until it is pressed, named after the band", () => {
    const html = render("header", { header: { enabled: true } });

    expect(html).toContain("page-running-options-toggle");
    expect(html).toContain('aria-label="ヘッダーの設定"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("page-running-options-card");
    // 「ヘッダー編集中」のような名札は出さない。
    expect(html).not.toContain("編集中");
  });

  it("uses a footer-specific icon and class for the footer", () => {
    const html = render("footer", { footer: { enabled: true } });

    expect(html).toContain("page-running-options footer");
    expect(html).toContain('aria-label="フッターの設定"');
    expect(html).toContain("lucide-panel-bottom");
  });

  it("has English wording for every string the card shows", () => {
    const t = createTranslator("en", "editor");

    expect(t("running.options", { replace: { region: "Header" } })).toBe("Header options");
    expect(t("running.insertCaption")).toBe("Insert page number and more");
    expect(t("running.insert.page")).toBe("Page number");
    expect(t("running.insert.total")).toBe("Total pages");
    expect(t("running.insert.pageOfTotal")).toBe("Page number / total pages");
    expect(t("running.insert.title")).toBe("Title");
    expect(t("running.showOnPage", { replace: { region: "Header" } })).toBe("Show Header on this page");
    expect(t("running.showOnPageAria", { replace: { region: "Footer", page: 3 } })).toBe("Show Footer on page 3");
    expect(t("running.hiddenPages", { replace: { pages: "1, 3" } })).toBe("Hidden on pages: 1, 3");
    expect(t("running.shownPages", { replace: { pages: "1, 4" } })).toBe("Shown on pages: 1, 4");
    expect(t("running.noPages")).toBe("Not shown on any page");
    expect(t("running.range.caption")).toBe("Pages to show on");
    expect(t("running.range.all")).toBe("All");
    expect(t("running.range.firstOnly")).toBe("First page only");
    expect(t("running.range.exceptFirst")).toBe("All but the first");
    expect(t("running.content.caption")).toBe("Content");
    expect(t("running.content.own")).toBe("Change the content for this page only");
    expect(t("running.content.ownAria", { replace: { region: "Header", page: 2 } })).toBe("Change the Header content for page 2 only");
    expect(t("running.content.hint")).toBe("Only the text changes per page. Shapes and images stay shared.");
    expect(t("running.content.pages", { replace: { pages: "2, 4" } })).toBe("Pages with their own content: 2, 4");
    expect(t("running.content.reset")).toBe("Make all pages share one");
  });

  it("joins the hidden pages the way the Japanese UI reads them", () => {
    const t = createTranslator("ja", "editor");

    expect(t("running.hiddenPages", { replace: { pages: ["1", "3"].join(t("running.pageSeparator")) } }))
      .toBe("表示していないページ: 1・3");
    expect(["all", "firstOnly", "exceptFirst"].map((range) => t(`running.range.${range as "all"}`)))
      .toEqual(["すべて", "先頭ページのみ", "先頭ページ以外"]);
    expect(t("running.content.own")).toBe("このページだけ内容を変える");
    expect(t("running.showOnPage", { replace: { region: "ヘッダー" } })).toBe("このページにヘッダーを表示");
  });
});
