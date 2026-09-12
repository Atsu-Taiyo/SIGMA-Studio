import { describe, expect, it } from "vitest";

import type { MeasuredBlock } from "@/components/editor/overlay-canvas/anchor";

import {
  getColumnContentAnchor,
  getNarrowColumnBounds,
  placeCenteredWidget,
} from "./extension-placement";

const leftColumnBlock: MeasuredBlock = {
  id: "left",
  left: 64,
  top: 120,
  width: 300,
  height: 42,
};

describe("page extension column placement", () => {
  it("uses a narrow measured block as one column but leaves full-span content inline", () => {
    expect(getNarrowColumnBounds(leftColumnBlock, 660)).toEqual({ left: 64, right: 364, width: 300 });
    expect(getNarrowColumnBounds({ ...leftColumnBlock, width: 620 }, 660)).toBeNull();
  });

  it("anchors extension content directly below the target in the same column", () => {
    expect(getColumnContentAnchor(leftColumnBlock, 660)).toEqual({
      left: 64,
      right: 364,
      width: 300,
      top: 166,
    });
  });

  it("shrinks and clamps a floating widget inside one column", () => {
    expect(placeCenteredWidget(410, 320, { left: 64, right: 364, width: 300 }, 12)).toEqual({
      center: 214,
      width: 276,
    });
  });
});
