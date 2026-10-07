import { describe, expect, it } from "vitest";
import {
  cropGraphSpecToSvgBox,
  createGraph2DSpecPreset,
  getGraphNumericRange,
  getGraphPlotBox,
  mapGraphPoint,
} from "./graph2d";
import {
  GRAPH_CROP_EXPAND_RATIO,
  GRAPH_CROP_MIN_SIZE,
  dragGraphCropBox,
  getGraphCropExpansionClipPath,
  getGraphCropShadowRects,
  graphCropBoxExtendsBeyondPlot,
  intersectGraphCropBoxWithPlot,
  type GraphCropPlotRect,
} from "./graph-crop-box";

const plot: GraphCropPlotRect = { left: 50, top: 20, right: 450, bottom: 220 };
const fullBox = { left: 50, top: 20, width: 400, height: 200 };

describe("dragGraphCropBox", () => {
  it("keeps edges inside the plot unless expansion is requested", () => {
    const shrunk = dragGraphCropBox({ start: fullBox, handle: "r", dx: -100, dy: 0, plot, expand: false });
    expect(shrunk).toMatchObject({ left: 50, width: 300 });

    const pushedOut = dragGraphCropBox({ start: fullBox, handle: "r", dx: 120, dy: 0, plot, expand: false });
    expect(pushedOut).toMatchObject({ left: 50, width: 400 });

    const pushedLeft = dragGraphCropBox({ start: fullBox, handle: "l", dx: -80, dy: 0, plot, expand: false });
    expect(pushedLeft).toMatchObject({ left: 50, width: 400 });
  });

  it("widens past the plot edge while expanding, on the side that was dragged", () => {
    const right = dragGraphCropBox({ start: fullBox, handle: "r", dx: 120, dy: 0, plot, expand: true });
    expect(right).toMatchObject({ left: 50, top: 20, width: 520, height: 200 });

    const left = dragGraphCropBox({ start: fullBox, handle: "l", dx: -80, dy: 0, plot, expand: true });
    expect(left).toMatchObject({ left: -30, width: 480 });

    const topLeft = dragGraphCropBox({ start: fullBox, handle: "tl", dx: -30, dy: -40, plot, expand: true });
    expect(topLeft).toMatchObject({ left: 20, top: -20, width: 430, height: 240 });

    const bottom = dragGraphCropBox({ start: fullBox, handle: "b", dx: 0, dy: 60, plot, expand: true });
    expect(bottom).toMatchObject({ top: 20, height: 260 });
  });

  it("caps the expansion at the configured ratio of the plot size", () => {
    const right = dragGraphCropBox({ start: fullBox, handle: "r", dx: 5000, dy: 0, plot, expand: true });
    expect(right.left + right.width).toBe(plot.right + 400 * GRAPH_CROP_EXPAND_RATIO);

    const top = dragGraphCropBox({ start: fullBox, handle: "t", dx: 0, dy: -5000, plot, expand: true });
    expect(top.top).toBe(plot.top - 200 * GRAPH_CROP_EXPAND_RATIO);
    expect(top.top + top.height).toBe(plot.bottom);
  });

  it("does not snap an already expanded box back to the plot edge when a handle is dragged without expansion", () => {
    const expanded = { left: -30, top: 20, width: 480, height: 200 };
    const nudged = dragGraphCropBox({ start: expanded, handle: "l", dx: 10, dy: 0, plot, expand: false });
    expect(nudged).toMatchObject({ left: -20, width: 470 });

    // ただし、そこから先 (さらに外) へは広げられない。
    const refused = dragGraphCropBox({ start: expanded, handle: "l", dx: -50, dy: 0, plot, expand: false });
    expect(refused).toMatchObject({ left: -30, width: 480 });
  });

  it("never shrinks below the minimum size", () => {
    const tiny = dragGraphCropBox({ start: fullBox, handle: "r", dx: -1000, dy: 0, plot, expand: false });
    expect(tiny.width).toBe(GRAPH_CROP_MIN_SIZE);
    const tinyLeft = dragGraphCropBox({ start: fullBox, handle: "l", dx: 1000, dy: 0, plot, expand: false });
    expect(tinyLeft.width).toBe(GRAPH_CROP_MIN_SIZE);
    expect(tinyLeft.left + tinyLeft.width).toBe(450);
  });

  it("moves the whole box, only past the plot when expanding", () => {
    const small = { left: 100, top: 60, width: 150, height: 80 };
    const inside = dragGraphCropBox({ start: small, handle: "center", dx: 2000, dy: 2000, plot, expand: false });
    expect(inside).toMatchObject({ left: 300, top: 140, width: 150, height: 80 });

    const beyond = dragGraphCropBox({ start: small, handle: "center", dx: 2000, dy: -2000, plot, expand: true });
    expect(beyond).toMatchObject({ left: 850 - 150, top: 20 - 200, width: 150, height: 80 });
  });
});

describe("graph crop box geometry", () => {
  it("reports whether the box leaves the plot", () => {
    expect(graphCropBoxExtendsBeyondPlot(fullBox, plot)).toBe(false);
    expect(graphCropBoxExtendsBeyondPlot({ left: 60, top: 30, width: 100, height: 50 }, plot)).toBe(false);
    expect(graphCropBoxExtendsBeyondPlot({ ...fullBox, width: 401 }, plot)).toBe(true);
    expect(graphCropBoxExtendsBeyondPlot({ ...fullBox, top: 10, height: 210 }, plot)).toBe(true);
  });

  it("shades exactly the part of the plot that the box cuts away", () => {
    const rects = getGraphCropShadowRects({ left: 100, top: 60, width: 200, height: 100 }, plot);
    const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    expect(area).toBeCloseTo(400 * 200 - 200 * 100);
    expect(getGraphCropShadowRects(fullBox, plot)).toEqual([]);
  });

  it("shades only the plot, not the expansion, when the box overhangs one side", () => {
    // 左へ 80 はみ出し、右は 100 切る: 切り落とされるのは右の 100 だけ。
    const rects = getGraphCropShadowRects({ left: -30, top: 20, width: 380, height: 200 }, plot);
    expect(rects).toEqual([{ x: 350, y: 20, width: 100, height: 200 }]);
  });

  it("shades the whole plot when the box lies entirely outside it", () => {
    const rects = getGraphCropShadowRects({ left: 500, top: 20, width: 100, height: 100 }, plot);
    expect(rects).toEqual([{ x: 50, y: 20, width: 400, height: 200 }]);
    expect(intersectGraphCropBoxWithPlot({ left: 500, top: 20, width: 100, height: 100 }, plot)).toBeNull();
  });

  it("builds an evenodd clip that leaves out the part already covered by the plot", () => {
    const path = getGraphCropExpansionClipPath({ left: 50, top: 20, width: 500, height: 200 }, plot);
    expect(path).toBe("M50 20h500v200h-500Z M50 20h400v200h-400Z");
    expect(getGraphCropExpansionClipPath({ left: 500, top: 20, width: 100, height: 100 }, plot))
      .toBe("M500 20h100v100h-100Z");
  });
});

describe("expanding a graph by cropping outside its plot", () => {
  it("adds drawing range and size on the dragged side while keeping the scale", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      width: 464,
      height: 272,
      viewBox: { xMin: "-5", xMax: "5", yMin: "-3", yMax: "3" },
    };
    const plotBox = getGraphPlotBox(spec);
    const plotRect = {
      left: plotBox.left,
      top: plotBox.top,
      right: spec.width - plotBox.right,
      bottom: spec.height - plotBox.bottom,
    };
    const start = {
      left: plotRect.left,
      top: plotRect.top,
      width: plotRect.right - plotRect.left,
      height: plotRect.bottom - plotRect.top,
    };
    const unitsPerPx = 10 / start.width;

    const box = dragGraphCropBox({ start, handle: "r", dx: 100, dy: 0, plot: plotRect, expand: true });
    const expanded = cropGraphSpecToSvgBox(spec, box, { resizeToCrop: true });

    expect(expanded).not.toBeNull();
    const range = getGraphNumericRange(expanded!);
    expect(range.xMin).toBeCloseTo(-5);
    expect(range.xMax).toBeCloseTo(5 + 100 * unitsPerPx);
    expect(range.yMin).toBeCloseTo(-3);
    expect(range.yMax).toBeCloseTo(3);
    expect(expanded!.width).toBeCloseTo(spec.width + 100);
    expect(expanded!.height).toBeCloseTo(spec.height);

    // 縮尺 (1 あたりのピクセル数) は変わらない: 元の x=2 は左端から同じ距離に残る。
    const before = mapGraphPoint(2, 1, getGraphNumericRange(spec), spec, plotBox);
    const after = mapGraphPoint(2, 1, range, expanded!, getGraphPlotBox(expanded!));
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
});
