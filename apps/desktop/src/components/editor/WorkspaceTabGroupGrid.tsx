"use client";

import { Minus, Plus, Scan } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AiEditPanel } from "@/components/editor/AiEditPanel";
import { DocumentSessionContext, DocumentWritableContext } from "./document-session-context";
import { EMPTY_OVERLAY_SELECTION } from "@/components/editor/editor-shell/constants";
import { WORKSPACE_TAB_DRAG_TYPE } from "@/components/editor/WorkspaceTabStrip";
import { PagedRenderSurface } from "@/components/print/paged-render/PagedRenderSurface";
import type { DocumentSessionHost } from "@/features/document-session/contracts";
import { getAppRuntime } from "@/lib/runtime";
import { ensurePageLayout, getPageMetrics, MM_TO_PX, type SigmaDocument } from "@/features/document";
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

/** プレビューの紙の周りに残す余白。 */
const PREVIEW_GUTTER = 24;
const MIN_PREVIEW_SCALE = 0.1;
const MAX_PREVIEW_SCALE = 3;

interface WorkspaceTabGroupGridProps {
  enabled?: boolean;
  sessionHost?: DocumentSessionHost;
  layout: WorkspaceLayoutV2;
  metadata: readonly DocumentMetadata[];
  activeFileId: string;
  children: ReactNode;
  onFocusGroup(groupId: string): void;
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
  const t = useT("editor");
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
      onPointerDown={() => {
        if (!focused) props.onFocusGroup(group.id);
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
                onOpenAiSettings={props.onOpenAiSettings}
              />
            : null}
      </div>
      {!live && activeTab?.kind === "document" && (
        <span className="workspace-pane-edit-hint" aria-hidden="true">{t("tabGroups.clickToEdit")}</span>
      )}
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
    <DocumentPreviewPane document={document} title={metadata?.title ?? t("tabGroups.material")} />
  );
  return (
    <DocumentSessionContext.Provider value={sessionHost?.get(fileId)}>
      <DocumentWritableContext.Provider value={writable}>{content}</DocumentWritableContext.Provider>
    </DocumentSessionContext.Provider>
  );
}

/**
 * 編集していないペインの紙面。
 *
 * 既定はペイン幅に合わせた倍率で、`Ctrl`/`⌘` + ホイールと隅の操作で拡大縮小できる。
 * 分割するとペインは必ず本来の紙より狭くなるので、倍率を持たないと中身が読めない。
 */
function DocumentPreviewPane({ document, title }: { document: SigmaDocument; title: string }) {
  const t = useT("editor");
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [manualScale, setManualScale] = useState<number | null>(null);

  const pageWidthPx = useMemo(() => {
    const metrics = getPageMetrics(ensurePageLayout(document).pageLayout!);
    return Math.max(1, metrics.page.widthMm * MM_TO_PX);
  }, [document]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => {
      setViewportWidth(viewport.clientWidth);
      setContentHeight(content.offsetHeight);
    });
    observer.observe(viewport);
    observer.observe(content);
    setViewportWidth(viewport.clientWidth);
    setContentHeight(content.offsetHeight);
    return () => observer.disconnect();
  }, []);

  const fitScale = viewportWidth > 0
    ? clamp((viewportWidth - PREVIEW_GUTTER * 2) / pageWidthPx, MIN_PREVIEW_SCALE, 1)
    : 1;
  const scale = manualScale ?? fitScale;

  const zoomBy = useCallback((factor: number) => {
    setManualScale((current) => clamp((current ?? fitScale) * factor, MIN_PREVIEW_SCALE, MAX_PREVIEW_SCALE));
  }, [fitScale]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      // ピンチも ctrlKey 付きのホイールとして届く。1 イベントの跳ね上がりは抑え、
      // マウスの 1 目盛りでも一気に飛ばないようにする。
      zoomBy(clamp(Math.exp(-event.deltaY / 420), 0.8, 1.25));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  return (
    <div className="workspace-document-preview">
      <div className="workspace-preview-viewport" ref={viewportRef} aria-label={t("tabGroups.preview", { title })}>
        <div
          className="workspace-preview-sizer"
          style={{ width: pageWidthPx * scale, height: contentHeight * scale }}
        >
          <div
            className="workspace-preview-scaler"
            ref={contentRef}
            style={{ width: pageWidthPx, transform: `scale(${scale})` }}
          >
            <PagedRenderSurface document={document} profile="teacher" />
          </div>
        </div>
      </div>
      <div
        className="workspace-preview-zoom"
        role="group"
        aria-label={t("tabGroups.zoomLabel")}
        // 倍率を変えただけでペインの担当教材が編集面に載せ替わらないようにする。
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button type="button" aria-label={t("tabGroups.zoomOut")} title={t("tabGroups.zoomOut")} onClick={() => zoomBy(1 / 1.2)}>
          <Minus size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="workspace-preview-zoom-value"
          aria-label={t("tabGroups.zoomFit")}
          title={t("tabGroups.zoomFit")}
          onClick={() => setManualScale(null)}
        >
          {manualScale === null ? <Scan size={13} aria-hidden="true" /> : null}
          <span>{Math.round(scale * 100)}%</span>
        </button>
        <button type="button" aria-label={t("tabGroups.zoomIn")} title={t("tabGroups.zoomIn")} onClick={() => zoomBy(1.2)}>
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
