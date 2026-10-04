import { describe, expect, it } from "vitest";

import {
  DEFAULT_AI_PROPOSAL_DISPLAY_STATE,
  patchAiProposalDisplayState,
  pruneAiProposalDisplayStates,
  readAiProposalDisplayState,
  type AiProposalDisplayStates,
} from "./proposal-display-state";

const EMPTY: AiProposalDisplayStates = new Map();
const CARD = "ai-proposal:p1:room:room-1";

describe("proposal display state (kept outside the card content)", () => {
  it("starts every card from the default state", () => {
    expect(readAiProposalDisplayState(EMPTY, CARD, ["proposal-1"])).toEqual({
      contentHidden: false,
      applyError: null,
      dismissReasonOpen: false,
      beforeHidden: false,
    });
    expect(DEFAULT_AI_PROPOSAL_DISPLAY_STATE.contentHidden).toBe(false);
  });

  it("keeps what the user did for the same proposals, whatever order their ids arrive in", () => {
    const states = patchAiProposalDisplayState(EMPTY, CARD, ["proposal-1", "proposal-2"], { contentHidden: true });
    const withError = patchAiProposalDisplayState(states, CARD, ["proposal-1", "proposal-2"], { applyError: "失敗" });

    expect(readAiProposalDisplayState(withError, CARD, ["proposal-2", "proposal-1"])).toMatchObject({
      contentHidden: true,
      applyError: "失敗",
    });
    expect(states).not.toBe(withError);
    expect(readAiProposalDisplayState(states, CARD, ["proposal-1", "proposal-2"]).applyError).toBeNull();
  });

  it("does not carry a hidden card or an old error over to a proposal that a later turn added", () => {
    const states = patchAiProposalDisplayState(EMPTY, CARD, ["proposal-1"], { contentHidden: true, applyError: "失敗" });

    // 同じ部屋の追加ターン: カードの key は同じでも提案が増えた。
    expect(readAiProposalDisplayState(states, CARD, ["proposal-1", "proposal-2"])).toEqual(DEFAULT_AI_PROPOSAL_DISPLAY_STATE);
    const next = patchAiProposalDisplayState(states, CARD, ["proposal-1", "proposal-2"], { dismissReasonOpen: true });
    expect(readAiProposalDisplayState(next, CARD, ["proposal-1", "proposal-2"])).toEqual({
      ...DEFAULT_AI_PROPOSAL_DISPLAY_STATE,
      dismissReasonOpen: true,
    });
  });

  it("keeps cards independent of each other", () => {
    const states = patchAiProposalDisplayState(EMPTY, CARD, ["proposal-1"], { contentHidden: true });
    expect(readAiProposalDisplayState(states, "ai-proposal:p2:room:room-1", ["proposal-1"]).contentHidden).toBe(false);
  });

  it("forgets cards whose proposals are gone or replaced, and leaves the map alone otherwise", () => {
    const states = patchAiProposalDisplayState(
      patchAiProposalDisplayState(EMPTY, CARD, ["proposal-1"], { contentHidden: true }),
      "overlay:room:room-2",
      ["proposal-9"],
      { beforeHidden: true },
    );

    const live = new Map([[CARD, ["proposal-1"]], ["overlay:room:room-2", ["proposal-9"]]]);
    expect(pruneAiProposalDisplayStates(states, live)).toBe(states);

    const pruned = pruneAiProposalDisplayStates(states, new Map([[CARD, ["proposal-1", "proposal-3"]]]));
    expect([...pruned.keys()]).toEqual([]);
    expect(pruneAiProposalDisplayStates(EMPTY, new Map())).toBe(EMPTY);
  });
});
