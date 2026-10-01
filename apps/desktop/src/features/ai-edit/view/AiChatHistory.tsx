"use client";
import { History, Search, Settings, Sparkles, SquarePen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties as ReactCSSProperties } from "react";
import { AiThinkingOrb } from "@/components/branding/AiThinkingOrb";
import { renderProviderMark } from "@/components/branding/provider-logos";
import { IconButton } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Shimmer } from "@/components/ui/Shimmer";
import { getReferenceDisplayLabel } from "@/lib/ai/ai-edit-reference";
import { isDefaultChatRoomTitle, type AiEditChatRoom } from "@/lib/ai/ai-run-controller";
import { isAiRunStatusActive, type AiRunSession } from "@/lib/ai/ai-run-session-store";
import { useT } from "@/lib/i18n/react";
import { tAiNow, tEditorNow } from "../application/ai-chat-translator";
const HISTORY_DIALOG_VIEWPORT_MARGIN=12;
const HISTORY_DIALOG_ANCHOR_GAP=8;
export function ChatRoomHistory({
  rooms,
  activeRoomId,
  loading,
  runSessions,
  onNewRoom,
  onSelectRoom,
  onOpenSettings,
}: {
  rooms: AiEditChatRoom[];
  activeRoomId: string | null;
  loading: boolean;
  // R1/R5: lets the room switcher show, at a glance, which rooms (including
  // ones not currently visible) have an AI run in flight.
  runSessions: ReadonlyMap<string, AiRunSession>;
  onNewRoom: () => void;
  onSelectRoom: (roomId: string) => void;
  onOpenSettings?: () => void;
}) {
  const t = useT("ai");
  const tCommon = useT("common");
  // 「AI設定」はダイアログ側と同じ見出し (`settings.ai.title` が出典)。
  const tSettings = useT("settings");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogPosition, setDialogPosition] = useState<{ top: number; right: number } | null>(null);
  const historyDialogAnchorRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const filteredRooms = useMemo(() => {
    const query = normalizeHistorySearchText(searchQuery);
    if (!query) {
      return rooms;
    }
    return rooms.filter((room) => normalizeHistorySearchText(getRoomSearchText(room)).includes(query));
  }, [rooms, searchQuery]);

  const updateDialogPosition = useCallback(() => {
    const anchor = historyDialogAnchorRef.current;
    if (!anchor) {
      setDialogPosition(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setDialogPosition({
      top: Math.max(HISTORY_DIALOG_VIEWPORT_MARGIN, rect.bottom + HISTORY_DIALOG_ANCHOR_GAP),
      right: Math.max(HISTORY_DIALOG_VIEWPORT_MARGIN, window.innerWidth - rect.right),
    });
  }, []);

  useEffect(() => {
    if (!dialogOpen) {
      return;
    }
    updateDialogPosition();
    window.addEventListener("resize", updateDialogPosition);
    window.addEventListener("scroll", updateDialogPosition, true);
    return () => {
      window.removeEventListener("resize", updateDialogPosition);
      window.removeEventListener("scroll", updateDialogPosition, true);
    };
  }, [dialogOpen, updateDialogPosition]);

  useEffect(() => {
    if (!dialogOpen || !searchOpen) {
      return;
    }
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [dialogOpen, searchOpen]);

  const openDialog = () => {
    updateDialogPosition();
    setDialogOpen(true);
  };
  const closeDialog = () => {
    setDialogOpen(false);
    setSearchOpen(false);
    setSearchQuery("");
  };
  const toggleSearch = () => {
    setSearchOpen((current) => {
      if (current) {
        setSearchQuery("");
      }
      return !current;
    });
  };
  const selectRoom = (roomId: string) => {
    onSelectRoom(roomId);
    closeDialog();
  };
  const createRoom = () => {
    onNewRoom();
    closeDialog();
  };

  const runningRoomCount = useMemo(
    () => rooms.filter((room) => isAiRunStatusActive(runSessions.get(room.id)?.status)).length,
    [rooms, runSessions],
  );
  // 見出しには今開いている会話の名前を出す。まだ名前が付いていない会話は、これまでどおり
  // 「チャット」の見出しのままにして、履歴の並びを勝手に増やさない。
  const activeRoom = activeRoomId ? rooms.find((room) => room.id === activeRoomId) ?? null : null;
  const activeRoomTitle = activeRoom && !isDefaultChatRoomTitle(activeRoom.title) ? activeRoom.title : null;

  return (
    <div className="ai-chat-room-history" aria-label={t("panel.chatActionsAria")}>
      <div className="ai-chat-room-history-head">
        <span
          className="ai-chat-room-section-label"
          data-titled={activeRoomTitle !== null}
          title={activeRoomTitle ?? undefined}
        >
          {activeRoomTitle ?? t("panel.chat")}
        </span>
        <div className="ai-chat-room-actions" aria-label={t("panel.chatActionsAria")}>
          <IconButton
            ref={historyDialogAnchorRef}
            className="ai-chat-room-icon-button"
            label={runningRoomCount > 0 ? t("chat.showHistoryRunning", { replace: { count: rooms.length, running: runningRoomCount } }) : t("chat.showHistory", { replace: { count: rooms.length } })}
            tooltip={{ label: t("chat.openPast") }}
            tone="ghost"
            size="sm"
            onClick={openDialog}
            disabled={loading}
            aria-haspopup="dialog"
          >
            <History size={16} />
            {runningRoomCount > 0 && (
              <span className="ai-chat-room-status-dot ai-chat-room-status-dot--badge" data-running="true" aria-hidden="true" />
            )}
          </IconButton>
          {onOpenSettings && (
            <IconButton
              className="ai-chat-room-icon-button"
              label={tSettings("ai.title")}
              tone="ghost"
              size="sm"
              onClick={onOpenSettings}
            >
              <Settings size={16} />
            </IconButton>
          )}
          <IconButton
            className="ai-chat-room-icon-button"
            label={t("chat.new")}
            tooltip={{ label: t("chat.startNew") }}
            tone="ghost"
            size="sm"
            onClick={createRoom}
          >
            <SquarePen size={16} />
          </IconButton>
        </div>
      </div>
      {loading && (
        <div className="ai-chat-room-loading" role="status">
          <Shimmer>{tCommon("status.loading")}</Shimmer>
        </div>
      )}
      <ModalFrame
        open={dialogOpen}
        onDismiss={closeDialog}
        size="sm"
        className="ai-chat-room-dialog-backdrop"
        surfaceClassName="ai-chat-room-dialog"
        ariaLabel={t("chat.historyTitle")}
        style={dialogPosition ? {
          "--ai-chat-room-dialog-top": `${dialogPosition.top}px`,
          "--ai-chat-room-dialog-right": `${dialogPosition.right}px`,
        } as ReactCSSProperties : undefined}
      >
        <ModalHeader
          className="ai-chat-room-dialog-head"
          title={t("chat.history")}
          description={t("chat.roomCount", { replace: { count: rooms.length } })}
          onClose={closeDialog}
          actions={(
            <IconButton
              label={searchOpen ? t("chat.closeSearch") : t("chat.searchHistory")}
              tone="ghost"
              size="sm"
              aria-pressed={searchOpen}
              data-modal-initial-focus
              onClick={toggleSearch}
            >
              <Search size={16} aria-hidden="true" />
            </IconButton>
          )}
        />
        <ModalBody className="ai-chat-room-dialog-body" padding="none" scroll="hidden" data-search-open={searchOpen}>
          {searchOpen && <label className="ai-chat-room-search">
              <Search size={15} />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                placeholder={t("chat.searchHistory")}
                aria-label={t("chat.searchHistory")}
              />
          </label>}
          <div className="ai-chat-room-dialog-list" role="list">
              {filteredRooms.length === 0 ? (
                <p className="ai-chat-room-dialog-empty">{t("chat.noMatchingHistory")}</p>
              ) : (
                filteredRooms.map((room) => {
                  const active = room.id === activeRoomId;
                  return (
                    <ChatHistoryRoomItem
                      key={room.id}
                      room={room}
                      session={runSessions.get(room.id) ?? null}
                      active={active}
                      onSelect={() => selectRoom(room.id)}
                    />
                  );
                })
              )}
          </div>
        </ModalBody>
      </ModalFrame>
    </div>
  );
}

/** One dense history row: provider identity plus title only. Run state is
 * expressed by the shared shimmer without adding a second status label. */
export function ChatHistoryRoomItem({
  room,
  session,
  active,
  onSelect,
}: {
  room: AiEditChatRoom;
  session: AiRunSession | null;
  active: boolean;
  onSelect: () => void;
}) {
  const t = useT("ai");
  const running = isAiRunStatusActive(session?.status);
  // 名前が付いていない会話だけ今の言語の呼び名にする (既定文は作成時の言語で保存される)。
  const roomTitle = isDefaultChatRoomTitle(room.title) ? t("chat.untitledRoom") : room.title;
  const rowProvider = session?.provider ?? room.provider ?? null;
  const providerMark = rowProvider
    ? renderProviderMark(rowProvider, { size: 15 })
    : <Sparkles size={15} aria-hidden="true" />;

  return (
    <button
      type="button"
      className="ai-chat-room-dialog-item"
      aria-current={active ? "true" : undefined}
      data-running={running}
      data-provider={rowProvider ?? "unknown"}
      onClick={onSelect}
    >
      <span className="ai-chat-room-dialog-provider" aria-hidden="true">
        {running && rowProvider
          ? <AiThinkingOrb decorative />
          : providerMark}
      </span>
      {/*
        利用者が付けた (あるいは指示から作られた) 名前はそのまま出す。**まだ名前が
        付いていない会話だけ**、今の言語の呼び名に差し替える — 既定文は作った時点の
        言語で保存されるので (D3)、そのまま出すと英語 UI に日本語が混じる。
      */}
      <span className="ai-chat-room-dialog-title">
        {running ? <Shimmer>{roomTitle}</Shimmer> : roomTitle}
      </span>
      {running && <span className="visually-hidden" role="status">{t("dock.status.running")}</span>}
    </button>
  );
}

function getRoomPreviewText(room: AiEditChatRoom): string {
  for (let index = room.turns.length - 1; index >= 0; index -= 1) {
    const turn = room.turns[index];
    if (turn.role === "user") {
      const text = turn.instruction.trim();
      if (text) {
        return truncateRoomPreview(text);
      }
    } else {
      const text = turn.result?.draft.summary ?? turn.error ?? turn.events[turn.events.length - 1]?.message ?? "";
      if (text.trim()) {
        return truncateRoomPreview(text);
      }
    }
  }
  return tAiNow("chat.noMessages");
}

function getRoomSearchText(room: AiEditChatRoom): string {
  const turnTexts = room.turns.flatMap((turn) => {
    if (turn.role === "user") {
      return [
        turn.instruction,
        ...turn.references.map((turnReference) => getReferenceDisplayLabel(turnReference, tAiNow, tEditorNow)),
        ...turn.attachments.map((attachment) => attachment.name),
        ...turn.mentionedDocuments.map((item) => `${item.title} ${item.documentPath}`),
      ];
    }
    return [
      turn.result?.draft.summary ?? "",
      ...(turn.result?.draft.plan ?? []),
      ...(turn.result?.draft.warnings ?? []),
      ...(turn.result?.questions ?? []),
      turn.error ?? "",
    ];
  });
  return [room.title, getRoomPreviewText(room), ...turnTexts].join(" ");
}

function normalizeHistorySearchText(value: string): string {
  return value.trim().toLowerCase();
}

function truncateRoomPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 72)}...` : normalized;
}

