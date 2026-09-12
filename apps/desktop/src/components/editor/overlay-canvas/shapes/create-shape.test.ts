import { describe, expect, it } from "vitest";

import {
  DEFAULT_OVERLAY_SHAPE_STYLE,
  pickStyleDefaultsForInsert,
  type OverlayInsertCommand,
} from "@/features/drawing";

import { buildInsertShape } from "./create-shape";

describe("buildInsertShape", () => {
  it.each([
    ["pentagon", 5],
    ["hexagon", 6],
    ["heptagon", 7],
    ["octagon", 8],
    ["nonagon", 9],
    ["decagon", 10],
    ["hendecagon", 11],
    ["dodecagon", 12],
  ] as const)("creates %s as a regular polygon with %i sides", (command, polygonSides) => {
    const shape = buildInsertShape(
      { kind: "insert", command },
      { x: 10, y: 20 },
      { x: 170, y: 120 },
      `shape_${command}`,
    );

    expect(shape).toMatchObject({
      type: "geo",
      x: 10,
      y: 20,
      props: { geo: "regularPolygon", polygonSides, w: 160, h: 100 },
    });
  });

  it("inserts block arrows horizontally even when the placement drag is diagonal", () => {
    const rightArrow = buildInsertShape(
      { kind: "insert", command: "blockArrow" },
      { x: 20, y: 30 },
      { x: 180, y: 90 },
      "shape:right",
    );
    const leftArrow = buildInsertShape(
      { kind: "insert", command: "blockArrow" },
      { x: 180, y: 90 },
      { x: 20, y: 30 },
      "shape:left",
    );

    expect(rightArrow).toMatchObject({
      type: "geo",
      rotation: 0,
      props: { geo: "blockArrow", w: 160, h: 60 },
    });
    expect(leftArrow).toMatchObject({
      type: "geo",
      rotation: Math.PI,
      props: { geo: "blockArrow", w: 160, h: 60 },
    });
  });

  it("uses the previous callout corner radius for both preview and insertion", () => {
    const shape = buildInsertShape(
      { kind: "insert", command: "callout", calloutRadius: 32 },
      { x: 20, y: 30 },
      { x: 220, y: 150 },
      "shape:callout",
    );

    expect(shape).toMatchObject({
      type: "callout",
      props: { w: 200, radius: 32 },
    });
  });

  it("creates a canonical 3D teaching-material shape from the selected preset", () => {
    const shape = buildInsertShape(
      { kind: "insert", command: "graph3d", graph3dPreset: "sphereTetrahedron" },
      { x: 40, y: 60 },
      { x: 440, y: 340 },
      "shape:graph3d",
    );

    expect(shape).toMatchObject({
      id: "shape:graph3d",
      type: "graph3dShape",
      x: 40,
      y: 60,
      props: {
        w: 400,
        h: 280,
        spec: {
          version: 1,
          objects: [
            expect.objectContaining({ kind: "boundedSolid" }),
            expect.objectContaining({ kind: "primitive" }),
          ],
        },
      },
    });
  });

  describe("starting from the author's last style", () => {
    const REMEMBERED = {
      color: "#dc2626",
      strokeOpacity: 0.6,
      dash: "dashed",
      size: "xl",
      arrowheadStart: "diamond",
      arrowheadEnd: "triangle",
      fill: "solid",
      fillColor: "#3366cc",
      fillOpacity: 0.35,
    } as const;

    const insert = (command: OverlayInsertCommand) => buildInsertShape(
      { kind: "insert", command },
      { x: 0, y: 0 },
      { x: 120, y: 80 },
      `shape_${command}`,
      undefined,
      false,
      pickStyleDefaultsForInsert(command, REMEMBERED),
    );

    it("keeps the built-in look when nothing is remembered", () => {
      // 非退行: 既定値を渡さない呼び出し(図形の種類変更など)は今までどおり。
      const shape = buildInsertShape(
        { kind: "insert", command: "rectangle" },
        { x: 0, y: 0 },
        { x: 120, y: 80 },
        "shape_plain",
      );

      expect(shape).toMatchObject({
        props: { color: "black", fill: "none", fillColor: "#ffffff", dash: "solid", size: "m" },
      });
      expect(shape?.props).not.toHaveProperty("strokeOpacity", 0.6);
    });

    it.each(["sector", "blockArrow"] as const)(
      "keeps %s designed the way it was until the author chooses a fill",
      (command) => {
        // 扇形の薄い塗り・太い矢印の水色は意図された設計。「まだ何も選んでいない」既定値が
        // それを塗りつぶしてしまうと、初回の挿入で見た目が変わる。
        const shape = buildInsertShape(
          { kind: "insert", command },
          { x: 0, y: 0 },
          { x: 120, y: 80 },
          `shape_${command}`,
          undefined,
          false,
          pickStyleDefaultsForInsert(command, DEFAULT_OVERLAY_SHAPE_STYLE),
        );

        expect(shape?.props).toMatchObject(command === "sector"
          ? { fill: "solid", fillColor: "#e5e7eb", fillOpacity: 0.35 }
          : { fill: "solid", fillColor: "#bfdbfe", fillOpacity: 0.85 });
      },
    );

    it("lets an explicit 塗りなし reach a sector", () => {
      const sector = buildInsertShape(
        { kind: "insert", command: "sector" },
        { x: 0, y: 0 },
        { x: 120, y: 80 },
        "shape_sector_none",
        undefined,
        false,
        pickStyleDefaultsForInsert("sector", { fill: "none" }),
      );

      expect(sector?.props).toMatchObject({ fill: "none" });
    });

    it("keeps a line headless even though an arrow is always given a head", () => {
      // 矢印の「必ず頭を付ける」下駄が線側へ漏れないこと。
      const line = buildInsertShape(
        { kind: "insert", command: "line" },
        { x: 0, y: 0 },
        { x: 120, y: 0 },
        "shape_line_plain",
        undefined,
        false,
        pickStyleDefaultsForInsert("line", DEFAULT_OVERLAY_SHAPE_STYLE),
      );

      expect(line?.props).toMatchObject({ arrowheadStart: "none", arrowheadEnd: "none" });
    });

    it("gives a rectangle the remembered stroke and fill", () => {
      expect(insert("rectangle")).toMatchObject({
        props: {
          color: "#dc2626",
          strokeOpacity: 0.6,
          dash: "dashed",
          size: "xl",
          fill: "solid",
          fillColor: "#3366cc",
          fillOpacity: 0.35,
        },
      });
    });

    it("gives a line the remembered stroke and heads", () => {
      expect(insert("line")).toMatchObject({
        props: {
          color: "#dc2626",
          dash: "dashed",
          size: "xl",
          arrowheadStart: "diamond",
          arrowheadEnd: "triangle",
        },
      });
    });

    it("carries the line width and colour across the line/arrow boundary", () => {
      const line = insert("line");
      const arrow = insert("arrow");

      expect(arrow?.props).toMatchObject({ color: "#dc2626", size: "xl", dash: "dashed" });
      expect(line?.props).toMatchObject({ color: "#dc2626", size: "xl", dash: "dashed" });
    });

    it("leaves the highlighter yellow whatever was drawn last", () => {
      expect(insert("highlight")).toMatchObject({
        props: { color: "#facc15", fillColor: "#facc15", fill: "solid", size: "m", dash: "solid" },
      });
    });

    it("gives an arc its heads and a sector the remembered fill", () => {
      expect(insert("arc")).toMatchObject({
        props: { color: "#dc2626", size: "xl", arrowheadStart: "diamond", arrowheadEnd: "triangle" },
      });
      expect(insert("sector")).toMatchObject({
        props: { fill: "solid", fillColor: "#3366cc", fillOpacity: 0.35, color: "#dc2626" },
      });
    });

    it("still gives an arrow a head when the remembered one is none", () => {
      const arrow = buildInsertShape(
        { kind: "insert", command: "arrow" },
        { x: 0, y: 0 },
        { x: 120, y: 0 },
        "shape_arrow",
        undefined,
        false,
        pickStyleDefaultsForInsert("arrow", { ...REMEMBERED, arrowheadEnd: "none" }),
      );

      expect(arrow).toMatchObject({ props: { arrowheadEnd: "arrow" } });
    });

    it("keeps a fully transparent fill", () => {
      const rectangle = buildInsertShape(
        { kind: "insert", command: "rectangle" },
        { x: 0, y: 0 },
        { x: 120, y: 80 },
        "shape_rect",
        undefined,
        false,
        pickStyleDefaultsForInsert("rectangle", { ...REMEMBERED, fillOpacity: 0 }),
      );

      expect(rectangle?.props).toMatchObject({ fillOpacity: 0 });
    });
  });
});
