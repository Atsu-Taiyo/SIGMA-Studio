"use client";

import { Bot, FileText, GripVertical, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { DocumentSessionContext, DocumentWritableContext } from "./document-session-context";
import { AiEditPanel } from "@/components/editor/AiEditPanel";
import { EMPTY_OVERLAY_SELECTION } from "@/components/editor/editor-shell/constants";
import { PagedRenderSurface } from "@/components/print/paged-render/PagedRenderSurface";
import type { DocumentSessionHost } from "@/features/document-session/contracts";
import { getAppRuntime } from "@/lib/runtime";
import type { SigmaDocument } from "@/features/document";
import { aiChatRoomsStore } from "@/lib/ai/ai-run-controller";
import { loadDocumentByFileIdWithRecovery, type DocumentMetadata } from "@/lib/storage";
import { useT } from "@/lib/i18n/react";
import {
  MAX_WORKSPACE_TAB_GROUPS,
  type TabGroupState,
  type WorkspaceDropEdge,
  type WorkspaceLayoutV2,
  type WorkspaceSplitNode,
  type WorkspaceTab,
} from "@/lib/workspace-tab-groups";

interface WorkspaceTabGroupGridProps {
  enabled?: boolean;
  sessionHost?: DocumentSessionHost;
  layout: WorkspaceLayoutV2;
  metadata: readonly DocumentMetadata[];
  activeFileId: string;
  children: ReactNode;
  onActivateTab(groupId: string, tab: WorkspaceTab): void;
  onCloseTab(groupId: string, tab: WorkspaceTab): void;
  onMoveTab(tabId: string, targetGroupId: string, targetIndex?: number): void;
  onSplitTab(tabId: string, targetGroupId: string, edge: WorkspaceDropEdge): void;
  onResizeSplit(splitId: string, ratio: number): void;
  onOpenAiSettings?(): void;
}

export function WorkspaceTabGroupGrid(props: WorkspaceTabGroupGridProps) {
  const aiRooms = useSyncExternalStore(
    aiChatRoomsStore.subscribe,
    aiChatRoomsStore.getSnapshot,
    aiChatRoomsStore.getSnapshot,
  );
  const metadataByFileId = useMemo(
    () => new Map(props.metadata.map((item) => [item.fileId, item])),
    [props.metadata],
  );
  if (props.enabled === false) return props.children;
  return (
    <div className="workspace-tab-group-grid" data-group-count={props.layout.groups.length}>
      <SplitNodeView {...props} node={props.layout.root} metadataByFileId={metadataByFileId} aiRooms={aiRooms} />
    </div>
  );
}

function SplitNodeView(
  props: WorkspaceTabGroupGridProps & {
    node: WorkspaceSplitNode;
    metadataByFileId: ReadonlyMap<string, DocumentMetadata>;
    aiRooms: ReturnType<typeof aiChatRoomsStore.getSnapshot>;
  },
) {
  const { node } = props;
  const t = useT("editor");
  const splitRef = useRef<HTMLDivElement>(null);
  if (node.kind === "group") {
    const group = props.layout.groups.find((candidate) => candidate.id === node.groupId);
    return group ? <GroupView {...props} group={group} /> : null;
  }
  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const bounds = splitRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const move = (pointer: PointerEvent) => {
      const ratio = node.direction === "row"
        ? (pointer.clientX - bounds.left) / bounds.width
        : (pointer.clientY - bounds.top) / bounds.height;
      props.onResizeSplit(node.id, ratio);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };
  const keyboardResize = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -0.05
      : event.key === "ArrowRight" || event.key === "ArrowDown" ? 0.05 : 0;
    if (!delta) return;
    event.preventDefault();
    props.onResizeSplit(node.id, node.ratio + delta);
  };
  return (
    <div
      ref={splitRef}
      className={`workspace-tab-split workspace-tab-split--${node.direction}`}
      style={node.direction === "row"
        ? { gridTemplateColumns: `minmax(280px, ${node.ratio}fr) 5px minmax(280px, ${1 - node.ratio}fr)` }
        : { gridTemplateRows: `minmax(220px, ${node.ratio}fr) 5px minmax(220px, ${1 - node.ratio}fr)` }}
    >
      <SplitNodeView {...props} node={node.first} />
      <button
        type="button"
        className="workspace-tab-splitter"
        aria-label={node.direction === "row" ? t("tabGroups.resizeHorizontal") : t("tabGroups.resizeVertical")}
        onPointerDown={startResize}
        onKeyDown={keyboardResize}
      >
        <GripVertical size={12} aria-hidden="true" />
      </button>
      <SplitNodeView {...props} node={node.second} />
    </div>
  );
}

function GroupView(
  props: WorkspaceTabGroupGridProps & {
    group: TabGroupState;
    metadataByFileId: ReadonlyMap<string, DocumentMetadata>;
    aiRooms: ReturnType<typeof aiChatRoomsStore.getSnapshot>;
  },
) {
  const { group } = props;
  const t = useT("editor");
  const [dragOver, setDragOver] = useState(false);
  const [splitAvailability, setSplitAvailability] = useState({ horizontal: false, vertical: false });
  const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId) ?? group.tabs[0];
  return (
    <section
      className={`workspace-tab-group${props.layout.focusedGroupId === group.id ? " is-focused" : ""}`}
      data-group-id={group.id}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("application/x-sigma-workspace-tab")) {
          const bounds = event.currentTarget.getBoundingClientRect();
          setSplitAvailability({ horizontal: bounds.width >= 565, vertical: bounds.height >= 445 });
          setDragOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={() => setDragOver(false)}
    >
      <div
        className="workspace-tab-strip"
        role="tablist"
        aria-label={t("tabGroups.label")}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const tabId = event.dataTransfer.getData("application/x-sigma-workspace-tab");
          if (tabId) props.onMoveTab(tabId, group.id);
        }}
      >
        {group.tabs.map((tab) => {
          const title = tab.kind === "document"
            ? props.metadataByFileId.get(tab.fileId)?.title ?? t("tabGroups.untitled")
            : `${props.aiRooms.find((room) => room.id === tab.roomId)?.title?.trim() || t("tabGroups.aiEdit")} · ${props.metadataByFileId.get(tab.documentFileId)?.title ?? t("tabGroups.untitled")}`;
          return (
            <div
              className={`workspace-group-tab${tab.id === activeTab?.id ? " active" : ""}`}
              key={tab.id}
              data-tab-id={tab.id}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDragOver(false);
                const tabId = event.dataTransfer.getData("application/x-sigma-workspace-tab");
                if (tabId) props.onMoveTab(tabId, group.id, group.tabs.findIndex((candidate) => candidate.id === tab.id));
              }}
            >
              <button
                type="button"
                role="tab"
                draggable
                aria-selected={tab.id === activeTab?.id}
                aria-label={title}
                title={title}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-sigma-workspace-tab", tab.id);
                }}
                onClick={() => props.onActivateTab(group.id, tab)}
              >
                {tab.kind === "document" ? <FileText size={13} /> : <Bot size={13} />}
                <span className="workspace-tab-title">{title}</span>
                <span className="workspace-tab-initial" aria-hidden="true">{Array.from(title)[0]}</span>
              </button>
              <button type="button" className="workspace-group-tab-close" aria-label={t("tabGroups.close", { title })} onClick={() => props.onCloseTab(group.id, tab)}>
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="workspace-tab-group-content">
        {activeTab?.kind === "document" && props.layout.focusedGroupId === group.id && activeTab.fileId === props.activeFileId
          ? props.children
          : activeTab ? <BackgroundTabContent key={activeTab.id} sessionHost={props.sessionHost} tab={activeTab} metadata={props.metadataByFileId.get(activeTab.kind === "document" ? activeTab.fileId : activeTab.documentFileId)} onOpenAiSettings={props.onOpenAiSettings} /> : null}
      </div>
      {dragOver && props.layout.groups.length < MAX_WORKSPACE_TAB_GROUPS && (
        <div className="workspace-tab-drop-zones" aria-hidden="true">
          {(["left", "right", "top", "bottom"] as const)
            .filter((edge) => edge === "left" || edge === "right" ? splitAvailability.horizontal : splitAvailability.vertical)
            .map((edge) => (
            <div
              key={edge}
              className={`workspace-tab-drop-zone workspace-tab-drop-zone--${edge}`}
              onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDragOver(false);
                const tabId = event.dataTransfer.getData("application/x-sigma-workspace-tab");
                if (tabId) props.onSplitTab(tabId, group.id, edge);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function BackgroundTabContent({
  sessionHost,
  tab,
  metadata,
  onOpenAiSettings,
}: {
  sessionHost?: DocumentSessionHost;
  tab: WorkspaceTab;
  metadata?: DocumentMetadata;
  onOpenAiSettings?: () => void;
}) {
  const t = useT("editor");
  const fileId = tab.kind === "document" ? tab.fileId : tab.documentFileId;
  const [document, setDocument] = useState<SigmaDocument | null>(null);
  const [writable, setWritable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const releaseVisible = sessionHost?.retainVisibleFile?.(fileId);
    let generation = 0;
    let unsubscribeSession = () => {};
    let unsubscribeAssets = () => {};
    const refresh = () => {
      const request = ++generation;
      const session = sessionHost?.get(fileId);
      setWritable(session?.writable ?? (!metadata?.sharing && !(sessionHost?.isReadOnly?.(fileId) ?? false)));
      if (session) {
        // Clone the projection for asset-only notifications without mutating the session.
        setDocument({ ...session.project() });
      } else {
        void loadDocumentByFileIdWithRecovery(fileId).then((result) => {
          if (!cancelled && request === generation) setDocument(result.ok ? result.document : null);
        }).catch(() => {
          if (!cancelled && request === generation) setDocument(null);
        });
      }
    };
    const bindSession = () => {
      unsubscribeSession();
      unsubscribeAssets();
      const session = sessionHost?.get(fileId);
      unsubscribeSession = session?.subscribe(refresh) ?? (() => {});
      unsubscribeAssets = session?.subscribeAssets?.(refresh) ?? (() => {});
      refresh();
    };
    queueMicrotask(() => { if (!cancelled) bindSession(); });
    const unsubscribeAuthority = sessionHost?.subscribeAuthority?.(bindSession);
    const unsubscribeStorage = getAppRuntime().library.onChange((event) => {
      if (event.type === "document" && event.fileId === fileId) refresh();
    });
    return () => {
      cancelled = true;
      releaseVisible?.();
      unsubscribeSession();
      unsubscribeAssets();
      unsubscribeAuthority?.();
      unsubscribeStorage();
    };
  }, [fileId, sessionHost, metadata?.sharing]);
  if (!document) return <div className="workspace-tab-loading-preview" aria-label={t("tabGroups.loading")} />;
  const content = tab.kind === "ai" && writable ? (
      <div className="workspace-ai-tab-panel">
        <AiEditPanel
          document={document}
          documentIdentityKey={tab.documentFileId}
          documentWorkspaceId={metadata?.workspaceId ?? null}
          controlledRoomId={tab.roomId}
          selectedId={null}
          selectedBlock={null}
          reference={null}
          overlaySelection={EMPTY_OVERLAY_SELECTION}
          variant="sidebar"
          staleProposalGroups={[]}
          onDiscardStaleProposals={() => undefined}
          onOpenAiSettings={onOpenAiSettings}
        />
      </div>
  ) : (
    <div className="workspace-document-preview" aria-label={t("tabGroups.preview", { title: metadata?.title ?? t("tabGroups.material") })}>
      <PagedRenderSurface document={document} profile="teacher" />
    </div>
  );
  return (
    <DocumentSessionContext.Provider value={sessionHost?.get(fileId)}>
      <DocumentWritableContext.Provider value={writable}>{content}</DocumentWritableContext.Provider>
    </DocumentSessionContext.Provider>
  );
}
