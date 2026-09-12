import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiStaleProposalNotice, staleProposalAutoRebaseKey } from "./AiStaleProposalNotice";
import type { StaleMcpProposalGroup } from "./ai-edit-preview-types";

function group(overrides: Partial<StaleMcpProposalGroup> = {}): StaleMcpProposalGroup {
  return {
    baseRevision: 3,
    currentRevision: 4,
    proposalIds: ["mcp_proposal_1", "mcp_proposal_2"],
    providers: ["claude"],
    summary: "本文を書き換え",
    createdAt: Date.now(),
    kind: "manual-rebase",
    ...overrides,
  };
}

describe("AiStaleProposalNotice", () => {
  it("renders nothing when there are no stale groups", () => {
    const html = renderToStaticMarkup(
      <AiStaleProposalNotice groups={[]} onDiscard={() => {}} />,
    );

    expect(html).toBe("");
  });

  it("shows the fixed notice copy and the proposal count", () => {
    const html = renderToStaticMarkup(
      <AiStaleProposalNotice groups={[group()]} onDiscard={() => {}} />,
    );

    expect(html).toContain("教材のrevisionが変わったため作り直しが必要");
    expect(html).toContain("2件");
    expect(html).toContain("revision 3→4");
  });

  it("renders a discard button with an accessible title", () => {
    const html = renderToStaticMarkup(
      <AiStaleProposalNotice groups={[group()]} onDiscard={() => {}} />,
    );

    expect(html).toContain("この編集案を破棄");
    expect(html).toContain(">破棄<");
  });

  it("renders one row per group", () => {
    const html = renderToStaticMarkup(
      <AiStaleProposalNotice
        groups={[group({ baseRevision: 1 }), group({ baseRevision: 2 })]}
        onDiscard={() => {}}
      />,
    );

    expect(html.match(/ai-stale-proposal-row/g) ?? []).toHaveLength(2);
  });

  it("shows the manual 'rebase' button only for kind === 'manual-rebase', not for 'pending-auto-rebase'", () => {
    const html = renderToStaticMarkup(
      <AiStaleProposalNotice
        groups={[group({ kind: "pending-auto-rebase" })]}
        onDiscard={() => {}}
        onRebase={() => Promise.resolve({ ok: true })}
      />,
    );

    expect(html).toContain("教材のrevisionが変わったため作り直しが必要");
    expect(html).not.toContain("作り直しを試す");
    // The discard action must still be available.
    expect(html).toContain(">破棄<");
  });

  it("shows the manual 'rebase' button for kind === 'manual-rebase' when onRebase is provided", () => {
    const html = renderToStaticMarkup(
      <AiStaleProposalNotice
        groups={[group({ kind: "manual-rebase" })]}
        onDiscard={() => {}}
        onRebase={() => Promise.resolve({ ok: true })}
      />,
    );

    expect(html).toContain("作り直しを試す");
  });

  it("renders a distinct conflict notice, with no rebase button, for kind === 'conflict'", () => {
    const html = renderToStaticMarkup(
      <AiStaleProposalNotice
        groups={[group({ kind: "conflict", conflictBlockIds: ["b1", "b2"], conflictReason: "content-stale" })]}
        onDiscard={() => {}}
        onRebase={() => Promise.resolve({ ok: true })}
        onForceApply={() => Promise.resolve({ ok: true })}
      />,
    );

    expect(html).toContain("ユーザーの編集と競合しています");
    expect(html).toContain("2箇所");
    expect(html).not.toContain("教材のrevisionが変わったため作り直しが必要");
    expect(html).not.toContain("作り直しを試す");
    expect(html).toContain("編集を優先して破棄");
    expect(html).toContain("AIの提案で上書き");
  });

  it.each([
    ["anchor-missing", "挿入先または更新対象がなくなったため、提案の再生成が必要です"],
    ["asset-collision", "同じIDの画像素材があるため、提案の再生成が必要です"],
  ] as const)("requires regeneration and hides force apply for %s", (conflictReason, message) => {
    const html = renderToStaticMarkup(
      <AiStaleProposalNotice
        groups={[group({ kind: "conflict", conflictBlockIds: ["b1"], conflictReason })]}
        onDiscard={() => {}}
        onForceApply={() => Promise.resolve({ ok: true })}
      />,
    );

    expect(html).toContain(message);
    expect(html).not.toContain("AIの提案で上書き");
    expect(html).toContain("編集を優先して破棄");
  });

  it("offers the existing AI chat re-request path for conflicts that cannot be force-applied", () => {
    const html = renderToStaticMarkup(
      <AiStaleProposalNotice
        groups={[group({
          kind: "conflict",
          conflictBlockIds: ["missing_anchor"],
          conflictReason: "anchor-missing",
          roomId: "room_1",
        })]}
        onDiscard={() => {}}
        onReRequest={() => {}}
      />,
    );

    expect(html).toContain("AIに再依頼");
    expect(html).toContain("この編集案のチャットを開き、現在の教材に合わせて依頼し直す");
    expect(html).not.toContain("AIの提案で上書き");
  });

  it("omits the force-apply button for a conflict group when onForceApply is not provided", () => {
    const html = renderToStaticMarkup(
      <AiStaleProposalNotice
        groups={[group({ kind: "conflict", conflictBlockIds: ["b1"] })]}
        onDiscard={() => {}}
      />,
    );

    expect(html).toContain("提案の再生成が必要です");
    expect(html).not.toContain("AIの提案で上書き");
    // Discard remains available even without a force-apply option.
    expect(html).toContain("編集を優先して破棄");
  });

  it("falls back to the conflict group's proposal count for the block count when conflictBlockIds is absent", () => {
    const html = renderToStaticMarkup(
      <AiStaleProposalNotice
        groups={[group({ kind: "conflict", proposalIds: ["p1"], conflictBlockIds: undefined })]}
        onDiscard={() => {}}
      />,
    );

    expect(html).toContain("1箇所");
  });

  it("renders conflict and non-conflict stale groups side by side without mixing their actions", () => {
    const html = renderToStaticMarkup(
      <AiStaleProposalNotice
        groups={[
          group({ kind: "conflict", baseRevision: 1, proposalIds: ["conflicted"], conflictReason: "content-stale" }),
          group({ kind: "manual-rebase", baseRevision: 2, proposalIds: ["legacy"] }),
        ]}
        onDiscard={() => {}}
        onRebase={() => Promise.resolve({ ok: true })}
        onForceApply={() => Promise.resolve({ ok: true })}
      />,
    );

    expect(html).toContain("ユーザーの編集と競合しています");
    expect(html).toContain("教材のrevisionが変わったため作り直しが必要");
    // Exactly one rebase button (for the manual-rebase group only).
    expect(html.match(/>作り直しを試す</g) ?? []).toHaveLength(1);
    expect(html.match(/>AIの提案で上書き</g) ?? []).toHaveLength(1);
  });

  it("changes the auto-rebase key when the current revision changes for the same proposal", () => {
    const oldKey = staleProposalAutoRebaseKey(group({
      baseRevision: 181,
      currentRevision: 184,
      proposalIds: ["mcp_proposal_1"],
    }));
    const nextKey = staleProposalAutoRebaseKey(group({
      baseRevision: 181,
      currentRevision: 187,
      proposalIds: ["mcp_proposal_1"],
    }));

    expect(nextKey).not.toBe(oldKey);
  });
});
