import { describe, expect, it } from "vitest";

import { combineTextFlowEditGuards, type TextFlowEditGuard } from "./edit-guard-extension";

const presentation = { highlightedBlockClassName: "a", readOnlyBlockClassName: "b", characterClassName: "c", atomClassName: "d" };

function guard(guardId: string, overrides: Partial<TextFlowEditGuard> = {}): TextFlowEditGuard {
  return { blockId: "block-1", guardId, isPrimaryActionTarget: false, blockedMessage: guardId, presentation, highlight: false, ...overrides };
}

const reservation = { baselineText: "本文", ranges: [{ from: 0, to: 1 }], inlineMathIds: [] };

describe("combineTextFlowEditGuards (two guards on one block)", () => {
  it("never lets a partial reservation weaken a whole-block guard (the later guard keeps its message and action)", () => {
    const whole = guard("result-only");
    const partialRun = guard("run", { contentReservations: [reservation], action: { label: "AIを停止して編集", busyLabel: "", failureTitle: "", buttonClassName: "", iconClassName: "", title: "", request: async () => ({ ok: true }) } });

    const combined = combineTextFlowEditGuards(whole, partialRun);

    expect(combined.guardId).toBe("run");
    expect(combined.action?.label).toBe("AIを停止して編集");
    expect(combined.contentReservations).toBeUndefined();
  });

  it("takes the later guard otherwise", () => {
    const partial = guard("run", { contentReservations: [reservation] });
    expect(combineTextFlowEditGuards(partial, guard("result-only"))).toEqual(guard("result-only"));
    expect(combineTextFlowEditGuards(guard("first"), guard("second"))).toEqual(guard("second"));
    const laterPartial = guard("later", { contentReservations: [reservation] });
    expect(combineTextFlowEditGuards(guard("earlier", { contentReservations: [reservation] }), laterPartial)).toBe(laterPartial);
  });
});
