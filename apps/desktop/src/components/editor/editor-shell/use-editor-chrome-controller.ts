"use client";

import type { BackstageSectionId } from "@/components/editor/editor-shell/chrome/ribbon-backstage";
import { closeBackstage as closeBackstageState,DEFAULT_BACKSTAGE_STATE,resolveBackstageStateForLayout,ribbonBackstagePanelId,selectBackstageSection as selectBackstageSectionState,toggleBackstage as toggleBackstageState } from "@/components/editor/editor-shell/chrome/ribbon-backstage";
import type { RibbonCollapseState,RibbonPanelTabId } from "@/components/editor/editor-shell/chrome/ribbon-tabs";
import { closeRibbonOverlay,DEFAULT_RIBBON_TAB_STATE,resolveRibbonTabState,resolveTabClickWhileCollapsed,ribbonTabElementId,selectRibbonTab as selectRibbonTabState,toggleRibbonCollapse as toggleRibbonCollapseState } from "@/components/editor/editor-shell/chrome/ribbon-tabs";
import type { ColorStylePanel,EditorMenu } from "@/components/editor/editor-shell/types";
import { useUiLayoutPreference } from "@/lib/ui-layout-preference";
import { useEffect,useId,useRef,useState } from "react";

interface ChromeControllerPorts {
  contextualVisible: boolean;
  uiLayoutPreference: ReturnType<typeof useUiLayoutPreference>[0];
  updateUiLayoutPreference: ReturnType<typeof useUiLayoutPreference>[1];
  closeMaterialMenu: () => void;
  setSearchOpen: (open: boolean) => void;
}
export function useEditorChromeController({ contextualVisible, uiLayoutPreference, updateUiLayoutPreference, closeMaterialMenu, setSearchOpen }: ChromeControllerPorts) {
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [lineToolMenuOpen, setLineToolMenuOpen] = useState(false);
  const [inlineMathMenuOpen, setInlineMathMenuOpen] = useState(false);
  const [fontFamilyMenuOpen, setFontFamilyMenuOpen] = useState(false);
  const [blockStyleMenuOpen, setBlockStyleMenuOpen] = useState(false);
  const [boxedTextMenuOpen, setBoxedTextMenuOpen] = useState(false);
  const [lineHeightMenuOpen, setLineHeightMenuOpen] = useState(false);
  const [textAlignMenuOpen, setTextAlignMenuOpen] = useState(false);
  const [orderedListMenuOpen, setOrderedListMenuOpen] = useState(false);
  const [moreBlocksMenuOpen, setMoreBlocksMenuOpen] = useState(false);
  const [lineDashMenuOpen, setLineDashMenuOpen] = useState(false);
  const [lineWidthMenuOpen, setLineWidthMenuOpen] = useState(false);
  const [colorStylePanel, setColorStylePanel] = useState<ColorStylePanel>(null);
  const [lineEndpointMenu, setLineEndpointMenu] = useState<"start" | "end" | null>(null);
  const [activeMenu, setActiveMenu] = useState<EditorMenu>(null);
  const [newDocMenuOpen, setNewDocMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [ribbonTabState, setRibbonTabState] = useState(DEFAULT_RIBBON_TAB_STATE);
  // ファイルタブ = Backstage（編集画面を覆う全画面）。リボンのタブ状態とは混ぜない
  // ので、閉じれば自動的に「直前に自分で選んだタブ」へ戻る。
  const [ribbonBackstage, setRibbonBackstage] = useState(DEFAULT_BACKSTAGE_STATE);
  // 折りたたみは永続 (ui-layout-preference)、浮かせている状態は一時。
  // 2つを1つの純関数へ渡すために、レンダーのたびに組で作る。
  const [ribbonOverlayOpen, setRibbonOverlayOpen] = useState(false);
  const ribbonContextualWasVisibleRef = useRef(false);
  // SDK は EditorShell を埋め込むので、1ページに2つ載っても id が衝突しないようにする。
  const ribbonIdPrefix = useId();
  const toggleMenu = (menu: NonNullable<EditorMenu>) => {
    setExportMenuOpen(false);
    setShapeMenuOpen(false);
    setLineToolMenuOpen(false);
    setFontFamilyMenuOpen(false);
    setBlockStyleMenuOpen(false);
    setBoxedTextMenuOpen(false);
    setLineHeightMenuOpen(false);
    setTextAlignMenuOpen(false);
    setOrderedListMenuOpen(false);
    setMoreBlocksMenuOpen(false);
    setLineDashMenuOpen(false);
    setLineWidthMenuOpen(false);
    setColorStylePanel(null);
    setLineEndpointMenu(null);
    setActiveMenu((current) => (current === menu ? null : menu));
  };

  // --- Word風リボン ---------------------------------------------------------
  // 状態の所有者は変えない。リボンは EditorShell が持つこの state と既存ハンドラを読むだけ。

  // 図形が「選択されている」ことだけを条件にする。overlayEditing まで含めると、
  // 図形ツールを選んだ瞬間 (まだ図形が無い) にタブを奪われ、しかもそのタブは
  // 全コントロールが disabled (canUseStrokeStyleControls 等はすべて
  // hasOverlaySelection を要求する) という行き止まりになる。選択解除で消えて
  // 直前のタブへ戻る、という仕様ともこちらの条件でしか両立しない。
  const ribbonContextualTabVisible = contextualVisible;

  useEffect(() => {
    const justAppeared = ribbonContextualTabVisible && !ribbonContextualWasVisibleRef.current;
    ribbonContextualWasVisibleRef.current = ribbonContextualTabVisible;
    // resolveRibbonTabState は変化が無ければ同じオブジェクトを返すので、ここで
    // 無駄な再レンダーは起きない（アイドル時のループ防止）。
    setRibbonTabState((current) => resolveRibbonTabState(current, {
      contextualVisible: ribbonContextualTabVisible,
      contextualJustAppeared: justAppeared,
    }));
  }, [ribbonContextualTabVisible]);

  // タブを切り替えるとポップオーバーのアンカーになっているボタンが unmount し、
  // ToolbarPopover は anchorRef.current === null で top:-9999px へ飛んで見えなくなる。
  // 先に全部閉じる。閉じる集合は toggleMenu と揃え、リボンのタブ内にしか
  // アンカーが無いもの（検索置換・数式・新規教材）も含める。Backstage の開閉でも
  // リボン本体ごと unmount するので、同じ集合を閉じる。
  const closeRibbonAnchoredPopovers = () => {
    setExportMenuOpen(false);
    setShapeMenuOpen(false);
    setLineToolMenuOpen(false);
    setFontFamilyMenuOpen(false);
    setBlockStyleMenuOpen(false);
    setBoxedTextMenuOpen(false);
    setLineHeightMenuOpen(false);
    setTextAlignMenuOpen(false);
    setOrderedListMenuOpen(false);
    setMoreBlocksMenuOpen(false);
    setLineDashMenuOpen(false);
    setLineWidthMenuOpen(false);
    setColorStylePanel(null);
    setLineEndpointMenu(null);
    setActiveMenu(null);
    setSearchOpen(false);
    setInlineMathMenuOpen(false);
    setNewDocMenuOpen(false);
  };

  // collapsed は永続 (ui-layout-preference)、overlayOpen は一時。純関数へ渡すために組で作る。
  // docs では折りたたみの概念が無いので必ず展開扱いにする。
  const ribbonCollapsed = uiLayoutPreference.mode === "word" && uiLayoutPreference.ribbonCollapsed;
  // 浮かせた本体は折りたたみ中にしか存在しない。展開したり docs へ移ったりしたら
  // 一時状態を畳む — 残しておくと「docs へ行って word に戻ったら、何も押していないのに
  // 本体が浮いている」になる。effect ではなくレンダー中に補正する (Backstage と同じ形)。
  const resolvedRibbonOverlayOpen = ribbonCollapsed && ribbonOverlayOpen;
  if (resolvedRibbonOverlayOpen !== ribbonOverlayOpen) {
    setRibbonOverlayOpen(resolvedRibbonOverlayOpen);
  }
  const ribbonCollapse: RibbonCollapseState = {
    collapsed: ribbonCollapsed,
    overlayOpen: resolvedRibbonOverlayOpen,
  };

  const selectRibbonTab = (tab: RibbonPanelTabId) => {
    closeRibbonAnchoredPopovers();
    // Backstage を開いたままタブを押したら、そのタブを開いて Backstage を閉じる
    // （Word と同じ）。閉じないとタブ行だけが反応しない行き止まりになる。
    setRibbonBackstage((current) => closeBackstageState(current));
    // 折りたたみ中は本体を «浮かせて» 出す。同じタブをもう一度押したら閉じる。
    // 比較先は «実際に選択として描かれているタブ»。コンテキストタブが消えた直後の
    // 1レンダーだけ state の active は不可視の shapeFormat のままで、クロームは
    // lastExplicit を選択として描いている（editor-chrome.tsx の activeRibbonTab と同じ導出）。
    const renderedActiveTab = ribbonTabState.active === "shapeFormat" && !ribbonContextualTabVisible
      ? ribbonTabState.lastExplicit
      : ribbonTabState.active;
    const nextCollapse = resolveTabClickWhileCollapsed(ribbonCollapse, {
      sameTab: renderedActiveTab === tab,
    });
    setRibbonOverlayOpen(nextCollapse.overlayOpen);
    setRibbonTabState((current) => selectRibbonTabState(current, tab));
  };

  const toggleRibbonCollapse = () => {
    closeRibbonAnchoredPopovers();
    const next = toggleRibbonCollapseState(ribbonCollapse);
    // collapsed だけ永続する。overlayOpen を永続すると、次回起動時に本体が
    // 浮いたまま出てしまう。
    updateUiLayoutPreference({ ribbonCollapsed: next.collapsed });
    setRibbonOverlayOpen(next.overlayOpen);
  };

  const closeRibbonOverlayNow = () => {
    setRibbonOverlayOpen((current) => closeRibbonOverlay({
      collapsed: true,
      overlayOpen: current,
    }).overlayOpen);
  };

  const toggleRibbonBackstage = () => {
    closeRibbonAnchoredPopovers();
    // Backstage は本文もリボンも覆うので、浮かせた本体は畳んでおく。残すと
    // Backstage を閉じた先に、誰も呼んでいない本体が浮いたまま出てくる
    // （キーボードだけで操作すると pointerdown が出ないのでこの経路に入る）。
    setRibbonOverlayOpen(false);
    setRibbonBackstage((current) => toggleBackstageState(current));
  };

  const closeRibbonBackstage = () => {
    setRibbonBackstage((current) => closeBackstageState(current));
  };

  const selectRibbonBackstageSection = (section: BackstageSectionId) => {
    setRibbonBackstage((current) => selectBackstageSectionState(current, section));
  };

  // レイアウトが Word風を離れたら Backstage を畳む。これが無いと docs へ切り替えて
  // 戻ってきた瞬間に全画面が残ったまま出る。
  // effect ではなくレンダー中に補正する（React 公式の「変化に合わせて state を調整する」形）。
  // resolveBackstageStateForLayout は変化が無ければ同じ参照を返すので、通常のレンダーでは
  // 何も起きない。以降は補正後の値だけを読む。
  const ribbonBackstageState = resolveBackstageStateForLayout(ribbonBackstage, uiLayoutPreference.mode);
  if (ribbonBackstageState !== ribbonBackstage) {
    setRibbonBackstage(ribbonBackstageState);
  }

  const ribbonBackstageOpen = ribbonBackstageState.open;

  // Backstage 表示中は本文・図形へキーを届かせない。
  // OverlayCanvasEditorClient の handleOverlayKeyboard は window の bubble リスナーで、
  // 「入力欄かどうか」しか見ない = Backstage のボタンにフォーカスがあると Delete や
  // 矢印キーが図形へ素通りする。window の capture で止めれば bubble まで降りない。
  // preventDefault はしないので Tab によるフォーカス移動は生きる。Escape だけは
  // 通して closeTransientUi に閉じさせる。
  useEffect(() => {
    if (!ribbonBackstageOpen) {
      return;
    }
    const guardBackstageKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        return;
      }
      event.stopPropagation();
    };
    window.addEventListener("keydown", guardBackstageKeys, true);
    return () => window.removeEventListener("keydown", guardBackstageKeys, true);
  }, [ribbonBackstageOpen]);

  // 浮かせたリボン本体は外側クリックで閉じる（ToolbarPopover と同じ形: document の
  // pointerdown + contains 判定）。タブ行の中は「外側」に含めない — タブを押したときの
  // 開閉は resolveTabClickWhileCollapsed が決めるので、ここで先に閉じると打ち消し合う。
  useEffect(() => {
    if (!ribbonOverlayOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      // SDK は1ページに EditorShell を2つ載せうるので、querySelector(".app-shell") で
      // «最初の» シェルを掴まない。自分のタブ行 (useId 由来の id) から辿る。
      const root = window.document
        .getElementById(ribbonTabElementId(ribbonIdPrefix, "file"))
        ?.closest(".app-shell");
      if (!root?.contains(target)) {
        return;
      }
      // 「外側」から外すのはタブそのものだけ。タブ行右端のコメント / AIチャット /
      // 展開ボタンを押したら、その結果が浮いた本体に隠れないよう畳む。
      if (target instanceof Element && target.closest(".ribbon-body, .ribbon-tabs")) {
        return;
      }
      closeRibbonOverlayNow();
    };
    window.document.addEventListener("pointerdown", handlePointerDown);
    return () => window.document.removeEventListener("pointerdown", handlePointerDown);
    // closeRibbonOverlayNow は setter しか呼ばないので、識別子が毎レンダー変わっても
    // 張り替える必要が無い（張り替えると pointerdown を取りこぼす）。
  }, [ribbonOverlayOpen, ribbonIdPrefix]);

  // 開いたら Backstage の先頭要素へ、閉じたらファイルタブへフォーカスを戻す。
  // クロームの JSX は1関数・1 render pass で作る規約なので ref を配れない。
  // id は ribbon-tabs.ts / ribbon-backstage.ts が組み立てを持っている（useId 由来の
  // 接頭辞なので、SDK が1ページに2つ埋め込んでも他方を掴まない）。
  useEffect(() => {
    if (!ribbonBackstageOpen) {
      return;
    }
    const panel = window.document.getElementById(ribbonBackstagePanelId(ribbonIdPrefix));
    panel?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => {
      window.document.getElementById(ribbonTabElementId(ribbonIdPrefix, "file"))?.focus();
    };
  }, [ribbonBackstageOpen, ribbonIdPrefix]);

  useEffect(() => {
    const closeTransientUi = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      setActiveMenu(null);
      setExportMenuOpen(false);
      setShapeMenuOpen(false);
      setLineToolMenuOpen(false);
      setFontFamilyMenuOpen(false);
      setBlockStyleMenuOpen(false);
      setBoxedTextMenuOpen(false);
      setLineHeightMenuOpen(false);
      setTextAlignMenuOpen(false);
      setLineDashMenuOpen(false);
      setLineWidthMenuOpen(false);
      setLineEndpointMenu(null);
      setColorStylePanel(null);
      setSearchOpen(false);
      closeMaterialMenu();
      // Word風の Backstage も Esc で閉じる（capture ガードは Escape だけ通す）。
      setRibbonBackstage((current) => closeBackstageState(current));
      // 折りたたみ中に浮かせているリボン本体も畳む（折りたたみ自体は解除しない）。
      setRibbonOverlayOpen(false);
    };

    window.addEventListener("keydown", closeTransientUi);
    return () => window.removeEventListener("keydown", closeTransientUi);
  }, [closeMaterialMenu, setSearchOpen]);

  return { shapeMenuOpen, setShapeMenuOpen, lineToolMenuOpen, setLineToolMenuOpen, inlineMathMenuOpen, setInlineMathMenuOpen, fontFamilyMenuOpen, setFontFamilyMenuOpen, blockStyleMenuOpen, setBlockStyleMenuOpen, boxedTextMenuOpen, setBoxedTextMenuOpen, lineHeightMenuOpen, setLineHeightMenuOpen, textAlignMenuOpen, setTextAlignMenuOpen, orderedListMenuOpen, setOrderedListMenuOpen, moreBlocksMenuOpen, setMoreBlocksMenuOpen, lineDashMenuOpen, setLineDashMenuOpen, lineWidthMenuOpen, setLineWidthMenuOpen, colorStylePanel, setColorStylePanel, lineEndpointMenu, setLineEndpointMenu, activeMenu, setActiveMenu, newDocMenuOpen, setNewDocMenuOpen, exportMenuOpen, setExportMenuOpen, ribbonTabState, ribbonBackstageState, ribbonBackstageOpen, ribbonCollapse, ribbonContextualTabVisible, ribbonIdPrefix, setRibbonBackstage, setRibbonOverlayOpen, selectRibbonTab, toggleRibbonCollapse, toggleRibbonBackstage, closeRibbonBackstage, selectRibbonBackstageSection, toggleMenu };
}
