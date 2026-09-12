import { describe, expect, expectTypeOf, it } from "vitest";

import type { OverlayInsertCommand } from "./overlay-tool";
import {
  DEFAULT_OVERLAY_SHAPE_STYLE,
  mergeStyleDefaults,
  normalizeStyleDefaults,
  pickStyleDefaultsForInsert,
  type OverlayShapeStyleDefaults,
} from "./shape-style-defaults";

/**
 * Inserting a shape used to start from hard-coded black/solid/m every time, so every change the
 * author made had to be made again on the next shape. These tests hold the two halves of the fix:
 * which axes carry between which shapes, and what may never carry at all.
 */

const REMEMBERED: OverlayShapeStyleDefaults = {
  color: "#dc2626",
  strokeOpacity: 0.6,
  dash: "dashed",
  size: "xl",
  arrowheadStart: "diamond",
  arrowheadEnd: "triangle",
  fill: "solid",
  fillColor: "#3366cc",
  fillOpacity: 0.35,
};

describe("which style a new shape starts from", () => {
  it("gives a line its stroke and its arrow heads, and no fill", () => {
    const picked = pickStyleDefaultsForInsert("line", REMEMBERED);

    expect(picked).toEqual({
      color: "#dc2626",
      strokeOpacity: 0.6,
      dash: "dashed",
      size: "xl",
      arrowheadStart: "diamond",
      arrowheadEnd: "triangle",
    });
  });

  it("gives a rectangle its stroke and its fill, and no arrow heads", () => {
    const picked = pickStyleDefaultsForInsert("rectangle", REMEMBERED);

    expect(picked).toEqual({
      color: "#dc2626",
      strokeOpacity: 0.6,
      dash: "dashed",
      size: "xl",
      fill: "solid",
      fillColor: "#3366cc",
      fillOpacity: 0.35,
    });
  });

  it("carries the same axes between a line and an arrow", () => {
    // 「線 → 矢印」「矢印 → 線」で線幅・線色が引き継がれる、が受入基準。
    expect(Object.keys(pickStyleDefaultsForInsert("arrow", REMEMBERED)).sort())
      .toEqual(Object.keys(pickStyleDefaultsForInsert("line", REMEMBERED)).sort());
  });

  it("carries only the common axes when the tool changes shape family", () => {
    const fromLine = new Set(Object.keys(pickStyleDefaultsForInsert("line", REMEMBERED)));
    const fromRectangle = new Set(Object.keys(pickStyleDefaultsForInsert("rectangle", REMEMBERED)));
    const common = [...fromLine].filter((axis) => fromRectangle.has(axis)).sort();

    expect(common).toEqual(["color", "dash", "size", "strokeOpacity"]);
  });

  it.each(["polyline", "curve", "freehand", "arc", "threePointArc"] as const)(
    "treats %s as an open shape",
    (command) => {
      expect(Object.keys(pickStyleDefaultsForInsert(command, REMEMBERED)).sort())
        .toEqual(Object.keys(pickStyleDefaultsForInsert("line", REMEMBERED)).sort());
    },
  );

  it.each(["circle", "ellipse", "triangle", "diamond", "hexagon", "blockArrow", "sector"] as const)(
    "treats %s as a closed shape",
    (command) => {
      expect(Object.keys(pickStyleDefaultsForInsert(command, REMEMBERED)).sort())
        .toEqual(Object.keys(pickStyleDefaultsForInsert("rectangle", REMEMBERED)).sort());
    },
  );

  it("sends nothing at all until the author has chosen something", () => {
    // 「まだ何も選んでいない」= 空。ここで既定色や既定の塗りを埋めてしまうと、扇形の薄い塗りや
    // 太い矢印の水色といった図形ごとの設計が、初回の挿入で上書きされて消える。
    for (const command of ["line", "arrow", "rectangle", "sector", "blockArrow"] as const) {
      expect(pickStyleDefaultsForInsert(command, DEFAULT_OVERLAY_SHAPE_STYLE)).toEqual({});
    }
  });

  it("carries an explicit 塗りなし once the author picks it", () => {
    // 「未選択」と「明示的に塗りなし」は別。後者は扇形にも効かなければならない。
    const unfilled: OverlayShapeStyleDefaults = { fill: "none" };

    expect(pickStyleDefaultsForInsert("sector", unfilled)).toEqual({ fill: "none" });
    expect(pickStyleDefaultsForInsert("rectangle", unfilled)).toEqual({ fill: "none" });
  });

  it("gives a sector the author's fill once there is one", () => {
    expect(pickStyleDefaultsForInsert("sector", REMEMBERED))
      .toMatchObject({ fill: "solid", fillColor: "#3366cc", fillOpacity: 0.35 });
  });

  it.each(["highlight", "text", "callout", "graph", "table"] as const)(
    "leaves %s on its own defaults",
    (command) => {
      expect(pickStyleDefaultsForInsert(command, REMEMBERED)).toEqual({});
    },
  );

  it("passes a zero opacity through instead of treating it as unset", () => {
    const invisible = { ...REMEMBERED, fillOpacity: 0, strokeOpacity: 0 };

    expect(pickStyleDefaultsForInsert("rectangle", invisible)).toMatchObject({ fillOpacity: 0, strokeOpacity: 0 });
    expect(pickStyleDefaultsForInsert("line", invisible)).toMatchObject({ strokeOpacity: 0 });
  });

  it("omits an axis the author never set rather than sending undefined", () => {
    expect(pickStyleDefaultsForInsert("line", { color: "#123456" })).toEqual({ color: "#123456" });
  });

  it("answers for every insert command, so a new tool cannot be forgotten", () => {
    // `STYLE_AXES_BY_COMMAND` は全網羅の Record なので、値を足すと型が落ちる。ここではその表と
    // このリストが食い違っていないことだけを確かめる。
    const commands: OverlayInsertCommand[] = [
      "rectangle", "circle", "ellipse", "triangle", "diamond",
      "pentagon", "hexagon", "heptagon", "octagon", "nonagon",
      "decagon", "hendecagon", "dodecagon", "blockArrow",
      "arc", "sector", "threePointArc", "arrow",
      "line", "polyline", "curve", "freehand",
      "highlight", "text", "callout", "graph", "table",
    ];

    for (const command of commands) {
      expect(() => pickStyleDefaultsForInsert(command, REMEMBERED)).not.toThrow();
    }
  });
});

describe("what can never be carried", () => {
  it("has no place for geometry, rotation or a label", () => {
    // 型に存在させないことが保証。値の検査ではなく型の検査。
    expectTypeOf<OverlayShapeStyleDefaults>().not.toHaveProperty("x");
    expectTypeOf<OverlayShapeStyleDefaults>().not.toHaveProperty("y");
    expectTypeOf<OverlayShapeStyleDefaults>().not.toHaveProperty("w");
    expectTypeOf<OverlayShapeStyleDefaults>().not.toHaveProperty("h");
    expectTypeOf<OverlayShapeStyleDefaults>().not.toHaveProperty("rotation");
    expectTypeOf<OverlayShapeStyleDefaults>().not.toHaveProperty("points");
    expectTypeOf<OverlayShapeStyleDefaults>().not.toHaveProperty("label");
    expectTypeOf<OverlayShapeStyleDefaults>().not.toHaveProperty("apexX");
    expectTypeOf<OverlayShapeStyleDefaults>().not.toHaveProperty("polygonSides");
  });

  it("cannot pass a geometry key through the picker either", () => {
    const smuggled = { ...REMEMBERED, w: 999, rotation: 1.5 } as OverlayShapeStyleDefaults;

    expect(pickStyleDefaultsForInsert("rectangle", smuggled)).not.toHaveProperty("w");
    expect(pickStyleDefaultsForInsert("rectangle", smuggled)).not.toHaveProperty("rotation");
  });
});

describe("what a toolbar change teaches the defaults", () => {
  it("takes only the axes the change names", () => {
    const next = mergeStyleDefaults(REMEMBERED, { size: "s" });

    expect(next).toEqual({ ...REMEMBERED, size: "s" });
  });

  it("records an opacity of zero as a change", () => {
    expect(mergeStyleDefaults(REMEMBERED, { fillOpacity: 0 }).fillOpacity).toBe(0);
    expect(mergeStyleDefaults(REMEMBERED, { strokeOpacity: 0 }).strokeOpacity).toBe(0);
  });

  it("covers every axis, so a new one cannot be silently dropped", () => {
    const flipped: OverlayShapeStyleDefaults = {
      color: "#000080",
      strokeOpacity: 0.1,
      dash: "dotted",
      size: "s",
      arrowheadStart: "bar",
      arrowheadEnd: "dot",
      fill: "none",
      fillColor: "#ffffff",
      fillOpacity: 0.9,
    };

    expect(mergeStyleDefaults(REMEMBERED, flipped)).toEqual(flipped);
  });
});

describe("reading a stored style back", () => {
  it("survives a round trip through JSON", () => {
    expect(normalizeStyleDefaults(JSON.parse(JSON.stringify(REMEMBERED)))).toEqual(REMEMBERED);
  });

  it.each([
    ["a declaration break-out", "red;background:url(//evil)"],
    ["a url()", "url(//evil)"],
    ["a data URI", "data:text/html,<script>"],
    ["a brace", "red}"],
    ["an oversized string", `#${"a".repeat(600)}`],
    ["a wrong type", 7],
  ])("refuses %s as a colour", (_label, stored) => {
    // 記憶値は色・塗り色・ラベル色の 3 箇所へ書き込まれ、そのまま教材に保存される。ここを緩めると
    // 公開ビューアが弾く教材ができあがり、その教材は二度と開けない。
    expect(normalizeStyleDefaults({ color: stored, fillColor: stored })).toEqual({});
  });

  it("accepts the colours the palette actually produces", () => {
    expect(normalizeStyleDefaults({ color: "#E60000", fillColor: "black" }))
      .toEqual({ color: "#e60000", fillColor: "black" });
  });

  it("drops an axis it cannot use rather than inventing a value for it", () => {
    // 空 = 未選択、という区別を正規化が壊さないこと。
    expect(normalizeStyleDefaults({ color: 7, dash: "wavy" })).toEqual({});
    expect(normalizeStyleDefaults({})).toEqual({});
  });

  it("accepts the arrow heads added alongside this work", () => {
    for (const head of ["triangle", "openArrow", "thinArrow", "diamond"] as const) {
      expect(normalizeStyleDefaults({ arrowheadEnd: head }).arrowheadEnd).toBe(head);
    }
  });

  it("keeps a stored zero opacity", () => {
    expect(normalizeStyleDefaults({ fillOpacity: 0, strokeOpacity: 0 }))
      .toMatchObject({ fillOpacity: 0, strokeOpacity: 0 });
  });

  it.each([
    ["a value from a newer build", { arrowheadEnd: "spiral" }],
    ["a prototype key", { arrowheadEnd: "__proto__" }],
    ["a wrong type", { arrowheadEnd: 7 }],
  ])("drops an unusable head for %s", (_label, stored) => {
    expect(normalizeStyleDefaults(stored).arrowheadEnd).toBeUndefined();
  });

  it.each([null, undefined, 42, "solid", [], { dash: "wavy", size: "xxl", color: "" }])(
    "returns an unchosen style for %s",
    (stored) => {
      expect(normalizeStyleDefaults(stored)).toEqual(DEFAULT_OVERLAY_SHAPE_STYLE);
    },
  );

  it("clamps an opacity that is out of range, and drops one that is not a number", () => {
    expect(normalizeStyleDefaults({ fillOpacity: 4 }).fillOpacity).toBe(1);
    expect(normalizeStyleDefaults({ fillOpacity: -1 }).fillOpacity).toBe(0);
    expect(normalizeStyleDefaults({ fillOpacity: Number.NaN }).fillOpacity).toBeUndefined();
  });
});
