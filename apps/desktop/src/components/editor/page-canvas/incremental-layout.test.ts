import { describe, expect, it } from "vitest";

import type { MeasuredBlock } from "@/components/editor/overlay-canvas/anchor";

import {
  canMeasureIncrementally,
  composeFlowMeasurement,
  isSameBlockGeometry,
  patchFlowMeasurement,
  resolveMeasureScope,
  type MeasuredBlockEntry,
} from "./incremental-layout";
import { decidePagination, type PaginationItem } from "./pagination-decisions";
import type { RenderUnit } from "./types";

/**
 * 増分レイアウトの不変条件は 1 つだけ: **「全部測り直した結果」と「汚れたところから測り直して
 * 前回分を持ち越した結果」が同じ**であること。
 *
 * ここが破れると同じ文書に自己整合なレイアウトが 2 つできる (実データで観測済み: 2px ずれ、
 * ひどいときは 1 ページずれる)。DOM の実測は e2e に任せ、ここでは「持ち越しの合成」と
 * 「そこから決まるページ割り」を突き合わせる。
 */
function block(id: string, top: number, height = 20): MeasuredBlock {
  return { id, top, left: 0, width: 500, height, lines: [{ index: 0, top, left: 0, width: 500, height }] };
}

function entries(blocks: readonly MeasuredBlock[], flowUnitIds: ReadonlySet<string>): MeasuredBlockEntry[] {
  return blocks.map((measured) => ({ block: measured, isFlowUnit: flowUnitIds.has(measured.id) }));
}

/** 実測はユニット単位で持つ。ここでは 1 ユニットに全部入れて合成だけを見る。 */
function oneSegment(blocks: readonly MeasuredBlock[], flowUnitIds: ReadonlySet<string>) {
  return [{ unitId: blocks[0]?.id ?? null, entries: entries(blocks, flowUnitIds) }];
}

/** 段落が縦に積まれた本文。`shiftFrom` 以降を `delta` px 下げる (上流の高さが変わった状態)。 */
function bodyBlocks(count: number, { shiftFrom = count, delta = 0 } = {}): MeasuredBlock[] {
  return Array.from({ length: count }, (_, index) => block(
    `b${index}`,
    index * 20 + (index >= shiftFrom ? delta : 0),
  ));
}

function paginationItems(blocks: readonly MeasuredBlock[]): PaginationItem[] {
  return blocks.map((measured) => ({
    kind: "block" as const,
    gapKey: measured.id,
    topNat: measured.top,
    height: measured.height ?? 0,
  }));
}

const ENV = { contentHeightPx: 200, pageStride: 220 };

describe("composeFlowMeasurement", () => {
  it("rebuilds the whole-document maps from carried and freshly measured blocks", () => {
    const blocks = bodyBlocks(4);
    const flowUnits = new Set(["b0", "b2"]);

    const measurement = composeFlowMeasurement(oneSegment(blocks, flowUnits));

    expect(measurement.ordered.map((entry) => entry.id)).toEqual(["b0", "b2"]);
    expect(measurement.anchorable.map((entry) => entry.id)).toEqual(["b0", "b1", "b2", "b3"]);
    expect([...measurement.rects.keys()].sort()).toEqual(["b0", "b1", "b2", "b3"]);
    expect(measurement.extents.get("b3")).toEqual({ top: 60, height: 20 });
    expect(measurement.tops.get("b2")).toBe(40);
  });

  it("sorts by position, not by the order blocks were measured in", () => {
    // 持ち越し分と測り直し分は DOM 順に混ざって届くが、下流は位置順を前提にしている。
    const measurement = composeFlowMeasurement([{
      unitId: "late",
      entries: [
        { block: block("late", 80), isFlowUnit: true },
        { block: block("early", 10), isFlowUnit: true },
      ],
    }]);

    expect(measurement.ordered.map((entry) => entry.id)).toEqual(["early", "late"]);
  });

  it("gives the same maps whether every block was re-measured or only the tail was", () => {
    // 上流が動いていないなら、上流を測り直しても持ち越しても同じ値になる。
    const blocks = bodyBlocks(6);
    const flowUnits = new Set(blocks.map((entry) => entry.id));
    const full = composeFlowMeasurement(oneSegment(blocks, flowUnits));
    const carriedThenMeasured = composeFlowMeasurement(oneSegment(
      [...blocks.slice(0, 3), ...blocks.slice(3)],
      flowUnits,
    ));

    expect(carriedThenMeasured.tops).toEqual(full.tops);
    expect(carriedThenMeasured.extents).toEqual(full.extents);
    expect(carriedThenMeasured.ordered).toEqual(full.ordered);
  });

  it("drops blocks that are gone from the document", () => {
    const blocks = bodyBlocks(3);
    const flowUnits = new Set(blocks.map((entry) => entry.id));

    const measurement = composeFlowMeasurement(oneSegment(blocks.filter((entry) => entry.id !== "b1"), flowUnits));

    expect(measurement.rects.has("b1")).toBe(false);
    expect(measurement.anchorable.map((entry) => entry.id)).toEqual(["b0", "b2"]);
  });
});

describe("resolveMeasureScope", () => {
  const units: RenderUnit[] = [
    { type: "textFlow", id: "u0", blocks: [] },
    { type: "textFlow", id: "u1", blocks: [] },
    { type: "textFlow", id: "u2", blocks: [] },
  ] as unknown as RenderUnit[];
  const scope = (
    dirty: string[],
    overrides: {
      fullDirty?: boolean;
      hasPrevious?: boolean;
      incrementalEligible?: boolean;
      unitsChangedSinceMeasure?: boolean;
    } = {},
  ) =>
    resolveMeasureScope({
      dirtyUnitIds: new Set(dirty),
      fullDirty: overrides.fullDirty ?? false,
      hasPrevious: overrides.hasPrevious ?? true,
      incrementalEligible: overrides.incrementalEligible ?? true,
      unitsChangedSinceMeasure: overrides.unitsChangedSinceMeasure ?? false,
      units,
    });

  it("measures everything on the first pass and after a whole-page change", () => {
    expect(scope([], { hasPrevious: false })).toEqual({ kind: "all" });
    expect(scope(["u1"], { fullDirty: true })).toEqual({ kind: "all" });
  });

  it("carries the previous geometry when nothing was marked dirty", () => {
    // 別の理由で走った再計算に相乗りしただけ。測り直す理由が無い。
    expect(scope([])).toEqual({ kind: "carry" });
  });

  it("measures everything when the units changed but nobody marked anything dirty", () => {
    // 汚れの申告は最適化のヒント。申告漏れがあっても、黙って 1 フレーム前の紙面で
    // ページを割らないように安全側へ倒す。
    expect(scope([], { unitsChangedSinceMeasure: true })).toEqual({ kind: "all" });
  });

  it("measures just the dirty unit when only one is dirty", () => {
    // 1 文字打っても行が増えなければユニットの高さは変わらず、下のブロックは動かない。
    expect(scope(["u1"])).toEqual({ kind: "dirtyUnit", unitId: "u1" });
  });

  it("starts at the topmost dirty unit when several are dirty", () => {
    // 下のユニットから測り直すと、その上の汚れたユニットの高さ変化が反映されない。間の
    // 汚れていないユニットも動きうるので、そこから下は全部測り直す。
    expect(scope(["u2", "u0"])).toEqual({ kind: "fromUnit", unitId: "u0" });
  });

  it("measures everything on a page the increment cannot reason about", () => {
    // 問題エリア・段組みは「打った場所より下だけ動く」が成り立たない。
    expect(scope(["u1"], { incrementalEligible: false })).toEqual({ kind: "all" });
  });

  it("measures everything when a dirty id is not on the page any more", () => {
    // ユニットが作り直されて id が消えた場合。安全側 (全体) に倒す。
    expect(scope(["gone"])).toEqual({ kind: "all" });
  });
});

describe("isSameBlockGeometry", () => {
  it("accepts sub-pixel jitter but not a real move", () => {
    const measured = block("b", 100, 20);

    expect(isSameBlockGeometry(measured, block("b", 100.03, 20.02))).toBe(true);
    expect(isSameBlockGeometry(measured, block("b", 100.5, 20))).toBe(false);
    expect(isSameBlockGeometry(measured, block("b", 100, 21))).toBe(false);
  });

  it("treats a block with no previous measurement as changed", () => {
    // 新しく現れたブロック。持ち越す元が無いので必ず測る側へ倒す。
    expect(isSameBlockGeometry(block("b", 10), undefined)).toBe(false);
  });
});

describe("patchFlowMeasurement", () => {
  const flowUnits = new Set(["b0", "b1", "b2"]);
  const previous = composeFlowMeasurement(oneSegment(bodyBlocks(3), flowUnits));

  it("gives the same maps as a full rebuild when nothing moved", () => {
    // 測り直したブロックが前回と同じ位置なら、並べ替え無しで差し替えても結果は同じ。
    const remeasured = block("b1", 20);

    const patched = patchFlowMeasurement(previous, [remeasured]);
    const rebuilt = composeFlowMeasurement(oneSegment([
      previous.rects.get("b0")!,
      remeasured,
      previous.rects.get("b2")!,
    ], flowUnits));

    expect(patched.tops).toEqual(rebuilt.tops);
    expect(patched.extents).toEqual(rebuilt.extents);
    expect(patched.ordered.map((entry) => entry.id)).toEqual(rebuilt.ordered.map((entry) => entry.id));
    expect(patched.rects.get("b1")).toBe(remeasured);
  });

  it("returns the previous measurement untouched when nothing was re-measured", () => {
    expect(patchFlowMeasurement(previous, [])).toBe(previous);
  });
});

describe("full vs partial measurement produce one layout", () => {
  it("keeps the same gaps when nothing upstream moved", () => {
    const blocks = bodyBlocks(30);
    const full = composeFlowMeasurement(oneSegment(blocks, new Set(blocks.map((entry) => entry.id))));
    // 部分計測: 先頭 20 ブロックは前回の実測を持ち越し、残りだけ測り直した。
    const partial = composeFlowMeasurement(oneSegment(
      [...blocks.slice(0, 20), ...blocks.slice(20)],
      new Set(blocks.map((entry) => entry.id)),
    ));

    const fullGaps = decidePagination(paginationItems(full.ordered), ENV, {}).gaps;
    const partialGaps = decidePagination(paginationItems(partial.ordered), ENV, {}).gaps;

    expect(partialGaps).toEqual(fullGaps);
  });

  it("moves the downstream blocks by exactly the upstream height change", () => {
    const before = bodyBlocks(30);
    const after = bodyBlocks(30, { shiftFrom: 10, delta: 10 });
    const partial = composeFlowMeasurement(oneSegment(
      // 先頭 10 は持ち越し (動いていない)、以降は測り直し (10px 下がった)。
      [...before.slice(0, 10), ...after.slice(10)],
      new Set(before.map((entry) => entry.id)),
    ));

    expect(partial.tops.get("b9")).toBe(180);
    expect(partial.tops.get("b10")).toBe(210);
    expect(partial.extents.get("b29")).toEqual({ top: 590, height: 20 });
    // 全部測り直した結果と一致する。
    expect(partial.tops).toEqual(composeFlowMeasurement(oneSegment(after, new Set(before.map((entry) => entry.id)))).tops);
  });

  it("agrees with a full re-measure when the change pushes a block onto the next page", () => {
    // 上流が 120px 伸びて、ページ (contentHeight 200) を跨ぐ位置まで下がるケース。
    const after = bodyBlocks(20, { shiftFrom: 5, delta: 120 });
    const flowUnits = new Set(after.map((entry) => entry.id));
    const full = composeFlowMeasurement(oneSegment(after, flowUnits));
    const partial = composeFlowMeasurement(oneSegment(
      [...bodyBlocks(20).slice(0, 5), ...after.slice(5)],
      flowUnits,
    ));

    const fullResult = decidePagination(paginationItems(full.ordered), ENV, {});
    const partialResult = decidePagination(paginationItems(partial.ordered), ENV, {});

    expect(partialResult.gaps).toEqual(fullResult.gaps);
    expect(partialResult.pageCount).toBe(fullResult.pageCount);
    expect(fullResult.pageCount).toBeGreaterThan(1);
  });
});

describe("canMeasureIncrementally", () => {
  const textFlow = { type: "textFlow", id: "u0", blocks: [] } as unknown as RenderUnit;
  const problemArea = { type: "problemArea", id: "q1:prompt", blocks: [] } as unknown as RenderUnit;

  it("allows a plain single-column body", () => {
    expect(canMeasureIncrementally([textFlow, textFlow], false)).toBe(true);
  });

  it("refuses problem areas and column flow", () => {
    // どちらも 1 ブロックの変化がまわりの配置まで動かす (エリアの高さ・段の割り付け)。
    expect(canMeasureIncrementally([textFlow, problemArea], false)).toBe(false);
    expect(canMeasureIncrementally([textFlow], true)).toBe(false);
  });
});
