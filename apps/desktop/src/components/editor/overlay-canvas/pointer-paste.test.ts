import { describe, expect, it } from "vitest";

import {
  clampPasteCenterToNearestPage,
  clientPointToCanvasPoint,
  countPasteLayoutPages,
  hasPageLayout,
  isPointerPasteSurface,
  resolvePointerPastePlacement,
  type PasteCanvasLayout,
} from "./pointer-paste";

// 3 ページ。ページ k は y = 1040k .. 1040k + 1000、幅は 800。
const LAYOUT: PasteCanvasLayout = {
  canvasWidth: 800,
  canvasHeight: 3 * 1000 + 2 * 40,
  pageHeightPx: 1000,
  pageGapPx: 40,
};
const SMALL = { w: 80, h: 40 };

describe("page layout of the paste surface", () => {
  it("counts the pages from the canvas height", () => {
    expect(countPasteLayoutPages(LAYOUT)).toBe(3);
    expect(countPasteLayoutPages({ ...LAYOUT, canvasHeight: 1000 })).toBe(1);
  });

  it("has no page layout where no page height is given (running region, material editor)", () => {
    expect(hasPageLayout({ ...LAYOUT, pageHeightPx: 0 })).toBe(false);
    expect(hasPageLayout(LAYOUT)).toBe(true);
    expect(countPasteLayoutPages({ ...LAYOUT, pageHeightPx: 0 })).toBe(1);
  });
});

describe("clientPointToCanvasPoint", () => {
  it("maps through the canvas's on-screen rect, so zoom does not matter", () => {
    // 800 x 3080 の面が 0.5 倍で (100, 50) に置かれている。
    const rect = { left: 100, top: 50, width: 400, height: 1540 };

    expect(clientPointToCanvasPoint({ x: 300, y: 820 }, rect, LAYOUT)).toEqual({ x: 400, y: 1540 });
  });

  it("refuses a rect with no size", () => {
    expect(clientPointToCanvasPoint({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 10 }, LAYOUT)).toBeNull();
  });
});

describe("clampPasteCenterToNearestPage", () => {
  it("leaves a centre that already lands on a page alone", () => {
    expect(clampPasteCenterToNearestPage({ x: 400, y: 600 }, SMALL, LAYOUT)).toEqual({ x: 400, y: 600 });
  });

  it("keeps the whole group inside the page horizontally and vertically", () => {
    // 右上の角 (790, 5): 図形の半分 (40, 20) が内側に入るまで寄せる。
    expect(clampPasteCenterToNearestPage({ x: 790, y: 5 }, SMALL, LAYOUT)).toEqual({ x: 760, y: 20 });
    // 左下: 2 ページ目の左下 (-30, 2030)。
    expect(clampPasteCenterToNearestPage({ x: -30, y: 2030 }, SMALL, LAYOUT)).toEqual({ x: 40, y: 1040 + 980 });
  });

  it("sends a point in the grey gap to the nearer page", () => {
    // 1 ページ目の下端は 1000、2 ページ目の上端は 1040。
    expect(clampPasteCenterToNearestPage({ x: 400, y: 1010 }, SMALL, LAYOUT).y).toBe(980);
    expect(clampPasteCenterToNearestPage({ x: 400, y: 1030 }, SMALL, LAYOUT).y).toBe(1040 + 20);
  });

  it("sends a point past the last page, or above the first, to those pages", () => {
    expect(clampPasteCenterToNearestPage({ x: 400, y: 99999 }, SMALL, LAYOUT).y).toBe(2 * 1040 + 1000 - 20);
    expect(clampPasteCenterToNearestPage({ x: 400, y: -500 }, SMALL, LAYOUT).y).toBe(20);
  });

  it("centres on the page along an axis the group is too big for", () => {
    expect(clampPasteCenterToNearestPage({ x: 10, y: 10 }, { w: 900, h: 1200 }, LAYOUT)).toEqual({ x: 400, y: 500 });
  });
});

describe("resolvePointerPastePlacement", () => {
  const rect = { left: 0, top: 0, width: 800, height: 3080 };

  it("returns the canvas point and the layout", () => {
    expect(resolvePointerPastePlacement({ x: 200, y: 300 }, rect, LAYOUT)).toEqual({
      point: { x: 200, y: 300 },
      layout: LAYOUT,
    });
  });

  it("yields nothing when the pointer is unknown, the rect is missing, or the surface has no pages", () => {
    expect(resolvePointerPastePlacement(null, rect, LAYOUT)).toBeNull();
    expect(resolvePointerPastePlacement({ x: 1, y: 1 }, null, LAYOUT)).toBeNull();
    expect(resolvePointerPastePlacement({ x: 1, y: 1 }, rect, { ...LAYOUT, pageHeightPx: 0 })).toBeNull();
  });
});

describe("isPointerPasteSurface", () => {
  type Fake = { matches: string[]; parent?: Fake; closest(selector: string): Fake | null };
  function node(matches: string[], parent?: Fake): Fake {
    const self: Fake = {
      matches,
      parent,
      closest(selector) {
        const wanted = selector.split(",").map((part) => part.trim());
        for (let current: Fake | undefined = self; current; current = current.parent) {
          if (wanted.some((part) => current!.matches.includes(part))) {
            return current;
          }
        }
        return null;
      },
    };
    return self;
  }

  it("accepts anything inside the document's editing area", () => {
    const area = node([".page-mode"]);
    expect(isPointerPasteSurface(node([".overlay-canvas-editor"], area))).toBe(true);
    expect(isPointerPasteSurface(area)).toBe(true);
  });

  it("rejects the menu bar, toolbars, sidebars and dialogs, and an unknown element", () => {
    expect(isPointerPasteSurface(node([".editor-menubar"]))).toBe(false);
    expect(isPointerPasteSurface(node(["[role='dialog']"], node([".app-shell"])))).toBe(false);
    expect(isPointerPasteSurface(null)).toBe(false);
  });

  it("rejects a read-only split pane and the whiteboard", () => {
    const passive = node([".workspace-passive-editor"]);
    expect(isPointerPasteSurface(node([".page-mode"], passive))).toBe(false);
    const whiteboard = node(["[data-whiteboard='true']"]);
    expect(isPointerPasteSurface(node([".page-mode"], whiteboard))).toBe(false);
  });
});
