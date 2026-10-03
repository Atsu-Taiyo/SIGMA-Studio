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
/** ロゴの入れ替わり (CSS アニメーション) が終わるのを、テストが好きな時点で起こす。 */
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

/** ロゴに「まだ終わっていない入れ替わりアニメーション」が 1 本ある状態にする。 */
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
    // 区間の長さは TS が持ち、CSS には変数で渡る (CSS 側にコピーを持たない)。
    for (const name of ["--splash-mark-in", "--splash-mark-hold", "--splash-turn", "--splash-fade-out"]) {
      expect(element?.style.getPropertyValue(name)).toMatch(/^\d+ms$/);
    }
    expect(element?.style.getPropertyValue("--splash-fade-out")).toBe(`${SPLASH_FADE_OUT_MS}ms`);
  });

  it("stays through the turn even when the app is already ready, then leaves once it has settled", async () => {
    motionPreference(false);
    introRunning();
    await mount();
    ready();

    await advance(SPLASH_MAX_VISIBLE_MS - 500);
    expect(isLeaving()).toBe(false);

    await act(async () => finishIntro());
    // 入れ替わった直後はロゴを少し残す。
    expect(isLeaving()).toBe(false);
    await advance(200);
    expect(isLeaving()).toBe(true);

    await advance(SPLASH_FADE_OUT_MS);
    expect(splash()).toBeNull();
  });

  it("waits for the app after the turn has finished", async () => {
    motionPreference(false);
    introRunning();
    await mount();

    await act(async () => finishIntro());
    await advance(1000);
    expect(isLeaving()).toBe(false);

    ready();
    expect(isLeaving()).toBe(true);
  });

  it("gives up waiting at the maximum even if neither the turn nor the app ever finishes", async () => {
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

  it("with reduced motion shows only the logo, for a short fixed time, instead of waiting for a turn", async () => {
    motionPreference(true);
    vi.spyOn(HTMLElement.prototype, "getAnimations").mockReturnValue([]);
    await mount();
    ready();

    await advance(600);
    expect(isLeaving()).toBe(false);
    await advance(200);
    expect(isLeaving()).toBe(true);
  });

  it("does not hold a turn that finished before the page was interactive", async () => {
    motionPreference(false);
    vi.spyOn(HTMLElement.prototype, "getAnimations").mockReturnValue([]);
    await mount();
    await advance(0);

    expect(isLeaving()).toBe(false);
    ready();
    expect(isLeaving()).toBe(true);
  });
});
