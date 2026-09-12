import { describe, expect, it } from "vitest";

import {
  blockLocalYToFragmentOffset,
  buildCaretFragmentTable,
  compareCaretSurfaceOrder,
  fragmentOffsetToBlockLocalY,
  nextSurfaceInVisualOrder,
  resolveCaretSurface,
  resolveVerticalMove,
  type CaretFragmentPlacement,
} from "./caret-placement";

/**
 * 断片テーブルの入力は実際には `EditorBoxBlockFragmentLayout`（描画に必要な矩形を持つ）で
 * 来る。純関数が必要とする 3 つの値だけを読み、余分な値を無視することを型でも示しておく。
 */
interface FragmentLayoutFixture extends CaretFragmentPlacement {
  blockId: string;
  totalHeight: number;
  x: number;
  y: number;
  width: number;
}

const replicas3: FragmentLayoutFixture[] = [
  { blockId: "b", fragmentIndex: 1, sourceOffsetY: 120, height: 120, totalHeight: 300, x: 0, y: 500, width: 400 },
  { blockId: "b", fragmentIndex: 2, sourceOffsetY: 240, height: 60, totalHeight: 300, x: 0, y: 900, width: 400 },
];

const table3 = buildCaretFragmentTable({ visibleHeight: 120, totalHeight: 300 }, replicas3);

/**
 * 行より低い断片 (index 1 が 10px) を挟んだテーブル。未計測フォールバックのページ割りは
 * 1px の薄い断片まで作れるので、実在しうる入力。
 */
const thinTable = buildCaretFragmentTable({ visibleHeight: 200, totalHeight: 310 }, [
  { fragmentIndex: 1, sourceOffsetY: 200, height: 10 },
  { fragmentIndex: 2, sourceOffsetY: 210, height: 100 },
]);

/** 送るだけで何も見せない断片 (高さ 0) を挟んだテーブル。 */
const emptyFragmentTable = buildCaretFragmentTable({ visibleHeight: 120, totalHeight: 300 }, [
  { fragmentIndex: 1, sourceOffsetY: 120, height: 0 },
  { fragmentIndex: 2, sourceOffsetY: 120, height: 180 },
]);

describe("buildCaretFragmentTable", () => {
  it("正本を fragmentIndex 0 として先頭に合成する", () => {
    expect(table3.fragments).toEqual([
      { fragmentIndex: 0, sourceOffsetY: 0, height: 120 },
      { fragmentIndex: 1, sourceOffsetY: 120, height: 120 },
      { fragmentIndex: 2, sourceOffsetY: 240, height: 60 },
    ]);
  });

  it("跨がないブロックは断片 1 個のテーブルになる", () => {
    expect(buildCaretFragmentTable({ visibleHeight: 80, totalHeight: 80 }, []).fragments).toHaveLength(1);
  });

  it("順不同・重複した断片を昇順の一意な並びに正す", () => {
    const table = buildCaretFragmentTable({ visibleHeight: 100, totalHeight: 300 }, [
      { fragmentIndex: 2, sourceOffsetY: 200, height: 100 },
      { fragmentIndex: 1, sourceOffsetY: 100, height: 100 },
      { fragmentIndex: 1, sourceOffsetY: 999, height: 100 },
    ]);
    expect(table.fragments).toEqual([
      { fragmentIndex: 0, sourceOffsetY: 0, height: 100 },
      { fragmentIndex: 1, sourceOffsetY: 100, height: 100 },
      { fragmentIndex: 2, sourceOffsetY: 200, height: 100 },
    ]);
  });
});

describe("resolveCaretSurface", () => {
  it("0 は正本", () => {
    expect(resolveCaretSurface(0, table3)).toEqual({ kind: "fragment", fragmentIndex: 0, localY: 0 });
  });

  it("visibleHeight 直前は正本", () => {
    expect(resolveCaretSurface(119.9, table3)).toMatchObject({ kind: "fragment", fragmentIndex: 0 });
  });

  it("localY === visibleHeight はちょうど次の断片", () => {
    expect(resolveCaretSurface(120, table3)).toMatchObject({ kind: "fragment", fragmentIndex: 1 });
  });

  it("最終断片の内部", () => {
    expect(resolveCaretSurface(299.9, table3)).toMatchObject({ kind: "fragment", fragmentIndex: 2 });
  });

  it("最終断片の下端はクランプして最終断片に落ちる", () => {
    expect(resolveCaretSurface(300, table3)).toEqual({ kind: "fragment", fragmentIndex: 2, localY: 300 });
  });

  it("負の localY は beforeBlock", () => {
    expect(resolveCaretSurface(-1, table3)).toEqual({ kind: "beforeBlock" });
  });

  it("totalHeight を超えたら afterBlock", () => {
    expect(resolveCaretSurface(300.6, table3)).toEqual({ kind: "afterBlock" });
  });

  it("advanceToNextSegment で空になった断片は宛先にならない", () => {
    const withEmpty = buildCaretFragmentTable({ visibleHeight: 120, totalHeight: 300 }, [
      { fragmentIndex: 1, sourceOffsetY: 120, height: 0 },
      { fragmentIndex: 2, sourceOffsetY: 120, height: 180 },
    ]);
    expect(resolveCaretSurface(120, withEmpty)).toMatchObject({ kind: "fragment", fragmentIndex: 2 });
  });

  it("許容誤差の範囲で下端を超えた位置はブロックの下端へ丸める", () => {
    expect(resolveCaretSurface(300.4, table3)).toEqual({ kind: "fragment", fragmentIndex: 2, localY: 300 });
  });

  it("数値でない位置は beforeBlock (黙って最終断片へ落とさない)", () => {
    expect(resolveCaretSurface(Number.NaN, table3)).toEqual({ kind: "beforeBlock" });
  });

  it("断片が 1 個だけのテーブルでも全域が正本に落ちる", () => {
    const single = buildCaretFragmentTable({ visibleHeight: 80, totalHeight: 80 }, []);
    expect([0, 40, 79.9, 80].map((localY) => resolveCaretSurface(localY, single)))
      .toMatchObject([
        { fragmentIndex: 0 },
        { fragmentIndex: 0 },
        { fragmentIndex: 0 },
        { fragmentIndex: 0 },
      ]);
  });
});

describe("blockLocalYToFragmentOffset / fragmentOffsetToBlockLocalY", () => {
  it("断片ローカル座標へ往復できる", () => {
    expect(blockLocalYToFragmentOffset(200, table3)).toBe(80);
    expect(fragmentOffsetToBlockLocalY(80, 1, table3)).toBe(200);
  });

  it("正本の localY は素通し", () => {
    expect(blockLocalYToFragmentOffset(50, table3)).toBe(50);
  });

  it("ブロック外は null", () => {
    expect(blockLocalYToFragmentOffset(-1, table3)).toBeNull();
  });

  it("断片内オフセットは断片の高さの中に収まる", () => {
    // 最終断片は高さ 60。ブロック下端 (300) はその末尾なので 60 を超えてはいけない。
    expect(blockLocalYToFragmentOffset(300, table3)).toBe(60);
  });

  it("断片の外を指す逆変換は null", () => {
    expect(fragmentOffsetToBlockLocalY(1000, 2, table3)).toBeNull();
    expect(fragmentOffsetToBlockLocalY(-50, 0, table3)).toBeNull();
    expect(fragmentOffsetToBlockLocalY(0, 9, table3)).toBeNull();
  });
});

describe("resolveVerticalMove", () => {
  it("同じ断片内にとどまる下移動は same を返す", () => {
    expect(resolveVerticalMove({ localY: 20, lineHeight: 20, direction: "down", table: table3 }))
      .toEqual({ kind: "same", fragmentIndex: 0, localY: 40 });
  });

  it("正本の最終行から下は断片 1 の先頭行へ", () => {
    expect(resolveVerticalMove({ localY: 110, lineHeight: 20, direction: "down", table: table3 }))
      .toEqual({ kind: "fragment", fragmentIndex: 1, localY: 130 });
  });

  it("断片 1 の先頭行から上は正本の最終行へ", () => {
    expect(resolveVerticalMove({ localY: 130, lineHeight: 20, direction: "up", table: table3 }))
      .toEqual({ kind: "fragment", fragmentIndex: 0, localY: 110 });
  });

  it("往復で元に戻る（対称性）", () => {
    // 断片の境界に揃った刻みだけでなく、境界からずれた開始位置と、行より低い断片を挟む
    // テーブルでも確かめる。ここが崩れると ↓↑ のたびにキャレットが 1 行ぶん流れていく。
    const cases = [
      { table: table3, lineHeight: 20, start: 0, end: 280 },
      { table: table3, lineHeight: 20, start: 7, end: 279 },
      { table: table3, lineHeight: 13.5, start: 3.25, end: 286 },
      { table: thinTable, lineHeight: 20, start: 0, end: 290 },
      { table: thinTable, lineHeight: 20, start: 5, end: 289 },
      // 行より低い断片を「跨ぐ」開始位置 (190 + 20 = 210 は index 1 の帯の外)。
      { table: thinTable, lineHeight: 20, start: 190, end: 290 },
    ];
    for (const { table, lineHeight, start, end } of cases) {
      for (let localY = start; localY <= end; localY += lineHeight) {
        const down = resolveVerticalMove({ localY, lineHeight, direction: "down", table });
        expect(down.kind === "fragment" || down.kind === "same").toBe(true);
        if (down.kind !== "fragment" && down.kind !== "same") {
          continue;
        }
        const back = resolveVerticalMove({
          localY: down.localY,
          lineHeight,
          direction: "up",
          table,
        });
        expect(back).toMatchObject({ localY });
      }
    }
  });

  it("最初の断片の先頭で上は beforeBlock", () => {
    expect(resolveVerticalMove({ localY: 5, lineHeight: 20, direction: "up", table: table3 }))
      .toEqual({ kind: "beforeBlock" });
  });

  it("最後の断片の末尾で下は afterBlock", () => {
    expect(resolveVerticalMove({ localY: 295, lineHeight: 20, direction: "down", table: table3 }))
      .toEqual({ kind: "afterBlock" });
  });

  it("行高が断片高さより大きいとき、次の断片を飛び越さない", () => {
    expect(resolveVerticalMove({ localY: 110, lineHeight: 200, direction: "down", table: table3 }))
      .toEqual({ kind: "fragment", fragmentIndex: 1, localY: 120 });
  });

  it("行より低い断片は 1 行ぶんの移動量を削らない", () => {
    // index 1 は 10px しかないので 1 行の行き先にならない。移動量を断片の高さで削ると
    // 往復のたびにキャレットが 1 行ぶん上へ流れる。
    expect(resolveVerticalMove({ localY: 190, lineHeight: 20, direction: "down", table: thinTable }))
      .toEqual({ kind: "fragment", fragmentIndex: 2, localY: 210 });
    expect(resolveVerticalMove({ localY: 210, lineHeight: 20, direction: "up", table: thinTable }))
      .toEqual({ kind: "fragment", fragmentIndex: 0, localY: 190 });
  });

  it("上移動は隣の断片の先頭へ落ちず、1 行ぶんちょうど上がる", () => {
    expect(resolveVerticalMove({ localY: 245, lineHeight: 200, direction: "up", table: table3 }))
      .toEqual({ kind: "fragment", fragmentIndex: 0, localY: 45 });
  });

  it("許容誤差より小さい移動でもブロックの外へ出ない", () => {
    expect(resolveVerticalMove({ localY: 295, lineHeight: 5.4, direction: "down", table: table3 }))
      .toEqual({ kind: "same", fragmentIndex: 2, localY: 300 });
    expect(resolveVerticalMove({ localY: 0.4, lineHeight: 0.5, direction: "up", table: table3 }))
      .toEqual({ kind: "same", fragmentIndex: 0, localY: 0 });
  });

  it("高さ 0 の断片は宛先にならず、その先の実体断片へ動く", () => {
    expect(resolveVerticalMove({ localY: 110, lineHeight: 20, direction: "down", table: emptyFragmentTable }))
      .toEqual({ kind: "fragment", fragmentIndex: 2, localY: 130 });
    // ブロックの外まで飛ぶ行高でも、高さ 0 の断片で止まらない。
    expect(resolveVerticalMove({ localY: 110, lineHeight: 400, direction: "down", table: emptyFragmentTable }))
      .toMatchObject({ kind: "fragment", fragmentIndex: 2 });
  });

  it("行高が数値でないときは動かない", () => {
    expect(resolveVerticalMove({ localY: 20, lineHeight: Number.NaN, direction: "down", table: table3 }))
      .toEqual({ kind: "same", fragmentIndex: 0, localY: 20 });
  });
});

describe("nextSurfaceInVisualOrder / compareCaretSurfaceOrder", () => {
  const surfaces = [
    { id: "unit1", order: [1] },
    { id: "unit1-frag1", order: [1, 1] },
    { id: "unit2", order: [2] },
  ];

  it("文書順タプルを辞書順で比べ、短い方が先に来る", () => {
    expect(compareCaretSurfaceOrder([1], [1, 1])).toBeLessThan(0);
    expect(compareCaretSurfaceOrder([1, 1], [2])).toBeLessThan(0);
    expect(compareCaretSurfaceOrder([2], [2])).toBe(0);
    expect(compareCaretSurfaceOrder([2], [1, 9])).toBeGreaterThan(0);
  });

  it("下方向は文書順で次の面を返す", () => {
    expect(nextSurfaceInVisualOrder(surfaces, [1], "down")).toMatchObject({ id: "unit1-frag1" });
  });

  it("上方向は文書順で前の面を返す", () => {
    expect(nextSurfaceInVisualOrder(surfaces, [2], "up")).toMatchObject({ id: "unit1-frag1" });
  });

  it("端では null", () => {
    expect(nextSurfaceInVisualOrder(surfaces, [1], "up")).toBeNull();
    expect(nextSurfaceInVisualOrder(surfaces, [2], "down")).toBeNull();
  });

  it("同値順序の候補が複数あっても先頭の 1 つに定まり、候補が空なら null", () => {
    const tied = [
      { id: "first", order: [3] },
      { id: "second", order: [3] },
    ];
    expect(nextSurfaceInVisualOrder(tied, [1], "down")).toMatchObject({ id: "first" });
    expect(nextSurfaceInVisualOrder([], [1], "down")).toBeNull();
  });
});
