"use client";

import { Bot, Columns2, FileText, Loader2, Rows2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAiWorkspaceTabTitles } from "@/components/editor/AiWorkspaceTabTitles";
import { DocumentTabSaveDot } from "@/components/editor/editor-shell/SaveStatusIndicators";
import { DocumentTitleText } from "@/features/rendering/adapters/react";
import type { InlineNode } from "@/features/document";
import { useT } from "@/lib/i18n/react";
import type { DocumentMetadata } from "@/lib/storage";
import {
  canSplitWorkspaceLayout,
  orderedWorkspaceGroups,
  workspaceTabInsertionIndex,
  type TabGroupState,
  type WorkspaceDropEdge,
  type WorkspaceLayoutV2,
  type WorkspaceTab,
} from "@/lib/workspace-tab-groups";

export const WORKSPACE_TAB_DRAG_TYPE = "application/x-sigma-workspace-tab";

export interface WorkspaceTabStripProps {
  layout: WorkspaceLayoutV2;
  metadata: readonly DocumentMetadata[];
  activeFileId: string;
  loadingFileId: string | null;
  /** 編集中の教材のタイトル。台帳より新しいので、そのタブだけはこちらを使う。 */
  activeDocumentTitle: string;
  /** 数式を含むタイトルを組むためのノード列 (編集中の教材のみ)。 */
  activeDocumentTitleNodes?: InlineNode[] | null;
  onActivateTab(groupId: string, tab: WorkspaceTab): void;
  onCloseTab(groupId: string, tab: WorkspaceTab): void;
  onMoveTab(tabId: string, targetGroupId: string, targetIndex?: number): void;
  onSplitTab(tabId: string, targetGroupId: string, edge: WorkspaceDropEdge): void;
  onFocusGroup(groupId: string): void;
}

interface TabContextMenuState {
  x: number;
  y: number;
  groupId: string;
  tab: WorkspaceTab;
}

/**
 * メニューバーの教材タブ列。
 *
 * 分割していないときは 1 本の素のタブ列 (分割機能が入る前と同じ位置・同じ見た目)。
 * 分割するとペインごとに Chrome のタブグループのような囲みが付き、囲みの番号が
 * ペイン左上の番号と対応する。タブはここだけにあり、ペインの中には置かない。
 */
export function WorkspaceTabStrip(props: WorkspaceTabStripProps) {
  const t = useT("editor");
  // タブそのものの文言 (領域名・閉じる) は従来のタブ列と同じものを使う。
  const tChrome = useT("chrome");
  const aiRoomTitles = useAiWorkspaceTabTitles();
  const metadataByFileId = useMemo(
    () => new Map(props.metadata.map((item) => [item.fileId, item])),
    [props.metadata],
  );
  const groups = orderedWorkspaceGroups(props.layout);
  const grouped = groups.length > 1;
  const [dropTarget, setDropTarget] = useState<{ groupId: string; index: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  const tabTitle = (tab: WorkspaceTab): string => {
    if (tab.kind === "document") {
      return tab.fileId === props.activeFileId
        ? props.activeDocumentTitle
        : metadataByFileId.get(tab.fileId)?.title || t("tabGroups.untitled");
    }
    const room = aiRoomTitles.get(tab.roomId);
    const document = metadataByFileId.get(tab.documentFileId)?.title || t("tabGroups.untitled");
    return `${room || t("tabGroups.aiEdit")} · ${document}`;
  };

  const dropIndexAt = (group: TabGroupState, clientX: number, container: HTMLElement): number => {
    const tabs = Array.from(container.querySelectorAll<HTMLElement>("[data-tab-id]"));
    const index = tabs.findIndex((element) => {
      const bounds = element.getBoundingClientRect();
      return clientX < bounds.left + bounds.width / 2;
    });
    return index === -1 ? group.tabs.length : index;
  };


  const splittable = canSplitWorkspaceLayout(props.layout);

  return (
    <div
      className="document-tabs-row workspace-tabs-row"
      data-grouped={grouped ? "true" : undefined}
      aria-label={tChrome("tabs.region")}
    >
      <div
        className="document-tabs-scroll"
        ref={scrollRef}
        role="tablist"
        aria-label={tChrome("tabs.list")}
        onWheel={(event) => {
          // 横一列なので、縦ホイールもそのまま列送りに使えたほうが速い。
          if (event.deltaY === 0 || event.shiftKey) return;
          const scroller = scrollRef.current;
          if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
          scroller.scrollLeft += event.deltaY;
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
        }}
      >
        {groups.map((group, groupIndex) => (
          <div
            className="workspace-tab-cluster"
            key={group.id}
            data-group-id={group.id}
            data-focused={props.layout.focusedGroupId === group.id ? "true" : undefined}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(WORKSPACE_TAB_DRAG_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropTarget({ groupId: group.id, index: dropIndexAt(group, event.clientX, event.currentTarget) });
            }}
            onDrop={(event) => {
              const tabId = event.dataTransfer.getData(WORKSPACE_TAB_DRAG_TYPE);
              event.preventDefault();
              const index = dropIndexAt(group, event.clientX, event.currentTarget);
              setDropTarget(null);
              if (tabId) props.onMoveTab(tabId, group.id, workspaceTabInsertionIndex(group, tabId, index));
            }}
          >
            {grouped && (
              <button
                type="button"
                className="workspace-tab-cluster-handle"
                aria-label={t("tabGroups.paneLabel", { index: groupIndex + 1 })}
                title={t("tabGroups.paneLabel", { index: groupIndex + 1 })}
                onClick={() => props.onFocusGroup(group.id)}
              >
                {groupIndex + 1}
              </button>
            )}
            {group.tabs.map((tab, tabIndex) => {
              const title = tabTitle(tab);
              const active = tab.id === group.activeTabId;
              const live = tab.kind === "document" && tab.fileId === props.activeFileId;
              return (
                <div
                  className={`document-tab workspace-tab ${active ? "active" : ""}`}
                  key={tab.id}
                  data-tab-id={tab.id}
                  data-drop-before={dropTarget?.groupId === group.id && dropTarget.index === tabIndex ? "true" : undefined}
                >
                  <button
                    type="button"
                    role="tab"
                    className="document-tab-main"
                    draggable
                    aria-selected={active}
                    aria-label={title}
                    title={title}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(WORKSPACE_TAB_DRAG_TYPE, tab.id);
                    }}
                    onDragEnd={() => setDropTarget(null)}
                    onClick={() => props.onActivateTab(group.id, tab)}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return;
                      event.preventDefault();
                      props.onCloseTab(group.id, tab);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setContextMenu({ x: event.clientX, y: event.clientY, groupId: group.id, tab });
                    }}
                  >
                    {props.loadingFileId && tab.kind === "document" && tab.fileId === props.loadingFileId
                      ? <Loader2 className="document-tab-loading" size={14} />
                      : tab.kind === "document" ? <FileText size={14} /> : <Bot size={14} />}
                    {/* 開いていない教材のタイトルは台帳の文字列しか無いので文字列パスで描く。
                        編集中の教材だけ、導出したノード列を渡す。 */}
                    <span className="document-tab-title">
                      {tab.kind === "document"
                        ? <DocumentTitleText title={title} nodes={live ? props.activeDocumentTitleNodes ?? undefined : undefined} />
                        : title}
                    </span>
                    <span className="document-tab-initial" aria-hidden="true">{Array.from(title)[0]}</span>
                    {live && <DocumentTabSaveDot />}
                  </button>
                  <button
                    type="button"
                    className="document-tab-close"
                    title={tChrome("tabs.close")}
                    aria-label={tChrome("tabs.closeNamed", { title })}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onCloseTab(group.id, tab);
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            <span
              className="workspace-tab-drop-marker"
              data-visible={dropTarget?.groupId === group.id && dropTarget.index >= group.tabs.length ? "true" : undefined}
              aria-hidden="true"
            />
          </div>
        ))}
      </div>

      {contextMenu && (
        <div
          className="workspace-context-menu workspace-tab-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!splittable}
            onClick={() => {
              props.onSplitTab(contextMenu.tab.id, contextMenu.groupId, "right");
              setContextMenu(null);
            }}
          >
            <Columns2 size={15} aria-hidden="true" />
            <span>{t("tabGroups.splitRight")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!splittable}
            onClick={() => {
              props.onSplitTab(contextMenu.tab.id, contextMenu.groupId, "bottom");
              setContextMenu(null);
            }}
          >
            <Rows2 size={15} aria-hidden="true" />
            <span>{t("tabGroups.splitDown")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              props.onCloseTab(contextMenu.groupId, contextMenu.tab);
              setContextMenu(null);
            }}
          >
            <X size={15} aria-hidden="true" />
            <span>{tChrome("tabs.close")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
