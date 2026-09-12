// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AssistantTurnView, type AssistantTurn } from "./AiEditPanel";
import type { AiEditPreviewState } from "@/components/editor/ai-edit-preview-types";

describe("AssistantTurnView apply failure", () => {
  it("renders the failed reason beside the clicked apply action and keeps the proposal pending", async () => {
    const reason = "対象が更新されたため適用できませんでした";
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
      result: {
        draft: {
          summary: "本文を直します",
          plan: [],
          warnings: [],
          operations: [],
        },
        questions: [],
      },
    } as unknown as AssistantTurn;
    const proposal: AiEditPreviewState = {
      targetId: "p1",
      roomId: "room-1",
      turnId: "turn-1",
      proposalIds: ["proposal-1"],
      baseRevision: 1,
      providers: ["chatgpt"],
      createdAt: 0,
      draft: {
        summary: "本文を直します",
        plan: [],
        warnings: [],
        operations: [],
      },
    };
    const onApplyProposal = vi.fn(async () => ({ ok: false as const, reason }));

    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(
        <AssistantTurnView turn={turn} clockNow={0} proposal={proposal}
          proposalBusy={false} onApplyProposal={onApplyProposal} />,
      ));
      const applyButton = container.querySelector<HTMLButtonElement>(".ai-chat-result-proposal-actions button");
      expect(applyButton).not.toBeNull();
      await act(async () => applyButton!.click());
      expect(onApplyProposal).toHaveBeenCalledWith(["proposal-1"]);
      expect(container.querySelector(".ai-chat-error")?.textContent).toBe(reason);
      expect(container.querySelector(".ai-chat-result-proposal")).not.toBeNull();
      expect(container.querySelector(".ai-chat-result-proposal-actions button")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
