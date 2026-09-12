import { describe, expect, it } from "vitest";

import {
  commentAnchorCandidateKey,
  decideSelectedTargetCommentAnchor,
  decideTextSelectionCleared,
  decideTextSelectionCommentAnchor,
  INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE,
  sameCommentAnchorPopover,
  sameExtensionActionPopover,
} from "./comment-anchor-candidate";
import type { SigmaCommentAnchor } from "@/features/document";

const blockAnchor: SigmaCommentAnchor = { type: "block", blockId: "block_1" };
const otherBlockAnchor: SigmaCommentAnchor = { type: "block", blockId: "block_2" };
const textRangeAnchor: SigmaCommentAnchor = {
  type: "textRange",
  start: { blockId: "block_1", offset: 0 },
  end: { blockId: "block_1", offset: 4 },
  quote: "abcd",
};

describe("comment anchor candidate ownership", () => {
  it("lets the text selection emit while a text selection exists, and locks the selected-target path out", () => {
    const selectionEmit = decideTextSelectionCommentAnchor(INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE, textRangeAnchor);
    expect(selectionEmit.emit).toBe(true);

    const targetEmit = decideSelectedTargetCommentAnchor(selectionEmit.gate, blockAnchor);
    expect(targetEmit.emit).toBe(false);
    expect(targetEmit.gate.emittedKey).toBe(selectionEmit.gate.emittedKey);
  });

  it("lets the selected target emit when there is no text selection", () => {
    const result = decideSelectedTargetCommentAnchor(INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE, blockAnchor);
    expect(result.emit).toBe(true);
    expect(result.gate.emittedKey).toBe(commentAnchorCandidateKey(blockAnchor));
  });

  it("does not emit the same anchor twice", () => {
    const first = decideSelectedTargetCommentAnchor(INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE, blockAnchor);
    const second = decideSelectedTargetCommentAnchor(first.gate, blockAnchor);
    expect(first.emit).toBe(true);
    expect(second.emit).toBe(false);
  });

  it("emits three times across null → anchor → null", () => {
    const first = decideSelectedTargetCommentAnchor(INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE, null);
    const second = decideSelectedTargetCommentAnchor(first.gate, blockAnchor);
    const third = decideSelectedTargetCommentAnchor(second.gate, null);
    expect([first.emit, second.emit, third.emit]).toEqual([true, true, true]);
  });

  it("does not disturb a selected-target candidate when no text selection was ever there", () => {
    // これがアイドル自己再レンダーループの本体だった: テキスト選択側の定期チェックが
    // 「選択なし」を毎回 null として emit し、選択ブロック側の emit と交互に上書きしていた。
    const selected = decideSelectedTargetCommentAnchor(INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE, blockAnchor);
    const idleSweep = decideTextSelectionCleared(selected.gate);
    expect(idleSweep.emit).toBe(false);
    expect(idleSweep.handOverToSelectedTarget).toBe(false);
    expect(idleSweep.gate.emittedKey).toBe(commentAnchorCandidateKey(blockAnchor));

    const nextSweep = decideSelectedTargetCommentAnchor(idleSweep.gate, blockAnchor);
    expect(nextSweep.emit).toBe(false);
  });

  it("keeps ownership while a selection exists even if no comment anchor could be built", () => {
    // 範囲の端がブロックに解決できないと anchor は null になるが、選択自体は生きている。
    // ここで所有権を手放すと、選択したままなのにブロック候補が割り込む。
    const selection = decideTextSelectionCommentAnchor(INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE, null);
    expect(selection.gate.textSelectionActive).toBe(true);
    expect(decideSelectedTargetCommentAnchor(selection.gate, blockAnchor).emit).toBe(false);
  });

  it("hands ownership over without emitting an intermediate null", () => {
    const selected = decideTextSelectionCommentAnchor(INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE, textRangeAnchor);
    const cleared = decideTextSelectionCleared(selected.gate);
    // null を挟むと候補ポップオーバーが一瞬消えて戻る。次の値は選択ターゲット側が決める。
    expect(cleared.emit).toBe(false);
    expect(cleared.handOverToSelectedTarget).toBe(true);
    expect(cleared.gate.textSelectionActive).toBe(false);

    const target = decideSelectedTargetCommentAnchor(cleared.gate, otherBlockAnchor);
    expect(target.emit).toBe(true);
    expect(target.gate.emittedKey).toBe(commentAnchorCandidateKey(otherBlockAnchor));
  });

  it("clears the candidate through the selected-target path when nothing is selected", () => {
    const selected = decideTextSelectionCommentAnchor(INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE, textRangeAnchor);
    const cleared = decideTextSelectionCleared(selected.gate);
    const target = decideSelectedTargetCommentAnchor(cleared.gate, null);
    expect(target.emit).toBe(true);
    expect(target.gate.emittedKey).toBe("null");
  });

  it("does not hand ownership over while the extension retains the candidate", () => {
    // AI ピン留め中。所有権を返すと選択ターゲット側が自分の候補で上書きしてしまう。
    const selected = decideTextSelectionCommentAnchor(INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE, textRangeAnchor);
    const cleared = decideTextSelectionCleared(selected.gate, { retainOnClear: true });
    expect(cleared.emit).toBe(false);
    expect(cleared.handOverToSelectedTarget).toBe(false);
    expect(cleared.gate.emittedKey).toBe(commentAnchorCandidateKey(textRangeAnchor));
    expect(cleared.gate.textSelectionActive).toBe(false);
  });

  it("ignores a repeated clear", () => {
    const selected = decideTextSelectionCommentAnchor(INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE, textRangeAnchor);
    const cleared = decideTextSelectionCleared(selected.gate);
    const clearedAgain = decideTextSelectionCleared(cleared.gate);
    expect(clearedAgain.handOverToSelectedTarget).toBe(false);
    expect(clearedAgain.emit).toBe(false);
  });
});

describe("popover equality", () => {
  it("treats the same action key at the same rounded position as unchanged", () => {
    const current = { action: { key: "ai:block_1" }, position: { left: 100.2, top: 40.1 } };
    const next = { action: { key: "ai:block_1" }, position: { left: 100.4, top: 39.9 } };
    expect(sameExtensionActionPopover(current, next)).toBe(true);
  });

  it("detects an action key change", () => {
    const current = { action: { key: "ai:block_1" }, position: { left: 100, top: 40 } };
    const next = { action: { key: "ai:block_2" }, position: { left: 100, top: 40 } };
    expect(sameExtensionActionPopover(current, next)).toBe(false);
  });

  it("detects a moved popover", () => {
    const current = { action: { key: "ai:block_1" }, position: { left: 100, top: 40 } };
    const next = { action: { key: "ai:block_1" }, position: { left: 100, top: 60 } };
    expect(sameExtensionActionPopover(current, next)).toBe(false);
  });

  it("treats null on both sides as unchanged and one-sided null as changed", () => {
    expect(sameExtensionActionPopover(null, null)).toBe(true);
    expect(sameExtensionActionPopover(null, { action: { key: "a" }, position: { left: 0, top: 0 } })).toBe(false);
    expect(sameCommentAnchorPopover(null, null)).toBe(true);
    expect(sameCommentAnchorPopover({ anchor: blockAnchor, position: { left: 0, top: 0 } }, null)).toBe(false);
  });

  it("compares comment popovers by anchor value and rounded position", () => {
    expect(sameCommentAnchorPopover(
      { anchor: blockAnchor, position: { left: 10.1, top: 20.2 } },
      { anchor: { type: "block", blockId: "block_1" }, position: { left: 10.4, top: 19.8 } },
    )).toBe(true);
    expect(sameCommentAnchorPopover(
      { anchor: blockAnchor, position: { left: 10, top: 20 } },
      { anchor: otherBlockAnchor, position: { left: 10, top: 20 } },
    )).toBe(false);
  });
});
