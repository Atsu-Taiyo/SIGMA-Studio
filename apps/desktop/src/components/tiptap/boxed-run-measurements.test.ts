import { describe, expect, it } from "vitest";

import {
  assignBoxedRunTargets,
  boxedRunSegmentCount,
  collectOwnedBoxedRunSegments,
  computeBoxedRunLineConnections,
  computeBoxedRunLineTargets,
  type BoxedRunRect,
  type BoxedRunWalkItem,
} from "@/components/tiptap/boxed-text-run-height";
import type { BoxedRunDomTarget } from "@/components/tiptap/boxed-text-run-height";

/**
 * These tests pin the DOM → document-target mapping that regresses whenever the
 * boxed-run markup changes. The headline hazard: ProseMirror coalesces adjacent
 * inline atoms sharing a mark (e.g. two boxed math nodes) into ONE `.boxed-text`
 * span, so a one-span-per-target mapping silently drops the trailing run member
 * (it then renders as its own standalone box instead of joining the frame).
 *
 * `boxedRunSegmentCount` (how many targets a span stands in for) and
 * `assignBoxedRunTargets` (the slot bookkeeping) are the pure cores of that mapping;
 * the full DOM walk is covered end-to-end by tests/e2e/boxed-text-run-height.spec.ts.
 */

function rect(top: number, bottom: number): BoxedRunRect {
  return { top, bottom, height: bottom - top };
}

/** Every segment measured as the same rect — the shape the walk produced before each
 *  coalesced member got its own box. */
function boxed(r: BoxedRunRect, segmentCount: number, fallback?: BoxedRunDomTarget): BoxedRunWalkItem {
  return {
    kind: "boxed",
    segments: Array.from({ length: Math.max(1, segmentCount) }, () => [r]),
    resolveFallback: () => fallback ?? {},
  };
}

/** One rect per segment, which is what the walk produces now. */
function boxedSegments(rects: BoxedRunRect[], fallback?: BoxedRunDomTarget): BoxedRunWalkItem {
  return {
    kind: "boxed",
    segments: rects.map((r) => [r]),
    resolveFallback: () => fallback ?? {},
  };
}

function loose(r: BoxedRunRect): BoxedRunWalkItem {
  return { kind: "loose", rects: [r] };
}

function target(from: number, to: number, styleKey: string): BoxedRunDomTarget {
  return { from, to, styleKey };
}

type FakeElementSpec = {
  attributes?: string[];
  children?: FakeElementSpec[];
  classes?: string[];
};

function fakeElement({ attributes = [], children = [], classes = [] }: FakeElementSpec): Element {
  return {
    children: children.map(fakeElement),
    classList: { contains: (name: string) => classes.includes(name) },
    hasAttribute: (name: string) => attributes.includes(name),
    matches: (selector: string) => selector.split(",").some((part) => {
      const className = part.trim().startsWith(".") ? part.trim().slice(1) : "";
      return className.length > 0 && classes.includes(className);
    }),
  } as unknown as Element;
}

/** 編集面のノードビュー (数式 1 つ) を表す子。静的な数式にはこの印が無い。 */
const MATH_NODE_VIEW: FakeElementSpec = {
  attributes: ["data-inline-math-node-view"],
  classes: ["inline-math-node"],
};

function fakeMarkSpan(children: FakeElementSpec[]): Element {
  return fakeElement({ classes: ["boxed-text"], children });
}

describe("boxedRunSegmentCount", () => {
  it("counts a plain boxed text span as one segment", () => {
    expect(boxedRunSegmentCount(fakeMarkSpan([]))).toBe(1);
  });

  it("counts one segment per coalesced math node view", () => {
    expect(boxedRunSegmentCount(fakeMarkSpan([MATH_NODE_VIEW]))).toBe(1);
    expect(boxedRunSegmentCount(fakeMarkSpan([MATH_NODE_VIEW, MATH_NODE_VIEW]))).toBe(2);
    expect(boxedRunSegmentCount(fakeMarkSpan([MATH_NODE_VIEW, MATH_NODE_VIEW, MATH_NODE_VIEW]))).toBe(3);
  });

  it("counts coalesced math node views inside a styled text wrapper", () => {
    const styledMathRun = fakeElement({
      classes: ["boxed-text"],
      children: [
        {
          classes: ["styledText"],
          children: [
            MATH_NODE_VIEW,
            MATH_NODE_VIEW,
          ],
        },
      ],
    });

    expect(boxedRunSegmentCount(styledMathRun)).toBe(2);
  });

  it("does not count node views owned by a nested boxed mark", () => {
    const nestedBox = fakeElement({
      classes: ["boxed-text"],
      children: [
        {
          classes: ["boxed-text"],
          children: [MATH_NODE_VIEW],
        },
      ],
    });

    expect(boxedRunSegmentCount(nestedBox)).toBe(1);
  });

  it("ignores non-node-view children when counting", () => {
    expect(boxedRunSegmentCount(fakeMarkSpan([MATH_NODE_VIEW, { classes: ["some-wrapper"] }]))).toBe(1);
  });
});

describe("assignBoxedRunTargets", () => {
  it("maps every coalesced math segment plus the trailing text to its own target", () => {
    // `αβ=X+Yi` + `αβ` coalesce into one span (segmentCount 2); `とすると` follows.
    const mathLeft = target(1, 2, "0|double|");
    const mathRight = target(2, 3, "0|double|");
    const text = target(3, 8, "0|double|");

    const measurements = assignBoxedRunTargets(
      [boxed(rect(8, 40), 2), boxed(rect(10, 34), 1)],
      [mathLeft, mathRight, text],
    );

    expect(measurements.map((m) => m.boxedTarget)).toEqual([mathLeft, mathRight, text]);
  });

  it("connects the coalesced math + text run into one frame", () => {
    const mathLeft = target(1, 2, "0|double|");
    const mathRight = target(2, 3, "0|double|");
    const text = target(3, 8, "0|double|");

    const connections = computeBoxedRunLineConnections(
      assignBoxedRunTargets([boxed(rect(8, 40), 2), boxed(rect(10, 34), 1)], [mathLeft, mathRight, text]),
    );

    expect(connections.get(mathLeft)).toEqual({ connectLeft: false, connectRight: true });
    expect(connections.get(mathRight)).toEqual({ connectLeft: true, connectRight: true });
    expect(connections.get(text)).toEqual({ connectLeft: true, connectRight: false });
  });

  it("raises the shorter trailing text box to the shared run height", () => {
    const mathLeft = target(1, 2, "0|double|");
    const mathRight = target(2, 3, "0|double|");
    const text = target(3, 8, "0|double|");

    const targets = computeBoxedRunLineTargets(
      assignBoxedRunTargets([boxed(rect(8, 40), 2), boxed(rect(10, 34), 1)], [mathLeft, mathRight, text]),
    );

    expect(targets.get(text)).toEqual({ targetHeight: 32, ownHeight: 24, extraPaddingTop: 2, extraPaddingBottom: 6 });
    expect(targets.get(mathLeft)?.targetHeight).toBe(32);
  });

  it("keeps a text / math / text run (separate spans) connected and aligned", () => {
    const left = target(1, 2, "0|frame|");
    const math = target(2, 3, "0|frame|");
    const right = target(3, 4, "0|frame|");

    const measurements = assignBoxedRunTargets(
      [boxed(rect(4, 28), 1), boxed(rect(0, 32), 1), boxed(rect(4, 28), 1)],
      [left, math, right],
    );
    const connections = computeBoxedRunLineConnections(measurements);

    expect(measurements.map((m) => m.boxedTarget)).toEqual([left, math, right]);
    expect(connections.get(left)).toEqual({ connectLeft: false, connectRight: true });
    expect(connections.get(math)).toEqual({ connectLeft: true, connectRight: true });
    expect(connections.get(right)).toEqual({ connectLeft: true, connectRight: false });
  });

  it("does not connect boxes separated by an unboxed (loose) gap", () => {
    const a = target(1, 2, "0|frame|");
    const math = target(3, 4, "0|frame|"); // not document-adjacent to `a`

    const measurements = assignBoxedRunTargets(
      [boxed(rect(4, 28), 1), loose(rect(4, 28)), boxed(rect(0, 32), 1)],
      [a, math],
    );
    const connections = computeBoxedRunLineConnections(measurements);

    // The loose rect is measured (affects line height) but carries no target.
    expect(measurements.filter((m) => m.boxedTarget === undefined)).toHaveLength(1);
    expect(connections.has(a)).toBe(false);
    expect(connections.has(math)).toBe(false);
  });

  it("falls back to the span's own target only when document targets run short", () => {
    const fallback = target(99, 100, "0|frame|");
    const measurements = assignBoxedRunTargets([boxed(rect(0, 24), 1, fallback)], []);

    expect(measurements.map((m) => m.boxedTarget)).toEqual([fallback]);
  });
});

describe("assignBoxedRunTargets with per-segment rects", () => {
  it("gives each coalesced member its own measured rect", () => {
    // `\sum` then `\frac12`: one mark span, two document targets, two different heights.
    const tall = rect(210, 259.5);
    const short = rect(218, 249.6);
    const sum = target(1, 2, "default");
    const frac = target(2, 3, "default");

    const measurements = assignBoxedRunTargets(
      [boxedSegments([tall, short])],
      [sum, frac],
    );

    expect(measurements).toEqual([
      { ...tall, boxedTarget: sum },
      { ...short, boxedTarget: frac },
    ]);
  });

  it("still pairs a plain text span with a single target", () => {
    const only = rect(210, 228);
    const text = target(1, 3, "default");
    expect(assignBoxedRunTargets([boxedSegments([only])], [text])).toEqual([
      { ...only, boxedTarget: text },
    ]);
  });
});

describe("collectOwnedBoxedRunSegments", () => {
  it("stands in for itself when the span holds no node views", () => {
    const span = fakeMarkSpan([]);
    expect(collectOwnedBoxedRunSegments(span)).toEqual([span]);
  });

  it("returns one element per coalesced node view", () => {
    const span = fakeMarkSpan([MATH_NODE_VIEW, MATH_NODE_VIEW]);
    const segments = collectOwnedBoxedRunSegments(span);
    expect(segments).toHaveLength(2);
    expect(segments).toEqual(Array.from(span.children));
  });
});
