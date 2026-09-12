import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InlineNode, SigmaCommentAnchor } from "@sigma-studio/viewer";

import { AiEditorHost, useAiProposalActions, useCommentAiRun } from "./desktop-ai-disabled";

let mounted: { root: Root; container: HTMLDivElement } | undefined;

afterEach(() => {
  if (!mounted) return;
  act(() => mounted?.root.unmount());
  mounted.container.remove();
  mounted = undefined;
});

describe("public Editor disabled AI hooks", () => {
  it("keeps the AI host and its children absent without subscribing to interactions", () => {
    const mountPanel = vi.fn();
    const close = vi.fn();
    const listener = vi.spyOn(window, "addEventListener");
    function PanelProbe() {
      useLayoutEffect(mountPanel, []);
      return <textarea aria-label="private AI input" />;
    }
    render(<AiEditorHost enabled inlineSessionId={1} onClose={close}><PanelProbe /></AiEditorHost>);
    render(<AiEditorHost enabled inlineSessionId={2} onClose={close}><PanelProbe /></AiEditorHost>);
    expect(document.querySelector(".ai-sidebar-panel")).toBeNull();
    expect(document.querySelector("textarea[aria-label='private AI input']")).toBeNull();
    expect(mountPanel).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(listener.mock.calls.filter(([type]) => type === "blur" || type.startsWith("pointer"))).toEqual([]);
  });

  it("keeps every proposal action unavailable without invoking host mutation ports", async () => {
    const host = { approve: vi.fn(), setDocument: vi.fn(), setBusy: vi.fn(), notify: vi.fn() };
    let actions!: ReturnType<typeof useAiProposalActions>;
    function Probe() {
      const result = useAiProposalActions(host);
      useLayoutEffect(() => { actions = result; });
      return null;
    }
    render(<Probe />);
    const firstActions = actions;
    await act(async () => {
      for (const operation of [
        actions.applyAiEditPreviewGroup,
        actions.forceApplyStaleProposals,
        actions.rebaseStaleProposals,
        actions.restoreProposalFromHistory,
        actions.revertAppliedProposals,
      ]) {
        expect(await operation(["proposal-1"])).toEqual({ ok: false, reason: "AI編集は公開Editorに含まれていません" });
      }
      await actions.applyAllAiEditPreviewGroups();
      await actions.dismissAiEditPreviewGroup(["proposal-1"], "不要");
      await actions.discardStaleProposals(["proposal-1"]);
      actions.clearAiEditPreview("applied", [{ roomId: "room", turnId: "turn" }], true);
    });
    render(<Probe />);
    expect(actions).toBe(firstActions);
    expect(actions.aiApplyAnimation).toBeNull();
    expect(actions.aiEditPreviewClearRequest).toEqual({ seq: 0, outcome: "dismissed" });
    for (const port of Object.values(host)) expect(port).not.toHaveBeenCalled();
  });

  it("disables comment AI delivery in a passive effect without appending replies or running a provider", () => {
    type Submit = (threadId: string, body: InlineNode[], anchor: SigmaCommentAnchor) => void;
    const previousSubmission = vi.fn<Submit>();
    const onCommentSubmittedRef = { current: previousSubmission as Submit };
    const host = { onCommentSubmittedRef, appendReplyMessage: vi.fn(), editCommentMessage: vi.fn(), runAiEdit: vi.fn() };
    let trigger!: Submit;
    let handlerAtLayout!: Submit;
    function Probe() {
      const result = useCommentAiRun(host);
      useLayoutEffect(() => {
        trigger = result;
        handlerAtLayout = onCommentSubmittedRef.current;
      });
      return null;
    }
    render(<Probe />);
    expect(handlerAtLayout).toBe(previousSubmission);
    expect(onCommentSubmittedRef.current).toBe(trigger);
    const anchor: SigmaCommentAnchor = { type: "block", blockId: "paragraph" };
    act(() => {
      for (const mention of ["@codex", "@claude", "@antigravity"]) {
        onCommentSubmittedRef.current("thread", [{ type: "text", text: `${mention} コメント` }], anchor);
      }
    });
    const previousTrigger = trigger;
    render(<Probe />);
    expect(trigger).toBe(previousTrigger);
    expect(previousSubmission).not.toHaveBeenCalled();
    expect(host.appendReplyMessage).not.toHaveBeenCalled();
    expect(host.editCommentMessage).not.toHaveBeenCalled();
    expect(host.runAiEdit).not.toHaveBeenCalled();
  });
});

function render(element: React.ReactElement) {
  if (!mounted) {
    const container = document.createElement("div");
    document.body.append(container);
    mounted = { root: createRoot(container), container };
  }
  act(() => mounted?.root.render(element));
}
