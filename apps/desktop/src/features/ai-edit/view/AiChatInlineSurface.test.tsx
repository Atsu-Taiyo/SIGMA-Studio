// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AssistantTurn } from "@/lib/ai/ai-run-controller";

import type { AiEditPreviewState } from "../model/preview";
import { AiChatInlineSurface, type AiChatInlineSurfaceProps } from "./AiChatInlineSurface";

const turn = {
  id: "turn-1",
  role: "assistant",
  createdAt: 0,
  startedAt: 0,
  events: [],
  isRunning: false,
  applied: false,
  dismissed: false,
  restored: false,
  result: { draft: { summary: "本文を直しました", plan: [], warnings: [], operations: [] }, questions: [] },
} as unknown as AssistantTurn;

const proposal: AiEditPreviewState = {
  targetId: "p1",
  roomId: "room-1",
  turnId: "turn-1",
  proposalIds: ["proposal-1"],
  baseRevision: 1,
  providers: ["claude"],
  createdAt: 0,
  draft: { summary: "本文を直しました", plan: [], warnings: [], operations: [] },
};

function surfaceElement(
  proposals: Partial<AiChatInlineSurfaceProps["proposals"]> = {},
  shownTurn: AssistantTurn = turn,
) {
  return (
    <AiChatInlineSurface
      surface={{ inlineOpen: true, inlineAnchor: { left: 0, top: 0 } }}
      conversation={{
        provider: "claude",
        lockedProvider: null,
        visibleTurns: [shownTurn],
        latestAssistant: shownTurn,
        activeRoomId: "room-1",
        inlineRunTurnId: null,
        inlineBaselineTurnId: null,
        isRunning: false,
        clockNow: 0,
      }}
      proposals={{
        previewGroups: [proposal],
        busy: false,
        onApplyGroup: async () => ({ ok: true }),
        onDismissGroup: () => {},
        activeRoomPreview: proposal,
        ...proposals,
      }}
      composer={null}
      composerError={null}
      hasOpenMenu={false}
      retryTurn={() => {}}
      dismissTurn={() => {}}
    />
  );
}

function renderSurface(proposals: Partial<AiChatInlineSurfaceProps["proposals"]> = {}): string {
  return renderToStaticMarkup(surfaceElement(proposals));
}

describe("AiChatInlineSurface result", () => {
  it("always offers the decision bar in the result panel, also for a proposal with a card on the page", () => {
    // パネルは実行開始位置 (多くはカードの上) に浮かぶので、ここに承認操作が無いとパネルを閉じるまで
    // 適用・破棄できない。紙面のカードのバーとの重なりは見た目の課題として残す (操作が届くことを優先)。
    const html = renderSurface();
    expect(html).toContain("ai-inline-result");
    expect(html).toContain('data-ai-proposal-bar=""');
    expect(html).toContain('aria-label="適用"');
    expect(html).toContain('aria-label="破棄"');
  });

  it("adds the merge notice to its bar when the proposal content is merged with the human's edits", () => {
    const html = renderSurface({ isMergedWithHumanEdits: (preview) => preview === proposal });
    expect(html).toContain("あなたの編集と合わせた内容です");
    expect(renderSurface()).not.toContain("あなたの編集と合わせた内容です");
  });
});

describe("AiChatInlineSurface decision on the page", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  it("tells which proposal its bar decides while the bar is shown, so the page does not float a second one", () => {
    const onInlineDecisionShownChange = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => root.render(surfaceElement({ onInlineDecisionShownChange })));
    expect(onInlineDecisionShownChange.mock.calls).toEqual([[["proposal-1"], true]]);

    // 結果を閉じた (ターンを片付けた) ら、紙面のバーに戻す。
    act(() => root.render(surfaceElement({ onInlineDecisionShownChange }, { ...turn, dismissed: true })));
    expect(onInlineDecisionShownChange.mock.calls).toEqual([[["proposal-1"], true], [["proposal-1"], false]]);
    act(() => root.unmount());
  });
});
