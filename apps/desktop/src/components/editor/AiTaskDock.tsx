"use client";

import { History, ListTodo, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { renderProviderMark } from "@/components/branding/provider-logos";
import { AiThinkingOrb } from "@/components/branding/AiThinkingOrb";
import { AiProposalDecisionButton } from "@/components/editor/AiProposalDecisionButton";
import { WebMcpDockSection } from "@/components/editor/webmcp/WebMcpDockSection";
import type { WebMcpHistoryEntry } from "@/components/editor/webmcp/webmcp-history";
import { Shimmer } from "@/components/ui/Shimmer";
import { findBlock, type EditableBlock } from "@/lib/document-tree";
import { cancelRun, isDefaultChatRoomTitle, useAiChatRoomsForDocument, type AiEditChatRoom } from "@/lib/ai/ai-run-controller";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { isAiRunStatusActive, useAiRunSessions, type AiRunSession } from "@/lib/ai/ai-run-session-store";
import type { AiEditPreviewState, StaleMcpProposalGroup, StaleMcpProposalKind } from "@/components/editor/ai-edit-preview-types";
import type { DesktopMcpEditProposalSummary } from "@/types/desktop";
import type { InlineNode, SigmaDocument } from "@/features/document";
import type { AiProposalApplyOutcome } from "@/features/ai-edit";
import { WEB_MCP_PROPOSAL_ID } from "@/lib/webmcp-tools";

const ANCHOR_EXCERPT_MAX_LENGTH = 26;

function inlineNodesToText(nodes: InlineNode[]): string {
  return nodes.map((node) => (node.type === "text" ? node.text : "")).join("");
}

/** Short human-readable hint for a run's target block, shown in the dock so a
 * task can be told apart from another at a glance. Best-effort: unknown or
 * removed blocks simply render no excerpt. */
export function excerptForBlock(block: EditableBlock | null): string | null {
  if (!block) {
    return null;
  }
  let text = "";
  if (block.type === "paragraph" || block.type === "heading" || block.type === "listItem") {
    text = inlineNodesToText(block.children);
  } else if (block.type === "section") {
    text = block.title;
  } else if (block.type === "list") {
    text = block.items.map((item) => inlineNodesToText(item.children)).join(" ");
  } else if (block.type === "problem") {
    const first = block.prompt.find((rich) => rich.type === "paragraph");
    text = first && first.type === "paragraph" ? inlineNodesToText(first.children) : "";
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > ANCHOR_EXCERPT_MAX_LENGTH
    ? `${normalized.slice(0, ANCHOR_EXCERPT_MAX_LENGTH - 1)}…`
    : normalized;
}

// "rejected" doubles as the terminal state for a failed run with no
// resulting proposal (nothing left to apply/discard, just a historical marker).
export type TaskStatusKind = "waiting" | "running" | "proposal" | "applied" | "auto-applied" | "rejected" | "reverted";

/**
 * `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く。
 * 固定ロケールにすると渡し忘れが静かに日本語で出るバグになるため (WI-7 で実測)。
 * `window` の無い環境では既定ロケール (日本語) に落ちるので既存の期待値は不変。
 */
const DEFAULT_AI_TRANSLATE = createCurrentLocaleTranslator("ai");

/**
 * 状態 → 辞書キー。`auto-applied` だけハイフンを含むのでキーは camelCase に寄せる。
 * export してあるのは、辞書側の網羅検査がこの一覧を回せるようにするため。
 */
export const DOCK_STATUS_KEYS = [
  "waiting", "running", "proposal", "applied", "autoApplied", "rejected", "reverted",
] as const;

function statusLabel(kind: TaskStatusKind, t: Translate<"ai">): string {
  const key = kind === "auto-applied" ? "autoApplied" : kind;
  return t(`dock.status.${key}` as never) as unknown as string;
}

export interface TaskRow {
  key: string;
  roomId: string | null;
  runId: string | null;
  provider: "claude" | "chatgpt" | "antigravity" | null;
  status: TaskStatusKind;
  label: string;
  anchorExcerpt: string | null;
  proposalIds: string[];
  /** この部屋の適用済み提案のうち、巻き戻す土台 (appliedRevision) が記録されている全ID。
   * 1つのturnが複数回の保存に分かれていることがあるため単数ではない — 実際に巻き戻す
   * 順序は EditorShell の selectSequentialAiRevertProposalIds が決める。 */
  revertibleProposalIds: string[];
  restorableProposalId: string | null;
  /** stale group由来の行にだけ設定される (see classifyStaleMcpProposal)。"conflict" は
   * 通常の「作り直し」(blind replay) を絶対に出してはいけない — 人間の編集を黙って
   * 上書きしかねないため、代わりに破棄/強制上書きの2択を出す。 */
  staleKind?: StaleMcpProposalKind;
  staleConflictReason?: StaleMcpProposalGroup["conflictReason"];
  staleMessage?: string;
}

/**
 * 部屋の見出し。まだ名前が付いていなければ渡された既定文を使う。
 *
 * **「名前が付いていない」の判定を文字列比較でやらないこと。** 会話のタイトルは
 * 作った時点の言語で保存されるので、日本語の既定文と比較すると英語で作られた部屋が
 * 「名前あり」に見えてしまう (逆も同じ)。`isDefaultChatRoomTitle` は全ロケールを見る。
 */
function resolveRoomLabel(room: AiEditChatRoom | undefined, fallback: string): string {
  const title = room?.title?.trim();
  return title && !isDefaultChatRoomTitle(title) ? title : fallback;
}

export function buildTaskRows(
  rooms: AiEditChatRoom[],
  sessions: ReadonlyMap<string, AiRunSession>,
  previewGroups: AiEditPreviewState[],
  staleGroups: StaleMcpProposalGroup[],
  resolvedProposals: DesktopMcpEditProposalSummary[],
  document: SigmaDocument,
  activeDocumentRevision: number | null,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): TaskRow[] {
  const rows: TaskRow[] = [];
  const seenRoomIds = new Set<string>();

  const anchorExcerpt = (blockId: string | null | undefined): string | null =>
    blockId ? excerptForBlock(findBlock(document, blockId)) : null;

  const pushRoomRow = (room: AiEditChatRoom) => {
    seenRoomIds.add(room.id);
    const session = sessions.get(room.id) ?? null;

    if (session && isAiRunStatusActive(session.status)) {
      rows.push({
        key: room.id,
        roomId: room.id,
        runId: session.runId,
        provider: session.provider,
        status: session.status === "waiting" ? "waiting" : "running",
        label: resolveRoomLabel(room, t("dock.defaultLabel")),
        anchorExcerpt: anchorExcerpt(session.anchor?.primaryBlockId),
        proposalIds: [],
        revertibleProposalIds: [],
        restorableProposalId: null,
      });
      return;
    }

    const group = previewGroups.find((candidate) => candidate.roomId === room.id);
    if (group) {
      rows.push({
        key: room.id,
        roomId: room.id,
        runId: group.runId ?? null,
        provider: group.providers[0] ?? null,
        status: "proposal",
        label: group.sessionLabel?.trim() || resolveRoomLabel(room, t("dock.defaultLabel")),
        anchorExcerpt: anchorExcerpt(group.targetId),
        proposalIds: group.proposalIds,
        revertibleProposalIds: [],
        restorableProposalId: null,
      });
      return;
    }

    const stale = staleGroups.find((candidate) => candidate.roomId === room.id);
    if (stale) {
      rows.push({
        key: room.id,
        roomId: room.id,
        runId: null,
        provider: stale.providers[0] ?? null,
        status: "proposal",
        label: t("dock.labelWithSuffix", { replace: {
          label: resolveRoomLabel(room, t("dock.defaultLabel")),
          suffix: t(stale.kind === "conflict" ? "dock.suffixConflict" : "dock.suffixNeedsRebuild"),
        } }),
        anchorExcerpt: null,
        proposalIds: stale.proposalIds,
        revertibleProposalIds: [],
        restorableProposalId: null,
        staleKind: stale.kind,
        staleConflictReason: stale.conflictReason,
        staleMessage: stale.kind === "conflict" && stale.conflictReason !== "content-stale"
          ? t("dock.needsRegeneration")
          : undefined,
      });
      return;
    }

    const roomProposals = resolvedProposals.filter((proposal) => proposal.roomId === room.id);
    const resolved = roomProposals
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (resolved) {
      const status: TaskStatusKind =
        resolved.status === "approved"
          ? resolved.autoApplied
            ? "auto-applied"
            : "applied"
          : resolved.status === "reverted"
            ? "reverted"
            : "rejected";
      // 承認後に教材が編集されていても巻き戻せる: main の getRevertPlan が
      // 「まるごと戻す」か「触れた範囲だけ戻す」かを判定する。ここで必要なのは、
      // 戻す対象の保存バッチを引ける appliedRevision が記録されていることだけ。
      // 部屋の適用済み提案を全部渡すのは、1つのturnが複数回の保存に分かれている場合に
      // 「最後に更新された1件」だけでは片方の保存しか戻せないため。
      const revertibleProposalIds =
        (status === "applied" || status === "auto-applied") && activeDocumentRevision !== null
          ? roomProposals
            .filter((proposal) => proposal.status === "approved" && proposal.appliedRevision !== undefined)
            .map((proposal) => proposal.proposalId)
          : [];
      rows.push({
        key: room.id,
        roomId: room.id,
        runId: resolved.runId ?? null,
        provider: resolved.provider,
        status,
        label: resolveRoomLabel(room, t("dock.defaultLabel")),
        anchorExcerpt: anchorExcerpt(resolved.changedIds[0]),
        proposalIds: [resolved.proposalId],
        revertibleProposalIds,
        restorableProposalId: status === "rejected" || status === "reverted" ? resolved.proposalId : null,
      });
      return;
    }

    if (session && session.status === "failed") {
      rows.push({
        key: room.id,
        roomId: room.id,
        runId: null,
        provider: session.provider,
        status: "rejected",
        label: resolveRoomLabel(room, t("dock.defaultLabel")),
        anchorExcerpt: anchorExcerpt(session.anchor?.primaryBlockId),
        proposalIds: [],
        revertibleProposalIds: [],
        restorableProposalId: null,
      });
    }
  };

  rooms.forEach(pushRoomRow);

  // Preview/stale groups whose room isn't in this document's room list (e.g. a
  // proposal attributed to a room from another still-loading session) still
  // deserve a row -- keyed by their proposal ids instead of a room.
  for (const group of previewGroups) {
    if (group.roomId && seenRoomIds.has(group.roomId)) {
      continue;
    }
    rows.push({
      key: `group:${group.proposalIds.join(",")}`,
      roomId: group.roomId ?? null,
      runId: group.runId ?? null,
      provider: group.providers[0] ?? null,
      status: "proposal",
      label: group.sessionLabel?.trim() || t("dock.defaultLabel"),
      anchorExcerpt: anchorExcerpt(group.targetId),
      proposalIds: group.proposalIds,
      revertibleProposalIds: [],
      restorableProposalId: null,
    });
  }

  return rows;
}

/** Web版 (WebMCP) の決着済みドラフトを、デスクトップと同じ行の形へ写す。
 *
 * 部屋も run も無いので `buildTaskRows` の room ループには乗らない。**巻き戻し/再提案の
 * IDは必ず空にすること** — Webには承認バッチ (appliedRevision) も main の getRevertPlan も
 * 無く、ボタンを出すと押せてしまう。 */
export function buildWebMcpHistoryRows(entries: WebMcpHistoryEntry[], document: SigmaDocument): TaskRow[] {
  return entries.map((entry) => ({
    key: `webmcp-history:${entry.entryId}`,
    roomId: null,
    runId: null,
    // 保留中の行 (WebMcpBridgeのpreview group) と同じ印にそろえる。
    provider: "chatgpt" as const,
    status: entry.status,
    label: "WebMCP",
    anchorExcerpt: entry.targetIds[0] ? excerptForBlock(findBlock(document, entry.targetIds[0])) : null,
    proposalIds: [entry.id],
    revertibleProposalIds: [],
    restorableProposalId: null,
  }));
}

// Statuses that still need a human (or the AI) to do something: a run actually
// executing, or a proposal sitting there awaiting approval/rejection/conflict
// resolution. Settled rows (applied/auto-applied/rejected/reverted) are just
// history and never bump the collapsed dock's badge.
const ACTIONABLE_TASK_STATUSES: readonly TaskStatusKind[] = ["waiting", "running", "proposal"];

/** Pure badge-count derivation for the collapsed top-left icon: active runs plus
 * actionable items (pending proposals, including conflicts). Kept separate from
 * the component so it's unit-testable without rendering anything. */
export function countAiTaskBadge(rows: TaskRow[]): number {
  return rows.filter((row) => ACTIONABLE_TASK_STATUSES.includes(row.status)).length;
}

/** Whether any row is a run actually executing right now (not just a pending
 * proposal) -- drives the quiet shimmer on the collapsed icon so it reads as
 * "AI is working" rather than merely "something needs you". */
export function hasActiveAiTaskRun(rows: TaskRow[]): boolean {
  return rows.some((row) => row.status === "waiting" || row.status === "running");
}

export interface AiTaskDockProps {
  documentIdentityKey: string;
  document: SigmaDocument;
  previewGroups: AiEditPreviewState[];
  staleGroups: StaleMcpProposalGroup[];
  activeDocumentRevision: number | null;
  busy: boolean;
  onApplyGroup: (proposalIds: string[]) => Promise<AiProposalApplyOutcome>;
  onDismissGroup: (proposalIds: string[]) => void;
  onRebaseGroup: (proposalIds: string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 競合stale提案 (staleKind === "conflict") の「AIの提案で上書き」。渡されない場合は
   * そのボタンを表示しない。 */
  onForceApplyGroup?: (proposalIds: string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onRevertProposal: (proposalIds: string[]) => void;
  /** Reopens a rejected proposal only after the backend verifies that its
   * touched content has not conflicted with newer user edits. */
  onRestoreProposal?: (proposalId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onFocusSession?: (roomId: string) => void;
  resolvedProposals: DesktopMcpEditProposalSummary[];
  /** Web版だけ: 接続状態とエージェント指示欄をこのdockの中に出す (教材IDがスコープ)。
   * デスクトップとSDK埋め込みでは渡さない。 */
  webMcpInstructionScopeId?: string | null;
  /** Web版だけ: 適用済み/破棄済みのWebMCPドラフト。行の末尾に履歴として並べる。 */
  webMcpHistory?: WebMcpHistoryEntry[];
}

/** Presentational task list -- header + rows, no state of its own. Kept separate
 * from AiTaskDock so it can be rendered directly (with a fixed `rows` prop) in
 * static-markup tests without needing the run-session/room-store hooks. */
export function AiTaskDockPanel({
  rows,
  busy,
  onApplyGroup,
  onDismissGroup,
  onRebaseGroup,
  onForceApplyGroup,
  onRevertProposal,
  onRestoreProposal,
  onFocusSession,
  onClose,
  webMcpInstructionScopeId,
}: {
  rows: TaskRow[];
  busy: boolean;
  onApplyGroup: (proposalIds: string[]) => Promise<AiProposalApplyOutcome>;
  onDismissGroup: (proposalIds: string[]) => void;
  onRebaseGroup: (proposalIds: string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onForceApplyGroup?: (proposalIds: string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onRevertProposal: (proposalIds: string[]) => void;
  onRestoreProposal?: (proposalId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onFocusSession?: (roomId: string) => void;
  onClose?: () => void;
  webMcpInstructionScopeId?: string | null;
}) {
  const t = useT("ai");
  const tCommon = useT("common");
  return (
    <div className="ai-task-dock" role="region" aria-label={t("dock.title")}>
      <header className="ai-task-dock-header">
        <span className="ai-task-dock-title">{t("dock.title")}</span>
        {rows.length > 0 && <span className="ai-task-dock-count">{rows.length}</span>}
        {onClose && (
          <button type="button" className="ai-task-dock-close" onClick={onClose} title={tCommon("actions.close")} aria-label={tCommon("actions.close")}>
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </header>
      {webMcpInstructionScopeId && (
        <WebMcpDockSection
          key={webMcpInstructionScopeId}
          instructionScopeId={webMcpInstructionScopeId}
          onDismissProposal={() => onDismissGroup([WEB_MCP_PROPOSAL_ID])}
        />
      )}
      <div className="ai-task-dock-list">
        {rows.length === 0 ? (
          <p className="ai-task-dock-empty">{t("dock.empty")}</p>
        ) : (
          rows.map((row) => (
            <AiTaskDockRow
              key={row.key}
              row={row}
              busy={busy}
              onApplyGroup={onApplyGroup}
              onDismissGroup={onDismissGroup}
              onRebaseGroup={onRebaseGroup}
              onForceApplyGroup={onForceApplyGroup}
              onRevertProposal={onRevertProposal}
              onRestoreProposal={onRestoreProposal}
              onFocusSession={onFocusSession}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Persistent, always-on-screen entry point for "what is the AI doing right now".
 * Collapsed by default to a single small icon button anchored at the top-left of
 * the editor canvas (see .ai-task-dock-root in globals.css) with a quiet badge
 * for anything actionable; clicking it expands the task panel in place (no
 * backdrop, no modal) so the user can glance, act, and keep working -- the
 * "cockpit" affordance replacing the old menu-toggled open/close dialog.
 */
export function AiTaskDock({
  documentIdentityKey,
  document,
  previewGroups,
  staleGroups,
  activeDocumentRevision,
  busy,
  onApplyGroup,
  onDismissGroup,
  onRebaseGroup,
  onForceApplyGroup,
  onRevertProposal,
  onRestoreProposal,
  onFocusSession,
  resolvedProposals,
  webMcpInstructionScopeId,
  webMcpHistory,
}: AiTaskDockProps) {
  const t = useT("ai");
  const [expanded, setExpanded] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rooms = useAiChatRoomsForDocument(documentIdentityKey);
  const sessions = useAiRunSessions();

  useEffect(
    () => () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  // Closing on Esc / outside click only matters while expanded; a collapsed
  // icon has nothing to close.
  useEffect(() => {
    if (!expanded) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
      }
    };
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !anchorRef.current?.contains(target)) {
        setExpanded(false);
      }
    };
    // NB: the `document` prop (the SigmaDocument) shadows the global DOM
    // `document` in this component, so these listeners go on `window` instead
    // (both keydown and mousedown bubble there just as well).
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("mousedown", closeOnOutsideClick);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("mousedown", closeOnOutsideClick);
    };
  }, [expanded]);

  const rows = [
    ...buildTaskRows(rooms, sessions, previewGroups, staleGroups, resolvedProposals, document, activeDocumentRevision, t),
    ...(webMcpHistory ? buildWebMcpHistoryRows(webMcpHistory, document) : []),
  ];
  const badgeCount = countAiTaskBadge(rows);
  const isRunning = hasActiveAiTaskRun(rows);
  const toggleLabel = badgeCount > 0 ? t("dock.titleWithCount", { replace: { count: badgeCount } }) : t("dock.title");

  const openPanel = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setPanelMounted(true);
    setExpanded(true);
  };

  const closePanel = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setExpanded(false);
  };

  const scheduleClosePanel = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      // ポインタが外れても、dockの中を触っている最中なら閉じない。Web版は指示欄の
      // textareaがこの中にあるので、入力中にマウスが逃げただけで畳むと入力が飛ぶ。
      // 閉じる経路は onBlur / Esc / 外側クリックが引き続き担当する。
      if (anchorRef.current?.contains(window.document.activeElement)) {
        return;
      }
      setExpanded(false);
    }, 100);
  };

  return (
    <div
      className="ai-task-dock-root"
      ref={anchorRef}
      onMouseEnter={openPanel}
      onMouseLeave={scheduleClosePanel}
      onFocus={openPanel}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          closePanel();
        }
      }}
    >
      <span className="ai-task-dock-hover-bridge" aria-hidden="true" />
      <button
        type="button"
        className={`ai-task-dock-toggle${isRunning ? " is-active" : ""}${expanded ? " is-panel-open" : ""}`}
        aria-label={toggleLabel}
        aria-expanded={expanded}
        title={toggleLabel}
      >
        {isRunning ? (
          <AiThinkingOrb className="ai-task-dock-toggle-icon" decorative />
        ) : (
          <ListTodo size={16} aria-hidden="true" />
        )}
        {badgeCount > 0 && (
          <span className="ai-task-dock-badge" aria-hidden="true">
            {badgeCount}
          </span>
        )}
      </button>
      {panelMounted && (
        <div
          className={`ai-task-dock-motion${expanded ? " is-expanded" : " is-collapsing"}`}
          onAnimationEnd={() => {
            if (!expanded) {
              setPanelMounted(false);
            }
          }}
        >
          <AiTaskDockPanel
            rows={rows}
            busy={busy}
            onApplyGroup={onApplyGroup}
            onDismissGroup={onDismissGroup}
            onRebaseGroup={onRebaseGroup}
            onForceApplyGroup={onForceApplyGroup}
            onRevertProposal={onRevertProposal}
            onRestoreProposal={onRestoreProposal}
            onFocusSession={onFocusSession
              ? (roomId) => {
                  setExpanded(false);
                  onFocusSession(roomId);
                }
              : undefined}
            onClose={closePanel}
            webMcpInstructionScopeId={webMcpInstructionScopeId}
          />
        </div>
      )}
    </div>
  );
}

export function AiTaskDockRow({
  row,
  busy,
  onApplyGroup,
  onDismissGroup,
  onRebaseGroup,
  onForceApplyGroup,
  onRevertProposal,
  onRestoreProposal,
  onFocusSession,
}: {
  row: TaskRow;
  busy: boolean;
  onApplyGroup: (proposalIds: string[]) => Promise<AiProposalApplyOutcome>;
  onDismissGroup: (proposalIds: string[]) => void;
  onRebaseGroup: (proposalIds: string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onForceApplyGroup?: (proposalIds: string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onRevertProposal: (proposalIds: string[]) => void;
  onRestoreProposal?: (proposalId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onFocusSession?: (roomId: string) => void;
}) {
  const t = useT("ai");
  const [rebasing, setRebasing] = useState(false);
  const [rebaseError, setRebaseError] = useState<string | null>(null);
  const [forceApplying, setForceApplying] = useState(false);
  const [forceApplyError, setForceApplyError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const isStale = row.staleKind !== undefined;
  // 競合 (staleKind === "conflict") は通常の「作り直し」(blind replay) を絶対に出さない —
  // rebaseは競合の有無を見ずに提案draftをreplayしてconflictをクリアしてしまうため、人間の
  // 編集を黙って上書きしかねない。破棄 / 強制上書きの明示的な2択だけを出す。
  const isConflict = row.staleKind === "conflict";
  const canManualRebase = row.staleKind === "manual-rebase";
  const isImplementing = row.status === "running";

  const runRebase = async () => {
    setRebasing(true);
    setRebaseError(null);
    try {
      const result = await onRebaseGroup(row.proposalIds);
      if (!result.ok) {
        setRebaseError(result.reason);
      }
    } finally {
      setRebasing(false);
    }
  };

  const runForceApply = async () => {
    if (!onForceApplyGroup) {
      return;
    }
    setForceApplying(true);
    setForceApplyError(null);
    try {
      const result = await onForceApplyGroup(row.proposalIds);
      if (!result.ok) {
        setForceApplyError(result.reason);
      }
    } finally {
      setForceApplying(false);
    }
  };

  const runRestore = async () => {
    if (!onRestoreProposal || !row.restorableProposalId) {
      return;
    }
    setRestoring(true);
    setRestoreError(null);
    try {
      const result = await onRestoreProposal(row.restorableProposalId);
      if (!result.ok) {
        setRestoreError(result.reason);
      }
    } finally {
      setRestoring(false);
    }
  };

  const runApply = async () => {
    setApplyError(null);
    try {
      const result = await onApplyGroup(row.proposalIds);
      if (!result.ok) {
        setApplyError(result.reason);
      }
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : t("card.applyFailed"));
    }
  };

  return (
    <div
      className={`ai-task-dock-row${row.roomId && onFocusSession ? " is-focusable" : ""}`}
      onClick={(event) => {
        if ((event.target as Element).closest("button")) {
          return;
        }
        if (row.roomId) {
          onFocusSession?.(row.roomId);
        }
      }}
    >
      <span className="ai-task-dock-provider" aria-hidden="true">
        {row.provider ? renderProviderMark(row.provider, { size: 14 }) : <History size={14} />}
      </span>
      <div className="ai-task-dock-row-main">
        <div className="ai-task-dock-row-head">
          {row.status !== "proposal" && row.status !== "running" && (
            <span className={`ai-task-dock-chip ai-task-dock-chip--${row.status}`}>
              {isImplementing ? <Shimmer>{statusLabel(row.status, t)}</Shimmer> : statusLabel(row.status, t)}
            </span>
          )}
          <button
            type="button"
            className="ai-task-dock-row-label"
            disabled={!row.roomId || !onFocusSession}
            onClick={() => row.roomId && onFocusSession?.(row.roomId)}
            title={row.roomId ? t("run.openInSideChat") : undefined}
          >
            {isImplementing ? <Shimmer>{row.label}</Shimmer> : row.label}
          </button>
        </div>
        {row.anchorExcerpt && <p className="ai-task-dock-anchor">{row.anchorExcerpt}</p>}
        {row.staleMessage && <p className="ai-task-dock-error">{row.staleMessage}</p>}
        {rebaseError && <p className="ai-task-dock-error">{rebaseError}</p>}
        {forceApplyError && <p className="ai-task-dock-error">{forceApplyError}</p>}
        {restoreError && <p className="ai-task-dock-error">{restoreError}</p>}
        {applyError && <p className="ai-chat-error ai-task-dock-error">{applyError}</p>}
      </div>
      <div className="ai-task-dock-actions">
        {(row.status === "running" || row.status === "waiting") && row.runId && (
          <button
            type="button"
            className="ai-task-dock-action ai-task-dock-action--icon ai-task-dock-action--stop"
            onClick={() => row.runId && cancelRun(row.runId)}
            title={t("dock.stop")}
            aria-label={t("dock.stop")}
          >
            <Square size={8} fill="currentColor" aria-hidden="true" />
          </button>
        )}
        {row.status === "proposal" && !isStale && (
          <>
            <AiProposalDecisionButton
              decision="dismiss"
              className="ai-task-dock-action ai-task-dock-action--icon"
              disabled={busy}
              onClick={() => onDismissGroup(row.proposalIds)}
            />
            <AiProposalDecisionButton
              decision="apply"
              className="ai-task-dock-action ai-task-dock-action--icon"
              disabled={busy}
              onClick={() => void runApply()}
            />
          </>
        )}
        {row.status === "proposal" && isStale && isConflict && (
          <>
            <button
              type="button"
              className="ai-task-dock-action"
              disabled={busy}
              title={t("stale.keepMineTooltip")}
              onClick={() => onDismissGroup(row.proposalIds)}
            >
              {t("proposal.dismiss")}
            </button>
            {onForceApplyGroup && row.staleConflictReason === "content-stale" && (
              <button
                type="button"
                className="ai-task-dock-action"
                disabled={forceApplying}
                title={t("stale.overwriteTooltip")}
                onClick={() => void runForceApply()}
              >
                {forceApplying ? <Shimmer>{t("stale.overwriting")}</Shimmer> : t("stale.overwrite")}
              </button>
            )}
          </>
        )}
        {row.status === "proposal" && isStale && !isConflict && canManualRebase && (
          <button type="button" className="ai-task-dock-action" disabled={rebasing} onClick={() => void runRebase()}>
            {rebasing ? (
              <Shimmer>{t("stale.rebuilding")}</Shimmer>
            ) : (
              t("dock.rebuild")
            )}
          </button>
        )}
        {row.revertibleProposalIds.length > 0 && (
          <button
            type="button"
            className="ai-task-dock-action"
            disabled={busy}
            onClick={() => onRevertProposal(row.revertibleProposalIds)}
          >
            {t("applied.revert")}
          </button>
        )}
        {row.restorableProposalId && onRestoreProposal && (
          <button
            type="button"
            className="ai-task-dock-action"
            disabled={busy || restoring}
            onClick={() => void runRestore()}
          >
            {restoring ? <Shimmer>{t("dock.reproposing")}</Shimmer> : t("dock.repropose")}
          </button>
        )}
      </div>
    </div>
  );
}
