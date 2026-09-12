import { describe, expect, it } from "vitest";

import {
  decidePagination,
  detectGapOscillation,
  gapMapSignature,
  occupiedPageCount,
  roundPaginationGap,
  type PaginationItem,
} from "./pagination-decisions";

const ENV = { contentHeightPx: 1000, pageStride: 1100 };

function block(gapKey: string, topNat: number, height: number, extra: Partial<PaginationItem> = {}): PaginationItem {
  return { kind: "block", gapKey, topNat, height, ...extra };
}

function atomicProblemArea(
  gapKey: string,
  topNat: number,
  height: number,
  extra: Partial<PaginationItem> = {},
): PaginationItem {
  return { kind: "atomicProblemArea", gapKey, topNat, height, ...extra };
}

describe("roundPaginationGap", () => {
  it("ignores sub-pixel noise and rounds everything else", () => {
    expect(roundPaginationGap(0.4)).toBe(0);
    expect(roundPaginationGap(-0.5)).toBe(0);
    expect(roundPaginationGap(113.6)).toBe(114);
    expect(roundPaginationGap(-4.2)).toBe(-4);
  });
});

describe("occupiedPageCount", () => {
  it("counts how many page strides an item covers", () => {
    expect(occupiedPageCount(0, 1100)).toBe(1);
    expect(occupiedPageCount(1099, 1100)).toBe(1);
    expect(occupiedPageCount(1100, 1100)).toBe(1);
    expect(occupiedPageCount(1101, 1100)).toBe(2);
    expect(occupiedPageCount(2400, 1100)).toBe(3);
  });
});

describe("decidePagination", () => {
  it("reserves split-frame chrome before accepting a block at the page bottom", () => {
    const fits = decidePagination([
      block("intro", 0, 900),
      block("framed", 900, 92, { fragmentEndSpacePx: 8 }),
    ], ENV, {});
    const overflows = decidePagination([
      block("intro", 0, 900),
      block("framed", 900, 92, { fragmentEndSpacePx: 9 }),
    ], ENV, {});
    const repeated = decidePagination([
      block("intro", 0, 900),
      block("framed", 900, 92, { fragmentEndSpacePx: 9 }),
    ], ENV, {});

    expect(fits.gaps.framed).toBeUndefined();
    expect(overflows.gaps.framed).toBe(200);
    expect(repeated).toEqual(overflows);
  });

  it("is idempotent for a framed prompt taller than a page", () => {
    // 高さは gap-free (エリア内部の spacer を除いた値) で渡す契約なので、
    // 何パス回しても同じ入力 → 同じ gaps でなければならない。
    const items = [
      block("intro", 0, 900),
      atomicProblemArea("prompt_tall", 900, 2400),
      block("after", 3300, 100),
    ];
    const first = decidePagination(items, ENV, {});
    const second = decidePagination(items, ENV, {});
    expect(first.gaps).toEqual(second.gaps);
    expect(first.pageCount).toBe(second.pageCount);
  });

  it("reaches the same decision whether the previous pass applied 0 or 114px of gap", () => {
    // 呼び出し側は測定値から適用済み gap を引いて topNat を作る。つまり前パスの出力は
    // 入力に現れない — これが往復 (114⇔4) を止める本体。
    const gapFree = [atomicProblemArea("prompt_tall", 900, 2400), block("after", 3300, 100)];
    const withApplied = [atomicProblemArea("prompt_tall", 900, 2400), block("after", 3300, 100)];
    expect(decidePagination(gapFree, ENV, {})).toEqual(decidePagination(withApplied, ENV, {}));
  });

  it("keeps an over-tall framed prompt whole and starts it on a fresh page", () => {
    const result = decidePagination(
      [block("intro", 0, 900), atomicProblemArea("prompt_tall", 900, 2400)],
      ENV,
      {},
    );
    // 900 から始めると 1 ページ目に収まらないので次ページ頭へ送る。
    expect(result.gaps.prompt_tall).toBe(200);
  });

  it("advances the page cursor across every page the over-tall problem covers", () => {
    const result = decidePagination(
      [block("intro", 0, 900), atomicProblemArea("prompt_tall", 900, 2400), block("after", 3300, 100)],
      ENV,
      {},
    );
    // 問題は 3 ページを占有する。後続ブロックはその最後のページの続きに置かれるので、
    // 「まだ 2 ページ目にいる」という前提で押し出されてはいけない。
    expect(result.gaps.after ?? 0).toBe(0);
    expect(result.pageCount).toBe(4);
  });

  it("does not over-advance for a problem that only just exceeds the content area", () => {
    // 高さ 1050 は「コンテンツ高さ (1000) は超えるが、ページの送り幅 (1100) には収まる」。
    // ここでカーソルを 2 ページ進めると、空ページが 1 枚増え、後続が常にページ頭扱いになる。
    const result = decidePagination(
      [atomicProblemArea("prompt_tall", 0, 1050), block("after", 1050, 200)],
      ENV,
      {},
    );
    expect(result.pageCount).toBe(2);
    expect(result.gaps.after).toBe(50);
  });

  it("walks a long solution block-by-block while keeping only the framed prompt atomic", () => {
    const items = [
      block("intro", 0, 700),
      atomicProblemArea("problem_1", 700, 180),
      block("solution_1", 880, 220),
      block("solution_2", 1_100, 500),
    ];

    const first = decidePagination(items, ENV, {});
    const second = decidePagination(items, ENV, {});

    // 問題全体なら problem_1 に gap が入る旧挙動だった。新経路では prompt は残り、
    // ページ境界を越える最初の solution 段落自身が spacer のキャリアになる。
    expect(first.gaps.problem_1).toBeUndefined();
    expect(first.gaps.solution_1).toBe(220);
    expect(first.gaps).toEqual(second.gaps);
    const signature = gapMapSignature(first.gaps);
    expect(detectGapOscillation([signature, signature], gapMapSignature(second.gaps))).toBe("stable");
  });

  it("pushes a framed prompt as one area at a page boundary and is stable on pass two", () => {
    const items = [block("intro", 0, 900), atomicProblemArea("problem_1", 900, 200)];
    const first = decidePagination(items, ENV, {});
    const second = decidePagination(items, ENV, {});

    expect(first.gaps.problem_1).toBe(200);
    expect(first.gaps).toEqual(second.gaps);
    const signature = gapMapSignature(first.gaps);
    expect(detectGapOscillation([signature, signature], gapMapSignature(second.gaps))).toBe("stable");
  });

  it("pushes a one-page min-height solution reservation with its area", () => {
    const items = [block("prompt", 0, 750), atomicProblemArea("problem_1:solution", 750, 400)];
    const first = decidePagination(items, ENV, {});
    const second = decidePagination(items, ENV, {});

    expect(first.gaps["problem_1:solution"]).toBe(350);
    expect(first.gaps).toEqual(second.gaps);
    const signature = gapMapSignature(first.gaps);
    expect(detectGapOscillation([signature, signature], gapMapSignature(second.gaps))).toBe("stable");
  });

  it("advances following flow by a min-height deficit missing from the area DOM", () => {
    const items = [
      block("intro", 0, 700),
      atomicProblemArea("solution_area", 700, 400, { reservedHeightDeficitPx: 300 }),
      block("after", 800, 100),
      block("tail", 900, 600),
    ];
    const first = decidePagination(items, ENV, {});
    const second = decidePagination(items, ENV, {});

    expect(first.gaps.solution_area).toBe(400);
    expect(first.gaps.after).toBe(300);
    expect(first.gaps.tail).toBe(600);
    expect(first).toEqual(second);
  });

  it("preserves visible paper space for an over-tall min-height reservation", () => {
    const items: PaginationItem[] = [
      block("solution", 0, 100),
      { kind: "reservedAreaEnd", gapKey: "virtual_solution_end", topNat: 1_500, height: 0 },
      block("after", 1_500, 100),
      block("tail", 1_600, 500),
    ];
    const first = decidePagination(items, ENV, {});
    const second = decidePagination(items, ENV, {});

    // 1500px の予約は紙面1000pxを1回またぐため、ページ間100pxを後続の前へ補う。
    expect(first.gaps.after).toBe(100);
    expect(first.gaps.tail).toBe(500);
    expect(first.gaps.virtual_solution_end).toBeUndefined();
    expect(first.pageCount).toBe(3);
    expect(first).toEqual(second);
    const signature = gapMapSignature(first.gaps);
    expect(detectGapOscillation([signature, signature], gapMapSignature(second.gaps))).toBe("stable");
  });

  it("counts a terminal min-height reservation without a following gap carrier", () => {
    const cases: PaginationItem[][] = [
      [atomicProblemArea("solution_area", 0, 2_400, { reservedHeightDeficitPx: 2_300 })],
      [
        block("solution", 0, 100),
        { kind: "reservedAreaEnd", gapKey: "virtual_solution_end", topNat: 2_400, height: 0 },
      ],
    ];

    for (const items of cases) {
      const first = decidePagination(items, ENV, {});
      const second = decidePagination(items, ENV, {});
      expect(first.pageCount).toBe(3);
      expect(first).toEqual(second);
      const signature = gapMapSignature(first.gaps);
      expect(detectGapOscillation([signature, signature], gapMapSignature(second.gaps))).toBe("stable");
    }
  });

  it("pushes a block that does not fit the rest of the page", () => {
    const result = decidePagination([block("a", 0, 900), block("b", 900, 200)], ENV, {});
    expect(result.gaps.b).toBe(200);
    expect(result.pageCount).toBe(2);
  });

  it("keeps a block with its next block only when the pair fits one page", () => {
    const fittingPair = [
      block("filler", 0, 800),
      block("heading", 800, 100, { keepWithNextHeightPx: 300 }),
      block("body", 900, 200),
    ];
    const overTallPair = [
      block("filler", 0, 800),
      block("heading", 800, 100, { keepWithNextHeightPx: 1_100 }),
      block("body", 900, 1_000),
    ];

    const fitting = decidePagination(fittingPair, ENV, {});
    const overTall = decidePagination(overTallPair, ENV, {});
    expect(fitting.gaps.heading).toBe(300);
    expect(overTall.gaps.heading).toBeUndefined();
    expect(decidePagination(fittingPair, ENV, {})).toEqual(fitting);
    expect(decidePagination(overTallPair, ENV, {})).toEqual(overTall);
  });

  it("moves a lead block with the following atomic problem area", () => {
    const items = [
      block("filler", 0, 850),
      block("problem_1_lead_empty", 850, 50, { keepWithNextHeightPx: 250 }),
      atomicProblemArea("problem_1:prompt", 900, 200),
    ];

    const first = decidePagination(items, ENV, {});
    expect(first.gaps.problem_1_lead_empty).toBe(250);
    expect(first.gaps["problem_1:prompt"]).toBeUndefined();
    expect(decidePagination(items, ENV, {})).toEqual(first);
  });

  it("uses the whole lead unit height when keeping a short atomic prompt with it", () => {
    const items = [
      block("filler", 0, 868),
      // The child block is only 28px, but the lead unit is 43px including its marker and
      // padding. Together with the 91px prompt, the 134px group exceeds the 132px remainder.
      block("problem_1_lead_empty", 868, 28, { keepWithNextHeightPx: 134 }),
      atomicProblemArea("problem_1:prompt", 896, 91),
    ];

    const first = decidePagination(items, ENV, {});
    expect(first.gaps.problem_1_lead_empty).toBe(232);
    expect(first.gaps["problem_1:prompt"]).toBeUndefined();
    expect(decidePagination(items, ENV, {})).toEqual(first);
  });

  it("excludes the next block trailing space from keep-with-next fitting", () => {
    const items = [
      block("filler", 0, 800),
      block("heading", 800, 100, { keepWithNextHeightPx: 200 }),
      block("body", 900, 200, { trailingSpacePx: 100 }),
    ];

    const first = decidePagination(items, ENV, {});
    expect(first.gaps.heading).toBeUndefined();
    expect(decidePagination(items, ENV, {})).toEqual(first);
  });

  it("keeps a fitting fragmentable box together on the next page", () => {
    const items = [
      block("filler", 0, 700),
      block("box", 700, 500, {
        kind: "fragmentableBlock",
        keepTogether: true,
        minStartHeightPx: 0,
      }),
    ];
    const first = decidePagination(items, ENV, {});
    const second = decidePagination(items, ENV, {});

    expect(first.gaps.box).toBe(400);
    expect(second).toEqual(first);
  });

  it("starts a fragmentable block in the remaining page space", () => {
    const result = decidePagination([
      block("a", 0, 700),
      block("box", 700, 900, { kind: "fragmentableBlock", minStartHeightPx: 80 }),
    ], ENV, {});
    expect(result.gaps.box ?? 0).toBe(0);
  });

  it("starts an area whose first block is taller than a page in the current remainder", () => {
    const result = decidePagination([
      block("intro", 0, 700),
      {
        kind: "area",
        gapKey: "nested",
        topNat: 700,
        height: 0,
        contentOffset: 0,
        firstBlockHeight: 1_600,
        firstBlockFragmentable: true,
        firstBlockMinStartHeightPx: 0,
      },
    ], ENV, {});

    expect(result.gaps.nested).toBeUndefined();
  });

  it("moves an area when its fitting first block does not fit the current remainder", () => {
    const result = decidePagination([
      block("intro", 0, 700),
      {
        kind: "area",
        gapKey: "nested",
        topNat: 700,
        height: 0,
        contentOffset: 0,
        firstBlockHeight: 500,
        firstBlockFragmentable: false,
      },
    ], ENV, {});

    expect(result.gaps.nested).toBe(400);
  });

  it("moves a fragmentable block only when the remainder cannot hold its first lines", () => {
    const result = decidePagination([
      block("a", 0, 950),
      block("box", 950, 900, { kind: "fragmentableBlock", minStartHeightPx: 80 }),
    ], ENV, {});
    expect(result.gaps.box).toBe(150);
  });

  it("honours a manual break before a block", () => {
    const result = decidePagination(
      [block("a", 0, 100), block("b", 100, 100, { forceBreakBefore: true })],
      ENV,
      {},
    );
    expect(result.gaps.b).toBe(1000);
  });

  it("never pushes the first item on a page", () => {
    const result = decidePagination([block("only", 0, 2400)], ENV, {});
    expect(result.gaps).toEqual({});
  });

  it("handles an empty document", () => {
    expect(decidePagination([], ENV, {})).toEqual({ gaps: {}, pageCount: 1 });
  });

  it("keeps reserve gaps that were seeded before the walk", () => {
    const result = decidePagination([block("a", 0, 100)], ENV, { a: 40 });
    expect(result.gaps.a).toBe(40);
  });

  it("lets the caller move the cursor after fragmenting an item", () => {
    const placements: string[] = [];
    const result = decidePagination(
      [block("tall", 0, 2400), block("after", 2400, 100)],
      ENV,
      {},
      {
        onPlaced: (item, placement) => {
          placements.push(`${item.gapKey}@${placement.pageIndex}`);
          if (item.gapKey !== "tall") {
            return;
          }
          return { pageIndex: 2, pageStartNatural: 2200, pendingGap: 0 };
        },
      },
    );
    expect(placements).toEqual(["tall@0", "after@2"]);
    expect(result.pageCount).toBe(3);
  });
});

describe("gapMapSignature", () => {
  it("is independent of key order and ignores zero gaps", () => {
    expect(gapMapSignature({ b: 4, a: 114 })).toBe(gapMapSignature({ a: 114, b: 4 }));
    expect(gapMapSignature({ a: 114, zero: 0 })).toBe(gapMapSignature({ a: 114 }));
  });

  it("separates the two sides of a 114 ⇔ 4 flip", () => {
    expect(gapMapSignature({ p: 114 })).not.toBe(gapMapSignature({ p: 4 }));
  });
});

describe("detectGapOscillation", () => {
  it("reports a stable layout", () => {
    expect(detectGapOscillation(["A", "A"], "A")).toBe("stable");
  });

  it("reports an A,B,A,B flip as oscillating", () => {
    expect(detectGapOscillation(["A", "B", "A"], "B")).toBe("oscillating");
  });

  it("does not call a converging sequence oscillating", () => {
    expect(detectGapOscillation(["A", "B", "C"], "C")).toBe("progressing");
    expect(detectGapOscillation([], "A")).toBe("progressing");
    expect(detectGapOscillation(["A"], "B")).toBe("progressing");
  });

  it("does not mistake a three-way cycle for a stable layout", () => {
    expect(detectGapOscillation(["A", "B", "C"], "A")).toBe("progressing");
  });
});

describe("decidePagination with a space below a block", () => {
  /**
   * 「余白を足したらその段落自身が次ページへ飛ぶ」はユーザーの意図と逆 — 下げたいのは
   * **次の行**。なので収まり判定からは末尾余白を除き、カーソルの前進には含める。
   */
  it("keeps the block itself in place when only its trailing space overflows", () => {
    const result = decidePagination(
      [
        block("intro", 0, 900),
        block("spaced", 900, 150, { trailingSpacePx: 100 }),
        block("after", 1050, 100),
      ],
      ENV,
      {},
    );

    // 本文 50px はページに収まる (900 + 50 <= 1000) ので、このブロックは動かない。
    expect(result.gaps.spaced).toBeUndefined();
    // 次のブロックは余白ぶんまで含めて溢れるので次ページ頭へ。
    expect(result.gaps.after).toBe(50);
  });

  it("still moves the block when its own content does not fit", () => {
    const result = decidePagination(
      [block("intro", 0, 900), block("spaced", 900, 250, { trailingSpacePx: 100 })],
      ENV,
      {},
    );

    // 本文 150px がページに収まらない (900 + 150 > 1000) ので、従来どおりブロックごと送る。
    expect(result.gaps.spaced).toBe(200);
  });

  it("treats a missing trailing space as 0 (documents without the field are unchanged)", () => {
    const withoutField = decidePagination(
      [block("intro", 0, 900), block("spaced", 900, 150), block("after", 1050, 100)],
      ENV,
      {},
    );
    const withZero = decidePagination(
      [
        block("intro", 0, 900),
        block("spaced", 900, 150, { trailingSpacePx: 0 }),
        block("after", 1050, 100),
      ],
      ENV,
      {},
    );

    expect(withZero).toEqual(withoutField);
  });

  it("does not let the trailing space start a fragmentable block one page early", () => {
    // 分割可能ブロックは「きれいに始められる残り高さ」で判定する。余白を高さに数えると
    // 本文が始められるのに次ページへ送られる。
    const result = decidePagination(
      [
        block("intro", 0, 900),
        {
          kind: "fragmentableBlock",
          gapKey: "long",
          topNat: 900,
          height: 1200,
          minStartHeightPx: 60,
          trailingSpacePx: 100,
        },
      ],
      ENV,
      {},
    );

    expect(result.gaps.long).toBeUndefined();
  });
});
