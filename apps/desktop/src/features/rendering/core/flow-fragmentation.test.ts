import { describe, expect, it } from "vitest";

import { fragmentFlowBlock, getFlowBlockStartHeight, isFlowBlockFragmentable, resolveFlowFragmentStep } from "./flow-fragmentation";

describe("fragmentFlowBlock coverage", () => {
  it("covers every source exactly once across page sizes, frame insets and column counts", () => {
    for (const columns of [1, 2, 3]) for (const capacity of [30, 100, 240]) {
      for (let lines = 1; lines <= 75; lines += 1) {
        const height = lines * 20;
        let region = 0, cursor = 0;
        const run = () => fragmentFlowBlock({
          height, breakOffsets: Array.from({ length: lines }, (_, i) => (i + 1) * 20), maxFragments: 200,
          region: () => ({ x: region % columns * 100, y: Math.floor(region / columns) * 300 + cursor,
            width: 90, available: capacity - cursor, fullHeight: capacity }),
          advance: () => { region += 1; cursor = 0; return true; },
          consume: (size) => { cursor += size; },
        });
        const fragments = run();
        let covered = 0;
        for (const fragment of fragments) {
          expect(fragment.sourceOffsetY).toBe(covered);
          expect(fragment.height).toBeGreaterThan(0);
          expect(fragment.height).toBeLessThanOrEqual(capacity);
          expect(fragment.height % 20).toBe(0);
          covered += fragment.height;
        }
        expect(covered).toBe(height);
        region = 0; cursor = 0;
        expect(run()).toEqual(fragments);
      }
    }
  });

  it("keeps an explicit boundary even when the entire block fits", () => {
    let page = 0, cursor = 0;
    const fragments = fragmentFlowBlock({ height: 100, forcedBreakOffsets: [40], maxFragments: 20,
      region: () => ({ x: 0, y: page * 1000 + cursor, width: 100, available: 900 - cursor, fullHeight: 900 }),
      advance: () => { page += 1; cursor = 0; return true; }, consume: (height) => { cursor += height; },
    });
    expect(fragments.map(({ sourceOffsetY, height, y }) => [sourceOffsetY, height, y])).toEqual([[0, 40, 0], [40, 60, 1000]]);
  });

  it("bounds unusable region traversal without discarding the remainder", () => {
    let advances = 0;
    const fragments = fragmentFlowBlock({ height: 400, breakOffsets: [20, 40], maxFragments: 4,
      region: () => ({ x: 0, y: advances * 10, width: 10, available: 0, fullHeight: 100 }),
      advance: () => { advances += 1; return true; }, consume: () => {},
    });
    expect(advances).toBeLessThanOrEqual(6);
    expect(fragments.reduce((sum, fragment) => sum + fragment.height, 0)).toBe(400);
  });
});

describe("resolveFlowFragmentStep", () => {
  it("honors an explicit boundary in a box even when all remaining content fits", () => {
    expect(resolveFlowFragmentStep({ available: 800, fullSegmentHeight: 900, remaining: 180, sourceOffsetY: 0, forcedBreakOffsets: [65] }))
      .toEqual({ advanceToNextSegment: false, height: 65 });
    expect(resolveFlowFragmentStep({ available: 900, fullSegmentHeight: 900, remaining: 115, sourceOffsetY: 65, forcedBreakOffsets: [65] }))
      .toEqual({ advanceToNextSegment: false, height: 115 });
  });

  it("advances instead of cutting a line that fits a fresh page", () => {
    expect(resolveFlowFragmentStep({
      available: 10,
      breakOffsets: [24, 48, 72],
      fullSegmentHeight: 100,
      remaining: 72,
      sourceOffsetY: 0,
    })).toEqual({ advanceToNextSegment: true, height: 0 });
  });

  it("keeps an over-tall visual line intact", () => {
    expect(resolveFlowFragmentStep({
      available: 100,
      breakOffsets: [140, 180],
      fullSegmentHeight: 100,
      remaining: 180,
      sourceOffsetY: 0,
    })).toEqual({ advanceToNextSegment: false, height: 140 });
  });

  it("keeps closing box chrome with the final line", () => {
    expect(resolveFlowFragmentStep({
      available: 85,
      breakOffsets: [40, 80],
      fullSegmentHeight: 100,
      remaining: 93,
      sourceOffsetY: 0,
    })).toEqual({ advanceToNextSegment: false, height: 40 });
  });
});

describe("isFlowBlockFragmentable", () => {
  it.each(["paragraph", "list", "quote", "codeBlock"])("flows a short %s only with measured internal lines", (type) => {
    expect(isFlowBlockFragmentable({ type }, 80, 100, [20, 40, 60])).toBe(true);
    expect(isFlowBlockFragmentable({ type }, 80, 100, [80])).toBe(false);
    expect(isFlowBlockFragmentable({ type }, 80, 100)).toBe(false);
  });

  it("keeps atomic figures intact even if measurement supplies internal offsets", () => {
    expect(isFlowBlockFragmentable({ type: "figure" }, 80, 100, [20, 40])).toBe(false);
  });
});

describe("getFlowBlockStartHeight", () => {
  it("keeps a problem lead with the first line, while respecting explicit keep-together", () => {
    expect(getFlowBlockStartHeight({ type: "paragraph" }, 80, 100, [20, 40, 60])).toBe(20);
    expect(getFlowBlockStartHeight({ type: "paragraph", pagination: { keepTogether: true } }, 80, 100, [20, 40, 60])).toBe(80);
    expect(getFlowBlockStartHeight({ type: "paragraph", keepTogether: true }, 80, 100, [20, 40, 60])).toBe(80);
  });
});
