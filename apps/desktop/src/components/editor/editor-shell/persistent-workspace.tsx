"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { WorkspaceTabGroupGrid, type WorkspaceTabGroupGridProps } from "../WorkspaceTabGroupGrid";
import { workspaceLayoutOpenFileIds, type WorkspaceLayoutV2 } from "@/lib/workspace-tab-groups";

type BoundaryResult = { ok: boolean; error?: string; skipped?: boolean; skippedReason?: import("./workspace-request").DocumentBoundarySkipReason };
interface Pane {
  id: string;
  initialFileId?: string;
  fileId?: string;
  ready: boolean;
  canvas: HTMLDivElement;
  save?: (reason: "tab-switch" | "app-close") => Promise<BoundaryResult>;
  dirty?: () => boolean;
  cleanup?: () => Promise<BoundaryResult>;
  close?: (fileId: string) => Promise<void>;
  grid?: WorkspaceTabGroupGridProps;
}

/** Mounted editors belong to visible documents, independently of the focused chrome. */
export class PersistentWorkspace {
  layout: WorkspaceLayoutV2 | null = null;
  panes: Pane[] = [];
  gridRoot: HTMLDivElement | null = null;
  private frame: HTMLDivElement | null = null;
  private sequence = 0;
  private listeners = new Set<() => void>();
  private paneListeners = new Set<() => void>();
  private gridListeners = new Set<() => void>();
  private gridRevision = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  subscribePanes = (listener: () => void) => { this.paneListeners.add(listener); return () => this.paneListeners.delete(listener); };
  subscribeGrid = (listener: () => void) => { this.gridListeners.add(listener); return () => this.gridListeners.delete(listener); };
  getLayout = () => this.layout;
  getPanes = () => this.panes;
  getGridRevision = () => this.gridRevision;
  private refreshGrid() { this.gridRevision++; this.gridListeners.forEach(listener => listener()); }
  setLayout = (layout: WorkspaceLayoutV2) => {
    if (layout === this.layout) return;
    this.layout = layout;
    this.listeners.forEach(listener => listener());
    this.refreshGrid();
  };
  focusedFile() {
    const group = this.layout?.groups.find(group => group.id === this.layout?.focusedGroupId);
    const tab = group?.tabs.find(tab => tab.id === group.activeTabId);
    return tab?.kind === "document" ? tab.fileId : this.layout?.lastDocumentFileId;
  }
  isFocused = (id: string) => {
    const focused = this.panes.find(pane => pane.fileId === this.focusedFile());
    return (focused ?? this.panes[0])?.id === id;
  };
  findFile = (fileId: string) => this.panes.find(pane => pane.fileId === fileId && pane.ready);
  initialize() {
    this.gridRoot ??= document.createElement("div");
    this.gridRoot.className = "workspace-persistent-grid";
    this.frame ??= document.createElement("div");
    this.frame.className = "app-shell workspace-panes-frame";
    this.frame.appendChild(this.gridRoot);
    document.body.appendChild(this.frame);
    if (this.panes.length === 0) this.addPane();
  }
  disposeFrame() { this.frame?.remove(); }
  placeGrid(slot: HTMLDivElement) {
    if (!this.gridRoot || !this.frame) return;
    const bounds = slot.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const shell = slot.closest<HTMLElement>(".app-shell");
    if (shell) {
      this.frame.dataset.uiLayout = shell.dataset.uiLayout;
      this.frame.dataset.pocket = shell.dataset.pocket;
      this.frame.style.cssText = shell.style.cssText;
      this.gridRoot.inert = slot.closest("main")?.inert ?? false;
    }
    Object.assign(this.gridRoot.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
  }
  addPane(initialFileId?: string) {
    const canvas = document.createElement("div");
    canvas.className = "workspace-document-editor";
    const pane: Pane = { id: `pane-${++this.sequence}`, initialFileId, fileId: initialFileId, ready: false, canvas };
    this.panes = [...this.panes, pane];
    this.paneListeners.forEach(listener => listener());
    return pane;
  }
  report(pane: Pane, fileId: string, ready: boolean) {
    // During the first load the shell still holds its empty draft; reserve the requested file.
    if (!ready && pane.initialFileId) return;
    if (pane.fileId === fileId && pane.ready === ready) return;
    pane.fileId = fileId; pane.ready = ready;
    this.panes = [...this.panes];
    this.paneListeners.forEach(listener => listener());
    this.listeners.forEach(listener => listener());
    this.refreshGrid();
  }
  publishGrid(pane: Pane, grid: WorkspaceTabGroupGridProps) { pane.grid = grid; this.refreshGrid(); }
  async saveOthers(id: string, reason: "tab-switch" | "app-close"): Promise<BoundaryResult> {
    for (const pane of this.panes) {
      if (pane.id === id || !pane.ready) continue;
      const result = await pane.save?.(reason);
      if (result && (!result.ok || (result.skipped && pane.dirty?.()))) return result;
    }
    return { ok: true };
  }
  async cleanupOthers(id: string): Promise<BoundaryResult> {
    for (const pane of this.panes) {
      if (pane.id === id) continue;
      const result = await pane.cleanup?.();
      if (result && !result.ok) return result;
    }
    return { ok: true };
  }
  /** Flush before releasing a pane. Failed saves keep their controller mounted. */
  async release(pane: Pane, stillHidden: () => boolean) {
    let result: BoundaryResult | undefined;
    try { result = await pane.save?.("tab-switch"); } catch { return; }
    if (!result?.ok || (result.skipped && pane.dirty?.()) || !stillHidden()) return;
    this.panes = this.panes.filter(candidate => candidate !== pane);
    this.paneListeners.forEach(listener => listener());
    this.refreshGrid();
  }
}

const PaneContext = createContext<{ workspace: PersistentWorkspace; pane: Pane } | null>(null);
export function usePersistentWorkspacePane() {
  const context = useContext(PaneContext);
  const workspace = context?.workspace;
  useSyncExternalStore(workspace?.subscribe ?? emptySubscribe, workspace?.getLayout ?? emptySnapshot, emptySnapshot);
  // A shell reporting its loaded file can change the owner of the chrome without changing layout.
  useSyncExternalStore(workspace?.subscribePanes ?? emptySubscribe, workspace?.getPanes ?? emptySnapshot, emptySnapshot);
  return context;
}
const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export function PersistentWorkspaceEditors({ renderPane }: { renderPane: () => ReactNode }) {
  const [workspace] = useState(() => new PersistentWorkspace());
  const panes = useSyncExternalStore(workspace.subscribePanes, workspace.getPanes, workspace.getPanes);
  const layout = useSyncExternalStore(workspace.subscribe, workspace.getLayout, workspace.getLayout);
  const releasing = useRef(new Set<string>());
  useLayoutEffect(() => {
    workspace.initialize();
    return () => { workspace.disposeFrame(); };
  }, [workspace]);
  useLayoutEffect(() => {
    if (!layout || !panes.some(pane => pane.ready)) return;
    const visibleFiles = visibleDocumentFiles(layout);
    for (const fileId of visibleFiles) {
      if (!workspace.panes.some(pane => pane.fileId === fileId)) workspace.addPane(fileId);
    }
    for (const pane of panes) {
      if (!pane.ready || !pane.fileId || visibleFiles.has(pane.fileId) || releasing.current.has(pane.id)) continue;
      releasing.current.add(pane.id);
      void workspace.release(pane, () => !visibleDocumentFiles(workspace.layout).has(pane.fileId ?? ""))
        .finally(() => releasing.current.delete(pane.id));
    }
  }, [layout, panes, workspace]);
  return <>
    {panes.map(pane => <PaneProvider key={pane.id} workspace={workspace} pane={pane}>{renderPane()}</PaneProvider>)}
    <PersistentGrid workspace={workspace} />
  </>;
}
function PaneProvider({ workspace, pane, children }: { workspace: PersistentWorkspace; pane: Pane; children: ReactNode }) {
  const [value] = useState(() => ({ workspace, pane }));
  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}
function visibleDocumentFiles(layout: WorkspaceLayoutV2 | null): Set<string> {
  const files = new Set(layout?.groups.flatMap(group => {
    const tab = group.tabs.find(tab => tab.id === group.activeTabId);
    return tab?.kind === "document" ? [tab.fileId] : [];
  }) ?? []);
  // AI tabs still use the most recent document's chrome and command owner.
  if (layout?.lastDocumentFileId) files.add(layout.lastDocumentFileId);
  return files;
}
function PaneMount({ element }: { element?: HTMLDivElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (element) ref.current?.appendChild(element); }, [element]);
  return <div className="workspace-document-mount" ref={ref} />;
}
function PersistentGrid({ workspace }: { workspace: PersistentWorkspace }) {
  useSyncExternalStore(workspace.subscribeGrid, workspace.getGridRevision, workspace.getGridRevision);
  const pane = workspace.panes.find(pane => workspace.isFocused(pane.id));
  const grid = pane?.grid;
  if (!workspace.gridRoot || !grid || !workspace.layout) return null;
  return createPortal(<WorkspaceTabGroupGrid {...grid} layout={workspace.layout} activeFileId={workspace.focusedFile() ?? grid.activeFileId}
    renderDocumentPane={fileId => <PaneMount element={workspace.panes.find(pane => pane.fileId === fileId)?.canvas} />}
  >{null}</WorkspaceTabGroupGrid>, workspace.gridRoot);
}

/** The portal target stays fixed, even when the surrounding split tree or focused chrome changes. */
export function PersistentWorkspaceCanvas(props: WorkspaceTabGroupGridProps) {
  const context = usePersistentWorkspacePane();
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!context) return;
    context.workspace.publishGrid(context.pane, props);
    if (context.workspace.isFocused(context.pane.id) && slot.current) context.workspace.placeGrid(slot.current);
  });
  useLayoutEffect(() => {
    if (!context || !slot.current) return;
    const update = () => { if (context.workspace.isFocused(context.pane.id) && slot.current) context.workspace.placeGrid(slot.current); };
    const observer = new ResizeObserver(update);
    observer.observe(slot.current);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, [context]);
  if (!context) return <WorkspaceTabGroupGrid {...props} />;
  return <>
    <div ref={slot} className="workspace-persistent-grid-slot" />
    {createPortal(props.children, context.pane.canvas)}
  </>;
}

export function usePersistentPaneLifecycle(fileId: string, ready: boolean, ports: Pick<Pane, "save" | "dirty" | "cleanup" | "close">) {
  const context = usePersistentWorkspacePane();
  useLayoutEffect(() => {
    if (!context) return;
    Object.assign(context.pane, ports);
    context.workspace.report(context.pane, fileId, ready);
  });
}

export function workspacePersistenceState(layout: WorkspaceLayoutV2) {
  return { openFileIds: workspaceLayoutOpenFileIds(layout), activeFileId: layout.lastDocumentFileId, layout };
}
