import { describe, expect, it } from "vitest";
import {
  cropGraphSpecToSvgBox,
  createGraph2DSpecPreset,
  getGraphNumericRange,
  getGraphPlotBox,
  mapGraphPoint,
} from "./graph2d";
import {
  clientDeltaToSvgDelta,
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

/** 再現できる擬似乱数 (mulberry32)。失敗したときに同じ入力を再現できるよう seed 固定で回す。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function expectBoxClose(actual: GraphCropRect4, expected: GraphCropRect4) {
  expect(actual.left).toBeCloseTo(expected.left, 9);
  expect(actual.top).toBeCloseTo(expected.top, 9);
  expect(actual.width).toBeCloseTo(expected.width, 9);
  expect(actual.height).toBeCloseTo(expected.height, 9);
}
type GraphCropRect4 = { left: number; top: number; width: number; height: number };

const HANDLES = ["center", "l", "r", "t", "b", "tl", "tr", "bl", "br"] as const;

describe("dragGraphCropBox invariants over random drags", () => {
  const random = createRandom(20261007);
  const between = (min: number, max: number) => min + (max - min) * random();

  function randomStartBox() {
    // プロットの内側、最小寸法以上の枠から始める (切り取りの初期状態と拡大済みの途中状態)。
    const width = between(GRAPH_CROP_MIN_SIZE, plot.right - plot.left);
    const height = between(GRAPH_CROP_MIN_SIZE, plot.bottom - plot.top);
    return {
      left: between(plot.left, plot.right - width),
      top: between(plot.top, plot.bottom - height),
      width,
      height,
    };
  }

  const cases = Array.from({ length: 400 }, (_, index) => ({
    index,
    start: randomStartBox(),
    handle: HANDLES[Math.floor(random() * HANDLES.length)],
    dx: between(-900, 900),
    dy: between(-600, 600),
    expand: random() < 0.5,
  }));

  it("never leaves the room the plot (plus the allowed expansion) gives it", () => {
    for (const { start, handle, dx, dy, expand } of cases) {
      const box = dragGraphCropBox({ start, handle, dx, dy, plot, expand });
      const roomX = expand ? (plot.right - plot.left) * GRAPH_CROP_EXPAND_RATIO : 0;
      const roomY = expand ? (plot.bottom - plot.top) * GRAPH_CROP_EXPAND_RATIO : 0;
      const context = JSON.stringify({ start, handle, dx, dy, expand, box });
      expect(box.left, context).toBeGreaterThanOrEqual(plot.left - roomX - 1e-9);
      expect(box.top, context).toBeGreaterThanOrEqual(plot.top - roomY - 1e-9);
      expect(box.left + box.width, context).toBeLessThanOrEqual(plot.right + roomX + 1e-9);
      expect(box.top + box.height, context).toBeLessThanOrEqual(plot.bottom + roomY + 1e-9);
    }
  });

  it("keeps the minimum size and only moves the edges the handle owns", () => {
    for (const { start, handle, dx, dy, expand } of cases) {
      const box = dragGraphCropBox({ start, handle, dx, dy, plot, expand });
      const context = JSON.stringify({ start, handle, dx, dy, expand, box });
      const startRight = start.left + start.width;
      const startBottom = start.top + start.height;
      expect(box.width, context).toBeGreaterThanOrEqual(GRAPH_CROP_MIN_SIZE - 1e-9);
      expect(box.height, context).toBeGreaterThanOrEqual(GRAPH_CROP_MIN_SIZE - 1e-9);

      if (handle === "center") {
        expect(box.width, context).toBeCloseTo(start.width, 9);
        expect(box.height, context).toBeCloseTo(start.height, 9);
        continue;
      }
      // 掴んでいない辺は動かない。
      if (!handle.includes("l")) expect(box.left, context).toBeCloseTo(start.left, 9);
      if (!handle.includes("r")) expect(box.left + box.width, context).toBeCloseTo(startRight, 9);
      if (!handle.includes("t")) expect(box.top, context).toBeCloseTo(start.top, 9);
      if (!handle.includes("b")) expect(box.top + box.height, context).toBeCloseTo(startBottom, 9);
    }
  });

  it("is the identity for a zero drag and never lets the modifier shrink what the plain drag allows", () => {
    for (const { start, handle, dx, dy } of cases) {
      expectBoxClose(dragGraphCropBox({ start, handle, dx: 0, dy: 0, plot, expand: false }), start);
      expectBoxClose(dragGraphCropBox({ start, handle, dx: 0, dy: 0, plot, expand: true }), start);

      // ⌥ ありの結果は、⌥ なしの結果が動ける範囲をすべて含む (⌥ を足して可動域が狭まることはない)。
      // 枠ごとの移動 ("center") は辺ではなく位置が動くので、辺ごとの比較の対象にしない
      // (`"center".includes("r")` が真になる点にも注意)。
      if (handle === "center") continue;
      const plain = dragGraphCropBox({ start, handle, dx, dy, plot, expand: false });
      const widened = dragGraphCropBox({ start, handle, dx, dy, plot, expand: true });
      const plainRight = plain.left + plain.width;
      const plainBottom = plain.top + plain.height;
      const widenedRight = widened.left + widened.width;
      const widenedBottom = widened.top + widened.height;
      if (handle.includes("l")) expect(widened.left).toBeLessThanOrEqual(plain.left + 1e-9);
      if (handle.includes("r")) expect(widenedRight).toBeGreaterThanOrEqual(plainRight - 1e-9);
      if (handle.includes("t")) expect(widened.top).toBeLessThanOrEqual(plain.top + 1e-9);
      if (handle.includes("b")) expect(widenedBottom).toBeGreaterThanOrEqual(plainBottom - 1e-9);
    }
  });

  it("is monotone: dragging further in the same direction never moves the edge back", () => {
    for (const { start, dx, expand } of cases) {
      const near = dragGraphCropBox({ start, handle: "r", dx, dy: 0, plot, expand });
      const far = dragGraphCropBox({ start, handle: "r", dx: dx + 50, dy: 0, plot, expand });
      expect(far.left + far.width).toBeGreaterThanOrEqual(near.left + near.width - 1e-9);
      const nearLeft = dragGraphCropBox({ start, handle: "l", dx, dy: 0, plot, expand });
      const farLeft = dragGraphCropBox({ start, handle: "l", dx: dx + 50, dy: 0, plot, expand });
      expect(farLeft.left).toBeGreaterThanOrEqual(nearLeft.left - 1e-9);
    }
  });
});

describe("cropping a graph spec keeps the scale for any box, shrinking or expanding", () => {
  const random = createRandom(7);
  const between = (min: number, max: number) => min + (max - min) * random();

  const kinds = [
    { name: "cartesian", build: () => ({ ...createGraph2DSpecPreset("sine"), width: 464, height: 272, viewBox: { xMin: "-6", xMax: "6", yMin: "-3", yMax: "3" } }) },
    { name: "cartesian, off-origin range", build: () => ({ ...createGraph2DSpecPreset("quadratic"), width: 520, height: 300, viewBox: { xMin: "-1", xMax: "5", yMin: "-2", yMax: "8" } }) },
    { name: "number line", build: () => ({ ...createGraph2DSpecPreset("numberLine"), width: 480, height: 120 }) },
  ];

  for (const { name, build } of kinds) {
    it(`${name}: every data point keeps its offset from the box corner, and the size is the box plus the margins`, () => {
      const spec = build();
      const plotBox = getGraphPlotBox(spec);
      const range = getGraphNumericRange(spec);
      const plotRect = {
        left: plotBox.left,
        top: plotBox.top,
        right: spec.width - plotBox.right,
        bottom: spec.height - plotBox.bottom,
      };
      const plotWidth = plotRect.right - plotRect.left;
      const plotHeight = plotRect.bottom - plotRect.top;

      for (let index = 0; index < 120; index += 1) {
        const left = between(plotRect.left - plotWidth, plotRect.right - GRAPH_CROP_MIN_SIZE);
        const top = between(plotRect.top - plotHeight, plotRect.bottom - GRAPH_CROP_MIN_SIZE);
        const box = {
          left,
          top,
          width: between(GRAPH_CROP_MIN_SIZE, plotRect.right + plotWidth - left),
          height: between(GRAPH_CROP_MIN_SIZE, plotRect.bottom + plotHeight - top),
        };
        const cropped = cropGraphSpecToSvgBox(spec, box, { resizeToCrop: true });
        const context = JSON.stringify({ name, box });
        expect(cropped, context).not.toBeNull();

        const nextPlotBox = getGraphPlotBox(cropped!);
        const nextRange = getGraphNumericRange(cropped!);
        expect(cropped!.width, context).toBeCloseTo(box.width + nextPlotBox.left + nextPlotBox.right, 6);
        expect(cropped!.height, context).toBeCloseTo(box.height + nextPlotBox.top + nextPlotBox.bottom, 6);

        // 縮尺 (1px あたりの範囲) が変わらない。
        expect((nextRange.xMax - nextRange.xMin) / box.width, context)
          .toBeCloseTo((range.xMax - range.xMin) / plotWidth, 6);
        expect((nextRange.yMax - nextRange.yMin) / box.height, context)
          .toBeCloseTo((range.yMax - range.yMin) / plotHeight, 6);

        // どのデータ点も、枠の左上からの距離が切り取りの前後で同じ (= 図が拡大・縮小されていない)。
        const point = { x: between(range.xMin, range.xMax), y: between(range.yMin, range.yMax) };
        const before = mapGraphPoint(point.x, point.y, range, spec, plotBox);
        const after = mapGraphPoint(point.x, point.y, nextRange, cropped!, nextPlotBox);
        // 範囲は文字列 (有効数字 6 桁ほど) で保存されるので、位置の誤差は 0.005px 未満に収まる。
        expect(after.x - nextPlotBox.left, context).toBeCloseTo(before.x - box.left, 2);
        expect(after.y - nextPlotBox.top, context).toBeCloseTo(before.y - box.top, 2);
      }
    });
  }

  it("expanding and then cutting the same amount back returns to the original range", () => {
    const spec = { ...createGraph2DSpecPreset("sine"), width: 464, height: 272, viewBox: { xMin: "-6", xMax: "6", yMin: "-3", yMax: "3" } };
    const plotBox = getGraphPlotBox(spec);
    const plotWidth = spec.width - plotBox.left - plotBox.right;
    const plotHeight = spec.height - plotBox.top - plotBox.bottom;
    const widened = cropGraphSpecToSvgBox(
      spec,
      { left: plotBox.left - 80, top: plotBox.top - 40, width: plotWidth + 200, height: plotHeight + 90 },
      { resizeToCrop: true },
    )!;
    const widenedPlot = getGraphPlotBox(widened);
    // 広げた結果のプロットのうち、元の図に当たる部分だけを切り取り直す。
    const restored = cropGraphSpecToSvgBox(
      widened,
      { left: widenedPlot.left + 80, top: widenedPlot.top + 40, width: plotWidth, height: plotHeight },
      { resizeToCrop: true },
    )!;
    const original = getGraphNumericRange(spec);
    const result = getGraphNumericRange(restored);
    expect(result.xMin).toBeCloseTo(original.xMin, 6);
    expect(result.xMax).toBeCloseTo(original.xMax, 6);
    expect(result.yMin).toBeCloseTo(original.yMin, 6);
    expect(result.yMax).toBeCloseTo(original.yMax, 6);
    expect(restored.width).toBeCloseTo(spec.width, 6);
    expect(restored.height).toBeCloseTo(spec.height, 6);
  });

  it("widens a separate display range together with the axis range and keeps their difference", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      width: 464,
      height: 272,
      viewBox: { xMin: "-5", xMax: "5", yMin: "-3", yMax: "3" },
      graphViewBox: { xMin: "-4", xMax: "4", yMin: "-2", yMax: "2" },
    };
    const plotBox = getGraphPlotBox(spec);
    const range = getGraphNumericRange(spec);
    const displayTopLeft = mapGraphPoint(-4, 2, range, spec, plotBox);
    const displayBottomRight = mapGraphPoint(4, -2, range, spec, plotBox);
    const box = {
      left: displayTopLeft.x - 50,
      top: displayTopLeft.y,
      width: displayBottomRight.x - displayTopLeft.x + 50 + 70,
      height: displayBottomRight.y - displayTopLeft.y,
    };
    const widened = cropGraphSpecToSvgBox(spec, box, { resizeToCrop: true })!;

    const axis = getGraphNumericRange(widened);
    const display = {
      xMin: Number(widened.graphViewBox!.xMin),
      xMax: Number(widened.graphViewBox!.xMax),
    };
    // 表示範囲は左へ 50px・右へ 70px 分だけ広がり、軸範囲との差 (左右とも 1) は保たれる。
    const perPx = 8 / (displayBottomRight.x - displayTopLeft.x);
    expect(display.xMin).toBeCloseTo(-4 - 50 * perPx, 6);
    expect(display.xMax).toBeCloseTo(4 + 70 * perPx, 6);
    expect(display.xMin - axis.xMin).toBeCloseTo(1, 6);
    expect(axis.xMax - display.xMax).toBeCloseTo(1, 6);
    expect(widened.width).toBeGreaterThan(spec.width);
  });

  it("extends a curve's explicit domain together with the range it was anchored to", () => {
    const base = createGraph2DSpecPreset("line");
    const spec = {
      ...base,
      width: 464,
      height: 272,
      viewBox: { xMin: "-5", xMax: "5", yMin: "-3", yMax: "3" },
      graphViewBox: { xMin: "-5", xMax: "5", yMin: "-3", yMax: "3" },
      curves: [{ ...base.curves[0], domain: { min: "-5", max: "5" } }],
    };
    const plotBox = getGraphPlotBox(spec);
    const range = getGraphNumericRange(spec);
    const topLeft = mapGraphPoint(-8, 3, range, spec, plotBox);
    const bottomRight = mapGraphPoint(9, -3, range, spec, plotBox);
    const widened = cropGraphSpecToSvgBox(
      spec,
      { left: topLeft.x, top: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y },
      { resizeToCrop: true },
    )!;
    // 定義域が表示範囲の端に結びついているので、範囲と一緒に端が動く。
    expect(Number(widened.curves[0].domain!.min)).toBeCloseTo(-8, 6);
    expect(Number(widened.curves[0].domain!.max)).toBeCloseTo(9, 6);
  });
});

describe("clientDeltaToSvgDelta", () => {
  const matrix = (zoom: number, radians = 0, flipX = false) => ({
    a: (flipX ? -1 : 1) * zoom * Math.cos(radians),
    b: (flipX ? -1 : 1) * zoom * Math.sin(radians),
    c: -zoom * Math.sin(radians),
    d: zoom * Math.cos(radians),
  });

  it("is the identity for an unscaled, unturned graph", () => {
    expect(clientDeltaToSvgDelta(matrix(1), 12, -7)).toEqual({ x: 12, y: -7 });
  });

  it("divides by the zoom", () => {
    expect(clientDeltaToSvgDelta(matrix(0.5), 30, 10)).toEqual({ x: 60, y: 20 });
    expect(clientDeltaToSvgDelta(matrix(2), 30, 10)).toEqual({ x: 15, y: 5 });
  });

  it("turns the pointer movement back into the graph's own axes", () => {
    // 図が 90° 回っている: 図の +x は画面の下、図の +y は画面の左。
    const quarter = clientDeltaToSvgDelta(matrix(1, Math.PI / 2), 0, 100)!;
    expect(quarter.x).toBeCloseTo(100, 9);
    expect(quarter.y).toBeCloseTo(0, 9);
    const left = clientDeltaToSvgDelta(matrix(1, Math.PI / 2), -40, 0)!;
    expect(left.x).toBeCloseTo(0, 9);
    expect(left.y).toBeCloseTo(40, 9);
  });

  it("round-trips any movement through the matrix, for any turn, zoom and flip", () => {
    const random = createRandom(11);
    for (let index = 0; index < 200; index += 1) {
      const m = matrix(0.2 + random() * 3, (random() - 0.5) * 2 * Math.PI, random() < 0.3);
      const local = { x: (random() - 0.5) * 400, y: (random() - 0.5) * 400 };
      // 図の座標 → 画面
      const client = { x: m.a * local.x + m.c * local.y, y: m.b * local.x + m.d * local.y };
      const back = clientDeltaToSvgDelta(m, client.x, client.y)!;
      expect(back.x).toBeCloseTo(local.x, 6);
      expect(back.y).toBeCloseTo(local.y, 6);
    }
  });

  it("refuses a collapsed or invalid matrix (an element that is not displayed)", () => {
    expect(clientDeltaToSvgDelta({ a: 0, b: 0, c: 0, d: 0 }, 5, 5)).toBeNull();
    expect(clientDeltaToSvgDelta({ a: 1, b: 2, c: 2, d: 4 }, 5, 5)).toBeNull();
    expect(clientDeltaToSvgDelta({ a: Number.NaN, b: 0, c: 0, d: 1 }, 5, 5)).toBeNull();
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
