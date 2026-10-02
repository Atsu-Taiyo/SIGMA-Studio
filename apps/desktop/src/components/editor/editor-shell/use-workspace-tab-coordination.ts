"use client";

import { type WorkspacePaneHandoff } from "@/components/editor/WorkspaceTabGroupGrid";
import { createId } from "@/lib/id";
import { saveWorkspaceState as persistWorkspaceState } from "@/lib/storage";
import { closeWorkspaceTabInLayout,createSingleGroupWorkspaceLayout,focusWorkspaceTab,moveWorkspaceTab,splitWorkspaceGroupWithTab,updateWorkspaceSplitRatio,workspaceLayoutOpenFileIds,type WorkspaceDropEdge,type WorkspaceLayoutV2,type WorkspaceTab } from "@/lib/workspace-tab-groups";
import { useCallback,useEffect,useRef,useState } from "react";
import { type DocumentTabOpenOptions } from "./document-tab-commands";

interface WorkspaceTabPorts {
  initialDocumentId: string;
  getActiveFileId: () => string;
  setOpenFileIds: (ids: string[]) => void;
  openDocumentInWorkspace: (fileId: string, options?: DocumentTabOpenOptions) => Promise<void>;
  closeDocumentTab: (fileId: string) => Promise<void>;
  rememberPaneHandoff: (fileId: string, handoff: WorkspacePaneHandoff) => void;
}
export function useWorkspaceTabCoordination({ initialDocumentId, getActiveFileId, setOpenFileIds, openDocumentInWorkspace, closeDocumentTab, rememberPaneHandoff }: WorkspaceTabPorts) {
  const [workspaceLayout, setStoredWorkspaceLayout] = useState<WorkspaceLayoutV2>(() => (
    createSingleGroupWorkspaceLayout([initialDocumentId], initialDocumentId)
  ));
  const workspaceLayoutRef = useRef(workspaceLayout);
  const setWorkspaceLayout = useCallback((layout: WorkspaceLayoutV2) => { workspaceLayoutRef.current = layout; setStoredWorkspaceLayout(layout); }, []);
  const getWorkspaceLayout = useCallback(() => workspaceLayoutRef.current, []);
  const workspaceLayoutSaveTimerRef = useRef<number | null>(null);
  const persistTabGroupLayout = useCallback((layout: WorkspaceLayoutV2) => {
    workspaceLayoutRef.current = layout;
    setWorkspaceLayout(layout);
    const nextOpenFileIds = workspaceLayoutOpenFileIds(layout);
    setOpenFileIds(nextOpenFileIds);
    void persistWorkspaceState({
      openFileIds: nextOpenFileIds,
      activeFileId: layout.lastDocumentFileId,
      layout,
    });
  }, [setOpenFileIds, setWorkspaceLayout]);

  const activateWorkspaceGroupTab = useCallback((groupId: string, tab: WorkspaceTab) => {
    const nextLayout = focusWorkspaceTab(workspaceLayoutRef.current, groupId, tab.id);
    if (tab.kind === "document" && tab.fileId !== getActiveFileId()) {
      void openDocumentInWorkspace(tab.fileId, { nextOpenFileIds: workspaceLayoutOpenFileIds(nextLayout), onOpened: () => persistTabGroupLayout(nextLayout) });
      return;
    }
    persistTabGroupLayout(nextLayout);
  }, [getActiveFileId, openDocumentInWorkspace, persistTabGroupLayout]);

  const moveWorkspaceGroupTab = useCallback((tabId: string, targetGroupId: string, targetIndex?: number) => {
    const nextLayout = moveWorkspaceTab(workspaceLayoutRef.current, tabId, targetGroupId, targetIndex);
    const tab = nextLayout.groups.flatMap((group) => group.tabs).find((candidate) => candidate.id === tabId);
    if (tab?.kind === "document" && tab.fileId !== getActiveFileId()) {
      void openDocumentInWorkspace(tab.fileId, { nextOpenFileIds: workspaceLayoutOpenFileIds(nextLayout), onOpened: () => persistTabGroupLayout(nextLayout) });
    } else {
      persistTabGroupLayout(nextLayout);
    }
  }, [getActiveFileId, openDocumentInWorkspace, persistTabGroupLayout]);

  const splitWorkspaceGroupTab = useCallback((tabId: string, targetGroupId: string, edge: WorkspaceDropEdge) => {
    const nextLayout = splitWorkspaceGroupWithTab(
      workspaceLayoutRef.current,
      tabId,
      targetGroupId,
      edge,
      createId("tab-group"),
      createId("tab-split"),
    );
    const tab = nextLayout.groups.flatMap((group) => group.tabs).find((candidate) => candidate.id === tabId);
    if (tab?.kind === "document" && tab.fileId !== getActiveFileId()) {
      void openDocumentInWorkspace(tab.fileId, { nextOpenFileIds: workspaceLayoutOpenFileIds(nextLayout), onOpened: () => persistTabGroupLayout(nextLayout) });
    } else {
      persistTabGroupLayout(nextLayout);
    }
  }, [getActiveFileId, openDocumentInWorkspace, persistTabGroupLayout]);

  const closeWorkspaceGroupTab = useCallback((_groupId: string, tab: WorkspaceTab) => {
    const nextLayout = closeWorkspaceTabInLayout(workspaceLayoutRef.current, tab.id);
    if (nextLayout === workspaceLayoutRef.current) return;
    if (tab.kind === "document") {
      void closeDocumentTab(tab.fileId);
      return;
    }
    persistTabGroupLayout(nextLayout);
  }, [closeDocumentTab, persistTabGroupLayout]);

  const resizeWorkspaceGroupSplit = useCallback((splitId: string, ratio: number) => {
    const nextLayout = updateWorkspaceSplitRatio(workspaceLayoutRef.current, splitId, ratio);
    workspaceLayoutRef.current = nextLayout;
    setWorkspaceLayout(nextLayout);
    if (workspaceLayoutSaveTimerRef.current !== null) window.clearTimeout(workspaceLayoutSaveTimerRef.current);
    workspaceLayoutSaveTimerRef.current = window.setTimeout(() => {
      persistTabGroupLayout(workspaceLayoutRef.current);
      workspaceLayoutSaveTimerRef.current = null;
    }, 160);
  }, [persistTabGroupLayout, setWorkspaceLayout]);
  const focusWorkspaceGroup = useCallback((groupId: string, handoff?: WorkspacePaneHandoff) => {
    const group = workspaceLayoutRef.current.groups.find((candidate) => candidate.id === groupId);
    const tab = group?.tabs.find((candidate) => candidate.id === group.activeTabId) ?? group?.tabs[0];
    if (!group || !tab) return;
    // 読み取り専用で描いていた紙面の位置を、そのまま編集面の復元位置にする。
    // 押した点があればキャレットはそこへ置くので、前回のキャレットは戻さない。
    if (handoff && tab.kind === "document" && tab.fileId !== getActiveFileId()) rememberPaneHandoff(tab.fileId, handoff);
    activateWorkspaceGroupTab(group.id, tab);
  }, [activateWorkspaceGroupTab, getActiveFileId, rememberPaneHandoff]);

  useEffect(() => () => { if (workspaceLayoutSaveTimerRef.current !== null) window.clearTimeout(workspaceLayoutSaveTimerRef.current); }, []);
  return { workspaceLayout, getWorkspaceLayout, setWorkspaceLayout, persistTabGroupLayout, activateWorkspaceGroupTab, moveWorkspaceGroupTab, splitWorkspaceGroupTab, closeWorkspaceGroupTab, resizeWorkspaceGroupSplit, focusWorkspaceGroup };
}
