import { describe, expect, it } from "vitest";

import {
  CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE,
  closeGraphItemActionsMenu,
  openGraphItemActionsMenuByHover,
  toggleGraphItemActionsMenuByClick,
} from "./graph-item-actions-menu-state";

describe("graph item actions menu state", () => {
  it("opens on hover", () => {
    expect(openGraphItemActionsMenuByHover(CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE)).toEqual({
      open: true,
      openedBy: "hover",
    });
  });

  it("keeps a hover-opened menu open when the pointer then clicks the trigger", () => {
    // マウスを乗せて押す = mouseenter (開く) → click。ここで toggle すると開いた直後に
    // 閉じ、2 回目のクリックでしか開かない。
    const hovered = openGraphItemActionsMenuByHover(CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE);

    expect(toggleGraphItemActionsMenuByClick(hovered)).toEqual({ open: true, openedBy: "click" });
  });

  it("closes on the second click once the menu is click-owned", () => {
    const clicked = toggleGraphItemActionsMenuByClick(
      openGraphItemActionsMenuByHover(CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE),
    );

    expect(toggleGraphItemActionsMenuByClick(clicked)).toEqual(CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE);
  });

  it("opens on click alone for keyboard and touch, where no hover happens", () => {
    expect(toggleGraphItemActionsMenuByClick(CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE)).toEqual({
      open: true,
      openedBy: "click",
    });
  });

  it("does not downgrade a click-owned menu back to hover", () => {
    const clicked = toggleGraphItemActionsMenuByClick(CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE);

    expect(openGraphItemActionsMenuByHover(clicked)).toEqual({ open: true, openedBy: "click" });
  });

  it("forgets how it was opened when it closes", () => {
    expect(closeGraphItemActionsMenu()).toEqual(CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE);
    expect(CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE).toEqual({ open: false, openedBy: null });
  });
});
