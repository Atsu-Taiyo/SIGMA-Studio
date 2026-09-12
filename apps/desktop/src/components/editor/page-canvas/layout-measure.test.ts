import { describe, expect, it } from "vitest";

import type { OverlayShape } from "@/components/editor/overlay-canvas/types";

import {
  calculateReserveSpaceGaps,
} from "./layout-measure";

describe("calculateReserveSpaceGaps", () => {
  it("keeps body flow independent from legacy reserveSpace overlay anchors", () => {
    const shape = {
      id: "legacy_callout",
      type: "callout",
      x: 20,
      y: 80,
      rotation: 0,
      anchor: { type: "block", blockId: "body_1", dx: 20, dy: 80, reserveSpace: true },
      props: {
        w: 320,
        h: 68,
        radius: 18,
        tail: {
          baseStart: { x: 48, y: 68 },
          baseEnd: { x: 88, y: 68 },
          tip: { x: 64, y: 96 },
        },
        blocks: [{ type: "paragraph", id: "layout_measure_test_32", children: [] }],
        color: "#111111",
        size: "m",
        dash: "solid",
        strokeWidth: "m",
      },
    } satisfies OverlayShape;

    expect(calculateReserveSpaceGaps([shape])).toEqual({});
  });
});
