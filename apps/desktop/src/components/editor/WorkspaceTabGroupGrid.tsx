"use client";

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AiEditPanel } from "@/components/editor/AiEditPanel";
import type { CommentPanelAuthor } from "@/components/editor/CommentThreadsPanel";
import { DocumentSessionContext, DocumentWritableContext } from "./document-session-context";
import { BASE_EDITOR_FONT_SIZE, EMPTY_OVERLAY_SELECTION } from "@/components/editor/editor-shell/constants";
import { PageCanvasEditor } from "@/components/editor/PageCanvasEditor";
import { WORKSPACE_TAB_DRAG_TYPE } from "@/components/editor/WorkspaceTabStrip";
import type { DocumentSession, DocumentSessionHost } from "@/features/document-session/contracts";
import { getAppRuntime } from "@/lib/runtime";
import { visibleCommentThreads } from "@/lib/comments";
import { isWhiteboardPageLayout, normalizePageLayout, type SigmaDocument } from "@/features/document";
import { loadDocumentByFileIdWithRecovery, type DocumentMetadata } from "@/lib/storage";
import { useT } from "@/lib/i18n/react";
import {
  canSplitWorkspaceLayout,
  orderedWorkspaceGroups,
  resolveWorkspaceDropIntent,
  type TabGroupState,
  type WorkspaceDropEdge,
  type WorkspaceDropIntent,
  type WorkspaceLayoutV2,
  type WorkspaceSplitNode,
  type WorkspaceTab,
} from "@/lib/workspace-tab-groups";

/**
 * 編集していないペインを、編集中のペインと同じ見た目 (倍率・コメント欄) で描くための表示状態。
 * 印刷プレビューに切り替えると紙の大きさも余白も変わり、クリックした瞬間に中身が跳ぶ。
 */
export interface WorkspacePaneView {
  zoom: number;
  showComments: boolean;
  showResolvedComments: boolean;
  commentAuthor: CommentPanelAuthor;
  /** そのタブを最後に編集していたときのスクロール位置。 */
  scrollFor?(fileId: string): { scrollTop: number; scrollLeft: number } | undefined;
}

/**
 * 編集していないペインを押したときに、編集面へ引き継ぐ位置。
 * 同じ倍率で描いているので、スクロール量と押した点をそのまま渡せば同じ場所にキャレットが立つ。
 */
export interface WorkspacePaneHandoff {
  scrollTop: number;
  scrollLeft: number;
  point: { x: number; y: number } | null;
}

interface WorkspaceTabGroupGridProps {
  enabled?: boolean;
  sessionHost?: DocumentSessionHost;
  layout: WorkspaceLayoutV2;
  metadata: readonly DocumentMetadata[];
  activeFileId: string;
  paneView: WorkspacePaneView;
  children: ReactNode;
  onFocusGroup(groupId: string, handoff?: WorkspacePaneHandoff): void;
  onMoveTab(tabId: string, targetGroupId: string, targetIndex?: number): void;
  onSplitTab(tabId: string, targetGroupId: string, edge: WorkspaceDropEdge): void;
  onResizeSplit(splitId: string, ratio: number): void;
  onOpenAiSettings?(): void;
}

export function WorkspaceTabGroupGrid(props: WorkspaceTabGroupGridProps) {
  const metadataByFileId = useMemo(
    () => new Map(props.metadata.map((item) => [item.fileId, item])),
    [props.metadata],
  );
  const groupPositions = useMemo(() => new Map(
    orderedWorkspaceGroups(props.layout).map((group, index) => [group.id, index + 1]),
  ), [props.layout]);
  if (props.enabled === false) return props.children;
  return (
    <div className="workspace-tab-group-grid" data-group-count={props.layout.groups.length}>
      <SplitNodeView
        {...props}
        node={props.layout.root}
        metadataByFileId={metadataByFileId}
        groupPositions={groupPositions}
      />
    </div>
  );
}

type SplitNodeViewProps = WorkspaceTabGroupGridProps & {
  node: WorkspaceSplitNode;
  metadataByFileId: ReadonlyMap<string, DocumentMetadata>;
  groupPositions: ReadonlyMap<string, number>;
};

function SplitNodeView(props: SplitNodeViewProps) {
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
    splitRef.current?.setAttribute("data-resizing", "true");
    const move = (pointer: PointerEvent) => {
      const ratio = node.direction === "row"
        ? (pointer.clientX - bounds.left) / bounds.width
        : (pointer.clientY - bounds.top) / bounds.height;
      props.onResizeSplit(node.id, ratio);
    };
    const finish = () => {
      splitRef.current?.removeAttribute("data-resizing");
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
        ? { gridTemplateColumns: `minmax(240px, ${node.ratio}fr) 8px minmax(240px, ${1 - node.ratio}fr)` }
        : { gridTemplateRows: `minmax(180px, ${node.ratio}fr) 8px minmax(180px, ${1 - node.ratio}fr)` }}
    >
      <SplitNodeView {...props} node={node.first} />
      <button
        type="button"
        className="workspace-tab-splitter"
        aria-label={node.direction === "row" ? t("tabGroups.resizeHorizontal") : t("tabGroups.resizeVertical")}
        onPointerDown={startResize}
        onDoubleClick={() => props.onResizeSplit(node.id, 0.5)}
        onKeyDown={keyboardResize}
      >
        <span className="workspace-tab-splitter-grip" aria-hidden="true" />
      </button>
      <SplitNodeView {...props} node={node.second} />
    </div>
  );
}

function GroupView(props: SplitNodeViewProps & { group: TabGroupState }) {
  const { group } = props;
  const [dropIntent, setDropIntent] = useState<WorkspaceDropIntent | null>(null);
  const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId) ?? group.tabs[0];
  const focused = props.layout.focusedGroupId === group.id;
  const grouped = props.layout.groups.length > 1;
  const splittable = canSplitWorkspaceLayout(props.layout);
  const live = focused && activeTab?.kind === "document" && activeTab.fileId === props.activeFileId;

  const readIntent = (event: React.DragEvent<HTMLElement>): WorkspaceDropIntent => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return resolveWorkspaceDropIntent(bounds, { x: event.clientX, y: event.clientY }, { splittable });
  };

  return (
    <section
      className="workspace-tab-group"
      data-group-id={group.id}
      data-focused={focused ? "true" : undefined}
      data-live={live ? "true" : undefined}
      onPointerDown={(event) => {
        if (focused) return;
        const scroller = event.currentTarget.querySelector<HTMLElement>(".workspace-passive-editor");
        const target = event.target instanceof Element ? event.target : null;
        // 紙面の上を押したときだけ、その点へキャレットを渡す (スクロールバーやコメント欄は除く)。
        const onPaper = event.button === 0 && Boolean(target?.closest(".workspace-passive-editor .page-canvas"));
        props.onFocusGroup(group.id, scroller ? {
          scrollTop: scroller.scrollTop,
          scrollLeft: scroller.scrollLeft,
          point: onPaper ? { x: event.clientX, y: event.clientY } : null,
        } : undefined);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(WORKSPACE_TAB_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropIntent(readIntent(event));
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropIntent(null);
      }}
      onDrop={(event) => {
        const tabId = event.dataTransfer.getData(WORKSPACE_TAB_DRAG_TYPE);
        if (!tabId) {
          setDropIntent(null);
          return;
        }
        event.preventDefault();
        const intent = readIntent(event);
        setDropIntent(null);
        if (intent.kind === "split") props.onSplitTab(tabId, group.id, intent.edge);
        else props.onMoveTab(tabId, group.id);
      }}
    >
      {grouped && (
        <span className="workspace-pane-badge" aria-hidden="true">{props.groupPositions.get(group.id)}</span>
      )}
      <div className="workspace-tab-group-content">
        {live
          ? props.children
          : activeTab
            ? <BackgroundTabContent
                sessionHost={props.sessionHost}
                tab={activeTab}
                metadata={props.metadataByFileId.get(activeTab.kind === "document" ? activeTab.fileId : activeTab.documentFileId)}
                paneView={props.paneView}
                onOpenAiSettings={props.onOpenAiSettings}
              />
            : null}
      </div>
      {dropIntent && (
        <div
          className="workspace-tab-drop-preview"
          data-intent={dropIntent.kind}
          data-edge={dropIntent.kind === "split" ? dropIntent.edge : undefined}
          aria-hidden="true"
        />
      )}
    </section>
  );
}

function BackgroundTabContent({
  sessionHost,
  tab,
  metadata,
  paneView,
  onOpenAiSettings,
}: {
  sessionHost?: DocumentSessionHost;
  tab: WorkspaceTab;
  metadata?: DocumentMetadata;
  paneView: WorkspacePaneView;
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
  if (tab.kind === "ai" && writable) {
    return (
      <DocumentSessionContext.Provider value={sessionHost?.get(fileId)}>
        <DocumentWritableContext.Provider value={writable}>
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
        </DocumentWritableContext.Provider>
      </DocumentSessionContext.Provider>
    );
  }
  return (
    <PassiveDocumentPane
      document={document}
      fileId={fileId}
      title={metadata?.title ?? t("tabGroups.material")}
      view={paneView}
      session={sessionHost?.get(fileId)}
    />
  );
}

/**
 * 編集していないペインの紙面。編集中のペインと同じ編集面 (`PageCanvasEditor`) を、同じ倍率と
 * コメント欄で読み取り専用に描く。押すとそのペインが編集対象になり、スクロール位置と押した点が
 * 編集面へ引き継がれる (`WorkspacePaneHandoff`)。
 *
 * 共同編集のセッションは画像の解決と相手のカーソル表示のために渡すが、自分の選択は配信しない
 * (`publishesSessionPresence={false}`)。見ているだけのペインの状態を他の参加者へ見せないため。
 */
function PassiveDocumentPane({
  document,
  fileId,
  title,
  view,
  session,
}: {
  document: SigmaDocument;
  fileId: string;
  title: string;
  view: WorkspacePaneView;
  session: DocumentSession | undefined;
}) {
  const t = useT("editor");
  const scrollerRef = useRef<HTMLElement>(null);
  const noop = useCallback(() => {}, []);
  const isWhiteboard = useMemo(() => isWhiteboardPageLayout(normalizePageLayout(document.pageLayout)), [document.pageLayout]);
  const threads = useMemo(
    () => visibleCommentThreads(document.comments, { showResolved: view.showResolvedComments }),
    [document.comments, view.showResolvedComments],
  );
  const commentPanel = useMemo(() => (view.showComments && !isWhiteboard ? {
    activeThreadId: null,
    author: view.commentAuthor,
    candidateAnchor: null,
    pendingAnchor: null,
    pendingDraft: [],
    replyDrafts: {},
    showResolved: view.showResolvedComments,
    threads,
    onAddThread: noop,
    onCancelPending: noop,
    onDeleteMessage: noop,
    onDeleteThread: noop,
    onEditMessage: noop,
    onEditThread: noop,
    onPendingDraftChange: noop,
    onReply: noop,
    onReplyDraftChange: noop,
    onResolveThread: noop,
    onReopenThread: noop,
    onSelectThread: noop,
    onShowResolvedChange: noop,
    onStartThread: noop,
    onToggleReaction: noop,
  } : undefined), [isWhiteboard, noop, threads, view.commentAuthor, view.showComments, view.showResolvedComments]);

  // 最後に編集していた位置から見せる。紙面は計測のあとで伸びるので、届くまで数回当て直す。
  const { scrollFor } = view;
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const saved = scrollFor?.(fileId);
    if (!scroller || !saved || (saved.scrollTop <= 0 && saved.scrollLeft <= 0)) return;
    let userScrolled = false;
    const markUserScroll = () => { userScrolled = true; };
    const apply = () => {
      if (userScrolled) return;
      scroller.scrollTop = saved.scrollTop;
      scroller.scrollLeft = saved.scrollLeft;
    };
    apply();
    const content = scroller.firstElementChild;
    const observer = content ? new ResizeObserver(apply) : null;
    if (content) observer?.observe(content);
    scroller.addEventListener("wheel", markUserScroll, { passive: true });
    scroller.addEventListener("keydown", markUserScroll);
    const stop = window.setTimeout(() => observer?.disconnect(), 3000);
    return () => {
      window.clearTimeout(stop);
      observer?.disconnect();
      scroller.removeEventListener("wheel", markUserScroll);
      scroller.removeEventListener("keydown", markUserScroll);
    };
  }, [fileId, scrollFor]);

  return (
    <section
      ref={scrollerRef}
      className="editor-canvas workspace-passive-editor"
      data-whiteboard={isWhiteboard ? "true" : undefined}
      aria-label={t("tabGroups.pane", { title })}
    >
      <DocumentSessionContext.Provider value={session}>
        <DocumentWritableContext.Provider value={false}>
          <PageCanvasEditor
            publishesSessionPresence={false}
            document={document}
            selectedId={null}
            selectedInlineMath={null}
            commentThreads={document.comments ?? []}
            showComments={view.showComments}
            commentPanel={commentPanel}
            overlaySelection={EMPTY_OVERLAY_SELECTION}
            fontSize={BASE_EDITOR_FONT_SIZE}
            zoom={view.zoom}
            historyRevision={0}
            suppressSelectionActions
            pendingDeletion={null}
            overlayCommandRequest={null}
            overlayImageRequest={null}
            overlayActionRequest={null}
            onSelect={noop}
            onChange={noop}
            onDelete={noop}
            onCopyBlock={noop}
            onDuplicate={noop}
            onMove={noop}
            onAddProblemBlock={noop}
            onReplaceTextFlow={noop}
            onPageLayoutChange={noop}
            onOverlayChange={noop}
            onOverlayImagesRequest={noop}
            onReanchorOverlay={noop}
            onOverlayCommandHandled={noop}
            onOverlayImageHandled={noop}
            onOverlayActionHandled={noop}
          />
        </DocumentWritableContext.Provider>
      </DocumentSessionContext.Provider>
    </section>
  );
}
