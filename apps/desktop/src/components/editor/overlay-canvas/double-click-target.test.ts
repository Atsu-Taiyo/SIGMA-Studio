import { describe, expect, it } from "vitest";

import {
  findEditableTextShapeAtPoint,
  isDoubleClickTextEditShape,
  resolveDoubleClickTarget,
  type EditableTextShapeAtPointInput,
} from "./double-click-target";
import type { OverlayShape } from "./types";

function textShape(id: string, x: number, y: number, extra: Partial<OverlayShape> = {}): OverlayShape {
  return {
    id,
    type: "text",
    x,
    y,
    props: {
      w: 100,
      h: 40,
      blocks: [{ type: "paragraph", id: `${id}_p`, children: [{ type: "text", text: id }] }],
      color: "black",
      size: "m",
    },
    ...extra,
  } as OverlayShape;
}

function rectangle(id: string, x: number, y: number, extra: Partial<OverlayShape> = {}): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    props: {
      w: 200,
      h: 120,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "dashed",
      size: "m",
    },
    ...extra,
  } as OverlayShape;
}

function image(id: string, x: number, y: number, extra: Partial<OverlayShape> = {}): OverlayShape {
  return { id, type: "image", x, y, props: { w: 200, h: 120, assetId: "asset_1" }, ...extra } as OverlayShape;
}

function table(id: string, x: number, y: number): OverlayShape {
  return { id, type: "tableShape", x, y, props: { w: 200, h: 120 } } as unknown as OverlayShape;
}

function group(id: string, extra: Partial<OverlayShape> = {}): OverlayShape {
  return { id, type: "group", x: 0, y: 0, props: { w: 1, h: 1 }, ...extra } as OverlayShape;
}

const NOT_RESERVED = new Set<string>();

function find(
  shapes: OverlayShape[],
  point: { x: number; y: number },
  extra: Partial<EditableTextShapeAtPointInput> = {},
) {
  return findEditableTextShapeAtPoint({
    shapes,
    point,
    isUnselectable: () => false,
    editPolicyLockedIds: NOT_RESERVED,
    ...extra,
  });
}

// 文章 (10,10)-(110,50) の上に、画像 / 四角形 (0,0)-(200,120) が重なる配置。
const POINT_ON_TEXT = { x: 50, y: 30 };

describe("isDoubleClickTextEditShape", () => {
  it("is true for the shapes whose own text a double click edits", () => {
    expect(isDoubleClickTextEditShape(textShape("t", 0, 0))).toBe(true);
    expect(isDoubleClickTextEditShape({ ...textShape("c", 0, 0), type: "callout" } as OverlayShape)).toBe(true);
    expect(isDoubleClickTextEditShape(table("tb", 0, 0))).toBe(true);
  });

  it("is false for images, figures and plain geometry", () => {
    expect(isDoubleClickTextEditShape(image("i", 0, 0))).toBe(false);
    expect(isDoubleClickTextEditShape(rectangle("r", 0, 0))).toBe(false);
  });
});

describe("findEditableTextShapeAtPoint", () => {
  it("finds a text shape that an image covers", () => {
    const shapes = [textShape("text", 10, 10), image("cover", 0, 0)];

    expect(find(shapes, POINT_ON_TEXT)?.id).toBe("text");
  });

  it("finds a text shape that a rectangle covers", () => {
    const shapes = [textShape("text", 10, 10), rectangle("cover", 0, 0)];

    expect(find(shapes, POINT_ON_TEXT)?.id).toBe("text");
  });

  it("returns the topmost of several text shapes under the point", () => {
    const shapes = [textShape("lower", 10, 10), textShape("upper", 20, 15), image("cover", 0, 0)];

    expect(find(shapes, POINT_ON_TEXT)?.id).toBe("upper");
  });

  it("finds nothing when no text shape is under the point", () => {
    const shapes = [textShape("text", 10, 10), image("cover", 0, 0)];

    expect(find(shapes, { x: 150, y: 100 })).toBeUndefined();
    expect(find([image("cover", 0, 0)], POINT_ON_TEXT)).toBeUndefined();
  });

  it("only takes a point inside the text box, not the click margin around it", () => {
    const shapes = [textShape("text", 10, 10), image("cover", 0, 0)];

    // 文章の箱 (10..110, 10..50) の 3px 外。
    expect(find(shapes, { x: 7, y: 30 })).toBeUndefined();
  });

  it("skips hidden text, locked text (also through its group) and text the edit policy holds", () => {
    const base = [image("cover", 0, 0)];

    expect(find([textShape("t", 10, 10, { hidden: true }), ...base], POINT_ON_TEXT)).toBeUndefined();
    expect(find([textShape("t", 10, 10, { locked: true }), ...base], POINT_ON_TEXT)).toBeUndefined();
    expect(find([
      group("g", { locked: true }),
      textShape("t", 10, 10, { parentId: "g" }),
      ...base,
    ], POINT_ON_TEXT)).toBeUndefined();
    expect(find([textShape("t", 10, 10), ...base], POINT_ON_TEXT, { editPolicyLockedIds: new Set(["t"]) })).toBeUndefined();
    expect(find([textShape("t", 10, 10), ...base], POINT_ON_TEXT, { isUnselectable: (id) => id === "t" })).toBeUndefined();
  });

  it("falls through to an editable text shape below a locked one", () => {
    const shapes = [textShape("below", 10, 10), textShape("locked", 10, 10, { locked: true }), image("cover", 0, 0)];

    expect(find(shapes, POINT_ON_TEXT)?.id).toBe("below");
  });

  it("looks at text in the background layer too", () => {
    const shapes = [textShape("back", 10, 10, { stackLayer: "background" }), image("cover", 0, 0)];

    expect(find(shapes, POINT_ON_TEXT)?.id).toBe("back");
  });
});

describe("resolveDoubleClickTarget", () => {
  it("keeps a text shape on top as the target without searching", () => {
    const top = textShape("top", 10, 10);
    let searched = false;

    expect(resolveDoubleClickTarget(top, () => {
      searched = true;
      return textShape("below", 0, 0);
    })).toBe(top);
    expect(searched).toBe(false);
  });

  it("keeps a table on top: a double click edits its cells", () => {
    const top = table("table", 0, 0);

    expect(resolveDoubleClickTarget(top, () => textShape("below", 0, 0))).toBe(top);
  });

  it("goes through an image to the text below", () => {
    const cover = image("cover", 0, 0);
    const below = textShape("below", 10, 10);

    expect(resolveDoubleClickTarget(cover, () => below)).toBe(below);
  });

  it("goes through any covering shape, not only images", () => {
    const below = textShape("below", 10, 10);

    for (const cover of [
      rectangle("rect", 0, 0),
      { ...rectangle("ellipse", 0, 0), props: { ...(rectangle("e", 0, 0) as { props: object }).props, geo: "ellipse" } } as OverlayShape,
      { id: "graph", type: "graph2dShape", x: 0, y: 0, props: { w: 200, h: 120 } } as unknown as OverlayShape,
      { id: "chart", type: "chartShape", x: 0, y: 0, props: { w: 200, h: 120 } } as unknown as OverlayShape,
    ]) {
      expect(resolveDoubleClickTarget(cover, () => below)).toBe(below);
    }
  });

  it("keeps the covering shape's own double click (image crop) when no text is below", () => {
    const cover = image("cover", 0, 0);

    expect(resolveDoubleClickTarget(cover, () => undefined)).toBe(cover);
  });
});
