import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import {
  filterFontFamilyGroups,
  FONT_FAMILY_GROUPS,
  FONT_FAMILY_OPTION_VALUES,
  SHORTCUT_FONT_FAMILIES,
} from "./constants";

describe("font family group headings", () => {
  it("keeps the searchable label in step with the chrome dictionary", () => {
    // 表示は `format.font.group.<id>` が持ち、`label` は検索の既定表記として残っている。
    // 二重に持っている以上ずれうるので、日本語側は必ず一致させる。片方だけ直すと
    // 「ツールバーの見出しは変わったのに検索が別名で当たる」という無音の腐敗になる。
    const t = createTranslator("ja", "chrome");
    expect(FONT_FAMILY_GROUPS.map((group) => [group.id, group.label]))
      .toEqual(FONT_FAMILY_GROUPS.map((group) => [group.id, t(`format.font.group.${group.id}`)]));
  });

  it("has an English heading for every group", () => {
    const t = createTranslator("en", "chrome");
    expect(FONT_FAMILY_GROUPS.map((group) => t(`format.font.group.${group.id}`)))
      .toEqual(["Basic", "Windows Japanese", "Mac Japanese", "Mac Latin", "Monospace"]);
  });
});

describe("font family catalog", () => {
  it("uses actual font names instead of standard gothic and mincho aliases", () => {
    const basicLabels = FONT_FAMILY_GROUPS
      .find((group) => group.label === "基本")
      ?.options.map((option) => option.label);

    expect(basicLabels).toEqual(expect.arrayContaining(["M PLUS 1p", "Noto Serif JP"]));
    expect(basicLabels).not.toEqual(expect.arrayContaining(["標準ゴシック", "標準明朝"]));
    for (const group of FONT_FAMILY_GROUPS) {
      expect(new Set(group.options.map((option) => option.value)).size).toBe(group.options.length);
    }
  });

  it("offers Windows Japanese teaching fonts with explicit fallbacks", () => {
    const windows = FONT_FAMILY_GROUPS.find((group) => group.label === "Windows 日本語");

    expect(windows?.options.map((option) => option.label)).toEqual(expect.arrayContaining([
      "メイリオ",
      "BIZ UDPゴシック",
      "BIZ UDP明朝",
      "UD デジタル 教科書体",
    ]));
    for (const option of FONT_FAMILY_GROUPS.flatMap((group) => group.options)) {
      expect(option.value).toMatch(/(?:sans-serif|serif|monospace|cursive)$/);
    }
  });

  it("filters the expanded catalog by its visible labels without duplicate candidates", () => {
    const windows = FONT_FAMILY_GROUPS.find((group) => group.label === "Windows 日本語");
    const labels = FONT_FAMILY_GROUPS.flatMap((group) => group.options.map((option) => option.label));
    expect(labels.filter((label) => label === "游明朝")).toHaveLength(1);
    expect(filterFontFamilyGroups("教科書").flatMap((group) => group.options.map((option) => option.label)))
      .toEqual(["UD デジタル 教科書体"]);
    expect(filterFontFamilyGroups("BIZ").flatMap((group) => group.options.map((option) => option.label)))
      .toEqual(["BIZ UDPゴシック", "BIZ UDP明朝"]);
    expect(filterFontFamilyGroups("Windows 日本語")).toEqual([
      expect.objectContaining({ label: "Windows 日本語", options: windows?.options }),
    ]);
  });

  it("keeps current font shortcuts aligned with selectable catalog values", () => {
    for (const value of Object.values(SHORTCUT_FONT_FAMILIES).filter(Boolean)) {
      expect(FONT_FAMILY_OPTION_VALUES.has(value)).toBe(true);
    }
  });
});
