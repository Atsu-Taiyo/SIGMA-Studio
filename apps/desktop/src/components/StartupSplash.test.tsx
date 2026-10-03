// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_READY_EVENT,
  SPLASH_FADE_OUT_MS,
  SPLASH_MARKER_ATTRIBUTE,
  SPLASH_MAX_VISIBLE_MS,
  StartupSplash,
} from "./StartupSplash";

let root: Root;
let container: HTMLDivElement;
/** ロゴを描き終える (CSS アニメーションの終了) のを、テストが好きな時点で起こす。 */
let finishIntro: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const splash = () => document.querySelector<HTMLElement>(`[${SPLASH_MARKER_ATTRIBUTE}]`);
const isLeaving = () => splash()?.classList.contains("is-leaving") === true;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function ready() {
  act(() => {
    window.dispatchEvent(new Event(APP_READY_EVENT));
  });
}

/** ロゴに「まだ描き終わっていないアニメーション」が 1 本ある状態にする。 */
function introRunning() {
  const finished = new Promise<void>((resolve) => {
    finishIntro = resolve;
  });
  vi.spyOn(HTMLElement.prototype, "getAnimations").mockReturnValue([{ finished } as unknown as Animation]);
}

function motionPreference(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) => ({ matches: reduce && query.includes("reduce"), media: query }) as MediaQueryList,
  );
}

async function mount() {
  await act(async () => {
    root.render(<StartupSplash />);
  });
}

describe("StartupSplash", () => {
  it("shows Turn A and the Sigma Studio logo on top of each other under the startup marker", async () => {
    await mount();

    const element = splash();
    expect(element).not.toBeNull();
    expect(element?.querySelector("svg.startup-splash-mark path")).not.toBeNull();
    expect(element?.querySelector("img.startup-splash-logo")?.getAttribute("src")).toBe(
      "./brand/sigma-studio-splash.png",
    );
    // 筆は上・中・下の 3 本で、順番は CSS の `.is-*` が向き (左→右、右→左、左→右) と遅れを決める。
    const strokes = [...(element?.querySelectorAll(".startup-splash-stroke") ?? [])];
    expect(strokes.map((stroke) => stroke.className)).toEqual([
      "startup-splash-stroke is-first",
      "startup-splash-stroke is-second",
      "startup-splash-stroke is-third",
    ]);
    for (const stroke of strokes) {
      expect(stroke.querySelector(".startup-splash-sweep img")?.getAttribute("src")).toBe(
        "./brand/sigma-studio-splash.png",
      );
    }
    // 区間の長さは TS が持ち、CSS には変数で渡る (CSS 側にコピーを持たない)。
    for (const name of [
      "--splash-mark-in",
      "--splash-mark-out-at",
      "--splash-mark-out-for",
      "--splash-reveal-end",
      "--splash-fade-out",
      ...[1, 2, 3].flatMap((index) => [`--splash-stroke-${index}-at`, `--splash-stroke-${index}-for`]),
    ]) {
      expect(element?.style.getPropertyValue(name)).toMatch(/^\d+ms$/);
    }
    expect(element?.style.getPropertyValue("--splash-fade-out")).toBe(`${SPLASH_FADE_OUT_MS}ms`);
  });

  it("gives each of the three strokes its own length and its own start", async () => {
    await mount();

    const style = splash()?.style;
    const read = (name: string) => Number.parseInt(style?.getPropertyValue(name) ?? "", 10);
    const durations = [1, 2, 3].map((index) => read(`--splash-stroke-${index}-for`));
    const starts = [1, 2, 3].map((index) => read(`--splash-stroke-${index}-at`));

    // ざっ・ざっ・ざっ の拍が機械的にならないよう、長さは 3 本とも違い、始まりは順に遅れる。
    expect(new Set(durations).size).toBe(3);
    expect(starts[0]).toBeLessThan(starts[1]);
    expect(starts[1]).toBeLessThan(starts[2]);
    // 全面のロゴが現れる (描き終わる) のは、最後に終わる筆の終わりと同じ。
    expect(read("--splash-reveal-end")).toBe(Math.max(...starts.map((at, i) => at + durations[i])));
  });

  it("stays until the strokes are done even when the app is already ready, then leaves once the logo has settled", async () => {
    motionPreference(false);
    introRunning();
    await mount();
    ready();

    await advance(SPLASH_MAX_VISIBLE_MS - 500);
    expect(isLeaving()).toBe(false);

    await act(async () => finishIntro());
    // 描き終わった直後はロゴを少し残す。
    expect(isLeaving()).toBe(false);
    await advance(400);
    expect(isLeaving()).toBe(true);

    await advance(SPLASH_FADE_OUT_MS);
    expect(splash()).toBeNull();
  });

  it("waits for the app after the strokes have finished", async () => {
    motionPreference(false);
    introRunning();
    await mount();

    await act(async () => finishIntro());
    await advance(1000);
    expect(isLeaving()).toBe(false);

    ready();
    expect(isLeaving()).toBe(true);
  });

  it("gives up waiting at the maximum even if neither the strokes nor the app ever finish", async () => {
    motionPreference(false);
    introRunning();
    await mount();

    await advance(SPLASH_MAX_VISIBLE_MS - 1);
    expect(isLeaving()).toBe(false);
    await advance(1);
    expect(isLeaving()).toBe(true);
    await advance(SPLASH_FADE_OUT_MS);
    expect(splash()).toBeNull();
  });

  it("with reduced motion shows only the logo, for a short fixed time, instead of waiting for strokes", async () => {
    motionPreference(true);
    vi.spyOn(HTMLElement.prototype, "getAnimations").mockReturnValue([]);
    await mount();
    ready();

    await advance(600);
    expect(isLeaving()).toBe(false);
    await advance(200);
    expect(isLeaving()).toBe(true);
  });

  it("does not hold strokes that finished before the page was interactive", async () => {
    motionPreference(false);
    vi.spyOn(HTMLElement.prototype, "getAnimations").mockReturnValue([]);
    await mount();
    await advance(0);

    expect(isLeaving()).toBe(false);
    ready();
    expect(isLeaving()).toBe(true);
  });
});
