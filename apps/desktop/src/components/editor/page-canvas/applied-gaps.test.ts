// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAppliedGapIndex,
  readAppliedGapPx,
  readInnerSpacerHeightPx,
  readUnitMarginTopPx,
} from "./applied-gaps";

function withOffsetHeight(element: HTMLElement, height: number): HTMLElement {
  Object.defineProperty(element, "offsetHeight", { configurable: true, value: height });
  return element;
}

function spacer(blockId: string, height: number): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-page-break-spacer", "");
  element.setAttribute("data-page-break-block-id", blockId);
  return withOffsetHeight(element, height);
}

/** The break marker widget carries the same block id but contributes no height. */
function marker(blockId: string, height: number): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-page-break-marker", "");
  element.setAttribute("data-page-break-block-id", blockId);
  return withOffsetHeight(element, height);
}

function unit(unitId: string, marginTop: string): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-flow-unit-id", unitId);
  element.style.marginTop = marginTop;
  return element;
}

/** computed style は文書に繋がっている要素でしか解決されないので body に載せる。 */
function flowWith(...children: HTMLElement[]): HTMLElement {
  const flow = document.createElement("div");
  for (const child of children) {
    flow.appendChild(child);
  }
  document.body.replaceChildren(flow);
  return flow;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("buildAppliedGapIndex", () => {
  it("indexes every rendered spacer in one pass", () => {
    const index = buildAppliedGapIndex(flowWith(
      spacer("block_a", 40),
      spacer("block_b", 12),
      spacer("block_c", 0),
    ));
    expect(index.spacerHeightByBlockId.size).toBe(3);
    expect(readAppliedGapPx(index, { kind: "block", id: "block_a" })).toBe(40);
    expect(readAppliedGapPx(index, { kind: "block", id: "block_b" })).toBe(12);
  });

  it("keeps the first spacer when a block id appears twice, like querySelector did", () => {
    const index = buildAppliedGapIndex(flowWith(spacer("block_a", 40), spacer("block_a", 88)));
    expect(readAppliedGapPx(index, { kind: "block", id: "block_a" })).toBe(40);
  });

  it("reports no gap for a block that has no spacer", () => {
    const index = buildAppliedGapIndex(flowWith(spacer("block_a", 40)));
    expect(readAppliedGapPx(index, { kind: "block", id: "block_b" })).toBe(0);
  });

  it("ignores the page-break marker widget, which carries the same block id", () => {
    // marker を拾うと、同じ改ページの gap を spacer と二重に数えてページ割りが発散する。
    const index = buildAppliedGapIndex(flowWith(marker("block_a", 24), spacer("block_a", 40)));
    expect(index.spacerHeightByBlockId.size).toBe(1);
    expect(readAppliedGapPx(index, { kind: "block", id: "block_a" })).toBe(40);
  });

  it("reads a flow unit's applied gap from its computed margin", () => {
    const index = buildAppliedGapIndex(flowWith(unit("problem_1:0", "36px")));
    expect(readAppliedGapPx(index, { kind: "unit", unitId: "problem_1:0" })).toBe(36);
  });

  it("reports no gap for a unit that is not in the flow", () => {
    const index = buildAppliedGapIndex(flowWith(unit("problem_1:0", "36px")));
    expect(readAppliedGapPx(index, { kind: "unit", unitId: "problem_2:0" })).toBe(0);
  });

  it("treats a non-numeric margin as no gap", () => {
    const index = buildAppliedGapIndex(flowWith(unit("problem_1:0", "auto")));
    expect(readAppliedGapPx(index, { kind: "unit", unitId: "problem_1:0" })).toBe(0);
  });

  it("keeps unit ids containing a colon addressable without CSS escaping", () => {
    const index = buildAppliedGapIndex(flowWith(unit("block_a:12", "8px")));
    expect(index.unitElementByUnitId.get("block_a:12")).toBeDefined();
  });

  it("sums the spacers rendered inside a flow unit", () => {
    // ユニットの矩形高さから引くための値。ページ超過の枠付き問題で、前パスが内部に入れた
    // spacer が次パスの高さに混ざって「収まる/収まらない」が往復するのを止める。
    const unitElement = unit("problem_1:0", "0px");
    unitElement.appendChild(spacer("inner_a", 40));
    unitElement.appendChild(spacer("inner_b", 74));
    const index = buildAppliedGapIndex(flowWith(unitElement, spacer("outside", 12)));
    expect(readInnerSpacerHeightPx(index, "problem_1:0")).toBe(114);
    expect(readInnerSpacerHeightPx(index, "problem_2:0")).toBe(0);
  });

  it("counts every spacer inside a unit, even when two share a block id", () => {
    const unitElement = unit("problem_1:0", "0px");
    unitElement.appendChild(spacer("inner_a", 40));
    unitElement.appendChild(spacer("inner_a", 40));
    const index = buildAppliedGapIndex(flowWith(unitElement));
    // gap の読み戻しは「最初の 1 件」だが、内部の高さ合計は物理的にそこにある分すべて。
    expect(readAppliedGapPx(index, { kind: "block", id: "inner_a" })).toBe(40);
    expect(readInnerSpacerHeightPx(index, "problem_1:0")).toBe(80);
  });

  it("measures each unit's margin only once", () => {
    const flow = flowWith(unit("problem_1:0", "36px"));
    const index = buildAppliedGapIndex(flow);
    const computedStyle = vi.spyOn(window, "getComputedStyle");
    readUnitMarginTopPx(index, "problem_1:0");
    readUnitMarginTopPx(index, "problem_1:0");
    expect(computedStyle).toHaveBeenCalledTimes(1);
    computedStyle.mockRestore();
  });

  it("queries the DOM a fixed number of times regardless of block count", () => {
    // これが WI-3 の本体: 従来は walk するアイテムごとに querySelector していたので、
    // 1500 ブロックの文書では 1 回の再ページ割りで 1500 回の部分木走査が走っていた。
    const many = Array.from({ length: 200 }, (_, index) => spacer(`block_${index}`, index));
    const flow = flowWith(...many, unit("problem_1:0", "36px"));
    const querySelectorAll = vi.spyOn(flow, "querySelectorAll");
    const querySelector = vi.spyOn(flow, "querySelector");

    const index = buildAppliedGapIndex(flow);
    for (let block = 0; block < 200; block += 1) {
      readAppliedGapPx(index, { kind: "block", id: `block_${block}` });
    }
    readAppliedGapPx(index, { kind: "unit", unitId: "problem_1:0" });

    expect(querySelectorAll.mock.calls.length).toBeLessThanOrEqual(2);
    expect(querySelector).not.toHaveBeenCalled();
    querySelectorAll.mockRestore();
    querySelector.mockRestore();
  });
});
