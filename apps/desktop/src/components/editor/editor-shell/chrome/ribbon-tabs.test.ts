import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import {
  DEFAULT_RIBBON_TAB_STATE,
  getVisibleRibbonTabs,
  DEFAULT_RIBBON_COLLAPSE_STATE,
  closeRibbonOverlay,
  resolveRibbonTabState,
  resolveTabClickWhileCollapsed,
  ribbonTabElementId,
  selectRibbonTab,
  toggleRibbonCollapse,
} from "./ribbon-tabs";

describe("ribbon tab labels", () => {
  // ラベルは chrome namespace が持つ (`ribbon.tabs.<id>`)。Word風リボンはいまアプリから
  // 到達できない (EditorShell が表示を docs へ倒している) ので、両ロケールの文言が
  // 揃っていることは e2e ではなくここで固定する。
  it("コンテキストタブを含む全タブに日本語ラベルがある", () => {
    const t = createTranslator("ja", "chrome");
    expect(getVisibleRibbonTabs(true).map((tab) => t(`ribbon.tabs.${tab}`))).toEqual([
      "ファイル",
      "ホーム",
      "挿入",
      "レイアウト",
      "表示",
      "図形の書式",
    ]);
  });

  it("コンテキストタブを含む全タブに英語ラベルがある", () => {
    const t = createTranslator("en", "chrome");
    expect(getVisibleRibbonTabs(true).map((tab) => t(`ribbon.tabs.${tab}`))).toEqual([
      "File",
      "Home",
      "Insert",
      "Layout",
      "View",
      "Shape Format",
    ]);
  });
});

describe("getVisibleRibbonTabs", () => {
  it("既定ではコンテキストタブを含まない5タブを返す", () => {
    expect(DEFAULT_RIBBON_TAB_STATE).toEqual({ active: "home", lastExplicit: "home" });
    expect(getVisibleRibbonTabs(false)).toEqual(["file", "home", "insert", "layout", "view"]);
  });

  it("コンテキストが可視のとき図形の書式が末尾に加わる", () => {
    expect(getVisibleRibbonTabs(true)).toEqual([
      "file",
      "home",
      "insert",
      "layout",
      "view",
      "shapeFormat",
    ]);
  });
});

describe("resolveRibbonTabState", () => {
  it("コンテキストタブが現れた瞬間はそこへ切り替わり、明示選択の記憶は変えない", () => {
    expect(
      resolveRibbonTabState(DEFAULT_RIBBON_TAB_STATE, {
        contextualVisible: true,
        contextualJustAppeared: true,
      }),
    ).toEqual({ active: "shapeFormat", lastExplicit: "home" });
  });

  it("図形選択中にユーザーが別タブを選んだら奪い返さない", () => {
    const afterAutoSwitch = resolveRibbonTabState(DEFAULT_RIBBON_TAB_STATE, {
      contextualVisible: true,
      contextualJustAppeared: true,
    });
    const afterUserPick = selectRibbonTab(afterAutoSwitch, "insert");
    expect(afterUserPick).toEqual({ active: "insert", lastExplicit: "insert" });

    // 選択が続いている間の再評価 (justAppeared でない) では動かない。
    expect(
      resolveRibbonTabState(afterUserPick, {
        contextualVisible: true,
        contextualJustAppeared: false,
      }),
    ).toBe(afterUserPick);
  });

  it("選択解除では直前に明示選択したタブへ戻る", () => {
    const afterUserPick = selectRibbonTab(
      { active: "shapeFormat", lastExplicit: "home" },
      "insert",
    );
    expect(
      resolveRibbonTabState(afterUserPick, {
        contextualVisible: false,
        contextualJustAppeared: false,
      }),
    ).toEqual({ active: "insert", lastExplicit: "insert" });
  });

  it("明示選択がなければ選択解除でホームに戻る", () => {
    expect(
      resolveRibbonTabState(
        { active: "shapeFormat", lastExplicit: "home" },
        { contextualVisible: false, contextualJustAppeared: false },
      ),
    ).toEqual({ active: "home", lastExplicit: "home" });
  });

  it("不可視になったコンテキストタブがactiveのまま残らない", () => {
    const next = resolveRibbonTabState(
      { active: "shapeFormat", lastExplicit: "layout" },
      { contextualVisible: false, contextualJustAppeared: false },
    );
    expect(getVisibleRibbonTabs(false)).toContain(next.active);
    expect(next.active).toBe("layout");
  });

  it("変化がないときは同じオブジェクトを返す", () => {
    // setState のバイパスに効かせるための参照同一性。毎回新しいオブジェクトを返すと
    // 「アイドルなのに再レンダーし続ける」ループの種になる。
    const state = { active: "home", lastExplicit: "home" } as const;
    expect(
      resolveRibbonTabState(state, { contextualVisible: false, contextualJustAppeared: false }),
    ).toBe(state);
    expect(
      resolveRibbonTabState(state, { contextualVisible: true, contextualJustAppeared: false }),
    ).toBe(state);
    expect(selectRibbonTab(state, "home")).toBe(state);
  });
});

describe("ribbonTabElementId", () => {
  // ファイルタブの id は Backstage の aria-labelledby と EditorShell のフォーカス復帰
  // (getElementById) の両方が引くので、組み立て方をこの1箇所に固定する。
  it("接頭辞とタブidから一意な要素idを作る", () => {
    expect(ribbonTabElementId(":r7:", "file")).toBe(":r7:ribbon-tab-file");
    expect(ribbonTabElementId(":r7:", "home")).not.toBe(ribbonTabElementId(":r7:", "file"));
    expect(ribbonTabElementId(":r8:", "file")).not.toBe(ribbonTabElementId(":r7:", "file"));
  });
});

describe("リボンの折りたたみ", () => {
  it("既定は展開・オーバーレイなし", () => {
    expect(DEFAULT_RIBBON_COLLAPSE_STATE).toEqual({ collapsed: false, overlayOpen: false });
  });

  it("トグルは collapsed を反転し、オーバーレイは必ず閉じる", () => {
    const collapsed = toggleRibbonCollapse(DEFAULT_RIBBON_COLLAPSE_STATE);
    expect(collapsed).toEqual({ collapsed: true, overlayOpen: false });

    // 折りたたみ中にタブを押してオーバーレイを出した状態から展開すると、
    // 浮いた本体が残らずに畳まれる。
    const withOverlay = resolveTabClickWhileCollapsed(collapsed, { sameTab: false });
    expect(withOverlay.overlayOpen).toBe(true);
    expect(toggleRibbonCollapse(withOverlay)).toEqual({ collapsed: false, overlayOpen: false });
  });

  it("折りたたみ中のタブクリックはオーバーレイを開く", () => {
    const collapsed = toggleRibbonCollapse(DEFAULT_RIBBON_COLLAPSE_STATE);
    expect(resolveTabClickWhileCollapsed(collapsed, { sameTab: false })).toEqual({
      collapsed: true,
      overlayOpen: true,
    });
  });

  it("オーバーレイ表示中に同じタブをもう一度押すと閉じる（トグル）", () => {
    const open = resolveTabClickWhileCollapsed(
      toggleRibbonCollapse(DEFAULT_RIBBON_COLLAPSE_STATE),
      { sameTab: false },
    );
    expect(resolveTabClickWhileCollapsed(open, { sameTab: true })).toEqual({
      collapsed: true,
      overlayOpen: false,
    });
  });

  it("オーバーレイ表示中に別のタブを押しても開いたまま（中身だけ入れ替わる）", () => {
    const open = resolveTabClickWhileCollapsed(
      toggleRibbonCollapse(DEFAULT_RIBBON_COLLAPSE_STATE),
      { sameTab: false },
    );
    expect(resolveTabClickWhileCollapsed(open, { sameTab: false })).toBe(open);
  });

  it("展開中のタブクリックはオーバーレイを開かない", () => {
    expect(resolveTabClickWhileCollapsed(DEFAULT_RIBBON_COLLAPSE_STATE, { sameTab: false }))
      .toBe(DEFAULT_RIBBON_COLLAPSE_STATE);
  });

  it("closeRibbonOverlay は collapsed を保ったままオーバーレイだけ閉じる", () => {
    const open = resolveTabClickWhileCollapsed(
      toggleRibbonCollapse(DEFAULT_RIBBON_COLLAPSE_STATE),
      { sameTab: false },
    );
    expect(closeRibbonOverlay(open)).toEqual({ collapsed: true, overlayOpen: false });
  });

  it("変化がないときは同じオブジェクトを返す", () => {
    // EditorShell は毎キーストローク再レンダーされるので、参照同一性で
    // useState の bail-out を効かせる（ribbon-tabs.ts の他の遷移と同じ理由）。
    expect(closeRibbonOverlay(DEFAULT_RIBBON_COLLAPSE_STATE)).toBe(DEFAULT_RIBBON_COLLAPSE_STATE);
    const collapsed = toggleRibbonCollapse(DEFAULT_RIBBON_COLLAPSE_STATE);
    expect(closeRibbonOverlay(collapsed)).toBe(collapsed);
  });
});
