import { describe, expect, it } from "vitest";

import {
  getTextFlowEditGuardsSyncKey,
  type TextFlowEditGuard,
  type TextFlowEditGuardPresentation,
} from "./edit-guard-extension";

const presentation: TextFlowEditGuardPresentation = {
  highlightedBlockClassName: "ai-edit-locked-block",
  readOnlyBlockClassName: "ai-edit-readonly-block",
  characterClassName: "ai-edit-lock-char",
  atomClassName: "ai-edit-lock-atom",
};

function guard(overrides: Partial<TextFlowEditGuard> = {}): TextFlowEditGuard {
  return {
    blockId: "p_first",
    guardId: "run_1",
    isPrimaryActionTarget: true,
    blockedMessage: "AI が編集中です",
    presentation,
    highlight: true,
    ...overrides,
  };
}

function guardMap(...guards: TextFlowEditGuard[]): ReadonlyMap<string, TextFlowEditGuard> {
  return new Map(guards.map((entry) => [entry.blockId, entry]));
}

describe("getTextFlowEditGuardsSyncKey", () => {
  it("is empty when nothing is guarded", () => {
    expect(getTextFlowEditGuardsSyncKey(new Map())).toBe("");
  });

  it("keeps one key for equal guards rebuilt into a new map", () => {
    // ガード表は打鍵のたびに作り直されるので、識別子で比べると装飾の再 dispatch が
    // 打鍵 × ユニット数だけ走る。
    expect(getTextFlowEditGuardsSyncKey(guardMap(guard())))
      .toBe(getTextFlowEditGuardsSyncKey(guardMap(guard())));
  });

  it("changes when the guard set, its scope, or its action changes", () => {
    const base = getTextFlowEditGuardsSyncKey(guardMap(guard()));

    expect(getTextFlowEditGuardsSyncKey(guardMap(guard({ highlight: false })))).not.toBe(base);
    expect(getTextFlowEditGuardsSyncKey(guardMap(guard({ guardId: "run_2" })))).not.toBe(base);
    expect(getTextFlowEditGuardsSyncKey(guardMap(guard({ isPrimaryActionTarget: false })))).not.toBe(base);
    expect(getTextFlowEditGuardsSyncKey(guardMap(guard({ blockedMessage: "別の理由" })))).not.toBe(base);
    expect(getTextFlowEditGuardsSyncKey(guardMap(guard({
      highlightScopes: [{ kind: "text", blockId: "p_first", from: 0, to: 3 }],
    })))).not.toBe(base);
    expect(getTextFlowEditGuardsSyncKey(guardMap(guard({
      action: {
        label: "停止",
        busyLabel: "停止中",
        failureTitle: "停止できませんでした",
        buttonClassName: "ai-edit-lock-stop",
        request: async () => ({ ok: true }),
      },
    })))).not.toBe(base);
    expect(getTextFlowEditGuardsSyncKey(guardMap(guard(), guard({ blockId: "p_second" })))).not.toBe(base);
  });

  it("tells 'no scopes' apart from 'an empty scope list'", () => {
    // undefined はブロック全体のハイライト、[] は範囲指定なしの部分ハイライトで見た目が違う。
    expect(getTextFlowEditGuardsSyncKey(guardMap(guard({ highlightScopes: [] }))))
      .not.toBe(getTextFlowEditGuardsSyncKey(guardMap(guard())));
  });

  it("does not collide when a message contains the separators of the key", () => {
    expect(getTextFlowEditGuardsSyncKey(guardMap(guard({ blockedMessage: "AI:編集中" }))))
      .not.toBe(getTextFlowEditGuardsSyncKey(guardMap(guard({ blockedMessage: "AI", guardId: "編集中" }))));
  });

  it("ignores the identity of the action callback so an unchanged lock stays quiet", () => {
    const action = {
      label: "停止",
      busyLabel: "停止中",
      failureTitle: "停止できませんでした",
      buttonClassName: "ai-edit-lock-stop",
    };

    expect(getTextFlowEditGuardsSyncKey(guardMap(guard({
      action: { ...action, request: async () => ({ ok: true }) },
    })))).toBe(getTextFlowEditGuardsSyncKey(guardMap(guard({
      action: { ...action, request: async () => ({ ok: false }) },
    }))));
  });
});
