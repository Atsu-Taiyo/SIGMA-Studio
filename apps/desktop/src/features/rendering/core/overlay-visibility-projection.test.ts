import { describe, expect, it } from "vitest";

import type { OverlayShape, OverlayShapeId } from "@/features/document";

import {
  getEffectiveShapeOpacity,
  getRenderableShapes,
  getRenderableShapesInVisualStackOrder,
  getShapesForStackLayer,
  isShapeInBackgroundStack,
} from "./overlay-visibility-projection";

/**
 * 索引化する前の祖先解決 (`shapes.find` 版)。等価性の基準として残す。
 * これと同じ答えを返すことが索引版の正しさの定義。
 */
function referenceAncestors(shapes: OverlayShape[], shape: OverlayShape): OverlayShape[] {
  const ancestors: OverlayShape[] = [];
  let parentId = shape.parentId;
  const seen = new Set<OverlayShapeId>([shape.id]);
  while (parentId) {
    const parent = shapes.find((candidate) => candidate.id === parentId);
    if (!parent || seen.has(parent.id)) {
      break;
    }
    ancestors.push(parent);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return ancestors;
}

function referenceHidden(shapes: OverlayShape[], shape: OverlayShape): boolean {
  return shape.hidden === true
    || referenceAncestors(shapes, shape).some((ancestor) => ancestor.hidden === true);
}

function referenceBackground(shapes: OverlayShape[], shape: OverlayShape): boolean {
  return shape.stackLayer === "background"
    || referenceAncestors(shapes, shape).some((ancestor) => ancestor.stackLayer === "background");
}

function referenceOpacity(shapes: OverlayShape[], shape: OverlayShape): number | undefined {
  let opacity = shape.opacity ?? 1;
  for (const ancestor of referenceAncestors(shapes, shape)) {
    opacity *= ancestor.opacity ?? 1;
  }
  return opacity === 1 ? undefined : opacity;
}

function shape(id: string, options: Partial<OverlayShape> = {}): OverlayShape {
  return {
    id,
    type: "geo",
    x: 0,
    y: 0,
    props: {
      w: 10,
      h: 10,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
    ...options,
  } as OverlayShape;
}

function group(id: string, options: Partial<OverlayShape> = {}): OverlayShape {
  return { id, type: "group", x: 0, y: 0, props: { w: 10, h: 10 }, ...options } as OverlayShape;
}

/** 決定的な擬似乱数 (seed 固定なので落ちたら必ず再現する)。 */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** 入れ子・隠し・背景・不透明度・循環・id 重複を混ぜた木を作る。 */
function buildTree(count: number, seed: number): OverlayShape[] {
  const random = makeRandom(seed);
  const shapes: OverlayShape[] = [];
  for (let index = 0; index < count; index += 1) {
    const isGroup = index < count / 4;
    const parentIndex = index === 0 ? -1 : Math.floor(random() * Math.min(index, count / 4));
    const options: Partial<OverlayShape> = {};
    if (parentIndex >= 0 && parentIndex < index) {
      options.parentId = `s${parentIndex}` as OverlayShapeId;
    }
    if (random() < 0.2) {
      options.hidden = true;
    }
    if (random() < 0.2) {
      options.stackLayer = "background";
    }
    if (random() < 0.3) {
      options.opacity = 0.5;
    }
    shapes.push(isGroup ? group(`s${index}`, options) : shape(`s${index}`, options));
  }
  return shapes;
}

describe("overlay visibility projection: 索引版の等価性", () => {
  it("祖先由来の hidden / background / opacity が find 版と一致する", () => {
    for (const seed of [1, 7, 99, 12345]) {
      const shapes = buildTree(200, seed);
      for (const target of shapes) {
        expect(isShapeInBackgroundStack(shapes, target)).toBe(referenceBackground(shapes, target));
        expect(getEffectiveShapeOpacity(shapes, target)).toEqual(referenceOpacity(shapes, target));
      }
      expect(getRenderableShapes(shapes).map((item) => item.id)).toEqual(
        shapes.filter((item) => item.type !== "group" && !referenceHidden(shapes, item))
          .map((item) => item.id),
      );
    }
  });

  it("親を辿る途中の循環で止まる", () => {
    const shapes = [
      group("a", { parentId: "b" as OverlayShapeId }),
      group("b", { parentId: "a" as OverlayShapeId }),
      shape("child", { parentId: "a" as OverlayShapeId, hidden: false }),
    ];
    expect(() => getRenderableShapes(shapes)).not.toThrow();
    expect(getRenderableShapes(shapes).map((item) => item.id)).toEqual(["child"]);
  });

  it("id が重複したときは find と同じく先頭を採る", () => {
    const shapes = [
      group("dup", { hidden: true }),
      group("dup", { hidden: false }),
      shape("child", { parentId: "dup" as OverlayShapeId }),
    ];
    // 先頭の "dup" は hidden なので child も隠れる。
    expect(getRenderableShapes(shapes).map((item) => item.id)).toEqual([]);
    expect(getRenderableShapes(shapes).map((item) => item.id))
      .toEqual(shapes.filter((item) => item.type !== "group" && !referenceHidden(shapes, item))
        .map((item) => item.id));
  });

  it("背景 / 前景の振り分けが find 版と一致する", () => {
    const shapes = buildTree(150, 42);
    for (const layer of ["background", "foreground"] as const) {
      const expected = layer === "foreground"
        ? shapes.filter((item) => !referenceBackground(shapes, item))
        : (() => {
          const ids = new Set<OverlayShapeId>();
          for (const item of shapes) {
            if (!referenceBackground(shapes, item)) {
              continue;
            }
            ids.add(item.id);
            for (const ancestor of referenceAncestors(shapes, item)) {
              ids.add(ancestor.id);
            }
          }
          return shapes.filter((item) => ids.has(item.id));
        })();
      expect(getShapesForStackLayer(shapes, layer).map((item) => item.id))
        .toEqual(expected.map((item) => item.id));
    }
  });

  it("視覚スタック順の描画対象が find 版と一致する", () => {
    const shapes = buildTree(120, 2024);
    const background = shapes.filter((item) => referenceBackground(shapes, item));
    const foreground = shapes.filter((item) => !referenceBackground(shapes, item));
    const expected = [...background, ...foreground]
      .filter((item) => item.type !== "group" && !referenceHidden(shapes, item));
    expect(getRenderableShapesInVisualStackOrder(shapes).map((item) => item.id))
      .toEqual(expected.map((item) => item.id));
  });
});

/**
 * 計測は時間でなく `id` の読み取り回数で行う。時間だと環境で揺れるうえ、
 * 「4 倍にして何倍か」を見ても JIT の暖まりに引きずられるため。
 * find 版は figure ごとに配列を舐めるので読み取りが O(S^2) になる。
 */
function countIdReads(count: number, run: (shapes: OverlayShape[]) => void): number {
  let reads = 0;
  const shapes = buildTree(count, 7).map((item) => {
    const id = item.id;
    const tracked = { ...item } as OverlayShape;
    Object.defineProperty(tracked, "id", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return id;
      },
    });
    return tracked;
  });
  run(shapes);
  return reads;
}

describe("overlay visibility projection: 図形数に対して線形", () => {
  it("1000 図形の描画対象抽出で id 読み取りが線形に収まる", () => {
    const small = countIdReads(250, (shapes) => void getRenderableShapes(shapes));
    const large = countIdReads(1000, (shapes) => void getRenderableShapes(shapes));

    // 線形なら 4 倍前後。find 版は 16 倍前後になるので、その手前で線を引く。
    expect(large / small).toBeLessThan(8);
    // 図形あたりの読み取り回数が図形数に比例して増えないこと。
    expect(large / 1000).toBeLessThan(small / 250 * 2);
  });

  it("図形ごとに呼ばれる不透明度解決でも索引が使い回される", () => {
    const small = countIdReads(250, (shapes) => {
      for (const item of shapes) {
        getEffectiveShapeOpacity(shapes, item);
      }
    });
    const large = countIdReads(1000, (shapes) => {
      for (const item of shapes) {
        getEffectiveShapeOpacity(shapes, item);
      }
    });
    expect(large / small).toBeLessThan(8);
  });
});
