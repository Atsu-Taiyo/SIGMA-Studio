import { describe, expect, it } from "vitest";

import {
  computeProblemAreaColumnFlow,
  getSafeProblemAreaMinHeightPx,
  hasManualBreakInside,
  isProblemAreaFlowEligible,
  simulateBalancedColumnHeightPx,
} from ".";

describe("computeProblemAreaColumnFlow", () => {
  const blocks10 = Array.from(
    { length: 10 },
    (_, index) => ({ id: `b${index}`, height: 100 }),
  );

  it("stays in balance mode when the area fits in the remaining space", () => {
    const result = computeProblemAreaColumnFlow(
      blocks10,
      2,
      100,
      10,
      600,
      1000,
      1123,
    );

    expect(result.mode).toBe("balance");
    expect(result.segments).toBe(1);
    expect(result.blockLayouts).toEqual({});
  });

  it("continues columns onto the next page when it does not fit", () => {
    const result = computeProblemAreaColumnFlow(
      blocks10,
      2,
      100,
      10,
      300,
      1000,
      1123,
    );

    expect(result.mode).toBe("flow");
    expect(result.segments).toBe(2);
    expect(result.blockLayouts.b0).toEqual({ x: 0, y: 0, width: 100 });
    expect(result.blockLayouts.b2).toEqual({ x: 0, y: 200, width: 100 });
    expect(result.blockLayouts.b3).toEqual({ x: 110, y: 0, width: 100 });
    expect(result.blockLayouts.b5).toEqual({ x: 110, y: 200, width: 100 });
    expect(result.blockLayouts.b6).toEqual({ x: 0, y: 423, width: 100 });
    expect(result.blockLayouts.b9).toEqual({ x: 0, y: 723, width: 100 });
    expect(result.totalHeightPx).toBe(823);
  });

  it("honors manual breaks by moving the block to the next column", () => {
    const result = computeProblemAreaColumnFlow([
      { id: "before", height: 100 },
      { id: "after_break", height: 80, break: true },
    ], 2, 100, 10, 600, 1000, 1123);

    expect(result.mode).toBe("flow");
    expect(result.segments).toBe(1);
    expect(result.blockLayouts.before).toEqual({ x: 0, y: 0, width: 100 });
    expect(result.markerLayouts.after_break).toEqual({
      x: 0,
      y: 100,
      width: 100,
    });
    expect(result.blockLayouts.after_break).toEqual({
      x: 110,
      y: 0,
      width: 100,
    });
  });

  it("never lets a block straddle a page boundary", () => {
    const result = computeProblemAreaColumnFlow(
      blocks10,
      2,
      100,
      10,
      250,
      1000,
      1123,
    );
    const pageGap = 1123 - 1000;

    for (const layout of Object.values(result.blockLayouts)) {
      const inGap = layout.y >= 250 - 0.5
        && layout.y < 250 + pageGap - 0.5;
      expect(inGap).toBe(false);
    }
  });

  it("skips a short first segment when a block fits only a full segment", () => {
    const run = () => computeProblemAreaColumnFlow([
      { id: "short_first", height: 30 },
      { id: "full_segment_only", height: 60 },
    ], 2, 100, 10, 40, 100, 120);

    const first = run();
    expect(first.blockLayouts.short_first).toEqual({ x: 0, y: 0, width: 100 });
    expect(first.blockLayouts.full_segment_only).toEqual({ x: 0, y: 60, width: 100 });
    expect(first.segments).toBe(2);
    expect(run()).toEqual(first);
  });

  it("approximates a balanced column height", () => {
    const height = simulateBalancedColumnHeightPx(
      blocks10.map((block) => block.height),
      2,
    );

    expect(height).toBeGreaterThanOrEqual(499);
    expect(height).toBeLessThanOrEqual(501);
  });

  it("honors keep-with-next and keep-together only when the kept content fits one column", () => {
    const kept = computeProblemAreaColumnFlow([
      { id: "filler", height: 60 },
      { id: "heading", height: 25, keepWithNext: true },
      { id: "body", height: 25 },
      { id: "box", height: 60, keepTogether: true },
      { id: "tail", height: 100 },
    ], 2, 100, 10, 100, 100, 100);

    expect(kept.mode).toBe("flow");
    expect(kept.blockLayouts.heading).toEqual({ x: 110, y: 0, width: 100 });
    expect(kept.blockLayouts.body).toEqual({ x: 110, y: 25, width: 100 });
    expect(kept.blockLayouts.box).toEqual({ x: 0, y: 100, width: 100 });

    const oversizedPair = computeProblemAreaColumnFlow([
      { id: "filler", height: 60 },
      { id: "heading", height: 60, keepWithNext: true },
      { id: "body", height: 60 },
      { id: "tail", height: 100 },
    ], 2, 100, 10, 100, 100, 100);
    expect(oversizedPair.blockLayouts.heading).toEqual({ x: 110, y: 0, width: 100 });
  });

  it("excludes the following block's trailing space from keep-with-next fitting", () => {
    const run = () => computeProblemAreaColumnFlow([
      { id: "filler", height: 70 },
      { id: "heading", height: 20, keepWithNext: true },
      { id: "body", height: 30, trailingSpacePx: 20 },
      { id: "tail", height: 100 },
    ], 2, 100, 10, 100, 100, 100);

    const first = run();
    expect(first.blockLayouts.heading).toEqual({ x: 0, y: 70, width: 100 });
    expect(first.blockLayouts.body).toEqual({ x: 0, y: 90, width: 100 });
    expect(run()).toEqual(first);
  });

  it("moves a keep-with-next pair from a short first segment to the next full segment", () => {
    const run = () => computeProblemAreaColumnFlow([
      { id: "heading", height: 20, keepWithNext: true },
      { id: "body", height: 30 },
      { id: "tail", height: 100 },
    ], 2, 100, 10, 40, 100, 100);

    const first = run();
    expect(first.blockLayouts.heading).toEqual({ x: 0, y: 40, width: 100 });
    expect(first.blockLayouts.body).toEqual({ x: 0, y: 60, width: 100 });
    expect(run()).toEqual(first);
  });

  it("clamps non-finite and extreme problem-area reservations", () => {
    expect(getSafeProblemAreaMinHeightPx(Number.POSITIVE_INFINITY, 100)).toBe(0);
    expect(getSafeProblemAreaMinHeightPx(Number.NaN, 100)).toBe(0);
    expect(getSafeProblemAreaMinHeightPx(1_000_000, 100)).toBe(100_000);
  });

  it("skips an exhausted synthetic first segment deterministically", () => {
    const run = () => computeProblemAreaColumnFlow(
      [{ id: "first", height: 40 }, { id: "second", height: 40 }],
      2,
      100,
      10,
      0,
      100,
      100,
    );

    const first = run();
    expect(first.blockLayouts.first).toEqual({ x: 0, y: 0, width: 100 });
    expect(first.segments).toBe(2);
    expect(run()).toEqual(first);
  });

  it("advances a following block from a short first segment to the top of the next segment", () => {
    const result = computeProblemAreaColumnFlow([
      { id: "first", height: 80 },
      { id: "following", height: 150 },
    ], 2, 100, 10, 100, 200, 250);

    expect(result.mode).toBe("flow");
    expect(result.blockLayouts.first).toEqual({ x: 0, y: 0, width: 100 });
    expect(result.blockLayouts.following).toEqual({ x: 0, y: 150, width: 100 });
  });

  it("produces identical short-first-segment flow on two runs", () => {
    const input = [
      { id: "first", height: 80 },
      { id: "following", height: 150 },
    ];

    const first = computeProblemAreaColumnFlow(input, 2, 100, 10, 100, 200, 250);
    const second = computeProblemAreaColumnFlow(input, 2, 100, 10, 100, 200, 250);

    expect(second).toEqual(first);
  });

  it("splits an over-tall paragraph at line boundaries and resumes after its final fragment", () => {
    const result = computeProblemAreaColumnFlow([
      { id: "paragraph", type: "paragraph", height: 150, breakOffsets: [50, 100] },
      { id: "following", type: "paragraph", height: 20 },
    ], 2, 100, 10, 100, 100, 130);

    expect(result.fragmentLayouts.paragraph).toEqual([
      { fragmentIndex: 0, sourceOffsetY: 0, height: 100, x: 0, y: 0, width: 100 },
      { fragmentIndex: 1, sourceOffsetY: 100, height: 50, x: 110, y: 0, width: 100 },
    ]);
    expect(result.blockLayouts.paragraph).toEqual({ x: 0, y: 0, width: 100 });
    expect(result.blockLayouts.following).toEqual({ x: 110, y: 50, width: 100 });
  });

  it("flows a box through the remaining space before continuing in the next column", () => {
    const result = computeProblemAreaColumnFlow([
      { id: "filler", type: "paragraph", height: 70 },
      { id: "box", type: "boxBlock", height: 80, minStartHeightPx: 20 },
      { id: "tail", type: "paragraph", height: 100 },
    ], 2, 100, 10, 100, 100, 130);

    expect(result.fragmentLayouts.box).toEqual([
      { fragmentIndex: 0, sourceOffsetY: 0, height: 30, x: 0, y: 70, width: 100 },
      { fragmentIndex: 1, sourceOffsetY: 30, height: 50, x: 110, y: 0, width: 100 },
    ]);
    expect(result.blockLayouts.tail).toEqual({ x: 0, y: 130, width: 100 });
  });

  it("moves a box to the next column when the remaining space is below its minimum start height", () => {
    const result = computeProblemAreaColumnFlow([
      { id: "filler", type: "paragraph", height: 85 },
      { id: "box", type: "boxBlock", height: 80, minStartHeightPx: 20 },
      { id: "tail", type: "paragraph", height: 150 },
    ], 2, 100, 10, 100, 100, 130);

    expect(result.blockLayouts.box).toEqual({ x: 110, y: 0, width: 100 });
    expect(result.fragmentLayouts.box).toBeUndefined();
  });

  it("keeps a non-box block whole when it fits a complete column", () => {
    const result = computeProblemAreaColumnFlow([
      { id: "filler", type: "paragraph", height: 70 },
      { id: "whole", type: "paragraph", height: 80, breakOffsets: [40] },
      { id: "tail", type: "paragraph", height: 150 },
    ], 2, 100, 10, 100, 100, 130);

    expect(result.blockLayouts.whole).toEqual({ x: 110, y: 0, width: 100 });
    expect(result.fragmentLayouts.whole).toBeUndefined();
  });

  it.each([undefined, 0])("fills the remainder with paragraph lines (fixed column %s)", (columnIndex) => {
    const blocks = [
      { id: "filler", type: "paragraph" as const, height: 70, columnIndex },
      { id: "body", type: "paragraph" as const, height: 80, breakOffsets: [20, 40, 60], columnIndex },
      { id: "tail", type: "paragraph" as const, height: 150, columnIndex },
    ];
    const run = () => computeProblemAreaColumnFlow(blocks, 2, 100, 10, 100, 100, 130);
    const result = run();
    expect(result.fragmentLayouts.body).toEqual([
      { fragmentIndex: 0, sourceOffsetY: 0, height: 20, x: 0, y: 70, width: 100 },
      { fragmentIndex: 1, sourceOffsetY: 20, height: 60, x: columnIndex === 0 ? 0 : 110, y: columnIndex === 0 ? 130 : 0, width: 100 },
    ]);
    expect(run()).toEqual(result);
  });

  it("keeps a one-column box together by moving it intact", () => {
    const result = computeProblemAreaColumnFlow([
      { id: "filler", type: "paragraph", height: 60 },
      { id: "box", type: "boxBlock", height: 80, keepTogether: true, minStartHeightPx: 10 },
      { id: "tail", type: "paragraph", height: 150 },
    ], 2, 100, 10, 100, 100, 130);

    expect(result.blockLayouts.box).toEqual({ x: 110, y: 0, width: 100 });
    expect(result.fragmentLayouts.box).toBeUndefined();
  });

  it("places fragments across three page segments with the inter-page gap", () => {
    const result = computeProblemAreaColumnFlow([
      {
        id: "three_pages",
        type: "paragraph",
        height: 490,
        breakOffsets: [80, 160, 260, 360, 460],
      },
    ], 2, 100, 10, 80, 100, 130, [80, 100, 100]);

    expect(result.fragmentLayouts.three_pages).toEqual([
      { fragmentIndex: 0, sourceOffsetY: 0, height: 80, x: 0, y: 0, width: 100 },
      { fragmentIndex: 1, sourceOffsetY: 80, height: 80, x: 110, y: 0, width: 100 },
      { fragmentIndex: 2, sourceOffsetY: 160, height: 100, x: 0, y: 110, width: 100 },
      { fragmentIndex: 3, sourceOffsetY: 260, height: 100, x: 110, y: 110, width: 100 },
      { fragmentIndex: 4, sourceOffsetY: 360, height: 100, x: 0, y: 240, width: 100 },
      { fragmentIndex: 5, sourceOffsetY: 460, height: 30, x: 110, y: 240, width: 100 },
    ]);
    expect(result.segments).toBe(3);
    expect(result.totalHeightPx).toBe(340);
  });

  it("returns deeply equal fragment layouts for identical gap-free input", () => {
    const input = [
      { id: "filler", type: "paragraph" as const, height: 70 },
      { id: "box", type: "boxBlock" as const, height: 180, minStartHeightPx: 20 },
    ];

    const first = computeProblemAreaColumnFlow(input, 2, 100, 10, 100, 100, 130);
    const second = computeProblemAreaColumnFlow(input, 2, 100, 10, 100, 100, 130);

    expect(second).toEqual(first);
  });

  it("handles missing break offsets, zero-height blocks, and one-column input", () => {
    const withoutOffsets = computeProblemAreaColumnFlow([
      { id: "tall", type: "paragraph", height: 250 },
      { id: "zero", type: "paragraph", height: 0 },
    ], 2, 100, 10, 100, 100, 130);
    expect(withoutOffsets.fragmentLayouts.tall).toEqual([
      { fragmentIndex: 0, sourceOffsetY: 0, height: 100, x: 0, y: 0, width: 100 },
      { fragmentIndex: 1, sourceOffsetY: 100, height: 100, x: 110, y: 0, width: 100 },
      { fragmentIndex: 2, sourceOffsetY: 200, height: 50, x: 0, y: 130, width: 100 },
    ]);
    expect(withoutOffsets.blockLayouts.zero).toEqual({ x: 0, y: 180, width: 100 });

    expect(computeProblemAreaColumnFlow([
      { id: "single", type: "paragraph", height: 250 },
    ], 1, 100, 10, 100, 100, 130)).toEqual({
      mode: "balance",
      segments: 1,
      totalHeightPx: 250,
      blockLayouts: {},
      fragmentLayouts: {},
      markerLayouts: {},
    });
  });
});

describe("hasManualBreakInside", () => {
  it("is false when no block requests a manual break", () => {
    expect(hasManualBreakInside([
      { pagination: undefined },
      { pagination: { break: false } },
    ])).toBe(false);
  });

  it("is false when only the first block carries break (nothing to break away from)", () => {
    expect(hasManualBreakInside([
      { pagination: { break: true } },
      { pagination: undefined },
    ])).toBe(false);
  });

  it("is true when a block other than the first carries break: always", () => {
    expect(hasManualBreakInside([
      { pagination: undefined },
      { pagination: { break: true } },
    ])).toBe(true);
  });
});

describe("isProblemAreaFlowEligible", () => {
  it("is always eligible for an ordinary (non-atomic) area", () => {
    expect(isProblemAreaFlowEligible({
      isFullSpan: false,
      isFramedArea: false,
      blocks: [{ pagination: undefined }],
    })).toBe(true);
  });

  it("keeps a framed area atomic when it has no manual break inside", () => {
    expect(isProblemAreaFlowEligible({
      isFullSpan: false,
      isFramedArea: true,
      blocks: [
        { pagination: undefined },
        { pagination: undefined },
      ],
    })).toBe(false);
  });

  it("flows measured framed areas even when they fit a complete segment", () => {
    const input = {
      isFullSpan: false,
      isFramedArea: true,
      blocks: [{ pagination: undefined }],
      segmentHeightPx: 1_000,
    };
    expect(isProblemAreaFlowEligible({ ...input, gapFreeHeightPx: 1_000 })).toBe(true);
    expect(isProblemAreaFlowEligible({ ...input, gapFreeHeightPx: 1_001 })).toBe(true);
  });

  it("keeps a full-span area atomic at exactly one segment and flows it at +1px", () => {
    const input = {
      isFullSpan: true,
      isFramedArea: false,
      blocks: [{ pagination: undefined }],
      segmentHeightPx: 1_000,
    };
    expect(isProblemAreaFlowEligible({ ...input, gapFreeHeightPx: 1_000 })).toBe(false);
    expect(isProblemAreaFlowEligible({ ...input, gapFreeHeightPx: 1_001 })).toBe(true);
  });

  it("keeps a full-span area atomic when it has no manual break inside", () => {
    expect(isProblemAreaFlowEligible({
      isFullSpan: true,
      isFramedArea: false,
      blocks: [
        { pagination: undefined },
        { pagination: undefined },
      ],
    })).toBe(false);
  });

  it("makes a framed area flowable once a manual break is placed inside it", () => {
    expect(isProblemAreaFlowEligible({
      isFullSpan: false,
      isFramedArea: true,
      blocks: [
        { pagination: undefined },
        { pagination: { break: true } },
      ],
    })).toBe(true);
  });

  it("makes a full-span area flowable once a manual break is placed inside it", () => {
    expect(isProblemAreaFlowEligible({
      isFullSpan: true,
      isFramedArea: false,
      blocks: [
        { pagination: undefined },
        { pagination: { break: true } },
      ],
    })).toBe(true);
  });

  it("does not become flowable from a break on its very first block", () => {
    expect(isProblemAreaFlowEligible({
      isFullSpan: false,
      isFramedArea: true,
      blocks: [
        { pagination: { break: true } },
        { pagination: undefined },
      ],
    })).toBe(false);
  });

  it("keeps atomic areas atomic when the segment height is invalid", () => {
    for (const segmentHeightPx of [0, -1, Number.NaN]) {
      expect(isProblemAreaFlowEligible({
        isFullSpan: false,
        isFramedArea: true,
        blocks: [{ pagination: undefined }],
        gapFreeHeightPx: 1_000,
        segmentHeightPx,
      })).toBe(false);
    }
  });
});

describe("computeProblemAreaColumnFlow invalid and extreme geometry", () => {
  it("returns a finite vertical fallback for zero, negative, and NaN content heights", () => {
    for (const contentHeightPx of [0, -1, Number.NaN]) {
      const result = computeProblemAreaColumnFlow(
        [{ id: "a", height: 120 }, { id: "b", height: 80 }],
        2,
        100,
        10,
        0,
        contentHeightPx,
        110,
        [0, 0],
      );
      expect(result).toMatchObject({ mode: "balance", segments: 1, totalHeightPx: 200 });
      expect(Number.isFinite(result.totalHeightPx)).toBe(true);
    }
  });

  it("caps replicas for an extreme measured block height", () => {
    const result = computeProblemAreaColumnFlow(
      [{ id: "extreme", height: 1_000_000, breakOffsets: [] }],
      2,
      100,
      10,
      100,
      100,
      120,
    );

    expect(result.fragmentLayouts.extreme).toHaveLength(1_000);
    expect(result.fragmentLayouts.extreme.at(-1)?.height).toBeGreaterThan(100);
  });

  it("shares the fragment budget across every block in one flow operation", () => {
    const result = computeProblemAreaColumnFlow(
      [
        { id: "extreme_a", height: 1_000_000, breakOffsets: [] },
        { id: "extreme_b", height: 1_000_000, breakOffsets: [] },
      ],
      2,
      100,
      10,
      100,
      100,
      120,
    );
    const fragments = Object.values(result.fragmentLayouts).flat();

    expect(fragments).toHaveLength(1_000);
    expect(result.blockLayouts.extreme_b).toBeDefined();
  });
});

describe("computeProblemAreaColumnFlow with independent columns", () => {
  it("continues a single remaining independent column across segments", () => {
    const result = computeProblemAreaColumnFlow([
      { id: "remaining", height: 220, type: "paragraph", columnIndex: 0, columnWidthPx: 100 },
    ], 1, 100, 0, 100, 100, 100);
    expect(result.mode).toBe("flow");
    expect(result.fragmentLayouts.remaining.map(fragment => fragment.height)).toEqual([100, 100, 20]);
    expect(result.fragmentLayouts.remaining.every(fragment => fragment.x === 0)).toBe(true);
  });

  it("continues only the overflowing column and leaves the shorter column blank", () => {
    const result = computeProblemAreaColumnFlow([
      { id: "left-1", height: 180, columnIndex: 0, columnWidthPx: 140 },
      { id: "left-2", height: 180, columnIndex: 0, columnWidthPx: 140 },
      { id: "right-1", height: 80, columnIndex: 1, columnWidthPx: 80 },
    ], 2, 100, 10, 300, 300, 420);

    expect(result.mode).toBe("flow");
    expect(result.blockLayouts["left-1"]).toEqual({ x: 0, y: 0, width: 140 });
    expect(result.blockLayouts["left-2"]).toEqual({ x: 0, y: 420, width: 140 });
    expect(result.blockLayouts["right-1"]).toEqual({ x: 0, y: 0, width: 80 });
    expect(result.segments).toBe(2);
  });

  it("uses the tallest fixed column as the balanced section height", () => {
    const result = computeProblemAreaColumnFlow([
      { id: "left", height: 120, columnIndex: 0 },
      { id: "right-1", height: 80, columnIndex: 1 },
      { id: "right-2", height: 90, columnIndex: 1 },
    ], 2, 100, 10, 300, 300, 420);

    expect(result.mode).toBe("balance");
    expect(result.totalHeightPx).toBe(170);
  });

  it("fragments a tall block within its fixed column without flowing into its neighbor", () => {
    const result = computeProblemAreaColumnFlow([
      {
        id: "left-tall",
        type: "paragraph",
        height: 260,
        breakOffsets: [80, 160, 240],
        columnIndex: 0,
        columnWidthPx: 140,
        columnOffsetPx: 0,
      },
      {
        id: "right-short",
        type: "paragraph",
        height: 40,
        columnIndex: 1,
        columnWidthPx: 80,
        columnOffsetPx: 150,
      },
    ], 2, 100, 10, 100, 100, 130);

    expect(result.fragmentLayouts["left-tall"]).toEqual([
      { fragmentIndex: 0, sourceOffsetY: 0, height: 80, x: 0, y: 0, width: 140 },
      { fragmentIndex: 1, sourceOffsetY: 80, height: 80, x: 0, y: 130, width: 140 },
      { fragmentIndex: 2, sourceOffsetY: 160, height: 100, x: 0, y: 260, width: 140 },
    ]);
    expect(result.blockLayouts["right-short"]).toEqual({ x: 0, y: 0, width: 80 });
    expect(result.segments).toBe(3);
  });
});

describe("computeProblemAreaColumnFlow with a space below a block", () => {
  /** 本文フローと同じ規約 — 余白で溢れたら送るのは次のブロック、そのブロック自身ではない。 */
  const COLUMN_HEIGHT = 300;
  const PAGE_STRIDE = COLUMN_HEIGHT + 123;

  function flow(blocks: Array<{ id: string; height: number; trailingSpacePx?: number }>) {
    return computeProblemAreaColumnFlow(blocks, 2, 100, 10, COLUMN_HEIGHT, COLUMN_HEIGHT, PAGE_STRIDE);
  }

  // 合計 800px なので 2 段に均しても 1 段に収まらず、必ず flow モードになる。
  const tail = [
    { id: "c", height: 50 },
    { id: "d", height: 200 },
    { id: "e", height: 200 },
  ];

  it("keeps the block itself in its column when only its trailing space overflows", () => {
    const result = flow([
      { id: "a", height: 200 },
      { id: "b", height: 150, trailingSpacePx: 100 },
      ...tail,
    ]);

    expect(result.mode).toBe("flow");
    // 本文 50px は 1 段目に収まる (200 + 50 <= 300) ので b は動かない。
    expect(result.blockLayouts.b).toEqual({ x: 0, y: 200, width: 100 });
    // 次のブロックは余白ぶんで溢れるので次の段へ。
    expect(result.blockLayouts.c).toEqual({ x: 110, y: 0, width: 100 });
  });

  it("moves the same block without the trailing space (the space is what kept it)", () => {
    const result = flow([
      { id: "a", height: 200 },
      { id: "b", height: 150 },
      ...tail,
    ]);

    expect(result.blockLayouts.b).toEqual({ x: 110, y: 0, width: 100 });
  });

  it("still moves the block when its own content does not fit", () => {
    const result = flow([
      { id: "a", height: 200 },
      { id: "b", height: 250, trailingSpacePx: 100 },
      ...tail,
    ]);

    expect(result.blockLayouts.b).toEqual({ x: 110, y: 0, width: 100 });
  });

  it("treats a missing trailing space as 0", () => {
    const blocks = [{ id: "a", height: 200 }, { id: "b", height: 150 }, ...tail];

    expect(flow(blocks.map((block) => ({ ...block, trailingSpacePx: 0 })))).toEqual(flow(blocks));
  });
});
