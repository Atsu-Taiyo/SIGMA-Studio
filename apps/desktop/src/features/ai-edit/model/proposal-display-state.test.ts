import { describe, expect, it } from "vitest";

import {
  applyAiProposalCardDisplayPatch,
  DEFAULT_AI_PROPOSAL_DISPLAY_STATE,
  patchAiProposalDisplayState,
  pruneAiProposalDisplayStates,
  readAiProposalCardDisplayState,
  readAiProposalDisplayState,
  routeAiProposalCardDisplayPatch,
  type AiProposalCardDisplayKeys,
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
      dismissReason: "",
      beforeHidden: false,
      afterOnly: false,
    });
    expect(DEFAULT_AI_PROPOSAL_DISPLAY_STATE.contentHidden).toBe(false);
    expect(DEFAULT_AI_PROPOSAL_DISPLAY_STATE.afterOnly).toBe(false);
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

describe("a page card's state split between the card and its proposal (conversation)", () => {
  const CONVERSATION = "room:room-1";
  const OTHER_CARD = "ai-proposal:p2:room:room-1";
  const KEYS: AiProposalCardDisplayKeys = { cardKey: CARD, conversationKey: CONVERSATION, conversationCardKeys: [CARD, OTHER_CARD] };
  const IDS = ["proposal-1"];

  /** 紙面と同じく、振り分けた書き換えを場所ごとに当てる。 */
  const press = (states: AiProposalDisplayStates, patch: Parameters<typeof routeAiProposalCardDisplayPatch>[0], keys = KEYS) => (
    routeAiProposalCardDisplayPatch(patch, keys).reduce(
      (next, [key, part]) => patchAiProposalDisplayState(next, key, IDS, part),
      states,
    )
  );

  it("shows the result only on every card and shape of the proposal at once, and is off by default", () => {
    expect(readAiProposalCardDisplayState(EMPTY, KEYS, IDS).afterOnly).toBe(false);

    const states = press(EMPTY, { afterOnly: true });

    expect(readAiProposalCardDisplayState(states, KEYS, IDS).afterOnly).toBe(true);
    // 同じ提案の別のアンカーのカードと、図形 (会話の key で引く) も同じ。
    expect(readAiProposalCardDisplayState(states, { ...KEYS, cardKey: OTHER_CARD }, IDS).afterOnly).toBe(true);
    expect(readAiProposalDisplayState(states, CONVERSATION, IDS).afterOnly).toBe(true);
    // 押し直せば差分の表示に戻る。
    expect(readAiProposalCardDisplayState(press(states, { afterOnly: false }), KEYS, IDS).afterOnly).toBe(false);
  });

  it("shows the hidden content again on every card of the proposal when the result only is chosen", () => {
    const hidden = press(press(EMPTY, { contentHidden: true }), { contentHidden: true }, { ...KEYS, cardKey: OTHER_CARD });
    expect(readAiProposalCardDisplayState(hidden, KEYS, IDS).contentHidden).toBe(true);
    expect(readAiProposalCardDisplayState(hidden, { ...KEYS, cardKey: OTHER_CARD }, IDS).contentHidden).toBe(true);

    const resultOnly = press(hidden, { afterOnly: true });

    expect(readAiProposalCardDisplayState(resultOnly, KEYS, IDS)).toMatchObject({ afterOnly: true, contentHidden: false });
    expect(readAiProposalCardDisplayState(resultOnly, { ...KEYS, cardKey: OTHER_CARD }, IDS).contentHidden).toBe(false);
    // 差分の表示に戻しても、隠した内容は戻らない (解除したまま)。
    expect(readAiProposalCardDisplayState(press(resultOnly, { afterOnly: false }), KEYS, IDS).contentHidden).toBe(false);
  });

  it("keeps the card's own state (hidden content, error) on the card and the before/result toggles on the proposal", () => {
    expect(routeAiProposalCardDisplayPatch({ contentHidden: false, applyError: "失敗" }, KEYS))
      .toEqual([[CARD, { contentHidden: false, applyError: "失敗" }]]);
    expect(routeAiProposalCardDisplayPatch({ beforeHidden: true }, KEYS)).toEqual([[CONVERSATION, { beforeHidden: true }]]);
    expect(routeAiProposalCardDisplayPatch({ afterOnly: false }, KEYS)).toEqual([[CONVERSATION, { afterOnly: false }]]);
  });

  it("returns to the default when a later turn changes the proposals", () => {
    const states = press(EMPTY, { afterOnly: true });
    expect(readAiProposalCardDisplayState(states, KEYS, ["proposal-1", "proposal-2"]).afterOnly).toBe(false);
  });

  it("leaves the result only when a card's content is hidden, for the whole proposal (cards and shapes alike)", () => {
    const resultOnly = press(EMPTY, { afterOnly: true });

    const hidden = press(resultOnly, { contentHidden: true });

    // 内容を隠したら適用後だけは解除 (適用前でも適用後でもない姿にしない)。図形も会話の key の同じ状態を読む。
    expect(readAiProposalCardDisplayState(hidden, KEYS, IDS)).toMatchObject({ contentHidden: true, afterOnly: false });
    expect(readAiProposalDisplayState(hidden, CONVERSATION, IDS).afterOnly).toBe(false);
    expect(readAiProposalCardDisplayState(hidden, { ...KEYS, cardKey: OTHER_CARD }, IDS).afterOnly).toBe(false);
    // 内容を出し直しても適用後だけには戻らない (解除したまま)。
    expect(readAiProposalCardDisplayState(press(hidden, { contentHidden: false }), KEYS, IDS).afterOnly).toBe(false);
  });

  it("applies the same rule to a card that keeps its state itself", () => {
    const hidden = applyAiProposalCardDisplayPatch(DEFAULT_AI_PROPOSAL_DISPLAY_STATE, { contentHidden: true });
    expect(applyAiProposalCardDisplayPatch(hidden, { afterOnly: true })).toEqual({
      ...DEFAULT_AI_PROPOSAL_DISPLAY_STATE,
      afterOnly: true,
      contentHidden: false,
    });
    expect(applyAiProposalCardDisplayPatch(hidden, { beforeHidden: true })).toMatchObject({ contentHidden: true, beforeHidden: true });
    expect(applyAiProposalCardDisplayPatch({ ...DEFAULT_AI_PROPOSAL_DISPLAY_STATE, afterOnly: true }, { contentHidden: true }))
      .toMatchObject({ contentHidden: true, afterOnly: false });
  });
});
