"use client";

import { usePersistentWorkspacePane } from "./persistent-workspace";
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
  prepareDocumentReplacement?: () => Promise<boolean>;
  rememberPaneHandoff: (fileId: string, handoff: WorkspacePaneHandoff) => void;
}
export function useWorkspaceTabCoordination({ initialDocumentId, getActiveFileId, setOpenFileIds, openDocumentInWorkspace, closeDocumentTab, rememberPaneHandoff, prepareDocumentReplacement }: WorkspaceTabPorts) {
  const persistent = usePersistentWorkspacePane();
  const [localWorkspaceLayout, setStoredWorkspaceLayout] = useState<WorkspaceLayoutV2>(() => (
    createSingleGroupWorkspaceLayout([initialDocumentId], initialDocumentId)
  ));
  const workspaceLayout = persistent?.workspace.layout ?? localWorkspaceLayout;
  const workspaceLayoutRef = useRef(workspaceLayout);
  const setWorkspaceLayout = useCallback((layout: WorkspaceLayoutV2) => { workspaceLayoutRef.current = layout; setStoredWorkspaceLayout(layout); persistent?.workspace.setLayout(layout); }, [persistent]);
  const getWorkspaceLayout = useCallback(() => persistent?.workspace.layout ?? workspaceLayoutRef.current, [persistent]);
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
    const nextLayout = focusWorkspaceTab(getWorkspaceLayout(), groupId, tab.id);
    if (tab.kind === "document" && tab.fileId !== getActiveFileId() && !persistent?.workspace.findFile(tab.fileId)) {
      void openDocumentInWorkspace(tab.fileId, { nextOpenFileIds: workspaceLayoutOpenFileIds(nextLayout), onOpened: () => persistTabGroupLayout(nextLayout) });
      return;
    }
    persistTabGroupLayout(nextLayout);
  }, [getActiveFileId, getWorkspaceLayout, openDocumentInWorkspace, persistTabGroupLayout, persistent]);

  const moveWorkspaceGroupTab = useCallback((tabId: string, targetGroupId: string, targetIndex?: number) => {
    const nextLayout = moveWorkspaceTab(getWorkspaceLayout(), tabId, targetGroupId, targetIndex);
    const tab = nextLayout.groups.flatMap((group) => group.tabs).find((candidate) => candidate.id === tabId);
    if (persistent && tab?.kind === "document" && tab.fileId !== getActiveFileId() && !persistent.workspace.findFile(tab.fileId)) {
      void (async () => {
        if (prepareDocumentReplacement && !(await prepareDocumentReplacement())) return;
        const group = nextLayout.groups.find(group => group.tabs.some(candidate => candidate.id === tabId));
        persistTabGroupLayout(group ? focusWorkspaceTab(nextLayout, group.id, tabId) : nextLayout);
      })();
      return;
    }
    if (tab?.kind === "document" && tab.fileId !== getActiveFileId() && !persistent?.workspace.findFile(tab.fileId)) {
      void openDocumentInWorkspace(tab.fileId, { nextOpenFileIds: workspaceLayoutOpenFileIds(nextLayout), onOpened: () => persistTabGroupLayout(nextLayout) });
    } else {
      persistTabGroupLayout(nextLayout);
    }
  }, [getActiveFileId, getWorkspaceLayout, openDocumentInWorkspace, persistTabGroupLayout, persistent, prepareDocumentReplacement]);

  const splitWorkspaceGroupTab = useCallback((tabId: string, targetGroupId: string, edge: WorkspaceDropEdge) => {
    const nextLayout = splitWorkspaceGroupWithTab(
      getWorkspaceLayout(),
      tabId,
      targetGroupId,
      edge,
      createId("tab-group"),
      createId("tab-split"),
    );
    const tab = nextLayout.groups.flatMap((group) => group.tabs).find((candidate) => candidate.id === tabId);
    if (persistent && tab?.kind === "document" && tab.fileId !== getActiveFileId() && !persistent.workspace.findFile(tab.fileId)) {
      void (async () => {
        if (prepareDocumentReplacement && !(await prepareDocumentReplacement())) return;
        const group = nextLayout.groups.find(group => group.tabs.some(candidate => candidate.id === tabId));
        persistTabGroupLayout(group ? focusWorkspaceTab(nextLayout, group.id, tabId) : nextLayout);
      })();
      return;
    }
    if (tab?.kind === "document" && tab.fileId !== getActiveFileId() && !persistent?.workspace.findFile(tab.fileId)) {
      void openDocumentInWorkspace(tab.fileId, { nextOpenFileIds: workspaceLayoutOpenFileIds(nextLayout), onOpened: () => persistTabGroupLayout(nextLayout) });
    } else {
      persistTabGroupLayout(nextLayout);
    }
  }, [getActiveFileId, getWorkspaceLayout, openDocumentInWorkspace, persistTabGroupLayout, persistent, prepareDocumentReplacement]);

  const closeWorkspaceGroupTab = useCallback((_groupId: string, tab: WorkspaceTab) => {
    const nextLayout = closeWorkspaceTabInLayout(getWorkspaceLayout(), tab.id);
    if (nextLayout === getWorkspaceLayout()) return;
    if (tab.kind === "document") {
      const owner = persistent?.workspace.findFile(tab.fileId);
      void (owner?.close ?? closeDocumentTab)(tab.fileId);
      return;
    }
    persistTabGroupLayout(nextLayout);
  }, [closeDocumentTab, getWorkspaceLayout, persistTabGroupLayout, persistent]);

  const resizeWorkspaceGroupSplit = useCallback((splitId: string, ratio: number) => {
    const nextLayout = updateWorkspaceSplitRatio(getWorkspaceLayout(), splitId, ratio);
    workspaceLayoutRef.current = nextLayout;
    setWorkspaceLayout(nextLayout);
    if (workspaceLayoutSaveTimerRef.current !== null) window.clearTimeout(workspaceLayoutSaveTimerRef.current);
    workspaceLayoutSaveTimerRef.current = window.setTimeout(() => {
      persistTabGroupLayout(workspaceLayoutRef.current);
      workspaceLayoutSaveTimerRef.current = null;
    }, 160);
  }, [getWorkspaceLayout, persistTabGroupLayout, setWorkspaceLayout]);
  const focusWorkspaceGroup = useCallback((groupId: string, handoff?: WorkspacePaneHandoff) => {
    const group = getWorkspaceLayout().groups.find((candidate) => candidate.id === groupId);
    const tab = group?.tabs.find((candidate) => candidate.id === group.activeTabId) ?? group?.tabs[0];
    if (!group || !tab) return;
    // 読み取り専用で描いていた紙面の位置を、そのまま編集面の復元位置にする。
    // 押した点があればキャレットはそこへ置くので、前回のキャレットは戻さない。
    if (!persistent && handoff && tab.kind === "document" && tab.fileId !== getActiveFileId()) rememberPaneHandoff(tab.fileId, handoff);
    activateWorkspaceGroupTab(group.id, tab);
  }, [activateWorkspaceGroupTab, getActiveFileId, getWorkspaceLayout, rememberPaneHandoff, persistent]);

  useEffect(() => () => { if (workspaceLayoutSaveTimerRef.current !== null) window.clearTimeout(workspaceLayoutSaveTimerRef.current); }, []);
  return { workspaceLayout, getWorkspaceLayout, setWorkspaceLayout, persistTabGroupLayout, activateWorkspaceGroupTab, moveWorkspaceGroupTab, splitWorkspaceGroupTab, closeWorkspaceGroupTab, resizeWorkspaceGroupSplit, focusWorkspaceGroup };
}
