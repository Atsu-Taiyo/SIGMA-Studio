import { describe, expect, it } from "vitest";

import {
  blockHitProbeColumnLeftPx,
  isContainerTopBand,
  isPointWithinColumnLaneAffordance,
  resolveBlockAffordanceHover,
  resolveBlockAffordancePointerOwner,
  resolveStationaryBlockAffordanceRefresh,
  resolveBlockInsertButtonLane,
  resolveBlockSelectionRange,
  resolveColumnLaneWidthPx,
  resolveInnerBlockAt,
  resolveInnerLaneProbe,
  sameBlockAffordanceHover,
  type BlockSpaceAfterTarget,
  type HoveredTopLevelBlock,
} from "./block-affordances";

/** A problem opening the document, with a paragraph after it. */
const problem: HoveredTopLevelBlock = {
  box: { id: "problem", top: 48, bottom: 200, left: 100, right: 500 },
  nextBlockId: "outro",
  isAtomic: true,
  aboveKind: "none",
  belowKind: "body",
};
/** The paragraph after that problem, and the last block in the document. */
const lastParagraph: HoveredTopLevelBlock = {
  box: { id: "outro", top: 208, bottom: 240, left: 100, right: 500 },
  nextBlockId: null,
  isAtomic: false,
  aboveKind: "atomic",
  belowKind: "none",
};
/** A paragraph between two other paragraphs. */
const middleParagraph: HoveredTopLevelBlock = {
  box: { id: "middle", top: 300, bottom: 340, left: 100, right: 500 },
  nextBlockId: "tail",
  isAtomic: false,
  aboveKind: "body",
  belowKind: "body",
};

describe("resolveBlockAffordanceHover", () => {
  it("keeps an existing gutter affordance when it overlaps a column divider", () => {
    expect(resolveBlockAffordancePointerOwner({
      dragging: false,
      targetIsAffordance: true,
      hitsColumnDivider: true,
    })).toBe("frozen");
  });

  it("gives the column gap to its divider unless the right lane's shown row is being approached", () => {
    const base = { dragging: false, targetIsAffordance: false, hitsColumnDivider: true };
    expect(resolveBlockAffordancePointerOwner(base)).toBe("divider");
    expect(resolveBlockAffordancePointerOwner({ ...base, keepsColumnLaneAffordance: true })).toBe("frozen");
    expect(resolveBlockAffordancePointerOwner({ ...base, hitsColumnDivider: false, keepsColumnLaneAffordance: true }))
      .toBe("content");
  });

  it("shows no gutter control while a column divider is being dragged over the text", () => {
    expect(resolveBlockAffordancePointerOwner({
      dragging: false,
      resizingColumns: true,
      targetIsAffordance: false,
      hitsColumnDivider: false,
    })).toBe("divider");
  });

  it("draws nothing in an empty part of a column, but keeps the container's insertion edge", () => {
    const hover = resolveBlockAffordanceHover(
      { ...problem, laneEmpty: true, spaceAfterTarget: { blockId: "inner", bottom: 120, left: 430, insideProblemArea: false, spaceAfterPx: 0 } },
      { x: 460, y: 199 },
    );
    expect(hover.handle).toBeNull();
    expect(hover.spaceAfter).toBeNull();
    expect(hover.insertPoint?.top).toBe(200);
  });

  it("suppresses both gutter controls while a column divider owns the pointer", () => {
    expect(resolveBlockAffordanceHover(
      {
        ...middleParagraph,
        spaceAfterTarget: {
          blockId: "middle",
          bottom: 340,
          left: 100,
          insideProblemArea: false,
          spaceAfterPx: 0,
        },
      },
      { x: 92, y: 320 },
      { suppressGutterControls: true },
    )).toEqual({
      handle: null,
      insertPoint: null,
      spaceAfter: null,
    });
  });

  it("keeps a container grip in its top band even when a child unit is measurable there", () => {
    expect(resolveBlockAffordanceHover(
      {
        ...problem,
        unit: { id: "inner", top: 48, bottom: 80, left: 112, insideProblemArea: false },
        useOwnerAffordance: true,
      },
      { x: 104, y: 50 },
    ).handle?.blockId).toBe("problem");
  });

  it("reports the hovered block without an insertion line in the middle of a block", () => {
    expect(resolveBlockAffordanceHover(problem, { x: 300, y: 120 })).toEqual({
      handle: { blockId: "problem", top: 48, bottom: 200, left: 100 },
      insertPoint: null,
      spaceAfter: null,
    });
  });

  it("always offers both edges of a problem or a box", () => {
    expect(resolveBlockAffordanceHover(problem, { x: 300, y: 50 }).insertPoint).toEqual({
      anchorBlockId: "problem",
      position: "before",
      top: 48,
      left: 100,
      width: 400,
    });
    expect(resolveBlockAffordanceHover(problem, { x: 300, y: 199 }).insertPoint?.top).toBe(200);

    // Even with body text on both sides, a box keeps both of its edges offered.
    const boxBetweenParagraphs: HoveredTopLevelBlock = { ...middleParagraph, isAtomic: true };
    expect(resolveBlockAffordanceHover(boxBetweenParagraphs, { x: 300, y: 301 }).insertPoint)
      .not.toBeNull();
    expect(resolveBlockAffordanceHover(boxBetweenParagraphs, { x: 300, y: 339 }).insertPoint)
      .not.toBeNull();
  });

  it("stays out of gaps a caret can already reach", () => {
    expect(resolveBlockAffordanceHover(middleParagraph, { x: 300, y: 301 }).insertPoint).toBeNull();
    expect(resolveBlockAffordanceHover(middleParagraph, { x: 300, y: 339 }).insertPoint).toBeNull();
    // The handle is still offered there.
    expect(resolveBlockAffordanceHover(middleParagraph, { x: 300, y: 301 }).handle?.blockId)
      .toBe("middle");
  });

  it("agrees on one gap from either side", () => {
    const fromAbove = resolveBlockAffordanceHover(problem, { x: 300, y: 199 });
    const fromBelow = resolveBlockAffordanceHover(lastParagraph, { x: 300, y: 209 });

    expect(fromAbove.insertPoint?.anchorBlockId).toBe("outro");
    expect(fromAbove.insertPoint?.position).toBe("before");
    expect(fromBelow.insertPoint?.anchorBlockId).toBe("outro");
    expect(fromBelow.insertPoint?.position).toBe("before");
  });

  it("offers the top of the document but leaves its end to the trailing zone", () => {
    const firstParagraph: HoveredTopLevelBlock = { ...middleParagraph, aboveKind: "none" };

    expect(resolveBlockAffordanceHover(firstParagraph, { x: 300, y: 301 }).insertPoint?.position)
      .toBe("before");
    expect(resolveBlockAffordanceHover(lastParagraph, { x: 300, y: 241 }).insertPoint).toBeNull();
  });

  it("treats a pointer in the gap as being on the edge it came from", () => {
    // 20px below the block: past the edge threshold, but resolved through the gap probe.
    const throughGap: HoveredTopLevelBlock = { ...problem, gapEdge: "bottom" };

    expect(resolveBlockAffordanceHover(throughGap, { x: 300, y: 220 }).insertPoint).toEqual({
      anchorBlockId: "outro",
      position: "before",
      top: 200,
      left: 100,
      width: 400,
    });
  });

  it("keeps the handle available while the pointer sits in the left gutter", () => {
    expect(resolveBlockAffordanceHover(problem, { x: 70, y: 120 }).handle?.blockId).toBe("problem");
    expect(resolveBlockAffordanceHover(problem, { x: 20, y: 120 }).handle).toBeNull();
  });

  it("ignores pointers outside the block column and misses", () => {
    expect(resolveBlockAffordanceHover(problem, { x: 600, y: 120 })).toEqual({
      handle: null,
      insertPoint: null,
      spaceAfter: null,
    });
    expect(resolveBlockAffordanceHover(null, { x: 300, y: 120 })).toEqual({
      handle: null,
      insertPoint: null,
      spaceAfter: null,
    });
  });
});

describe("resolveStationaryBlockAffordanceRefresh", () => {
  it("adopts changed geometry at the last pointer point when layout revision advances", () => {
    const current = resolveBlockAffordanceHover(middleParagraph, { x: 300, y: 320 });
    const next = resolveBlockAffordanceHover({
      ...middleParagraph,
      unit: { id: "middle", top: 300, bottom: 364, left: 100, insideProblemArea: false },
      spaceAfterTarget: {
        blockId: "middle",
        bottom: 364,
        left: 100,
        insideProblemArea: false,
        spaceAfterPx: 0,
      },
    }, { x: 300, y: 320 });

    expect(resolveStationaryBlockAffordanceRefresh({
      previousRevision: 4,
      revision: 5,
      point: { x: 300, y: 320 },
      current,
      next,
    })).toEqual({ revision: 5, hover: next, changed: true });
  });
});

describe("resolveBlockSelectionRange", () => {
  const ids = ["a", "b", "c", "d"];

  it("returns the document-ordered span between two blocks", () => {
    expect(resolveBlockSelectionRange(ids, "c", "a")).toEqual(["a", "b", "c"]);
    expect(resolveBlockSelectionRange(ids, "b", "d")).toEqual(["b", "c", "d"]);
  });

  it("falls back to the clicked block when the anchor is gone", () => {
    expect(resolveBlockSelectionRange(ids, "missing", "c")).toEqual(["c"]);
  });
});

describe("the space-after handle target", () => {
  const target: BlockSpaceAfterTarget = {
    blockId: "middle",
    bottom: 340,
    left: 100,
    insideProblemArea: false,
    spaceAfterPx: 0,
  };
  const hovered: HoveredTopLevelBlock = { ...middleParagraph, spaceAfterTarget: target };

  it("comes back for a block that can carry a space below it", () => {
    expect(resolveBlockAffordanceHover(hovered, { x: 300, y: 320 }).spaceAfter).toEqual(target);
  });

  it("is null for a block that never draws one (a quote, a box, a column section)", () => {
    // 呼び出し側が `rendersBlockSpaceAfter` で落とすと `spaceAfterTarget` が付かない。
    expect(resolveBlockAffordanceHover(middleParagraph, { x: 300, y: 320 }).spaceAfter).toBeNull();
  });

  it("appears from the left gutter, like the grip", () => {
    expect(resolveBlockAffordanceHover(hovered, { x: 60, y: 320 }).spaceAfter).toEqual(target);
  });

  it("disappears when the pointer leaves the block", () => {
    expect(resolveBlockAffordanceHover(hovered, { x: 600, y: 320 }).spaceAfter).toBeNull();
  });

  it("carries the current value so the drag can start from it", () => {
    const withSpace: HoveredTopLevelBlock = {
      ...middleParagraph,
      spaceAfterTarget: { ...target, spaceAfterPx: 24 },
    };

    expect(resolveBlockAffordanceHover(withSpace, { x: 300, y: 320 }).spaceAfter?.spaceAfterPx).toBe(24);
  });
});

describe("resolveBlockInsertButtonLane", () => {
  const spaceAfter: BlockSpaceAfterTarget = {
    blockId: "middle",
    bottom: 340,
    left: 100,
    insideProblemArea: false,
    spaceAfterPx: 0,
  };
  const insertPoint = { anchorBlockId: "tail", position: "before" as const, top: 340, left: 100, width: 400 };

  it("keeps the default lane when there is no space-after handle to collide with", () => {
    expect(resolveBlockInsertButtonLane({ handle: null, insertPoint, spaceAfter: null })).toBe("default");
  });

  it("keeps the default lane when the two sit on different edges", () => {
    expect(resolveBlockInsertButtonLane({
      handle: null,
      insertPoint: { ...insertPoint, top: 200 },
      spaceAfter,
    })).toBe("default");
  });

  it("moves out one lane when the insert button would cover the handle", () => {
    // 問題・囲み枠の直前のブロック: 同じ辺に両方が出て、＋ がつまみの上に乗る。
    expect(resolveBlockInsertButtonLane({ handle: null, insertPoint, spaceAfter })).toBe("outer");
  });

  it("moves out for a boundary the pointer reached through the gap, too", () => {
    expect(resolveBlockInsertButtonLane({
      handle: null,
      insertPoint: { ...insertPoint, top: 344 },
      spaceAfter,
    })).toBe("outer");
  });

  it("stays put for a handle already in the problem lane, where moving out would collide instead", () => {
    expect(resolveBlockInsertButtonLane({
      handle: null,
      insertPoint,
      spaceAfter: { ...spaceAfter, insideProblemArea: true },
    })).toBe("default");
  });
});

describe("sameBlockAffordanceHover with a space-after target", () => {
  const base = resolveBlockAffordanceHover(
    { ...middleParagraph, spaceAfterTarget: { blockId: "middle", bottom: 340, left: 100, insideProblemArea: false, spaceAfterPx: 0 } },
    { x: 300, y: 320 },
  );

  function hoverWith(patch: Partial<BlockSpaceAfterTarget>) {
    return resolveBlockAffordanceHover(
      {
        ...middleParagraph,
        spaceAfterTarget: {
          blockId: "middle",
          bottom: 340,
          left: 100,
          insideProblemArea: false,
          spaceAfterPx: 0,
          ...patch,
        },
      },
      { x: 300, y: 320 },
    );
  }

  it("treats an identical hover as unchanged (no re-render)", () => {
    expect(sameBlockAffordanceHover(base, hoverWith({}))).toBe(true);
  });

  it.each([
    ["bottom", { bottom: 341 }],
    ["left", { left: 210 }],
    ["value", { spaceAfterPx: 24 }],
    ["lane", { insideProblemArea: true }],
    ["column lane", { columnLaneWidthPx: 13 }],
    ["block", { blockId: "other" }],
  ])("detects a changed %s", (_name, patch) => {
    expect(sameBlockAffordanceHover(base, hoverWith(patch))).toBe(false);
  });

  it("detects the target appearing and disappearing", () => {
    const without = resolveBlockAffordanceHover(middleParagraph, { x: 300, y: 320 });

    expect(sameBlockAffordanceHover(base, without)).toBe(false);
    expect(sameBlockAffordanceHover(without, base)).toBe(false);
  });
});

describe("blockHitProbeColumnLeftPx", () => {
  // 本文左端 100、段幅 300、段間 30 の 2 段組。2 段目の左端は 430。
  const layout = { contentLeftPx: 100, columnCount: 2, columnWidthPx: 300, columnGapPx: 30 };

  it("always probes the content column when there is a single column", () => {
    expect(blockHitProbeColumnLeftPx({ ...layout, columnCount: 1 }, 20)).toBe(100);
    expect(blockHitProbeColumnLeftPx({ ...layout, columnCount: 1 }, 900)).toBe(100);
  });

  it("keeps the left margin and the first column on the first column", () => {
    expect(blockHitProbeColumnLeftPx(layout, 10)).toBe(100);
    expect(blockHitProbeColumnLeftPx(layout, 100)).toBe(100);
    expect(blockHitProbeColumnLeftPx(layout, 399)).toBe(100);
  });

  it("assigns the inter-column gap to the column on its right (the handle lane)", () => {
    expect(blockHitProbeColumnLeftPx(layout, 401)).toBe(430);
    expect(blockHitProbeColumnLeftPx(layout, 429)).toBe(430);
    expect(blockHitProbeColumnLeftPx(layout, 600)).toBe(430);
  });

  it("clamps past the last column", () => {
    expect(blockHitProbeColumnLeftPx(layout, 2000)).toBe(430);
  });
});

describe("resolveInnerBlockAt", () => {
  // 局所 2 段組: 左段に a(上)/b(下)、右段に c(上)/d(下)。段間は 400〜430。
  const twoColumns = [
    { id: "a", top: 100, bottom: 140, left: 100, right: 400 },
    { id: "b", top: 150, bottom: 190, left: 100, right: 400 },
    { id: "c", top: 100, bottom: 140, left: 430, right: 730 },
    { id: "d", top: 150, bottom: 190, left: 430, right: 730 },
  ];

  it("resolves the block under the pointer in each column", () => {
    expect(resolveInnerBlockAt(twoColumns, 200, 120)).toEqual({ id: "a", firstColumn: true });
    expect(resolveInnerBlockAt(twoColumns, 500, 170)).toEqual({ id: "d", firstColumn: false });
  });

  it("assigns the inter-column gap to the right column, where its handles are drawn", () => {
    expect(resolveInnerBlockAt(twoColumns, 410, 120)).toEqual({ id: "c", firstColumn: false });
  });

  it("assigns the area left of every column to the first column", () => {
    expect(resolveInnerBlockAt(twoColumns, 40, 170)).toEqual({ id: "b", firstColumn: true });
  });

  it("ignores the pointer x entirely with a single column, like the problem-area gutter", () => {
    const single = [
      { id: "a", top: 100, bottom: 140, left: 100, right: 700 },
      { id: "b", top: 150, bottom: 190, left: 100, right: 700 },
    ];

    // 問題 chrome の上 (ブロックよりずっと左) にプローブが落ちても当たる。
    expect(resolveInnerBlockAt(single, 5, 120)).toEqual({ id: "a", firstColumn: true });
  });

  it("falls back to the lowest block above the pointer, within reach, per lane", () => {
    expect(resolveInnerBlockAt(twoColumns, 200, 200)).toEqual({ id: "b", firstColumn: true });
    expect(resolveInnerBlockAt(twoColumns, 500, 200)).toEqual({ id: "d", firstColumn: false });
    // 手の届かない遠くには出ない。
    expect(resolveInnerBlockAt(twoColumns, 200, 400)).toBeNull();
  });

  it("returns null with no candidates", () => {
    expect(resolveInnerBlockAt([], 100, 100)).toBeNull();
  });
});

describe("resolveInnerLaneProbe", () => {
  it("keeps the outer problem-area lane ownership in a nested first column", () => {
    const outer = resolveInnerLaneProbe([
      { left: 100, right: 400 },
      { left: 430, right: 730 },
    ], 450);
    expect(outer?.firstColumn).toBe(false);

    const inner = resolveInnerLaneProbe([
      { left: 430, right: 560 },
      { left: 570, right: 700 },
    ], 450, outer?.firstColumn);
    expect(inner).toMatchObject({ laneLeft: 430, firstColumn: false });
  });
});

describe("isContainerTopBand", () => {
  it("keeps real container padding above the first child", () => {
    expect(isContainerTopBand(100, 118, 124)).toBe(true);
    expect(isContainerTopBand(100, 124, 124)).toBe(false);
  });

  it("reserves six pixels when the first child starts at the container top", () => {
    expect(isContainerTopBand(100, 102, 100)).toBe(true);
    expect(isContainerTopBand(100, 106, 100)).toBe(false);
  });
});

describe("column gap lanes", () => {
  it("keeps grips in the right half of a divider gap, clear of the divider line", () => {
    // 8mm (≈30px) の段間: 中央 15px から 3px 離し、右半分の 12px に収める。
    expect(resolveColumnLaneWidthPx(30.2)).toBe(12);
    // 中央線の左右 3px を空けられる最も狭い段間。
    expect(resolveColumnLaneWidthPx(26)).toBe(10);
    // 広い段間でも最大幅まで。
    expect(resolveColumnLaneWidthPx(80)).toBe(18);
    // 極端に狭い段間では掴める最小幅を優先する (中央へはみ出す)。
    expect(resolveColumnLaneWidthPx(12)).toBe(10);
    expect(resolveColumnLaneWidthPx(0)).toBe(10);
    // 列境界の無いガター (枠の内側) は最大幅。
    expect(resolveColumnLaneWidthPx(null)).toBe(18);
  });

  it("keeps a right-lane affordance only while the pointer stays on that row inside the gap", () => {
    const hover = {
      handle: { blockId: "r2", top: 100, bottom: 160, left: 430, columnLaneWidthPx: 13 },
      insertPoint: null,
      spaceAfter: { blockId: "r2", bottom: 160, left: 430, insideProblemArea: false, columnLaneWidthPx: 13, spaceAfterPx: 0 },
    };
    expect(isPointWithinColumnLaneAffordance(hover, { x: 415, y: 100 })).toBe(true);
    // 下端つまみ (高さ 16px) の下まで。
    expect(isPointWithinColumnLaneAffordance(hover, { x: 415, y: 169 })).toBe(true);
    expect(isPointWithinColumnLaneAffordance(hover, { x: 415, y: 175 })).toBe(false);
    expect(isPointWithinColumnLaneAffordance(hover, { x: 415, y: 90 })).toBe(false);
    // 段の本文側は通常の解決に任せる。
    expect(isPointWithinColumnLaneAffordance(hover, { x: 440, y: 120 })).toBe(false);
    // 1 段目 (ページ余白のレーン) の表示は段間では保たない。
    expect(isPointWithinColumnLaneAffordance({ ...hover, handle: { ...hover.handle, columnLaneWidthPx: undefined } }, { x: 415, y: 120 }))
      .toBe(false);
  });

  it("carries the column lane width from the hovered unit to the grip", () => {
    const hover = resolveBlockAffordanceHover(
      { ...middleParagraph, unit: { id: "r2", top: 300, bottom: 340, left: 430, insideProblemArea: false, columnLaneWidthPx: 13 } },
      { x: 500, y: 320 },
    );
    expect(hover.handle).toEqual({ blockId: "r2", top: 300, bottom: 340, left: 430, insideProblemArea: false, columnLaneWidthPx: 13 });
  });
});
