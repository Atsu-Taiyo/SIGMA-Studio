// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Graph2DSpec } from "@/features/document";
import { createGraph2DSpecPreset, getGraphNumericRange, getGraphPlotBox, type GraphSpecChangeMeta } from "@/lib/graph2d";

import { Graph2DPreview } from "./Graph2DPreview";

/**
 * 切り取りモードの操作を、実際のコンポーネントに対して再現する。
 *
 * 守るもの (どれも一度は壊れた/壊れかけた):
 * - ドラッグ中は `onSpecChange` を呼ばない。途中のスペック (範囲だけ切り取り後・幅は元のまま) が
 *   文書に保存されると、確定した結果を巻き戻した。
 * - 確定はどの終わり方でも「ちょうど 1 回」。
 * - ⌥ を押している間だけ枠がプロットの外へ広がり、広げた分だけ範囲と図の大きさが増える。
 */

const PLOT_LEFT = 46;
const PLOT_TOP = 18;
const SPEC_WIDTH = 464;
const SPEC_HEIGHT = 272;
const PLOT_WIDTH = SPEC_WIDTH - PLOT_LEFT - 18; // 400
const PLOT_HEIGHT = SPEC_HEIGHT - PLOT_TOP - 34; // 220

const HANDLE_ORDER = ["tl", "tr", "bl", "br", "t", "b", "l", "r"] as const;
type HandleName = (typeof HANDLE_ORDER)[number];

function baseSpec(overrides: Partial<Graph2DSpec> = {}): Graph2DSpec {
  return {
    ...createGraph2DSpecPreset("sine"),
    width: SPEC_WIDTH,
    height: SPEC_HEIGHT,
    viewBox: { xMin: "-5", xMax: "5", yMin: "-2.75", yMax: "2.75" },
    axes: { ...createGraph2DSpecPreset("sine").axes, showTicks: false },
    ...overrides,
  };
}

interface Mounted {
  host: HTMLElement;
  root: Root;
  onSpecChange: ReturnType<typeof vi.fn>;
  onCropEnd: ReturnType<typeof vi.fn>;
  rerender: (props?: Partial<React.ComponentProps<typeof Graph2DPreview>>) => Promise<void>;
  /** 表示倍率 (ズーム)。0.5 なら画面上の 1px が SVG 座標の 2 に当たる。 */
  setScale: (scale: number) => void;
  setRotation: (radians: number) => void;
  setMatrixSupported: (supported: boolean) => void;
}

const mounted: Mounted[] = [];
let scale = 1;
/** 図が画面上で回っている角度 (rad)。 */
let rotation = 0;
/** false なら `getScreenCTM` を持たない環境 (要素の大きさの比へ戻る経路)。 */
let matrixSupported = true;

async function mount(initial: Partial<React.ComponentProps<typeof Graph2DPreview>> = {}): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onSpecChange = vi.fn<(spec: Graph2DSpec, meta?: GraphSpecChangeMeta) => void>();
  const onCropEnd = vi.fn();
  let current: Partial<React.ComponentProps<typeof Graph2DPreview>> = initial;
  const render = async () => {
    await act(async () => {
      root.render(
        <Graph2DPreview spec={baseSpec()} onSpecChange={onSpecChange} onCropEnd={onCropEnd} {...current} />,
      );
    });
  };
  await render();
  const instance: Mounted = {
    host,
    root,
    onSpecChange,
    onCropEnd,
    rerender: async (props = {}) => {
      current = { ...current, ...props };
      await render();
    },
    setScale: (value) => {
      scale = value;
    },
    setRotation: (value) => {
      rotation = value;
    },
    setMatrixSupported: (value) => {
      matrixSupported = value;
    },
  };
  mounted.push(instance);
  return instance;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  scale = 1;
  rotation = 0;
  matrixSupported = true;
  // happy-dom にはポインタキャプチャも、要素の実寸も、座標変換行列 (単位行列しか返さない) も無い。
  // 実ブラウザと同じ結果を返すよう、操作の経路に必要な分だけ用意する。
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  const getScreenCTM = function getScreenCTM() {
    if (!matrixSupported) return null;
    // svg の座標系 → 画面: 表示倍率と回転。SVG の matrix(a b c d e f) の並びで返す。
    return {
      a: scale * Math.cos(rotation),
      b: scale * Math.sin(rotation),
      c: -scale * Math.sin(rotation),
      d: scale * Math.cos(rotation),
      e: 0,
      f: 0,
    } as DOMMatrix;
  };
  // happy-dom は SVG 要素の側に (単位行列を返す) 実装を持つので、継承の上流だけの上書きでは負ける。
  for (const prototype of [Element.prototype, SVGElement.prototype, SVGSVGElement.prototype]) {
    Object.defineProperty(prototype, "getScreenCTM", { configurable: true, writable: true, value: getScreenCTM });
  }
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    // 画面上の大きさ = viewBox の大きさ × 表示倍率 (ズーム)。viewBox から読むので、幅の違う図でもそのまま動く。
    const element = this as Element;
    const viewBox = element.classList?.contains("graph2d-svg") ? element.getAttribute("viewBox")?.split(" ").map(Number) : undefined;
    const width = viewBox ? viewBox[2] * scale : 0;
    const height = viewBox ? viewBox[3] * scale : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
  };
});

afterEach(async () => {
  for (const instance of mounted.splice(0)) {
    await act(async () => instance.root.unmount());
    instance.host.remove();
  }
});

function container(m: Mounted): HTMLElement {
  return m.host.querySelector(".graph2d-container") as HTMLElement;
}
function isCropping(m: Mounted): boolean {
  return m.host.querySelector(".graph2d-container.cropping") !== null;
}
function svgOf(m: Mounted): SVGSVGElement {
  return m.host.querySelector("svg.graph2d-svg") as SVGSVGElement;
}
function handleEl(m: Mounted, name: HandleName): Element {
  return m.host.querySelectorAll("circle[fill='transparent']")[HANDLE_ORDER.indexOf(name)];
}
function boxEl(m: Mounted): SVGRectElement {
  return m.host.querySelector("rect[stroke-dasharray='4 3']") as SVGRectElement;
}
function box(m: Mounted) {
  const rect = boxEl(m);
  return {
    left: Number(rect.getAttribute("x")),
    top: Number(rect.getAttribute("y")),
    width: Number(rect.getAttribute("width")),
    height: Number(rect.getAttribute("height")),
  };
}
function expansion(m: Mounted): Element | null {
  return m.host.querySelector("[data-testid='graph2d-crop-expansion']");
}

async function fire(element: Element, type: string, init: Record<string, unknown> = {}) {
  await act(async () => {
    const Constructor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    element.dispatchEvent(new Constructor(type, { bubbles: true, cancelable: true, pointerId: 1, ...init }));
  });
}

async function enterByDoubleClick(m: Mounted) {
  await fire(container(m), "dblclick");
  expect(isCropping(m)).toBe(true);
}

/** ハンドルを掴み、(dx, dy) を `steps` 回に分けて動かす。離すところまでは行わない。 */
async function dragTo(
  m: Mounted,
  name: HandleName | "center",
  dx: number,
  dy: number,
  options: { alt?: boolean } = {},
) {
  const target = name === "center" ? boxEl(m) : handleEl(m, name);
  await fire(target, "pointerdown", { clientX: 200, clientY: 120 });
  await fire(target, "pointermove", { clientX: 200 + dx, clientY: 120 + dy, altKey: options.alt === true });
}
async function release(m: Mounted, name: HandleName | "center") {
  await fire(name === "center" ? boxEl(m) : handleEl(m, name), "pointerup");
}
/** 図の中の枠の外を押す = 確定。 */
async function pressOutsideTheBox(m: Mounted) {
  await fire(container(m), "pointerdown", { clientX: 2, clientY: 2 });
}

function committed(m: Mounted): { spec: Graph2DSpec; meta: GraphSpecChangeMeta } {
  expect(m.onSpecChange).toHaveBeenCalledTimes(1);
  const [spec, meta] = m.onSpecChange.mock.calls[0] as [Graph2DSpec, GraphSpecChangeMeta];
  return { spec, meta };
}

describe("entering crop mode", () => {
  it("opens on double click with eight handles and the one-line hint", async () => {
    const m = await mount();
    expect(isCropping(m)).toBe(false);
    expect(m.host.querySelector(".graph2d-crop-hint")).toBeNull();

    await enterByDoubleClick(m);

    expect(m.host.querySelectorAll("circle[fill='transparent']")).toHaveLength(8);
    expect(box(m)).toEqual({ left: PLOT_LEFT, top: PLOT_TOP, width: PLOT_WIDTH, height: PLOT_HEIGHT });
    expect(m.host.querySelector(".graph2d-crop-hint")?.textContent).toContain("描画範囲を拡大");
    expect(expansion(m)).toBeNull();
    expect(m.onSpecChange).not.toHaveBeenCalled();
  });

  it("does not open when cropping is disabled, static, or there is nobody to receive the result", async () => {
    const disabled = await mount({ disableCropInteraction: true });
    await fire(container(disabled), "dblclick");
    expect(isCropping(disabled)).toBe(false);

    const staticView = await mount({ staticMode: true });
    await fire(container(staticView), "dblclick");
    expect(isCropping(staticView)).toBe(false);

    const readOnly = await mount({ onSpecChange: undefined });
    await fire(container(readOnly), "dblclick");
    expect(isCropping(readOnly)).toBe(false);
  });

  it("never leaks crop UI into the static markup used for SVG export", () => {
    const html = renderToStaticMarkup(<Graph2DPreview spec={baseSpec()} staticMode />);
    expect(html).not.toContain("graph2d-crop-hint");
    expect(html).not.toContain("graph2d-crop-expansion");
    expect(html).not.toContain("cropping");
  });
});

describe("shrinking by dragging a handle", () => {
  it("writes nothing while dragging, then commits once, with the cropped size, when the box is left", async () => {
    const m = await mount();
    await enterByDoubleClick(m);

    await dragTo(m, "r", -150, 0);
    expect(box(m).width).toBeCloseTo(250, 6);
    await release(m, "r");
    // 途中経過は文書に書かない。
    expect(m.onSpecChange).not.toHaveBeenCalled();
    expect(m.onCropEnd).not.toHaveBeenCalled();
    expect(isCropping(m)).toBe(true);

    await pressOutsideTheBox(m);

    const { spec, meta } = committed(m);
    expect(spec.width).toBeCloseTo(250 + PLOT_LEFT + 18, 6);
    expect(spec.height).toBeCloseTo(SPEC_HEIGHT, 6);
    expect(meta).toMatchObject({ source: "crop", resizeToCrop: true });
    expect(meta.cropBox).toMatchObject({ left: PLOT_LEFT, top: PLOT_TOP });
    expect(meta.cropBox.width).toBeCloseTo(250, 6);
    expect(m.onCropEnd).toHaveBeenCalledTimes(1);
    expect(isCropping(m)).toBe(false);
  });

  it("keeps the scale: the cropped range is the dragged part of the original range", async () => {
    const m = await mount();
    await enterByDoubleClick(m);
    await dragTo(m, "r", -150, 0);
    await dragTo(m, "l", 80, 0);
    await pressOutsideTheBox(m);

    const range = getGraphNumericRange(committed(m).spec);
    // 元は 400px で 10 (= 0.025/px)。左を 80px、右を 150px 切ったので 170px 残る。
    expect(range.xMin).toBeCloseTo(-5 + 80 * 0.025, 4);
    expect(range.xMax).toBeCloseTo(-5 + 80 * 0.025 + 170 * 0.025, 4);
    expect(range.yMin).toBeCloseTo(-2.75, 4);
  });

  it("can also be finished by double-clicking again", async () => {
    const m = await mount();
    await enterByDoubleClick(m);
    await dragTo(m, "b", 0, -100);
    await release(m, "b");

    await fire(container(m), "dblclick");

    const { spec } = committed(m);
    expect(spec.height).toBeCloseTo(120 + PLOT_TOP + 34, 6);
    expect(isCropping(m)).toBe(false);
    expect(m.onCropEnd).toHaveBeenCalledTimes(1);
  });

  it("scales a drag by how large the graph is on screen (zoomed pages)", async () => {
    const m = await mount();
    m.setScale(0.5); // 50% 表示: 画面上の 60px は SVG 座標で 120
    await enterByDoubleClick(m);
    await dragTo(m, "r", -60, 0);
    expect(box(m).width).toBeCloseTo(PLOT_WIDTH - 120, 6);
    await release(m, "r");
    m.setScale(2); // 200% 表示: 画面上の 60px は SVG 座標で 30
    await dragTo(m, "t", 0, 60);
    expect(box(m).height).toBeCloseTo(PLOT_HEIGHT - 30, 6);
  });

  it("falls back to the element size when the environment gives no transform matrix", async () => {
    const m = await mount();
    m.setMatrixSupported(false);
    m.setScale(0.5);
    await enterByDoubleClick(m);
    await dragTo(m, "r", -60, 0);
    expect(box(m).width).toBeCloseTo(PLOT_WIDTH - 120, 6);
  });

  it("follows the pointer in the graph's own axes when the graph is turned on the page", async () => {
    const m = await mount();
    m.setRotation(Math.PI / 2); // 図の +x は画面の下向き、図の +y は画面の左向き
    await enterByDoubleClick(m);

    // 画面で上へ 100px = 図の x 軸に沿って -100。右の辺が 100 内側へ入る。
    await dragTo(m, "r", 0, -100);
    expect(box(m).width).toBeCloseTo(PLOT_WIDTH - 100, 6);
    expect(box(m).height).toBeCloseTo(PLOT_HEIGHT, 6);
    await release(m, "r");

    // 画面で右へ 40px = 図の y 軸に沿って -40 (図の下向きが画面の左)。下の辺が 40 内側へ入る。
    await dragTo(m, "b", 40, 0);
    expect(box(m).height).toBeCloseTo(PLOT_HEIGHT - 40, 6);
    expect(box(m).width).toBeCloseTo(PLOT_WIDTH - 100, 6);
  });

  it("combines a turn with the zoom", async () => {
    const m = await mount();
    m.setRotation(Math.PI / 6);
    m.setScale(2);
    await enterByDoubleClick(m);
    // 図の x 方向へ 30 (= 画面で 60px、30° 傾いた向き)。
    const screen = 60;
    await dragTo(m, "r", screen * Math.cos(Math.PI / 6), screen * Math.sin(Math.PI / 6));
    expect(box(m).width).toBeCloseTo(PLOT_WIDTH - 0, 4);
    await release(m, "r");
    await dragTo(m, "l", screen * Math.cos(Math.PI / 6), screen * Math.sin(Math.PI / 6));
    expect(box(m).left).toBeCloseTo(PLOT_LEFT + 30, 4);
    expect(box(m).top).toBeCloseTo(PLOT_TOP, 4);
  });

  it("moves the whole box inside the plot without changing its size", async () => {
    const m = await mount();
    await enterByDoubleClick(m);
    await dragTo(m, "r", -200, 0);
    await release(m, "r");
    await dragTo(m, "center", 500, 0);

    expect(box(m)).toMatchObject({ left: PLOT_LEFT + PLOT_WIDTH - 200, width: 200 });
  });

  it("leaves a graph that was never touched as it was", async () => {
    const m = await mount();
    await enterByDoubleClick(m);
    await pressOutsideTheBox(m);

    const { spec } = committed(m);
    const before = getGraphNumericRange(baseSpec());
    const after = getGraphNumericRange(spec);
    expect(spec.width).toBeCloseTo(SPEC_WIDTH, 6);
    expect(spec.height).toBeCloseTo(SPEC_HEIGHT, 6);
    expect(after.xMin).toBeCloseTo(before.xMin, 5);
    expect(after.xMax).toBeCloseTo(before.xMax, 5);
    expect(after.yMin).toBeCloseTo(before.yMin, 5);
    expect(after.yMax).toBeCloseTo(before.yMax, 5);
  });
});

describe("pressing inside the crop UI", () => {
  it("does not leave crop mode when the box or a handle is pressed", async () => {
    const m = await mount();
    await enterByDoubleClick(m);

    await fire(boxEl(m), "pointerdown", { clientX: 200, clientY: 100 });
    await fire(boxEl(m), "pointerup");
    await fire(handleEl(m, "tl"), "pointerdown", { clientX: 50, clientY: 20 });
    await fire(handleEl(m, "tl"), "pointerup");

    expect(isCropping(m)).toBe(true);
    expect(m.onSpecChange).not.toHaveBeenCalled();
    expect(m.onCropEnd).not.toHaveBeenCalled();
  });

  it("ignores pointer movement that did not start on a handle", async () => {
    const m = await mount();
    await enterByDoubleClick(m);
    await fire(svgOf(m), "pointermove", { clientX: 10, clientY: 10, altKey: true });
    expect(box(m)).toEqual({ left: PLOT_LEFT, top: PLOT_TOP, width: PLOT_WIDTH, height: PLOT_HEIGHT });
  });
});

describe("ending crop mode from the host (mode change)", () => {
  it("auto-starts when told to, and commits once when told to stop", async () => {
    const m = await mount({ autoStartCrop: true });
    expect(isCropping(m)).toBe(true);

    await dragTo(m, "r", -100, 0);
    await release(m, "r");
    expect(m.onSpecChange).not.toHaveBeenCalled();

    await m.rerender({ autoStartCrop: false });

    expect(isCropping(m)).toBe(false);
    expect(committed(m).spec.width).toBeCloseTo(300 + PLOT_LEFT + 18, 6);
  });

  it("commits only once when the box is left first and the host then stops the mode as well", async () => {
    // `transitionMode({ type: "select" })` が `onCropEnd` に続いて `autoStartCrop` を false にする経路。
    const m = await mount({ autoStartCrop: true });
    await dragTo(m, "r", -100, 0);
    await release(m, "r");

    await pressOutsideTheBox(m);
    await m.rerender({ autoStartCrop: false });

    expect(m.onSpecChange).toHaveBeenCalledTimes(1);
    expect(m.onCropEnd).toHaveBeenCalledTimes(1);
  });

  it("can be entered and committed again in a second session", async () => {
    const m = await mount({ autoStartCrop: true });
    await dragTo(m, "r", -100, 0);
    await release(m, "r");
    await m.rerender({ autoStartCrop: false });
    expect(m.onSpecChange).toHaveBeenCalledTimes(1);

    await m.rerender({ autoStartCrop: true });
    expect(isCropping(m)).toBe(true);
    await dragTo(m, "b", 0, -60);
    await release(m, "b");
    await m.rerender({ autoStartCrop: false });

    expect(m.onSpecChange).toHaveBeenCalledTimes(2);
    expect((m.onSpecChange.mock.calls[1] as [Graph2DSpec])[0].height).toBeCloseTo(PLOT_HEIGHT - 60 + PLOT_TOP + 34, 6);
  });
});

describe("widening the drawing range with the modifier key", () => {
  it("lets an edge go past the plot only while ⌥ is held, and previews the added part", async () => {
    const m = await mount();
    await enterByDoubleClick(m);

    await dragTo(m, "r", 120, 0, { alt: true });
    expect(box(m)).toEqual({ left: PLOT_LEFT, top: PLOT_TOP, width: PLOT_WIDTH + 120, height: PLOT_HEIGHT });
    expect(expansion(m)).not.toBeNull();
    // 広げる前の部分は影にならない。
    expect(m.host.querySelectorAll("rect[fill='#0f172a80']")).toHaveLength(0);
    await release(m, "r");

    await pressOutsideTheBox(m);
    const { spec, meta } = committed(m);
    expect(spec.width).toBeCloseTo(SPEC_WIDTH + 120, 6);
    expect(spec.height).toBeCloseTo(SPEC_HEIGHT, 6);
    expect(meta.cropBox.width).toBeCloseTo(PLOT_WIDTH + 120, 6);
    // 縮尺は変わらない: 1px あたり 0.025 のまま、右へ 120px 分だけ範囲が増える。
    const range = getGraphNumericRange(spec);
    expect(range.xMin).toBeCloseTo(-5, 4);
    expect(range.xMax).toBeCloseTo(5 + 120 * 0.025, 4);
  });

  it("does not widen without the modifier key, however far the handle is dragged", async () => {
    const m = await mount();
    await enterByDoubleClick(m);

    await dragTo(m, "r", 300, 0);
    await dragTo(m, "l", -300, 0);
    await dragTo(m, "t", 0, -300);
    await dragTo(m, "b", 0, 300);

    expect(expansion(m)).toBeNull();
    expect(box(m)).toEqual({ left: PLOT_LEFT, top: PLOT_TOP, width: PLOT_WIDTH, height: PLOT_HEIGHT });
    await pressOutsideTheBox(m);
    expect(committed(m).spec.width).toBeCloseTo(SPEC_WIDTH, 6);
  });

  it("falls back to the plot edge when the key is released while the handle is still held", async () => {
    const m = await mount();
    await enterByDoubleClick(m);
    const handle = handleEl(m, "r");
    await fire(handle, "pointerdown", { clientX: 200, clientY: 120 });
    await fire(handle, "pointermove", { clientX: 320, clientY: 120, altKey: true });
    expect(box(m).width).toBe(PLOT_WIDTH + 120);

    await fire(handle, "pointermove", { clientX: 320, clientY: 120, altKey: false });

    expect(box(m).width).toBe(PLOT_WIDTH);
    expect(expansion(m)).toBeNull();
  });

  it("widens on both axes from a corner and moves the origin of the shape with the left and top edges", async () => {
    const m = await mount();
    await enterByDoubleClick(m);
    await dragTo(m, "tl", -40, -30, { alt: true });
    await release(m, "tl");

    expect(box(m)).toEqual({ left: PLOT_LEFT - 40, top: PLOT_TOP - 30, width: PLOT_WIDTH + 40, height: PLOT_HEIGHT + 30 });
    await pressOutsideTheBox(m);

    const { spec, meta } = committed(m);
    expect(spec.width).toBeCloseTo(SPEC_WIDTH + 40, 6);
    expect(spec.height).toBeCloseTo(SPEC_HEIGHT + 30, 6);
    // 位置の補正 (左・上へ広げたぶん図形を左・上へずらす) は host が cropBox から行う。その入力がここで決まる。
    expect(meta.cropBox.left - PLOT_LEFT).toBeCloseTo(-40, 6);
    expect(meta.cropBox.top - PLOT_TOP).toBeCloseTo(-30, 6);
    const range = getGraphNumericRange(spec);
    expect(range.xMin).toBeCloseTo(-5 - 40 * 0.025, 4);
    expect(range.yMax).toBeCloseTo(2.75 + 30 * 0.025, 4);
  });

  it("caps the expansion at the configured room", async () => {
    const m = await mount();
    await enterByDoubleClick(m);
    await dragTo(m, "r", 10_000, 0, { alt: true });
    expect(box(m).width).toBe(PLOT_WIDTH * 2);
  });

  it("can move the whole box past the plot, which shifts the range without scaling it", async () => {
    const m = await mount();
    await enterByDoubleClick(m);
    await dragTo(m, "r", -200, 0);
    await release(m, "r");
    await dragTo(m, "center", 400, 0, { alt: true });
    await release(m, "center");
    await pressOutsideTheBox(m);

    const range = getGraphNumericRange(committed(m).spec);
    // 200px 幅の枠を、プロットの右端から 200px はみ出る位置まで動かした。
    expect(range.xMax - range.xMin).toBeCloseTo(200 * 0.025, 4);
    expect(range.xMin).toBeCloseTo(5, 4);
  });

  it("previews the curve in the added part, and only while the box is outside the plot", async () => {
    const m = await mount();
    await enterByDoubleClick(m);

    await dragTo(m, "l", -100, 0, { alt: true });
    const preview = expansion(m)!;
    expect(preview).not.toBeNull();
    const curves = preview.querySelectorAll("path[stroke]");
    expect(curves.length).toBeGreaterThan(0);
    expect(curves[0].getAttribute("d")?.length ?? 0).toBeGreaterThan(20);
    // 切り抜きは「枠 − 元のプロットと重なる部分」(evenodd で内側を抜く)。
    const clip = m.host.querySelector("clipPath path[clip-rule='evenodd']");
    expect(clip?.getAttribute("d")?.match(/M/g)).toHaveLength(2);

    // 枠をプロットの縁まで戻すと、下見は消える (掴み直すので、枠の左端はいま PLOT_LEFT - 100)。
    await release(m, "l");
    await dragTo(m, "l", 120, 0, { alt: true });
    expect(box(m).left).toBeGreaterThanOrEqual(PLOT_LEFT);
    expect(expansion(m)).toBeNull();
  });

  it("lets an already widened box be trimmed without the key", async () => {
    const m = await mount();
    await enterByDoubleClick(m);
    await dragTo(m, "r", 120, 0, { alt: true });
    await release(m, "r");

    await dragTo(m, "r", -20, 0);

    expect(box(m).width).toBe(PLOT_WIDTH + 100);
    expect(expansion(m)).not.toBeNull();
  });

  it("shades only what is cut away when one side is widened and another is cut", async () => {
    const m = await mount();
    await enterByDoubleClick(m);
    await dragTo(m, "l", -60, 0, { alt: true });
    await release(m, "l");
    await dragTo(m, "r", -100, 0);
    await release(m, "r");

    const shadows = [...m.host.querySelectorAll("rect[fill='#0f172a80']")].map((rect) => ({
      x: Number(rect.getAttribute("x")),
      width: Number(rect.getAttribute("width")),
      height: Number(rect.getAttribute("height")),
    }));
    expect(shadows).toEqual([{ x: PLOT_LEFT + PLOT_WIDTH - 100, width: 100, height: PLOT_HEIGHT }]);
  });

  it("widens a graph that has a separate display range, keeping the difference between the two ranges", async () => {
    // 表示範囲 (±4) が軸範囲 (±5) より 1 だけ内側。切り取りの初期の枠は表示範囲の領域になる。
    const spec = baseSpec({
      viewBox: { xMin: "-5", xMax: "5", yMin: "-2.75", yMax: "2.75" },
      graphViewBox: { xMin: "-4", xMax: "4", yMin: "-1.75", yMax: "1.75" },
    });
    const m = await mount({ spec });
    await enterByDoubleClick(m);
    expect(box(m).width).toBeCloseTo(320, 6);
    await dragTo(m, "r", 80, 0, { alt: true });
    await release(m, "r");
    await pressOutsideTheBox(m);

    const result = committed(m).spec;
    // 表示範囲は右へ 80px 分 (= 2) 広がり、軸範囲との差 (1) は保たれる。
    expect(Number(result.graphViewBox!.xMin)).toBeCloseTo(-4, 4);
    expect(Number(result.graphViewBox!.xMax)).toBeCloseTo(6, 4);
    expect(Number(result.viewBox.xMin)).toBeCloseTo(-5, 4);
    expect(Number(result.viewBox.xMax)).toBeCloseTo(7, 4);
  });

  it("uses the number-line plot margins for its limits", async () => {
    const numberLine = { ...createGraph2DSpecPreset("numberLine"), width: 480, height: 120 };
    const plot = getGraphPlotBox(numberLine);
    const m = await mount({ spec: numberLine });
    await enterByDoubleClick(m);
    const before = box(m);
    expect(before.left).toBeCloseTo(plot.left, 6);

    await dragTo(m, "r", 30, 0, { alt: true });
    await release(m, "r");
    await pressOutsideTheBox(m);

    expect(committed(m).spec.width).toBeCloseTo(480 + 30, 6);
  });
});
