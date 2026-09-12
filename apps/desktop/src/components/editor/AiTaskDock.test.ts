import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AiTaskDock,
  AiTaskDockPanel,
  buildTaskRows,
  buildWebMcpHistoryRows,
  countAiTaskBadge,
  excerptForBlock,
  hasActiveAiTaskRun,
  type TaskRow,
} from "./AiTaskDock";
import type { AiEditChatRoom } from "@/lib/ai/ai-run-controller";
import type { AiRunSession } from "@/lib/ai/ai-run-session-store";
import type { AiEditPreviewState, StaleMcpProposalGroup } from "@/components/editor/ai-edit-preview-types";
import type { DesktopMcpEditProposalSummary } from "@/types/desktop";
import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import type { SigmaDocument } from "@/types/sigma-doc";

function makeDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_1",
    metadata: { title: "テスト教材" },
    content: [
      { id: "p1", type: "paragraph", children: [{ type: "text", text: "二次関数のグラフを描く問題です" }] },
    ],
    outputProfiles: {
      student: { showSolutions: false, showHints: false },
      teacher: { showSolutions: true, showHints: true },
      answerBook: { onlySolutions: true, includeAnswers: true },
    },
  };
}

function makeRoom(overrides: Partial<AiEditChatRoom> & { id: string }): AiEditChatRoom {
  return {
    version: 1,
    documentIdentityKey: "doc_1",
    title: "新しい会話",
    agentThreadId: null,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    turns: [],
    ...overrides,
  };
}

function makeStale(overrides: Partial<StaleMcpProposalGroup> = {}): StaleMcpProposalGroup {
  return {
    baseRevision: 1,
    currentRevision: 2,
    proposalIds: ["stale_1"],
    providers: ["claude"],
    summary: "書き換え",
    createdAt: Date.now(),
    kind: "manual-rebase",
    ...overrides,
  };
}

function makeSession(overrides: Partial<AiRunSession> = {}): AiRunSession {
  return {
    roomId: "room_1",
    runId: "turn_1",
    provider: "chatgpt",
    status: "running",
    events: [],
    streamText: "",
    planSteps: [],
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    anchor: { primaryBlockId: "p1", blockIds: ["p1"], shapeIds: [] },
    queuedMessages: [],
    ...overrides,
  };
}

function makePreviewGroup(overrides: Partial<AiEditPreviewState> = {}): AiEditPreviewState {
  const draft: AiEditSessionDraft = { summary: "本文を書き換えます", plan: [], operations: [], warnings: [] };
  return {
    targetId: "p1",
    draft,
    createdAt: Date.now(),
    proposalIds: ["proposal_1"],
    baseRevision: 1,
    providers: ["chatgpt"],
    ...overrides,
  };
}

function makeProposal(overrides: Partial<DesktopMcpEditProposalSummary> = {}): DesktopMcpEditProposalSummary {
  const draft: AiEditSessionDraft = { summary: "編集", plan: [], operations: [], warnings: [] };
  return {
    proposalId: "proposal_1",
    fileId: "doc_1",
    baseRevision: 1,
    baseDocId: "doc_1",
    title: "教材",
    summary: "編集",
    plan: [],
    warnings: [],
    changedIds: ["p1"],
    provider: "chatgpt",
    draft,
    status: "approved",
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("excerptForBlock", () => {
  it("returns null for a null block", () => {
    expect(excerptForBlock(null)).toBeNull();
  });

  it("extracts and truncates paragraph text", () => {
    const long = "あ".repeat(40);
    const excerpt = excerptForBlock({ id: "p1", type: "paragraph", children: [{ type: "text", text: long }] });
    expect(excerpt).not.toBeNull();
    expect(excerpt!.length).toBeLessThan(long.length);
    expect(excerpt!.endsWith("…")).toBe(true);
  });

  it("returns null for an empty paragraph", () => {
    expect(excerptForBlock({ id: "p1", type: "paragraph", children: [] })).toBeNull();
  });

  it("uses the section title directly", () => {
    expect(excerptForBlock({ id: "s1", type: "section", title: "第1章" })).toBe("第1章");
  });
});

describe("buildTaskRows", () => {
  const document = makeDocument();

  it("shows a running session as an active row with no proposal actions", () => {
    const room = makeRoom({ id: "room_1", title: "数式の見直し" });
    const sessions = new Map([["room_1", makeSession({ status: "running" })]]);

    const rows = buildTaskRows([room], sessions, [], [], [], document, 1);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "running", label: "数式の見直し", proposalIds: [] });
    expect(rows[0].anchorExcerpt).toContain("二次関数");
  });

  it("labels a queued (same-anchor) run as waiting", () => {
    const room = makeRoom({ id: "room_1" });
    const sessions = new Map([["room_1", makeSession({ status: "waiting" })]]);

    const rows = buildTaskRows([room], sessions, [], [], [], document, 1);

    expect(rows[0].status).toBe("waiting");
  });

  it("shows a pending proposal group as 'proposal' once the run itself has settled", () => {
    const room = makeRoom({ id: "room_1" });
    const sessions = new Map([["room_1", makeSession({ status: "completed" })]]);
    const group = makePreviewGroup({ roomId: "room_1", sessionLabel: "会話A" });

    const rows = buildTaskRows([room], sessions, [group], [], [], document, 1);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "proposal", label: "会話A", proposalIds: ["proposal_1"] });
  });

  it("shows a stale group with a '要作り直し' label and no proposalIds mixed into a fresh group", () => {
    const room = makeRoom({ id: "room_1" });
    const sessions = new Map<string, AiRunSession>();
    const stale = makeStale({ roomId: "room_1" });

    const rows = buildTaskRows([room], sessions, [], [stale], [], document, 2);

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toContain("要作り直し");
    expect(rows[0].proposalIds).toEqual(["stale_1"]);
    expect(rows[0].staleKind).toBe("manual-rebase");
  });

  it("shows a '競合' label (not '要作り直し') for a stale group flagged as a conflict", () => {
    const room = makeRoom({ id: "room_1" });
    const sessions = new Map<string, AiRunSession>();
    const stale = makeStale({ roomId: "room_1", kind: "conflict", conflictBlockIds: ["b1"] });

    const rows = buildTaskRows([room], sessions, [], [stale], [], document, 2);

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toContain("競合");
    expect(rows[0].label).not.toContain("要作り直し");
    expect(rows[0].staleKind).toBe("conflict");
  });

  it("shows the most recent resolved proposal as applied/auto-applied/rejected/reverted, once there is nothing pending", () => {
    const room = makeRoom({ id: "room_1" });
    const sessions = new Map<string, AiRunSession>();
    const approved = makeProposal({ proposalId: "p_old", status: "approved", updatedAt: "2026-06-27T00:00:01.000Z", roomId: "room_1" });
    const rejected = makeProposal({ proposalId: "p_new", status: "rejected", updatedAt: "2026-06-27T00:00:05.000Z", roomId: "room_1" });

    const rows = buildTaskRows([room], sessions, [], [], [approved, rejected], document, 1);

    // Most recently updated resolved proposal wins.
    expect(rows[0].status).toBe("rejected");
    expect(rows[0].restorableProposalId).toBe("p_new");
  });

  it("also offers restore for a reverted proposal (承認取消/undo), not just rejected", () => {
    const room = makeRoom({ id: "room_1" });
    const sessions = new Map<string, AiRunSession>();
    const reverted = makeProposal({ proposalId: "p_reverted", status: "reverted", roomId: "room_1" });

    const rows = buildTaskRows([room], sessions, [], [], [reverted], document, 1);

    expect(rows[0].status).toBe("reverted");
    expect(rows[0].restorableProposalId).toBe("p_reverted");
  });

  it("marks an auto-applied proposal distinctly from a manually applied one", () => {
    const room = makeRoom({ id: "room_1" });
    const sessions = new Map<string, AiRunSession>();
    const autoApplied = makeProposal({ status: "approved", autoApplied: true, roomId: "room_1" });

    const rows = buildTaskRows([room], sessions, [], [], [autoApplied], document, 1);

    expect(rows[0].status).toBe("auto-applied");
  });

  it("keeps an applied proposal revertible after the document revision moved on (main decides full vs. selective)", () => {
    const room = makeRoom({ id: "room_1" });
    const sessions = new Map<string, AiRunSession>();
    const applied = makeProposal({ proposalId: "p_applied", status: "approved", appliedRevision: 2, roomId: "room_1" });

    const stillCurrent = buildTaskRows([room], sessions, [], [], [applied], document, 2);
    expect(stillCurrent[0].revertibleProposalIds).toEqual(["p_applied"]);
    expect(stillCurrent[0].restorableProposalId).toBeNull();

    const movedOn = buildTaskRows([room], sessions, [], [], [applied], document, 3);
    expect(movedOn[0].revertibleProposalIds).toEqual(["p_applied"]);
  });

  it("offers every approved batch of the room, not just the most recently updated one", () => {
    const room = makeRoom({ id: "room_1" });
    const sessions = new Map<string, AiRunSession>();
    // 古い保存バッチの方が後から更新されていても、両方を revert 対象として渡す
    // (巻き戻す順序は EditorShell 側の selectSequentialAiRevertProposalIds が決める)。
    const older = makeProposal({
      proposalId: "p_old",
      status: "approved",
      appliedRevision: 2,
      roomId: "room_1",
      updatedAt: "2026-06-27T00:00:09.000Z",
    });
    const newer = makeProposal({
      proposalId: "p_new",
      status: "approved",
      appliedRevision: 3,
      roomId: "room_1",
      updatedAt: "2026-06-27T00:00:01.000Z",
    });

    const rows = buildTaskRows([room], sessions, [], [], [older, newer], document, 3);
    expect(rows[0].status).toBe("applied");
    expect([...rows[0].revertibleProposalIds].sort()).toEqual(["p_new", "p_old"]);
  });

  it("marks an applied proposal non-revertible only when nothing identifies the saved batch", () => {
    const room = makeRoom({ id: "room_1" });
    const sessions = new Map<string, AiRunSession>();
    const legacy = makeProposal({ proposalId: "p_legacy", status: "approved", roomId: "room_1" });

    // appliedRevision が記録されていない旧レコード: main側に戻す土台が無い。
    expect(buildTaskRows([room], sessions, [], [], [legacy], document, 3)[0].revertibleProposalIds).toEqual([]);

    const applied = makeProposal({ proposalId: "p_applied", status: "approved", appliedRevision: 2, roomId: "room_1" });
    expect(buildTaskRows([room], sessions, [], [], [applied], document, null)[0].revertibleProposalIds).toEqual([]);
  });

  it("omits a room with nothing active, pending, stale, or resolved to show", () => {
    const room = makeRoom({ id: "room_1" });
    const rows = buildTaskRows([room], new Map(), [], [], [], document, 1);
    expect(rows).toHaveLength(0);
  });

  it("still surfaces a preview group whose room is not in the document's room list", () => {
    const group = makePreviewGroup({ roomId: "room_unknown", sessionLabel: "外部セッション" });
    const rows = buildTaskRows([], new Map(), [group], [], [], document, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("外部セッション");
  });
});

function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    key: "room_1",
    roomId: "room_1",
    runId: null,
    provider: null,
    status: "applied",
    label: "AI編集",
    anchorExcerpt: null,
    proposalIds: [],
    revertibleProposalIds: [],
    restorableProposalId: null,
    ...overrides,
  };
}

describe("countAiTaskBadge (collapsed dock badge count)", () => {
  it("counts running and waiting rows as actionable", () => {
    const rows = [makeRow({ status: "running" }), makeRow({ key: "room_2", status: "waiting" })];
    expect(countAiTaskBadge(rows)).toBe(2);
  });

  it("counts a pending proposal row (including a conflict-flagged one)", () => {
    const rows = [makeRow({ status: "proposal" }), makeRow({ key: "room_2", status: "proposal", staleKind: "conflict" })];
    expect(countAiTaskBadge(rows)).toBe(2);
  });

  it("does not count settled rows (applied/auto-applied/rejected/reverted)", () => {
    const rows = [
      makeRow({ status: "applied" }),
      makeRow({ key: "room_2", status: "auto-applied" }),
      makeRow({ key: "room_3", status: "rejected" }),
      makeRow({ key: "room_4", status: "reverted" }),
    ];
    expect(countAiTaskBadge(rows)).toBe(0);
  });

  it("returns 0 for an empty row list", () => {
    expect(countAiTaskBadge([])).toBe(0);
  });
});

describe("hasActiveAiTaskRun (collapsed icon shimmer)", () => {
  it("is true when a row is running or waiting", () => {
    expect(hasActiveAiTaskRun([makeRow({ status: "running" })])).toBe(true);
    expect(hasActiveAiTaskRun([makeRow({ status: "waiting" })])).toBe(true);
  });

  it("is false for a pending proposal with no run actually executing", () => {
    expect(hasActiveAiTaskRun([makeRow({ status: "proposal" })])).toBe(false);
  });

  it("is false for an empty row list", () => {
    expect(hasActiveAiTaskRun([])).toBe(false);
  });
});

describe("AiTaskDock (collapsed-by-default top-left icon)", () => {
  const document = makeDocument();
  const noop = () => {};
  const applySuccess = async () => ({ ok: true as const });
  const noopAsync = async () => ({ ok: true as const });

  it("renders only the toggle icon when collapsed (default), with no badge and no task list", () => {
    const html = renderToStaticMarkup(
      createElement(AiTaskDock, {
        documentIdentityKey: "doc_1",
        document,
        previewGroups: [],
        staleGroups: [],
        activeDocumentRevision: 1,
        busy: false,
        onApplyGroup: applySuccess,
        onDismissGroup: noop,
        onRebaseGroup: noopAsync,
        onRevertProposal: noop,
        resolvedProposals: [],
      }),
    );

    expect(html).toContain("ai-task-dock-toggle");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("AIタスク");
    expect(html).not.toContain("ai-task-dock-list");
    expect(html).not.toContain("ai-task-dock-badge");
  });

  it("uses resolved proposal props without scanning desktop storage", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./AiTaskDock.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).not.toContain("listMcpEditProposals");
  });
});

describe("AiTaskDockPanel (expanded panel content)", () => {
  const noop = () => {};
  const applySuccess = async () => ({ ok: true as const });
  const noopAsync = async () => ({ ok: true as const });

  it("renders the empty state when there are no rows", () => {
    const html = renderToStaticMarkup(
      createElement(AiTaskDockPanel, {
        rows: [],
        busy: false,
        onApplyGroup: applySuccess,
        onDismissGroup: noop,
        onRebaseGroup: noopAsync,
        onRevertProposal: noop,
      }),
    );

    expect(html).toContain("実行中のAIタスクはありません");
  });

  it("renders an icon-only close action when a close handler is provided", () => {
    const html = renderToStaticMarkup(
      createElement(AiTaskDockPanel, {
        rows: [],
        busy: false,
        onApplyGroup: applySuccess,
        onDismissGroup: noop,
        onRebaseGroup: noopAsync,
        onRevertProposal: noop,
        onClose: noop,
      }),
    );

    expect(html).toContain('aria-label="閉じる"');
    expect(html).not.toContain(">閉じる</button>");
  });

  it("renders rows with no redundant proposal label and shared ×/○ decision icons", () => {
    const rows = [
      makeRow({ key: "room_1", label: "数式の見直し", status: "running", runId: "run_1" }),
      makeRow({ key: "room_2", label: "図形の追加", status: "proposal", proposalIds: ["proposal_1"] }),
    ];
    const html = renderToStaticMarkup(
      createElement(AiTaskDockPanel, {
        rows,
        busy: false,
        onApplyGroup: applySuccess,
        onDismissGroup: noop,
        onRebaseGroup: noopAsync,
        onRevertProposal: noop,
      }),
    );

    expect(html).toContain("数式の見直し");
    expect(html).toContain("図形の追加");
    expect(html).not.toContain("実行中");
    expect(html).not.toContain("提案あり");
    expect(html).toContain("ai-task-dock-row");
    expect(html).toContain('aria-label="停止"');
    expect(html).toContain('aria-label="適用"');
    expect(html).toContain("ui-shimmer-text");
    expect(html).toContain("ai-task-dock-action--stop");
    expect(html).toContain('width="8"');
    expect(html).toContain("lucide-check");
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toContain(">停止</button>");
    expect(html).not.toContain(">適用</button>");
  });

  it("shows force apply only for content-stale conflicts", () => {
    const renderConflict = (reason: TaskRow["staleConflictReason"]) => renderToStaticMarkup(
      createElement(AiTaskDockPanel, {
        rows: [makeRow({
          status: "proposal",
          proposalIds: ["proposal_1"],
          staleKind: "conflict",
          staleConflictReason: reason,
          staleMessage: reason === "content-stale" ? undefined : "提案の再生成が必要です",
        })],
        busy: false,
        onApplyGroup: applySuccess,
        onDismissGroup: noop,
        onRebaseGroup: noopAsync,
        onForceApplyGroup: noopAsync,
        onRevertProposal: noop,
      }),
    );

    expect(renderConflict("content-stale")).toContain("AIの提案で上書き");
    const anchorMissingHtml = renderConflict("anchor-missing");
    expect(anchorMissingHtml).toContain("提案の再生成が必要です");
    expect(anchorMissingHtml).not.toContain("AIの提案で上書き");
  });
});


describe("buildWebMcpHistoryRows (Web版の結果行)", () => {
  it("keeps applied and discarded drafts visible with no revert or repropose affordance", () => {
    const rows = buildWebMcpHistoryRows(
      [
        { entryId: "entry_2", id: "webmcp_single_draft", status: "rejected", operationCount: 2, targetIds: ["p1"], resolvedAt: 2 },
        { entryId: "entry_1", id: "webmcp_single_draft", status: "applied", operationCount: 1, targetIds: ["p1"], resolvedAt: 1 },
      ],
      makeDocument(),
    );

    expect(rows.map((row) => row.status)).toEqual(["rejected", "applied"]);
    expect(rows.map((row) => row.key)).toEqual(["webmcp-history:entry_2", "webmcp-history:entry_1"]);
    expect(new Set(rows.map((row) => row.key).filter(Boolean)).size).toBe(2);
    expect(rows.map((row) => row.proposalIds)).toEqual([
      ["webmcp_single_draft"],
      ["webmcp_single_draft"],
    ]);
    expect(rows[0]!.anchorExcerpt).toBe("二次関数のグラフを描く問題です");
    // Webには承認バッチも巻き戻し判定も無い。押せるボタンを生やさないこと。
    expect(rows.every((row) => row.revertibleProposalIds.length === 0)).toBe(true);
    expect(rows.every((row) => row.restorableProposalId === null)).toBe(true);
    expect(rows.every((row) => row.roomId === null)).toBe(true);
    // 決着済みなので、たたんだアイコンのバッジは動かさない。
    expect(countAiTaskBadge(rows)).toBe(0);
  });

  it("still renders a row when the changed block is already gone", () => {
    const rows = buildWebMcpHistoryRows(
      [{ entryId: "entry_1", id: "draft_1", status: "applied", operationCount: 1, targetIds: ["removed"], resolvedAt: 1 }],
      makeDocument(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.anchorExcerpt).toBeNull();
  });
});

describe("AiTaskDockPanel (Web版のWebMCP区画)", () => {
  const noop = () => {};
  const applySuccess = async () => ({ ok: true as const });
  const noopAsync = async () => ({ ok: true as const });

  const render = (webMcpInstructionScopeId?: string) => renderToStaticMarkup(
    createElement(AiTaskDockPanel, {
      rows: [],
      busy: false,
      onApplyGroup: applySuccess,
      onDismissGroup: noop,
      onRebaseGroup: noopAsync,
      onRevertProposal: noop,
      webMcpInstructionScopeId,
    }),
  );

  it("shows the connection state and the agent instructions inside the dock on web", () => {
    const html = render("doc_1");

    expect(html).toContain("ai-task-dock-webmcp");
    expect(html).toContain("エージェントへの指示");
    expect(html).toContain("ai-task-dock-webmcp-input");
  });

  it("shows nothing web-specific on desktop", () => {
    const html = render();

    expect(html).not.toContain("ai-task-dock-webmcp");
    expect(html).not.toContain("エージェントへの指示");
  });
});
