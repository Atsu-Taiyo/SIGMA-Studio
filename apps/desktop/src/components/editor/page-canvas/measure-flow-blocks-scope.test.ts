import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { measureFlowBlocks } from "./layout-measure";
import type { FlowMeasurement } from "./incremental-layout";

/**
 * 増分計測の本体 (DOM を歩く側) の等価性。
 *
 * 純関数側 (`incremental-layout.test.ts`) は「合成が正しいか」しか見ない。ここでは実際に
 * `measureFlowBlocks` を歩かせて、**全部測り直した結果と、汚れたところだけ測った結果が
 * 一致する**ことを固定する。これが崩れると同じ文書に自己整合なレイアウトが 2 つできる。
 */
const windowRef = new Window();

beforeEach(() => {
  (globalThis as { document?: unknown }).document = windowRef.document;
  (globalThis as { window?: unknown }).window = windowRef;
  (globalThis as { Node?: unknown }).Node = windowRef.Node;
  (globalThis as { CSS?: unknown }).CSS = { escape: (value: string) => value };
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { CSS?: unknown }).CSS;
});

const UNIT_COUNT = 3;
const BLOCKS_PER_UNIT = 2;
const BLOCK_HEIGHT = 20;

interface FlowFixture {
  flow: HTMLElement;
  /** そのブロックの現在の top を書き換える (下流が動いた状態を作る)。 */
  shiftFrom: (blockIndex: number, delta: number) => void;
}

/** `[data-flow-unit-id]` の入れ物に `.ProseMirror > [data-sigma-doc-id]` が並ぶ本文。 */
function createFlow(): FlowFixture {
  const doc = windowRef.document;
  const flow = doc.createElement("div") as unknown as HTMLElement;
  const tops = new Map<string, number>();
  const setRect = (element: HTMLElement, id: string) => {
    (element as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({
      top: tops.get(id) ?? 0,
      left: 0,
      width: 500,
      height: BLOCK_HEIGHT,
      bottom: (tops.get(id) ?? 0) + BLOCK_HEIGHT,
      right: 500,
      x: 0,
      y: tops.get(id) ?? 0,
      toJSON: () => ({}),
    }) as DOMRect;
  };
  (flow as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({
    top: 0, left: 0, width: 500, height: 1000, bottom: 1000, right: 500, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;

  let blockIndex = 0;
  for (let unit = 0; unit < UNIT_COUNT; unit += 1) {
    const unitElement = doc.createElement("div");
    const editor = doc.createElement("div");
    editor.className = "ProseMirror";
    for (let inner = 0; inner < BLOCKS_PER_UNIT; inner += 1) {
      const id = `b${blockIndex}`;
      const block = doc.createElement("p");
      block.setAttribute("data-sigma-doc-id", id);
      tops.set(id, blockIndex * BLOCK_HEIGHT);
      setRect(block as unknown as HTMLElement, id);
      editor.append(block);
      if (inner === 0) {
        unitElement.setAttribute("data-flow-unit-id", id);
      }
      blockIndex += 1;
    }
    unitElement.append(editor);
    flow.append(unitElement as unknown as Node);
  }

  return {
    flow,
    shiftFrom: (fromIndex: number, delta: number) => {
      for (let index = fromIndex; index < UNIT_COUNT * BLOCKS_PER_UNIT; index += 1) {
        const id = `b${index}`;
        tops.set(id, (tops.get(id) ?? 0) + delta);
      }
    },
  };
}

function measureAll(flow: HTMLElement): FlowMeasurement {
  return measureFlowBlocks(flow, 1, 0, undefined, { scope: { kind: "all" } });
}

function tops(measurement: FlowMeasurement): Array<[string, number]> {
  return [...measurement.tops.entries()].sort(([a], [b]) => a.localeCompare(b));
}

it("remeasures downstream when the last line is deleted but surviving lines keep their geometry", () => {
  const { flow, shiftFrom } = createFlow();
  const previous = measureAll(flow);
  flow.querySelector('[data-sigma-doc-id="b1"]')!.remove();
  shiftFrom(2, -BLOCK_HEIGHT);
  const incremental = measureFlowBlocks(flow, 1, 0, undefined, {
    scope: { kind: "dirtyUnit", unitId: "b0" }, previous,
  });
  expect(tops(incremental)).toEqual(tops(measureAll(flow)));
});

describe("measureFlowBlocks scopes", () => {
  it("measures every block when asked for everything", () => {
    const { flow } = createFlow();

    const measurement = measureAll(flow);

    expect(measurement.ordered.map((entry) => entry.id)).toEqual(["b0", "b1", "b2", "b3", "b4", "b5"]);
    expect(measurement.tops.get("b5")).toBe(100);
  });

  it("gives the same maps as a full pass when the dirty unit did not move", () => {
    // 1 文字打っても行が増えなければ、どのブロックも動かない。下流は前回のままでよい。
    const { flow } = createFlow();
    const previous = measureAll(flow);

    const incremental = measureFlowBlocks(flow, 1, 0, undefined, {
      scope: { kind: "dirtyUnit", unitId: "b2" },
      previous,
    });

    expect(tops(incremental)).toEqual(tops(measureAll(flow)));
    expect(incremental.ordered.map((entry) => entry.id)).toEqual(previous.ordered.map((entry) => entry.id));
  });

  it("measures downstream too when the dirty unit changed height", () => {
    // 打った行が増えた: そのユニット以降は全部動くので、持ち越しでは足りない。
    const { flow, shiftFrom } = createFlow();
    const previous = measureAll(flow);
    shiftFrom(3, 12);

    const incremental = measureFlowBlocks(flow, 1, 0, undefined, {
      scope: { kind: "dirtyUnit", unitId: "b2" },
      previous,
    });

    expect(tops(incremental)).toEqual(tops(measureAll(flow)));
    expect(incremental.tops.get("b5")).toBe(112);
  });

  it("keeps upstream blocks and re-measures from the requested unit", () => {
    const { flow, shiftFrom } = createFlow();
    const previous = measureAll(flow);
    shiftFrom(4, 30);

    const incremental = measureFlowBlocks(flow, 1, 0, undefined, {
      scope: { kind: "fromUnit", unitId: "b4" },
      previous,
    });

    expect(tops(incremental)).toEqual(tops(measureAll(flow)));
  });

  it("measures nothing on a carry pass but still keeps the whole document", () => {
    const { flow, shiftFrom } = createFlow();
    const previous = measureAll(flow);
    // 誰も汚れを申告していないパス。DOM が動いていても読みに行かない (呼び出し側が
    // 申告漏れを `all` に倒す責任を持つ — `resolveMeasureScope`)。
    shiftFrom(0, 5);

    const carried = measureFlowBlocks(flow, 1, 0, undefined, {
      scope: { kind: "carry" },
      previous,
    });

    expect(tops(carried)).toEqual(tops(previous));
    expect(carried.rects.size).toBe(previous.rects.size);
  });

  it("measures a block that has no previous measurement, whatever the scope", () => {
    const { flow } = createFlow();
    const previous = measureAll(flow);
    const partial: FlowMeasurement = {
      ...previous,
      rects: new Map([...previous.rects].filter(([id]) => id !== "b5")),
    };

    const incremental = measureFlowBlocks(flow, 1, 0, undefined, {
      scope: { kind: "carry" },
      previous: partial,
    });

    expect(incremental.tops.get("b5")).toBe(100);
  });

  it("enumerates blocks inside the dirty unit only, never the whole flow", () => {
    // ここが増分の肝。ブロックの列挙まで汚れたユニットに閉じ込めないと、測らないブロックの
    // 「居るかどうか」を知るためだけに 1,500 要素を毎打鍵で舐めることになる。
    const { flow } = createFlow();
    const previous = measureAll(flow);
    const blockQueries: string[] = [];
    const originalQuery = flow.querySelectorAll.bind(flow);
    (flow as unknown as { querySelectorAll: (selector: string) => unknown }).querySelectorAll = (selector: string) => {
      blockQueries.push(selector);
      return originalQuery(selector);
    };

    measureFlowBlocks(flow, 1, 0, undefined, {
      scope: { kind: "dirtyUnit", unitId: "b2" },
      previous,
    });

    // 紙面全体に投げてよいのは「ユニットの入れ物を数える」問い合わせだけ。
    expect(blockQueries).toEqual(["[data-flow-unit-id]"]);
  });

  it("touches no element at all on a carry pass", () => {
    const { flow } = createFlow();
    const previous = measureAll(flow);
    let rectReads = 0;
    for (const element of Array.from(flow.querySelectorAll("[data-sigma-doc-id]"))) {
      const original = (element as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect;
      (element as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => {
        rectReads += 1;
        return original.call(element);
      };
    }

    measureFlowBlocks(flow, 1, 0, undefined, { scope: { kind: "carry" }, previous });

    expect(rectReads).toBe(0);
  });

  it("falls back to measuring everything when the unit element is gone", () => {
    const { flow, shiftFrom } = createFlow();
    const previous = measureAll(flow);
    shiftFrom(0, 7);

    const incremental = measureFlowBlocks(flow, 1, 0, undefined, {
      scope: { kind: "dirtyUnit", unitId: "missing-unit" },
      previous,
    });

    expect(tops(incremental)).toEqual(tops(measureAll(flow)));
  });
});
