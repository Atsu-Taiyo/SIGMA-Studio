// Word風リボンのタブ状態。クローム唯一の複雑なロジックなので、React から切り離した
// 純関数として持ち、ユニットテストで固定する。

export type RibbonTabId = "file" | "home" | "insert" | "layout" | "view" | "shapeFormat";

/**
 * リボン本体を持つタブ。「ファイル」は Backstage（全画面）を開くだけで
 * タブパネルを持たないため、選択状態としては扱わない（ribbon-backstage.ts）。
 * これにより「Backstage を閉じたら直前に自分で選んだタブへ戻る」が構造的に成立する。
 */
export type RibbonPanelTabId = Exclude<RibbonTabId, "file">;

/** タブの並びは Word 365 日本語版に合わせる（ファイル → ホーム → 挿入 → レイアウト → 表示）。 */
const BASE_RIBBON_TABS: readonly RibbonTabId[] = ["file", "home", "insert", "layout", "view"];

const RIBBON_TABS_WITH_CONTEXTUAL: readonly RibbonTabId[] = [...BASE_RIBBON_TABS, "shapeFormat"];

// 表示ラベルはここには置かない。`chrome` namespace の `ribbon.tabs.<id>` が持ち、
// このモジュールは純粋なタブ状態ロジックのままにする。

export interface RibbonTabState {
  /** いま開いているタブ。 */
  active: RibbonPanelTabId;
  /**
   * ユーザーが最後に自分で選んだタブ。コンテキストタブが消えたときの戻り先で、
   * 自動切替（図形選択）では書き換えない。
   */
  lastExplicit: RibbonPanelTabId;
}

export const DEFAULT_RIBBON_TAB_STATE: RibbonTabState = { active: "home", lastExplicit: "home" };

export function getVisibleRibbonTabs(contextualVisible: boolean): readonly RibbonTabId[] {
  return contextualVisible ? RIBBON_TABS_WITH_CONTEXTUAL : BASE_RIBBON_TABS;
}

/**
 * タブボタンの DOM id。Backstage の aria-labelledby と、Backstage を閉じたときの
 * フォーカス復帰（getElementById）が同じ id を引くので、組み立て方はここだけに置く。
 */
export function ribbonTabElementId(prefix: string, tab: RibbonTabId): string {
  return `${prefix}ribbon-tab-${tab}`;
}

function keepIfUnchanged(current: RibbonTabState, next: RibbonTabState): RibbonTabState {
  // 参照が毎回変わると useState の bail-out が効かず、何も起きていないのに再レンダーが
  // 続く。変化がないときは必ず元のオブジェクトを返す。
  return current.active === next.active && current.lastExplicit === next.lastExplicit
    ? current
    : next;
}

/**
 * コンテキストタブ（図形の書式）の出現・消滅に対するタブ状態の遷移。
 *
 * - 現れた瞬間はそこへ自動で切り替わる（Word 365 は単クリックでも切り替わる）
 * - 表示中にユーザーが別タブへ移ったら、そのまま留まる（勝手に奪い返さない）
 * - 消えたら直前にユーザーが明示選択したタブへ戻る（既定はホーム）
 */
export function resolveRibbonTabState(
  current: RibbonTabState,
  input: { contextualVisible: boolean; contextualJustAppeared: boolean },
): RibbonTabState {
  if (input.contextualVisible) {
    return input.contextualJustAppeared
      ? keepIfUnchanged(current, { active: "shapeFormat", lastExplicit: current.lastExplicit })
      : current;
  }
  // 不可視のタブが active のまま残らないようにする。
  return current.active === "shapeFormat"
    ? keepIfUnchanged(current, { active: current.lastExplicit, lastExplicit: current.lastExplicit })
    : current;
}

/** ユーザーがタブを押したときの遷移。コンテキストタブの選択は戻り先を書き換えない。 */
export function selectRibbonTab(current: RibbonTabState, tab: RibbonPanelTabId): RibbonTabState {
  return keepIfUnchanged(current, {
    active: tab,
    lastExplicit: tab === "shapeFormat" ? current.lastExplicit : tab,
  });
}

/**
 * リボン本体の折りたたみ。
 *
 * - `collapsed` はユーザーの持続的な選択（ui-layout-preference.ts に永続する）
 * - `overlayOpen` は「折りたたみ中にタブを押して本体を一時的に浮かせている」だけの
 *   一時状態。永続しないし、展開したら必ず落とす
 *
 * クローム高さトークンは overlayOpen では変えない（浮かせるだけ = 本文が動かない）。
 */
export interface RibbonCollapseState {
  collapsed: boolean;
  overlayOpen: boolean;
}

export const DEFAULT_RIBBON_COLLAPSE_STATE: RibbonCollapseState = {
  collapsed: false,
  overlayOpen: false,
};

function keepCollapseIfUnchanged(
  current: RibbonCollapseState,
  next: RibbonCollapseState,
): RibbonCollapseState {
  return current.collapsed === next.collapsed && current.overlayOpen === next.overlayOpen
    ? current
    : next;
}

/** `∧` / `∨` / Ctrl+F1 / タブのダブルクリック。浮いている本体は必ず畳む。 */
export function toggleRibbonCollapse(current: RibbonCollapseState): RibbonCollapseState {
  return keepCollapseIfUnchanged(current, { collapsed: !current.collapsed, overlayOpen: false });
}

/** 外側クリック / Escape / タブ切替以外の操作で、浮いた本体だけを閉じる。 */
export function closeRibbonOverlay(current: RibbonCollapseState): RibbonCollapseState {
  return keepCollapseIfUnchanged(current, { collapsed: current.collapsed, overlayOpen: false });
}

/**
 * タブを押したときの遷移。
 *
 * 展開中は何も起きない（本体は常に見えている）。折りたたみ中は本体を浮かせ、
 * すでに浮いている状態で **同じタブ** を押したら閉じる（Word と同じトグル）。
 * 別のタブなら開いたまま中身だけ入れ替わる。
 */
export function resolveTabClickWhileCollapsed(
  current: RibbonCollapseState,
  input: { sameTab: boolean },
): RibbonCollapseState {
  if (!current.collapsed) {
    return current;
  }
  const overlayOpen = current.overlayOpen ? !input.sameTab : true;
  return keepCollapseIfUnchanged(current, { collapsed: true, overlayOpen });
}
