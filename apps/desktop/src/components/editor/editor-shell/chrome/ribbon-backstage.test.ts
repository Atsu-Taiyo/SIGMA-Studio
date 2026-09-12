import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import {
  BACKSTAGE_SECTIONS,
  DEFAULT_BACKSTAGE_STATE,
  closeBackstage,
  openBackstage,
  resolveBackstageStateForLayout,
  ribbonBackstagePanelId,
  selectBackstageSection,
  toggleBackstage,
} from "./ribbon-backstage";

describe("BACKSTAGE_SECTIONS", () => {
  it("Word の Backstage と同じ並びの7セクションを持つ", () => {
    expect(BACKSTAGE_SECTIONS).toEqual([
      "home",
      "new",
      "open",
      "info",
      "export",
      "options",
      "help",
    ]);
  });

  it("同じセクションを二重に持たない（左ナビが重複しない）", () => {
    expect(new Set(BACKSTAGE_SECTIONS).size).toBe(BACKSTAGE_SECTIONS.length);
  });

  it("全セクションに日本語ラベルがある", () => {
    // ラベルは chrome namespace が持つ。ここでは「並び順どおりに全部引ける」ことを固定する。
    const t = createTranslator("ja", "chrome");
    expect(BACKSTAGE_SECTIONS.map((section) => t(`backstage.sections.${section}`))).toEqual([
      "ホーム",
      "新規",
      "開く",
      "情報",
      "エクスポート",
      "オプション",
      "ヘルプ",
    ]);
  });

  it("全セクションに英語ラベルがある", () => {
    const t = createTranslator("en", "chrome");
    expect(BACKSTAGE_SECTIONS.map((section) => t(`backstage.sections.${section}`))).toEqual([
      "Home",
      "New",
      "Open",
      "Info",
      "Export",
      "Options",
      "Help",
    ]);
  });
});

describe("toggleBackstage", () => {
  it("既定は閉じていて、ホームセクションから開く", () => {
    expect(DEFAULT_BACKSTAGE_STATE).toEqual({ open: false, section: "home" });
    expect(toggleBackstage(DEFAULT_BACKSTAGE_STATE)).toEqual({ open: true, section: "home" });
  });

  it("開いている状態でもう一度押すと閉じ、次回はホームから開き直す", () => {
    const opened = toggleBackstage(DEFAULT_BACKSTAGE_STATE);
    const onOptions = selectBackstageSection(opened, "options");
    const closed = toggleBackstage(onOptions);
    expect(closed).toEqual({ open: false, section: "home" });
    expect(toggleBackstage(closed)).toEqual({ open: true, section: "home" });
  });
});

describe("openBackstage", () => {
  it("閉じているときはホームセクションで開く", () => {
    expect(openBackstage(DEFAULT_BACKSTAGE_STATE)).toEqual({ open: true, section: "home" });
  });

  it("すでに開いていてもホームへ戻して開き直す", () => {
    const onOptions = selectBackstageSection(openBackstage(DEFAULT_BACKSTAGE_STATE), "options");
    expect(openBackstage(onOptions)).toEqual({ open: true, section: "home" });
  });
});

describe("selectBackstageSection", () => {
  it("開いたままセクションだけ変える", () => {
    const opened = toggleBackstage(DEFAULT_BACKSTAGE_STATE);
    expect(selectBackstageSection(opened, "export")).toEqual({ open: true, section: "export" });
  });

  it("閉じているときは開かない（セクション選択は開閉を兼ねない）", () => {
    expect(selectBackstageSection(DEFAULT_BACKSTAGE_STATE, "options")).toEqual({
      open: false,
      section: "options",
    });
  });
});

describe("closeBackstage", () => {
  it("開いていれば閉じてホームへ戻す", () => {
    const onHelp = selectBackstageSection(toggleBackstage(DEFAULT_BACKSTAGE_STATE), "help");
    expect(closeBackstage(onHelp)).toEqual({ open: false, section: "home" });
  });
});

describe("resolveBackstageStateForLayout", () => {
  it("Word風のままなら状態を触らない", () => {
    const opened = toggleBackstage(DEFAULT_BACKSTAGE_STATE);
    expect(resolveBackstageStateForLayout(opened, "word")).toBe(opened);
  });

  it("Googleドキュメント風へ移ったら必ず閉じる", () => {
    const opened = selectBackstageSection(toggleBackstage(DEFAULT_BACKSTAGE_STATE), "options");
    expect(resolveBackstageStateForLayout(opened, "docs")).toEqual({
      open: false,
      section: "home",
    });
  });
});

describe("resolveBackstageStateForLayout の未知のモード", () => {
  // 保存済み設定に無い値が来ても Word風以外は必ず閉じる（既定へ倒す）。
  it.each(["", "docs", "unknown-layout"])("%s は Word風ではないので閉じる", (mode) => {
    const opened = openBackstage(DEFAULT_BACKSTAGE_STATE);
    expect(resolveBackstageStateForLayout(opened, mode)).toEqual({ open: false, section: "home" });
  });
});

describe("参照同一性", () => {
  // EditorShell は毎キーストローク再レンダーされる。変化が無いのに新しい
  // オブジェクトを返すと useState の bail-out が効かず、アイドル時の再レンダー
  // ループの種になる（ribbon-tabs.ts の keepIfUnchanged と同じ理由）。
  it("変化が無いときは同じオブジェクトを返す", () => {
    expect(closeBackstage(DEFAULT_BACKSTAGE_STATE)).toBe(DEFAULT_BACKSTAGE_STATE);
    expect(selectBackstageSection(DEFAULT_BACKSTAGE_STATE, "home")).toBe(DEFAULT_BACKSTAGE_STATE);
    expect(resolveBackstageStateForLayout(DEFAULT_BACKSTAGE_STATE, "docs")).toBe(
      DEFAULT_BACKSTAGE_STATE,
    );
    const opened = toggleBackstage(DEFAULT_BACKSTAGE_STATE);
    expect(selectBackstageSection(opened, "home")).toBe(opened);
    expect(resolveBackstageStateForLayout(opened, "word")).toBe(opened);
  });
});

describe("ribbonBackstagePanelId", () => {
  // SDK は1ページに EditorShell を2つ埋め込みうるので、id は useId 由来の接頭辞から作る。
  // EditorShell 側のフォーカス移動が getElementById で同じ id を引くため、
  // 組み立て方をこの1箇所に固定する。
  it("接頭辞から一意なパネルidを作る", () => {
    expect(ribbonBackstagePanelId(":r7:")).toBe(":r7:ribbon-backstage");
    expect(ribbonBackstagePanelId(":r7:")).not.toBe(ribbonBackstagePanelId(":r8:"));
  });
});
