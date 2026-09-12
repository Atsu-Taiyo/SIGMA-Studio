import { describe, expect, it } from "vitest";

import {
  NO_POINTER_MODIFIERS,
  resolveBodyPointerRoute,
  type BodyPointerModifiers,
} from "./body-pointer-routing";

/** 既定は「本文の上に重なった図形」— 透過の規約が効く場面。 */
function route(input: {
  hitShapeId?: string | null;
  selectedShapeIds?: readonly string[];
  pointerOverBodyText?: boolean;
  modifiers?: Partial<BodyPointerModifiers>;
}) {
  return resolveBodyPointerRoute({
    hitShapeId: input.hitShapeId ?? null,
    selectedShapeIds: input.selectedShapeIds ?? [],
    pointerOverBodyText: input.pointerOverBodyText ?? true,
    modifiers: { ...NO_POINTER_MODIFIERS, ...input.modifiers },
  });
}

describe("resolveBodyPointerRoute", () => {
  it("passes a press on an unselected shape through to the body text", () => {
    expect(route({ hitShapeId: "shape_1", selectedShapeIds: [] })).toBe("text");
  });

  it("keeps a press on an already selected shape on the shape", () => {
    expect(route({ hitShapeId: "shape_1", selectedShapeIds: ["shape_1"] })).toBe("overlayShape");
  });

  it("keeps a press on one shape of a multi-selection on the shape", () => {
    expect(route({ hitShapeId: "shape_2", selectedShapeIds: ["shape_1", "shape_2"] })).toBe("overlayShape");
  });

  it("passes a press on an unselected shape through even while another shape is selected", () => {
    expect(route({ hitShapeId: "shape_9", selectedShapeIds: ["shape_1"] })).toBe("text");
  });

  it("routes a press that hits no shape to the body text", () => {
    expect(route({ hitShapeId: null, selectedShapeIds: ["shape_1"] })).toBe("text");
  });

  it("routes Ctrl-click to the overlay so a shape can be picked up deliberately", () => {
    expect(route({ hitShapeId: "shape_1", modifiers: { ctrl: true } })).toBe("overlayShape");
  });

  it("routes Cmd-click to the overlay so a shape can be picked up deliberately", () => {
    expect(route({ hitShapeId: "shape_1", modifiers: { meta: true } })).toBe("overlayShape");
  });

  it("routes Ctrl/Cmd-click with no shape under it to the overlay for a marquee", () => {
    expect(route({ hitShapeId: null, modifiers: { ctrl: true } })).toBe("overlayShape");
    expect(route({ hitShapeId: null, modifiers: { meta: true } })).toBe("overlayShape");
  });

  it("leaves Shift-click to the body text so range selection keeps working under a shape", () => {
    expect(route({ hitShapeId: "shape_1", modifiers: { shift: true } })).toBe("text");
  });

  it("leaves Alt-click to the body text", () => {
    expect(route({ hitShapeId: "shape_1", modifiers: { alt: true } })).toBe("text");
  });

  it("hands a press with no body text under it to the shape, selected or not", () => {
    // 用紙の外・余白・本文の切れ目。透過する相手がいないので、押した物がそのまま選ばれる。
    expect(route({ hitShapeId: "shape_1", pointerOverBodyText: false })).toBe("overlayShape");
    expect(route({ hitShapeId: "shape_1", selectedShapeIds: ["shape_9"], pointerOverBodyText: false })).toBe("overlayShape");
  });

  it("still routes to the body text when nothing was hit outside the body", () => {
    expect(route({ hitShapeId: null, pointerOverBodyText: false })).toBe("text");
  });

  it("does not care about the object kind outside the body text", () => {
    // 図形・画像・表・テキスト — 種別で経路を変えない。ここに型が現れたら受入基準が壊れている。
    for (const id of ["geo_1", "image_1", "table_1", "text_1"]) {
      expect(route({ hitShapeId: id, pointerOverBodyText: false })).toBe("overlayShape");
    }
  });

  it("does not care about the shape's fill, stroke, or geometry", () => {
    // 塗り透明 / 不透明 / 線だけ の区別はヒットテスト側の関心で、経路の決め方は同じ。
    // ここに図形種別が現れたら「塗りの有無で挙動を変えない」受入基準が壊れている。
    for (const id of ["filled_rect", "transparent_rect", "bare_line"]) {
      expect(route({ hitShapeId: id, selectedShapeIds: [] })).toBe("text");
      expect(route({ hitShapeId: id, selectedShapeIds: [id] })).toBe("overlayShape");
    }
  });
});
