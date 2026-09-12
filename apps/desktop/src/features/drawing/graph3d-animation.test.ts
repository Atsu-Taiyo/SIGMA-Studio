import { describe, expect, it } from "vitest";

import type { Graph3DParameter, Graph3DSpec } from "@/features/document";

import {
  buildGraph3DAnimationTimeline,
  graph3DAnimationCycleMs,
  graph3DAnimationMaxFrames,
  graph3DAnimationSupersample,
  graph3DAnimationValueAt,
  graph3DAnimationOverridesAt,
  graph3DHasPageAnimation,
  graph3DPageAnimationParameters,
  graph3DVideoAnimationParameters,
  graph3DVideoDurationMs,
} from "./graph3d-animation";

function parameter(overrides: Partial<Graph3DParameter> = {}): Graph3DParameter {
  return {
    id: "parameter_1",
    name: "s",
    value: 0,
    min: 0,
    max: 10,
    animation: { durationMs: 1_000, loop: "repeat" },
    ...overrides,
  };
}

function spec(parameters: Graph3DParameter[]): Graph3DSpec {
  return {
    version: 1,
    parameters,
    objects: [],
    cuts: [],
    regions: [],
    annotations: [],
    camera: {
      projection: "perspective",
      position: { x: 5, y: -5, z: 4 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
    },
    view: { coordinateSystem: "zUp", showAxes: true, showGrid: true, backgroundColor: "#ffffff" },
  };
}

describe("graph3DAnimationValueAt", () => {
  it("sweeps the parameter's own range and jumps back when it repeats", () => {
    const repeating = parameter();

    expect(graph3DAnimationValueAt(repeating, 0)).toBe(0);
    expect(graph3DAnimationValueAt(repeating, 500)).toBe(5);
    expect(graph3DAnimationValueAt(repeating, 1_200)).toBeCloseTo(2);
  });

  it("comes back on the return leg of a ping-pong", () => {
    const pingPong = parameter({ animation: { durationMs: 1_000, loop: "pingPong" } });

    expect(graph3DAnimationValueAt(pingPong, 250)).toBe(2.5);
    expect(graph3DAnimationValueAt(pingPong, 1_250)).toBe(7.5);
    expect(graph3DAnimationValueAt(pingPong, 2_250)).toBe(2.5);
  });

  it("stops at the far end when it plays once", () => {
    const once = parameter({ animation: { durationMs: 1_000, loop: "once" } });

    expect(graph3DAnimationValueAt(once, 900)).toBe(9);
    expect(graph3DAnimationValueAt(once, 9_000)).toBe(10);
  });

  it("moves across a range that does not start at zero", () => {
    const shifted = parameter({ min: -1.7, max: 1.7, animation: { durationMs: 1_000, loop: "repeat" } });

    expect(graph3DAnimationValueAt(shifted, 0)).toBe(-1.7);
    expect(graph3DAnimationValueAt(shifted, 500)).toBeCloseTo(0);
  });

  it("ping-pongs by default when a parameter carries no animation of its own", () => {
    const bare = parameter({ animation: undefined });

    expect(graph3DAnimationValueAt(bare, 0)).toBe(0);
    expect(graph3DAnimationValueAt(bare, 4_000)).toBe(10);
    expect(graph3DAnimationValueAt(bare, 6_000)).toBe(5);
    expect(graph3DAnimationCycleMs(bare)).toBe(8_000);
  });

  it("counts a ping-pong's return leg as part of one pass", () => {
    expect(graph3DAnimationCycleMs(parameter())).toBe(1_000);
    expect(graph3DAnimationCycleMs(parameter({ animation: { durationMs: 1_000, loop: "pingPong" } }))).toBe(2_000);
  });
});

describe("buildGraph3DAnimationTimeline", () => {
  it("has nothing to bake until a parameter is asked to move on the page", () => {
    const still = spec([parameter()]);

    expect(graph3DPageAnimationParameters(still)).toEqual([]);
    expect(graph3DHasPageAnimation(still)).toBe(false);
    expect(buildGraph3DAnimationTimeline(still)).toBeNull();
  });

  it("samples the loop evenly and ends before it repeats itself", () => {
    const moving = spec([parameter({
      animation: { durationMs: 900, loop: "repeat", playOnPage: true },
    })]);

    const timeline = buildGraph3DAnimationTimeline(moving);

    expect(timeline?.loopMs).toBe(900);
    expect(timeline?.frames).toHaveLength(10);
    expect(timeline?.frames[0].overrides).toEqual({ s: 0 });
    expect(timeline?.frames[9].overrides.s).toBeCloseTo(9);
    expect(timeline?.frames.every((frame) => frame.delayMs === 90)).toBe(true);
  });

  it("gives several moving parameters one shared loop, the longest pass long", () => {
    const moving = spec([
      parameter({ id: "a", name: "s", min: 0, max: 1, animation: { durationMs: 500, loop: "repeat", playOnPage: true } }),
      parameter({ id: "b", name: "t", min: 0, max: 4, animation: { durationMs: 1_000, loop: "pingPong", playOnPage: true } }),
    ]);

    const timeline = buildGraph3DAnimationTimeline(moving);

    expect(timeline?.loopMs).toBe(2_000);
    // `s` runs its 500 ms pass four times inside the shared loop; `t` goes out and back once.
    expect(timeline?.frames[0].overrides).toEqual({ s: 0, t: 0 });
    const halfway = timeline!.frames[timeline!.frames.length / 2];
    expect(halfway.overrides.s).toBeCloseTo(0);
    expect(halfway.overrides.t).toBeCloseTo(4);
  });

  it("keeps a still parameter out of the frames", () => {
    const moving = spec([
      parameter({ id: "a", name: "s", animation: { durationMs: 1_000, loop: "repeat", playOnPage: true } }),
      parameter({ id: "b", name: "t" }),
    ]);

    expect(Object.keys(buildGraph3DAnimationTimeline(moving)!.frames[0].overrides)).toEqual(["s"]);
  });

  it("never spends more frames than the caller's budget allows", () => {
    const moving = spec([parameter({
      animation: { durationMs: 8_000, loop: "repeat", playOnPage: true },
    })]);

    expect(buildGraph3DAnimationTimeline(moving)?.frames).toHaveLength(24);
    expect(buildGraph3DAnimationTimeline(moving, { maxFrames: 6 })?.frames).toHaveLength(6);
  });
});

describe("animation capture budget", () => {
  it("supersamples a small material and stops at 1:1 for a large one", () => {
    expect(graph3DAnimationSupersample(240, 200, 12)).toBe(2);
    expect(graph3DAnimationSupersample(900, 700, 24)).toBe(1);
  });

  it("trades frames away rather than the picture when a material is large", () => {
    expect(graph3DAnimationMaxFrames(240, 200)).toBe(24);
    expect(graph3DAnimationMaxFrames(1_200, 900)).toBeLessThan(24);
    expect(graph3DAnimationMaxFrames(4_000, 4_000)).toBe(4);
  });
});

describe("graph3DVideoAnimationParameters", () => {
  it("exports the page animation when the author picked one", () => {
    const moving = parameter({ id: "a", name: "a", animation: { durationMs: 1_000, loop: "repeat", playOnPage: true } });
    const still = parameter({ id: "b", name: "b" });

    expect(graph3DVideoAnimationParameters(spec([moving, still]))).toEqual([moving]);
  });

  it("moves every parameter that spans a range when nothing is marked for the page", () => {
    const first = parameter({ id: "a", name: "a" });
    const second = parameter({ id: "b", name: "b" });
    // 幅ゼロは動かしても絵が変わらない。押せるボタンの意味がなくなるので数えない。
    const fixed = parameter({ id: "c", name: "c", min: 2, max: 2 });

    expect(graph3DVideoAnimationParameters(spec([first, second, fixed]))).toEqual([first, second]);
  });

  it("has nothing to animate when no parameter spans a range", () => {
    expect(graph3DVideoAnimationParameters(spec([parameter({ min: 1, max: 1 })]))).toEqual([]);
  });
});

describe("graph3DVideoDurationMs", () => {
  it("runs for one full pass of the slowest parameter", () => {
    const quick = parameter({ id: "a", name: "a", animation: { durationMs: 2_000, loop: "repeat" } });
    // 往復は片道の2倍で1周。
    const slow = parameter({ id: "b", name: "b", animation: { durationMs: 3_000, loop: "pingPong" } });

    expect(graph3DVideoDurationMs([quick, slow])).toBe(6_000);
  });

  it("keeps the file between a usable and a sane length", () => {
    expect(graph3DVideoDurationMs([parameter({ animation: { durationMs: 100, loop: "once" } })])).toBe(1_000);
    expect(graph3DVideoDurationMs([parameter({ animation: { durationMs: 90_000, loop: "once" } })])).toBe(30_000);
    expect(graph3DVideoDurationMs([])).toBe(0);
  });
});

describe("graph3DAnimationOverridesAt", () => {
  it("reads every parameter off its own clock at the same instant", () => {
    const fast = parameter({ id: "a", name: "a", animation: { durationMs: 1_000, loop: "repeat" } });
    const slow = parameter({ id: "b", name: "b", animation: { durationMs: 2_000, loop: "repeat" } });

    expect(graph3DAnimationOverridesAt([fast, slow], 500)).toEqual({ a: 5, b: 2.5 });
  });
});
