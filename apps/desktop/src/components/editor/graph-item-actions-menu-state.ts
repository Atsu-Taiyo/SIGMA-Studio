/**
 * グラフ設定パネルの各カードにある `⋯` の開閉。
 *
 * hover でも click でも開くので、素朴な toggle だと「マウスを乗せて押す」が
 * mouseenter (開く) → click (閉じる) になり、2 回目のクリックでしか開かない。
 * 誰が開いたかを覚えておき、click で閉じるのは click で開いた時だけにする。
 */
export type GraphItemActionsMenuOpenSource = "hover" | "click";

export interface GraphItemActionsMenuState {
  open: boolean;
  openedBy: GraphItemActionsMenuOpenSource | null;
}

export const CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE: GraphItemActionsMenuState = {
  open: false,
  openedBy: null,
};

export function openGraphItemActionsMenuByHover(
  state: GraphItemActionsMenuState,
): GraphItemActionsMenuState {
  if (state.open) {
    // 既に開いているなら開いた経緯は変えない (click で開いたものを hover で降格させない)。
    return state;
  }

  return { open: true, openedBy: "hover" };
}

export function toggleGraphItemActionsMenuByClick(
  state: GraphItemActionsMenuState,
): GraphItemActionsMenuState {
  if (state.open && state.openedBy === "click") {
    return CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE;
  }

  // hover で開いた直後のクリックは「閉じる」ではなく「クリックで開いた状態にする」。
  return { open: true, openedBy: "click" };
}

export function closeGraphItemActionsMenu(): GraphItemActionsMenuState {
  return CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE;
}
