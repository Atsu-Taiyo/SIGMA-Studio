"use client";

import {
  AlertTriangle,
  Building2,
  Check,
  LayoutTemplate,
  Loader2,
  RefreshCw,
  Search,
  UserRoundPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent as ReactMouseEvent } from "react";

import { Button } from "@/components/ui/Button";
import { WorkspaceJoinDialog } from "./WorkspaceJoinDialog";
import { Select } from "@/components/ui/Select";

import {
  createDocumentInWorkspace,
  createFolder,
  createWorkspace,
  deleteDocumentInWorkspace,
  deleteFolder,
  deleteWorkspace as deleteWorkspaceInRepository,
  loadWorkspacePreviewDocument,
  listWorkspaceOverview,
  moveFileToFolder,
  moveFileToWorkspace,
  updateFolder,
  type WorkspaceFileSummary,
  type WorkspaceFolderSummary,
  type WorkspaceOverview,
} from "@/lib/workspace-repository";
import { TemplateGallery } from "@/components/templates/TemplateGallery";
import { LedgerSchemaFailurePanel } from "@/components/ledger/LedgerSchemaFailurePanel";
import { createTemplateAtDestination } from "./workspace-template-commands";
import type { TemplateItem } from "@/types/template";
import { navigateToAppRoute } from "@/lib/app-navigation";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { getAppRuntime } from "@/lib/runtime";
import { resolveDocumentTitle } from "@/lib/document-title";
import type { LedgerSchemaFailure } from "@/lib/library-schema";
import { useWorkspaceViewPreference } from "@/lib/workspace-view-preferences";
import type { WorkspaceSummary } from "@/lib/runtime/types";

import {
  WorkspaceCreateContextMenu,
  WorkspaceFileActionMenu,
  WorkspaceNavContextMenu,
  type WorkspaceContextMenuState,
  type WorkspaceFileActionMenuState,
  type WorkspaceNavContextMenuState,
} from "./WorkspaceContextMenus";
import { WorkspaceContentHeader } from "./WorkspaceContentHeader";
import { WorkspaceCreateDialog, type WorkspaceCreateDialogState, type WorkspaceCreateKind } from "./WorkspaceCreateDialog";
import { WorkspaceConfirmDialog } from "./WorkspaceConfirmDialog";
import { WorkspaceDeleteDialog, type WorkspaceDeleteDialogState } from "./WorkspaceDeleteDialog";
import type { WorkspaceEmptyVariant } from "./WorkspaceEmptyState";
import { WorkspaceItemGrid } from "./WorkspaceItemGrid";
import { WorkspaceItemList } from "./WorkspaceItemList";
import { canDeleteWorkspaceItem, canMutateWorkspaceItem } from "./workspace-sharing-permissions";
import type { WorkspaceInlineRenameTarget } from "./use-inline-rename";
import { WorkspaceSharingDialog } from "./WorkspaceSharingDialog";
import { SHARED_ITEMS_WORKSPACE_ID, type LibrarySharingTarget } from "@/lib/runtime/shared-catalog";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { parseWorkspaceItemKey, type WorkspaceDragItem, type WorkspaceDropTarget } from "./workspace-drag";
import { useWorkspaceDragAndDrop } from "./use-workspace-drag-and-drop";
import { useInlineRename } from "./use-inline-rename";
import { useWorkspaceItemKeyboard } from "./use-workspace-item-keyboard";
import { useWorkspaceSelection } from "./use-workspace-selection";
import { applyPendingRenames, buildFolderPath, buildWorkspaceRows } from "./workspace-list-model";
import { resolveFileDisplayName, resolveFolderDisplayName } from "./workspace-format";
import { isInteractiveContextTarget, isSelectableItemTarget } from "./workspace-interaction";
import { enterLedgerSchemaFailure, type LedgerSchemaErrorResult } from "./workspace-overview-result";
import { useT } from "@/lib/i18n/react";
import type { Translate } from "@/lib/i18n/translator";
import { WorkspaceCollaborationAccount } from "@/features/collaboration/renderer/CollaborationAccountControl";

const ALL_FOLDERS = "all";

type FolderFilter = typeof ALL_FOLDERS | string;
type SaveStatus = "idle" | "loading" | "saving" | "error" | "saved";
type WorkspaceOverviewResult = Awaited<ReturnType<typeof listWorkspaceOverview>>;
type PendingDeleteConfirmation =
  | { kind: "folder"; folder: WorkspaceFolderSummary }
  | { kind: "file"; file: WorkspaceFileSummary }
  | { kind: "selection"; keys: string[] };

function listWorkspaceOverviewWithTimeout(
  workspaceId: string | null | undefined,
  t: Translate<"workspace">,
): Promise<WorkspaceOverviewResult> {
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      resolve({ state: "error", error: t("error.loadTimeout") });
    }, 12000);

    listWorkspaceOverview(workspaceId)
      .then((value) => resolve(value))
      .catch((error) => resolve({
        state: "error",
        error: error instanceof Error ? error.message : t("error.loadFailed"),
      }))
      .finally(() => window.clearTimeout(timeoutId));
  });
}

export function WorkspaceManager() {
  const t = useT("workspace");
  const tc = useT("chrome");

  const [joinOpen, setJoinOpen] = useState(false);
  const [sharingSelection, setSharingSelection] = useState<{ target: LibrarySharingTarget; name: string } | null>(null);
  const share = (target: LibrarySharingTarget, name: string) => {
    setContextMenu(null); setFileActionMenu(null); setWorkspaceNavContextMenu(null);
    setSharingSelection({ target, name });
  };
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null);
  const [ledgerFailure, setLedgerFailure] = useState<LedgerSchemaFailure | null>(null);
  const [folderFilter, setFolderFilter] = useState<FolderFilter>(ALL_FOLDERS);
  const [workspaceTreeExpanded, setWorkspaceTreeExpanded] = useState(false);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => new Set());
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [folderParentDraft, setFolderParentDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [status, setStatus] = useState<SaveStatus>("loading");
  // 初期値は mount 時に確定するので、**言語を切り替えてもここだけ元の言語のまま**
  // 次の状態更新まで残る (EditorShell の同種の箇所と同じ既知の割り切り)。読み込みは
  // すぐ終わって上書きされるため、実際に見えるのは一瞬。
  const [message, setMessage] = useState(t("status.loading"));
  const [savingFileId, setSavingFileId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<WorkspaceContextMenuState | null>(null);
  const [fileActionMenu, setFileActionMenu] = useState<WorkspaceFileActionMenuState | null>(null);
  const [workspaceNavContextMenu, setWorkspaceNavContextMenu] = useState<WorkspaceNavContextMenuState | null>(null);
  const menuKey = fileActionMenu ? `file:${fileActionMenu.fileId}` : workspaceNavContextMenu ? `workspace:${workspaceNavContextMenu.workspaceId}` : contextMenu?.folderId ? `folder:${contextMenu.folderId}` : null;
  const [createDialog, setCreateDialog] = useState<WorkspaceCreateDialogState | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<WorkspaceDeleteDialogState | null>(null);
  const [pendingDeleteConfirmation, setPendingDeleteConfirmation] = useState<PendingDeleteConfirmation | null>(null);
  const [pendingDeleteSaving, setPendingDeleteSaving] = useState(false);
  const [templateGalleryOpen, setTemplateGalleryOpen] = useState(false);

  useEffect(() => {
    const file = getDesktopBridge()?.file;
    if (!file?.getPendingOpenDocument || !file.onOpenDocumentAvailable) return;
    let disposed = false;
    const openEditor = async () => {
      // Leave the request unacknowledged. The editor owns validation, saving and import.
      const pending = await file.getPendingOpenDocument!();
      if (pending && !disposed) navigateToAppRoute("/");
    };
    const check = () => { void openEditor().catch(() => {}); };
    const unsubscribe = file.onOpenDocumentAvailable(check);
    check();
    return () => { disposed = true; unsubscribe(); };
  }, []);
  const [viewPreference, setViewPreference] = useWorkspaceViewPreference();
  // Owned here (not inside use-inline-rename.ts) so applyOverview can read it
  // directly: it must re-apply any still-pending optimistic rename on top of
  // EVERY incoming overview, not just the rename hook's own success path --
  // in particular the storage watcher's debounced background reload (see the
  // storage-change effect below), which can land mid-flight and would
  // otherwise revert an in-flight rename's display name for a frame.
  const pendingRenamesRef = useRef<Map<string, string>>(new Map());
  const currentWorkspaceIdRef = useRef<string | null>(null);
  const overviewRequestRef = useRef(0);

  const applyOverview = useCallback((nextOverview: WorkspaceOverview, nextMessage?: string) => {
    currentWorkspaceIdRef.current = nextOverview.activeWorkspaceId;
    setOverview(applyPendingRenames(nextOverview, pendingRenamesRef.current));
    setEditingFolderId(null);
    setFolderNameDraft("");
    setFolderParentDraft("");
    setStatus("idle");
    setMessage(nextMessage ?? t("status.ready"));
  }, [t]);

  const handleLedgerSchemaError = useCallback((
    result: WorkspaceOverviewResult,
  ): result is LedgerSchemaErrorResult => {
    if (!enterLedgerSchemaFailure(result, setLedgerFailure)) {
      return false;
    }
    setStatus("error");
    return true;
  }, []);

  const loadOverview = useCallback(async (
    workspaceId?: string | null,
    nextMessage?: string,
    options?: { silent?: boolean },
  ) => {
    const request = ++overviewRequestRef.current;
    const requestedWorkspaceId = workspaceId ?? currentWorkspaceIdRef.current;
    if (workspaceId) currentWorkspaceIdRef.current = workspaceId;
    if (!options?.silent) {
      setStatus("loading");
      setMessage(t("status.loading"));
    }
    const result = await listWorkspaceOverviewWithTimeout(requestedWorkspaceId, t);
    if (request !== overviewRequestRef.current) return;
    if (handleLedgerSchemaError(result)) {
      return;
    }
    if (result.state === "ready") {
      applyOverview(result.overview, nextMessage);
      return;
    }
    if (options?.silent) {
      return;
    }

    setStatus(result.state === "unavailable" ? "idle" : "error");
    setMessage(result.state === "unavailable"
      ? t("error.unavailable")
      : result.error);
  }, [applyOverview, handleLedgerSchemaError, t]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadOverview(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadOverview]);

  useEffect(() => {
    // 別ウィンドウ / 別タブでの構造変更 (作成・改名・移動) は library/workspace
    // イベントで届く。desktop は fs.watch、web は BroadcastChannel。
    let timeoutId: number | null = null;
    const unsubscribe = getAppRuntime().library.onChange((event) => {
      const type = (event as { type?: unknown } | null)?.type;
      if (type !== "library" && type !== "workspace") {
        return;
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void loadOverview(undefined, undefined, { silent: true });
      }, 400);
    });
    return () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      unsubscribe();
    };
  }, [loadOverview]);

  useEffect(() => {
    const catalog = getDesktopBridge()?.sharedCatalog;
    if (!catalog) return;
    const visible = () => { void catalog.setVisible(document.visibilityState !== "hidden").catch(() => {}); };
    const refresh = () => { void catalog.refresh().catch(() => {}); };
    const unsubscribe = catalog.onChange(() => { void loadOverview(undefined, undefined, { silent: true }); });
    visible();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { unsubscribe(); void catalog.setVisible(false).catch(() => {}); window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [loadOverview]);

  const activeWorkspace = useMemo(() => {
    return overview?.workspaces.find((workspace) => workspace.id === overview.activeWorkspaceId) ?? null;
  }, [overview]);
  const visibleWorkspaces = useMemo(() => overview?.workspaces ?? [], [overview]);

  const folders = useMemo(() => overview?.folders ?? [], [overview]);
  const files = useMemo(() => overview?.files ?? [], [overview]);
  const effectiveFolderFilter = folderFilter === ALL_FOLDERS ||
    folders.some((folder) => folder.id === folderFilter)
    ? folderFilter
    : ALL_FOLDERS;
  const selectedFolder = folders.find((folder) => folder.id === effectiveFolderFilter) ?? null;
  const searchActive = searchQuery.trim().length > 0;
  const emptyVariant: WorkspaceEmptyVariant = searchActive ? "search" : selectedFolder ? "folder" : "root";
  const filteredFiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      return files.filter((file) => file.title.toLowerCase().includes(query));
    }
    return files.filter((file) =>
      effectiveFolderFilter === ALL_FOLDERS ? !file.folderId : file.folderId === effectiveFolderFilter,
    );
  }, [effectiveFolderFilter, files, searchQuery]);
  const visibleFolders = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      return folders.filter((folder) => folder.name.toLowerCase().includes(query));
    }
    return folders.filter((folder) =>
      effectiveFolderFilter === ALL_FOLDERS
        ? !folder.parentFolderId
        : folder.parentFolderId === effectiveFolderFilter,
    );
  }, [effectiveFolderFilter, folders, searchQuery]);
  const rootFolders = useMemo(() => folders.filter((folder) => !folder.parentFolderId), [folders]);
  const rootFiles = useMemo(() => files.filter((file) => !file.folderId), [files]);

  const currentFolderContextId = selectedFolder?.id ?? null;
  const folderPath = buildFolderPath(folders, currentFolderContextId);
  const workspaceName = activeWorkspace?.name ?? t("nav.workspace");
  const workspaceCount = overview?.workspaces.length ?? 0;
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const renameItem = (target: WorkspaceInlineRenameTarget) => target.type === "workspace"
    ? visibleWorkspaces.find((item) => item.id === target.id)
    : target.type === "folder" ? folders.find((item) => item.id === target.id)
    : files.find((item) => item.fileId === target.id);
  const canEditItem = (item: { sharing?: import("@/lib/runtime/shared-catalog").LibrarySharingMetadata; sharingPending?: boolean } | null | undefined, capability: "rename" | "move" | "deleteDescendants" | "createChildren" | "deleteRootShare") => Boolean(item) && !item?.sharingPending && canMutateWorkspaceItem(item?.sharing, overview?.catalog, capability);
  const canDeleteItem = (item: WorkspaceFileSummary | WorkspaceFolderSummary | undefined) => {
    if (!item || item.sharingPending) return false;
    if (!item.sharing) return true;
    const parentFolderId = "fileId" in item ? item.folderId : item.parentFolderId;
    const parent = parentFolderId ? folders.find((folder) => folder.id === parentFolderId) : activeWorkspace;
    return canDeleteWorkspaceItem(item, parent, overview?.catalog);
  };
  const canCreateAt = (folderId: string | null) => folderId
    ? canEditItem(folders.find((item) => item.id === folderId), "createChildren")
    : activeWorkspaceId !== SHARED_ITEMS_WORKSPACE_ID && canEditItem(activeWorkspace, "createChildren");
  const inlineRename = useInlineRename({
    canRename: (target) => target.id !== SHARED_ITEMS_WORKSPACE_ID && canEditItem(renameItem(target), "rename"),
    isShared: (target) => Boolean(renameItem(target)?.sharing || renameItem(target)?.sharingPending),
    activeWorkspaceId,
    pendingRenamesRef,
    setOverview,
    applyOverview,
    handleLedgerSchemaError,
    setStatus,
    setMessage,
  });

  const selection = useWorkspaceSelection();

  // Unified row order for keyboard navigation and Shift-click range math.
  // WorkspaceItemGrid/WorkspaceItemList each independently rebuild the same
  // array from the same folders/files/sortKey/sortDirection inputs via the
  // same deterministic buildWorkspaceRows -- the .key order always matches
  // even though the array instances differ, so there is no need to thread
  // this array down as a prop.
  const selectionRows = useMemo(
    () => buildWorkspaceRows({
      folders: visibleFolders,
      files: filteredFiles,
      sortKey: viewPreference.sortKey,
      sortDirection: viewPreference.sortDirection,
      t,
    }),
    [visibleFolders, filteredFiles, viewPreference.sortKey, viewPreference.sortDirection, t],
  );

  // Prune (not clear) whenever the overview refreshes: an unrelated
  // rename/background sync must not blow away what the user had selected,
  // but a key pointing at a since-deleted file/folder must never remain
  // actionable.
  useEffect(() => {
    if (!overview) {
      return;
    }
    const existingKeys = new Set<string>([
      ...overview.files.map((file) => `file:${file.fileId}`),
      ...overview.folders.map((folder) => `folder:${folder.id}`),
    ]);
    selection.pruneToKeys(existingKeys);
    // selection.pruneToKeys is a stable useCallback identity; the containing
    // `selection` object is a fresh literal every render (see
    // use-workspace-selection.ts), so depending on it directly would rerun
    // this effect -- and clear/prune the selection -- on every render
    // instead of only when the overview actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, selection.pruneToKeys]);

  // A folder navigation, a search query change, or switching the active
  // workspace all change the visible row set outright, so the selection is
  // cleared rather than pruned.
  useEffect(() => {
    selection.clearSelection();
    // selection.clearSelection is a stable useCallback identity; only the
    // three inputs below should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFolderFilter, searchQuery, activeWorkspaceId]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeMenu = () => setContextMenu(null);
    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!fileActionMenu) {
      return;
    }

    const closeMenu = () => setFileActionMenu(null);
    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [fileActionMenu]);

  useEffect(() => {
    if (!workspaceNavContextMenu) {
      return;
    }

    const closeMenu = () => setWorkspaceNavContextMenu(null);
    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [workspaceNavContextMenu]);

  useEffect(() => {
    if (status !== "saved") {
      return;
    }
    const timeoutId = window.setTimeout(() => setStatus("idle"), 2600);
    return () => window.clearTimeout(timeoutId);
  }, [status, message]);

  const runWorkspaceAction = async (
    action: () => Promise<Awaited<ReturnType<typeof listWorkspaceOverview>>>,
    nextMessage: string,
  ) => {
    setStatus("saving");
    setMessage(t("status.saving"));
    const result = await action();
    if (handleLedgerSchemaError(result)) {
      return false;
    }
    if (result.state === "ready") {
      applyOverview(result.overview, nextMessage);
      setStatus("saved");
      return true;
    }

    setStatus("error");
    setMessage(result.state === "unavailable"
      ? t("error.changeFailed")
      : result.error);
    return false;
  };

  const openContextMenu = (
    event: ReactMouseEvent,
    folderId: string | null,
    options?: { allowInteractiveTarget?: boolean },
  ) => {
    if (!options?.allowInteractiveTarget && isInteractiveContextTarget(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.type === "click" ? rect.right - 224 : event.clientX;
    const y = event.type === "click" ? rect.bottom + 6 : event.clientY;
    const maxX = Math.max(12, window.innerWidth - 248);
    const maxY = Math.max(12, window.innerHeight - 280);
    setWorkspaceNavContextMenu(null);
    setFileActionMenu(null);
    setContextMenu({
      x: Math.min(Math.max(x, 12), maxX),
      y: Math.min(Math.max(y, 12), maxY),
      folderId,
    });
  };

  const openCreateMenuFromButton = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setFileActionMenu(null);
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({
      x: Math.min(Math.max(rect.left, 12), Math.max(12, window.innerWidth - 248)),
      y: Math.min(rect.bottom + 6, Math.max(12, window.innerHeight - 156)),
      folderId: currentFolderContextId,
    });
  };

  const openFileActionMenu = (event: ReactMouseEvent, file: WorkspaceFileSummary) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setWorkspaceNavContextMenu(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 224;
    const maxX = Math.max(12, window.innerWidth - menuWidth - 12);
    const maxY = Math.max(12, window.innerHeight - 212);
    setFileActionMenu({
      x: Math.min(Math.max(rect.right - menuWidth, 12), maxX),
      y: Math.min(rect.bottom + 6, maxY),
      fileId: file.fileId,
    });
  };

  const openCreateDialog = (kind: WorkspaceCreateKind, folderId: string | null) => {
    if (kind !== "workspace" && !canCreateAt(folderId)) return;
    setContextMenu(null);
    setFileActionMenu(null);
    setWorkspaceNavContextMenu(null);
    setCreateDialog({
      kind,
      folderId,
      name: kind === "folder" ? t("newFolder") : kind === "workspace" ? t("newWorkspace") : t("untitledMaterial"),
    });
  };

  const openFile = (fileId: string) => {
    navigateToAppRoute("/", { fileId });
  };

  const useTemplateInWorkspace = useCallback(async (template: TemplateItem) => {
    try {
      const target = selectedFolder ?? activeWorkspace;
      const canCreate = Boolean(activeWorkspace && target && !target.sharingPending)
        && (Boolean(selectedFolder) || activeWorkspace?.id !== SHARED_ITEMS_WORKSPACE_ID)
        && canMutateWorkspaceItem(target?.sharing, overview?.catalog, "createChildren");
      const record = await createTemplateAtDestination(template, {
        workspaceId: activeWorkspace?.id ?? "", folderId: currentFolderContextId, canCreate,
      });
      navigateToAppRoute("/", { fileId: record.metadata.fileId });
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error && error.message.includes("FORBIDDEN") ? t("error.creationNotAllowed") : error instanceof Error ? error.message : t("error.createFromTemplateFailed"));
    }
  }, [t, activeWorkspace, selectedFolder, currentFolderContextId, overview]);

  const submitCreateDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (!createDialog) {
      return;
    }

    const dialog = createDialog;
    if (dialog.kind === "workspace") {
      const created = await runWorkspaceAction(
        () => createWorkspace(dialog.name),
        t("status.workspaceCreated"),
      );
      if (created) {
        setCreateDialog(null);
        setFolderFilter(ALL_FOLDERS);
      }
      return;
    }

    if (!activeWorkspace) {
      return;
    }

    if (!canCreateAt(dialog.folderId)) return;
    const created = await runWorkspaceAction(
      () => dialog.kind === "folder"
        ? createFolder(activeWorkspace.id, dialog.name, dialog.folderId)
        : createDocumentInWorkspace(activeWorkspace.id, dialog.folderId, dialog.name),
      dialog.kind === "folder" ? t("status.folderCreated") : t("status.materialCreated"),
    );
    if (created) {
      setCreateDialog(null);
      if (dialog.kind === "document" && dialog.folderId) {
        setFolderFilter(dialog.folderId);
      }
    }
  };

  const openWorkspaceNavContextMenu = (event: ReactMouseEvent, workspaceId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setFileActionMenu(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.type === "click" ? rect.right - 224 : event.clientX;
    const y = event.type === "click" ? rect.bottom + 6 : event.clientY;
    setWorkspaceNavContextMenu({
      x: Math.min(Math.max(x, 12), Math.max(12, window.innerWidth - 224)),
      y: Math.min(Math.max(y, 12), Math.max(12, window.innerHeight - 248)),
      workspaceId,
    });
  };

  const startEditingFolder = (folder: WorkspaceFolderSummary) => {
    if (!canEditItem(folder, "rename")) return;
    setEditingFolderId(folder.id);
    setFolderNameDraft(folder.name);
    setFolderParentDraft(folder.parentFolderId ?? "");
  };

  const saveFolder = async (folder: WorkspaceFolderSummary) => {
    if (!canEditItem(folder, "rename")) return;
    if (!activeWorkspace) {
      return;
    }

    await runWorkspaceAction(
      () => updateFolder(activeWorkspace.id, folder.id, {
        name: folderNameDraft,
        parentFolderId: folderParentDraft || null,
      }),
      t("status.folderUpdated"),
    );
  };

  const removeFolder = (folder: WorkspaceFolderSummary) => {
    if (!canDeleteItem(folder)) return;
    const key = `folder:${folder.id}`;
    // If this folder is part of a broader multi-selection, "削除" deletes
    // the whole selection behind one count-based confirmation instead of
    // just this one folder.
    if (selection.selectedKeys.size > 1 && selection.selectedKeys.has(key)) {
      deleteSelection(selection.selectedKeys);
      return;
    }

    if (!activeWorkspace) {
      return;
    }

    setPendingDeleteConfirmation({ kind: "folder", folder });
  };

  const performRemoveFolder = async (folder: WorkspaceFolderSummary) => {
    if (!canDeleteItem(folders.find((current) => current.id === folder.id))) return;
    if (!activeWorkspace) {
      return;
    }
    const deleted = await runWorkspaceAction(
      () => deleteFolder(activeWorkspace.id, folder.id),
      t("status.folderDeleted"),
    );
    if (deleted && folderFilter === folder.id) {
      setFolderFilter(ALL_FOLDERS);
    }
  };

  const moveFolder = async (folderId: string, parentFolderId: string | null) => {
    if (!activeWorkspace) {
      return;
    }
    const folder = folders.find((item) => item.id === folderId);
    if (!canEditItem(folder, "move") || !canCreateAt(parentFolderId)) return;
    if (!folder || folder.parentFolderId === parentFolderId || folder.id === parentFolderId) {
      return;
    }

    await runWorkspaceAction(
      () => updateFolder(activeWorkspace.id, folder.id, { parentFolderId }),
      t("status.folderMoved"),
    );
  };

  const moveFile = async (file: WorkspaceFileSummary, folderId: string) => {
    if (!canEditItem(file, "move")) return;
    if (!activeWorkspace) {
      return;
    }

    setSavingFileId(file.fileId);
    setStatus("saving");
    setMessage(t("status.movingMaterial"));
    const result = await moveFileToFolder(activeWorkspace.id, file.fileId, folderId || null);
    setSavingFileId(null);
    if (handleLedgerSchemaError(result)) {
      return;
    }
    if (result.state === "ready") {
      applyOverview(result.overview, t("status.materialMoved"));
      setStatus("saved");
      return;
    }

    setStatus("error");
    setMessage(result.state === "unavailable"
      ? t("error.moveMaterialFailed")
      : result.error);
  };

  const moveFileToWorkspaceTarget = async (
    file: WorkspaceFileSummary,
    targetWorkspaceId: string,
    folderId: string | null = null,
    nextMessage = t("status.locationUpdated"),
  ) => {
    if (!canEditItem(file, "move")) return;
    const targetWorkspace = overview?.workspaces.find((workspace) => workspace.id === targetWorkspaceId) ?? null;
    if (!targetWorkspace) {
      setStatus("error");
      setMessage(t("error.targetWorkspaceMissing"));
      return;
    }

    setSavingFileId(file.fileId);
    setStatus("saving");
    setMessage(t("status.updatingLocation"));
    const result = await moveFileToWorkspace(file.fileId, targetWorkspace.id, folderId);
    setSavingFileId(null);
    if (handleLedgerSchemaError(result)) {
      return;
    }
    if (result.state === "ready") {
      applyOverview(result.overview, nextMessage);
      setStatus("saved");
      return;
    }

    setStatus("error");
    setMessage(result.state === "unavailable"
      ? t("error.updateLocationFailed")
      : result.error);
  };

  const openDeleteWorkspaceDialog = async (workspace: WorkspaceSummary) => {
    if (workspace.id === SHARED_ITEMS_WORKSPACE_ID || !canEditItem(workspace, "deleteRootShare")) return;
    setWorkspaceNavContextMenu(null);
    const result = await listWorkspaceOverview(workspace.id);
    if (handleLedgerSchemaError(result)) {
      return;
    }
    if (result.state !== "ready") {
      setStatus("error");
      setMessage(result.state === "unavailable"
        ? t("error.inspectWorkspaceFailed")
        : result.error);
      return;
    }
    setDeleteDialog({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      fileCount: result.overview.files.length,
      folderCount: result.overview.folders.length,
    });
  };

  const confirmDeleteWorkspace = async () => {
    if (!deleteDialog) {
      return;
    }
    if (!canEditItem(visibleWorkspaces.find((item) => item.id === deleteDialog.workspaceId), "deleteRootShare")) return;
    const deleted = await runWorkspaceAction(
      () => deleteWorkspaceInRepository(deleteDialog.workspaceId),
      t("status.workspaceDeleted"),
    );
    if (deleted) {
      setDeleteDialog(null);
      setFolderFilter(ALL_FOLDERS);
    }
  };

  const removeFile = (file: WorkspaceFileSummary) => {
    if (!canDeleteItem(file)) return;
    setFileActionMenu(null);
    const key = `file:${file.fileId}`;
    // If this file is part of a broader multi-selection, "削除" deletes the
    // whole selection behind one count-based confirmation instead of just
    // this one file.
    if (selection.selectedKeys.size > 1 && selection.selectedKeys.has(key)) {
      deleteSelection(selection.selectedKeys);
      return;
    }

    if (!activeWorkspace) {
      return;
    }

    setPendingDeleteConfirmation({ kind: "file", file });
  };

  const performRemoveFile = async (file: WorkspaceFileSummary) => {
    if (!canDeleteItem(files.find((current) => current.fileId === file.fileId))) return;
    if (!activeWorkspace) {
      return;
    }
    setSavingFileId(file.fileId);
    await runWorkspaceAction(
      () => deleteDocumentInWorkspace(activeWorkspace.id, file.fileId),
      t("status.materialDeleted"),
    );
    setSavingFileId(null);
  };

  const addFileToTemplate = async (file: WorkspaceFileSummary) => {
    setFileActionMenu(null);
    setSavingFileId(file.fileId);
    setStatus("saving");
    setMessage(t("status.addingTemplate"));
    try {
      const document = await loadWorkspacePreviewDocument(file.fileId);
      if (!document) {
        throw new Error(t("error.loadMaterialFailed"));
      }
      const templateName = file.title || resolveDocumentTitle(document, t("untitledTemplate"));
      await getAppRuntime().templates.createTemplate({
        workspaceId: file.workspaceId,
        name: templateName,
        document: {
          ...document,
          metadata: {
            ...document.metadata,
            title: resolveDocumentTitle(document, templateName),
          },
        },
      });
      setStatus("saved");
      setMessage(t("status.templateAdded"));
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : t("error.addTemplateFailed"));
    } finally {
      setSavingFileId(null);
    }
  };

  // Plain functions (not useCallback), matching every other handler in this
  // component (removeFile, moveFile, saveFolder, ...): none of these need a
  // stable identity across renders for correctness, they're only ever
  // invoked from an event. useWorkspaceSelection's returned object is also
  // a fresh literal every render, so wrapping callbacks that read its
  // fields in useCallback fights the React Compiler's memoization-
  // preservation check for no actual benefit.
  const openItemByKey = (key: string) => {
    if (key.startsWith("file:")) {
      openFile(key.slice("file:".length));
      return;
    }
    if (key.startsWith("folder:")) {
      setFolderFilter(key.slice("folder:".length));
      setSearchQuery("");
    }
  };

  const canRenameKey = (key: string) => {
    if (key.startsWith("file:")) {
      const fileId = key.slice("file:".length);
      return canEditItem(files.find((file) => file.fileId === fileId), "rename");
    }
    if (key.startsWith("folder:")) {
      const folderId = key.slice("folder:".length);
      return canEditItem(folders.find((folder) => folder.id === folderId), "rename");
    }
    return false;
  };

  const startRenameByKey = (key: string) => {
    if (key.startsWith("file:")) {
      const fileId = key.slice("file:".length);
      const file = files.find((candidate) => candidate.fileId === fileId);
      if (file) {
        inlineRename.start({ type: "file", id: file.fileId }, resolveFileDisplayName(file, t));
      }
      return;
    }
    if (key.startsWith("folder:")) {
      const folderId = key.slice("folder:".length);
      const folder = folders.find((candidate) => candidate.id === folderId);
      if (folder) {
        inlineRename.start({ type: "folder", id: folder.id }, resolveFolderDisplayName(folder));
      }
    }
  };

  // Deletes an entire multi-selection behind ONE confirmation stating the
  // count -- used by the keyboard Delete/Backspace path, and by
  // removeFile/removeFolder above when the target item is part of a >1
  // selection. Sequences the repository calls and applies only the last
  // resulting overview, mirroring moveSelection below.
  const canMutateDragItem = (item: WorkspaceDragItem, capability: "move" | "deleteDescendants") => {
    const record = item.type === "file" ? files.find((candidate) => candidate.fileId === item.fileId)
      : folders.find((candidate) => candidate.id === item.folderId);
    return capability === "deleteDescendants" ? canDeleteItem(record) : canEditItem(record, capability);
  };
  const deleteSelection = (keys: ReadonlySet<string>) => {
    if (!activeWorkspace || keys.size === 0) {
      return;
    }
    const items = Array.from(keys)
      .map((key) => parseWorkspaceItemKey(key))
      .filter((item): item is WorkspaceDragItem => item !== null);
    if (items.length === 0 || !items.every((item) => canMutateDragItem(item, "deleteDescendants"))) {
      return;
    }

    setPendingDeleteConfirmation({
      kind: "selection",
      keys: Array.from(keys).filter((key) => parseWorkspaceItemKey(key) !== null),
    });
  };

  const performDeleteSelection = async (keys: readonly string[]) => {
    if (!activeWorkspace || keys.length === 0) {
      return;
    }
    const items = keys
      .map((key) => parseWorkspaceItemKey(key))
      .filter((item): item is WorkspaceDragItem => item !== null);
    if (items.length === 0) {
      return;
    }

    setStatus("saving");
    setMessage(t("status.deleting"));
    let lastResult: WorkspaceOverviewResult | null = null;
    for (const item of items) {
      if (!canMutateDragItem(item, "deleteDescendants")) return;
      lastResult = item.type === "file"
        ? await deleteDocumentInWorkspace(activeWorkspace.id, item.fileId)
        : await deleteFolder(activeWorkspace.id, item.folderId);
      if (lastResult.state !== "ready") {
        break;
      }
    }

    if (lastResult && handleLedgerSchemaError(lastResult)) {
      return;
    }

    if (lastResult?.state === "ready") {
      applyOverview(lastResult.overview, t("status.selectionDeleted"));
      setStatus("saved");
      selection.clearSelection();
      return;
    }

    setStatus("error");
    setMessage(lastResult?.state === "error"
      ? lastResult.error
      : t("error.deleteSelectionFailed"));
  };

  const confirmPendingDelete = async () => {
    if (!pendingDeleteConfirmation || pendingDeleteSaving) {
      return;
    }

    setPendingDeleteSaving(true);
    try {
      if (pendingDeleteConfirmation.kind === "folder") {
        await performRemoveFolder(pendingDeleteConfirmation.folder);
      } else if (pendingDeleteConfirmation.kind === "file") {
        await performRemoveFile(pendingDeleteConfirmation.file);
      } else {
        await performDeleteSelection(pendingDeleteConfirmation.keys);
      }
    } finally {
      setPendingDeleteConfirmation(null);
      setPendingDeleteSaving(false);
    }
  };

  const handleKeyboardDeleteSelection = () => {
    if (selection.selectedKeys.size > 0) {
      void deleteSelection(selection.selectedKeys);
      return;
    }
    if (selection.focusedKey) {
      void deleteSelection(new Set([selection.focusedKey]));
    }
  };

  // Moves every item in a multi-selection to `target` in one drag: sequences
  // the repository calls one at a time (each returns a fresh overview) and
  // applies only the LAST resulting overview, rather than re-rendering once
  // per item. Called from useWorkspaceDragAndDrop only when the dragged
  // item is part of a >1-sized selection; single-item drags keep using
  // moveFile/moveFolder/moveFileToWorkspaceTarget below unchanged.
  const moveSelection = async (items: WorkspaceDragItem[], target: WorkspaceDropTarget) => {
    if (!activeWorkspace || !target || items.length === 0) {
      return;
    }

    if (!items.every((item) => canMutateDragItem(item, "move"))) return;
    setStatus("saving");
    setMessage(t("status.movingSelection"));
    let lastResult: WorkspaceOverviewResult | null = null;
    for (const item of items) {
      if (target === "root") {
        lastResult = item.type === "file"
          ? await moveFileToFolder(activeWorkspace.id, item.fileId, null)
          : await updateFolder(activeWorkspace.id, item.folderId, { parentFolderId: null });
      } else if (target.startsWith("folder:")) {
        const folderId = target.slice("folder:".length);
        lastResult = item.type === "file"
          ? await moveFileToFolder(activeWorkspace.id, item.fileId, folderId)
          : await updateFolder(activeWorkspace.id, item.folderId, { parentFolderId: folderId });
      } else if (target.startsWith("workspace:") && item.type === "file") {
        const targetWorkspaceId = target.slice("workspace:".length);
        lastResult = await moveFileToWorkspace(item.fileId, targetWorkspaceId, null);
      } else {
        continue;
      }
      if (lastResult.state !== "ready") {
        break;
      }
    }

    if (lastResult && handleLedgerSchemaError(lastResult)) {
      return;
    }

    if (lastResult?.state === "ready") {
      applyOverview(lastResult.overview, t("status.selectionMoved"));
      setStatus("saved");
      return;
    }

    setStatus("error");
    setMessage(lastResult?.state === "error"
      ? lastResult.error
      : t("error.moveSelectionFailed"));
  };

  const itemKeyboardHandler = useWorkspaceItemKeyboard({
    rows: selectionRows,
    layout: viewPreference.mode,
    anchorKey: selection.anchorKey,
    onFocusKey: selection.setFocusedKey,
    onReplaceSelection: selection.replaceSelection,
    onSelectOnly: selection.selectOnly,
    onClearSelection: selection.clearSelection,
    onOpen: openItemByKey,
    onStartRename: startRenameByKey,
    canRename: canRenameKey,
    onDeleteSelection: handleKeyboardDeleteSelection,
  });

  const dragDrop = useWorkspaceDragAndDrop({
    canMoveItem: (item) => canMutateDragItem(item, "move"),
    canReceive: (target) => target === "root" ? canCreateAt(null)
      : target?.startsWith("folder:") ? canCreateAt(target.slice(7))
      : target?.startsWith("workspace:") ? target.slice(10) !== SHARED_ITEMS_WORKSPACE_ID && canEditItem(visibleWorkspaces.find((item) => item.id === target.slice(10)), "createChildren") : false,
    folders,
    files,
    workspaces: overview?.workspaces ?? [],
    hasActiveWorkspace: Boolean(activeWorkspace),
    selectedKeys: selection.selectedKeys,
    onMoveFile: moveFile,
    onMoveFolder: moveFolder,
    onMoveFileToWorkspace: moveFileToWorkspaceTarget,
    onMoveSelection: moveSelection,
  });

  if (ledgerFailure) {
    return (
      <div className="workspace-page-shell">
        <LedgerSchemaFailurePanel
          failure={ledgerFailure}
          onReload={() => {
            setLedgerFailure(null);
            void loadOverview();
          }}
        />
      </div>
    );
  }

  return (
    <div className="workspace-page-shell">
      <header className="workspace-page-header">
        <div className="workspace-page-brand">
          <div className="workspace-brand-mark" aria-hidden="true">Σ</div>
          <h1>Sigma Studio</h1>
        </div>
        <label className="workspace-search">
          <Search size={16} />
          <input
            aria-label={t("search.material")}
            value={searchQuery}
            placeholder={t("search.placeholder")}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchActive && (
            <button
              type="button"
              className="workspace-search-clear"
              aria-label={t("search.clear")}
              onClick={() => setSearchQuery("")}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <div className="workspace-page-actions">
          {overview?.catalog && <Button size="sm" tone="ghost" onClick={() => setJoinOpen(true)}><UserRoundPlus size={15} />{tc("collaboration.join")}</Button>}
          <button
            type="button"
            className="workspace-template-button"
            title={t("action.openTemplateGallery")}
            aria-label={t("action.openTemplateGallery")}
            onClick={() => setTemplateGalleryOpen(true)}
          >
            <LayoutTemplate size={15} />
            <span>{t("action.templatesShort")}</span>
          </button>
          <button
            type="button"
            className="workspace-reload-button"
            title={t("action.reload")}
            aria-label={t("action.reload")}
            onClick={() => void loadOverview(undefined, t("status.reloaded"))}
          >
            <RefreshCw size={15} />
            <span>{t("action.reloadShort")}</span>
          </button>
          <WorkspaceCollaborationAccount />
        </div>
      </header>

      <TemplateGallery
        open={templateGalleryOpen}
        onClose={() => setTemplateGalleryOpen(false)}
        mode="use"
        activeWorkspaceId={activeWorkspace?.id ?? null}
        onUse={useTemplateInWorkspace}
      />

      {!overview ? (
        status === "loading" ? (
          <main className="workspace-page-main workspace-page-skeleton" role="status" aria-label={message}>
            <aside className="workspace-sidebar" aria-hidden="true">
              <span className="shimmer-block" style={{ width: "118px", height: "44px", borderRadius: "999px" }} />
              <span className="shimmer-line" style={{ width: "52%" }} />
              <span className="shimmer-block" style={{ height: "36px" }} />
              <span className="shimmer-block" style={{ height: "36px" }} />
            </aside>
            <section className="workspace-content" aria-hidden="true">
              <span className="shimmer-line" style={{ width: "200px" }} />
              <div className="workspace-skeleton-cards">
                {[0, 1, 2, 3, 4, 5].map((index) => (
                  <span className="shimmer-block" style={{ height: "148px", borderRadius: "14px" }} key={index} />
                ))}
              </div>
            </section>
          </main>
        ) : (
          <main className="workspace-page-empty" aria-live="polite">
            <Building2 size={28} />
            <h2>{message}</h2>
          </main>
        )
      ) : (
        <main className="workspace-page-main">
          <WorkspaceSidebar
            menuKey={menuKey}
            visibleWorkspaces={visibleWorkspaces}
            activeWorkspaceId={overview.activeWorkspaceId}
            workspaceTreeExpanded={workspaceTreeExpanded}
            setWorkspaceTreeExpanded={setWorkspaceTreeExpanded}
            expandedFolderIds={expandedFolderIds}
            setExpandedFolderIds={setExpandedFolderIds}
            folders={folders}
            files={files}
            rootFolders={rootFolders}
            rootFiles={rootFiles}
            effectiveFolderFilter={effectiveFolderFilter}
            setFolderFilter={setFolderFilter}
            setSearchQuery={setSearchQuery}
            dropTarget={dragDrop.dropTarget}
            dropProps={dragDrop.dropProps}
            onNewButtonClick={openCreateMenuFromButton}
            onSwitchWorkspace={(workspaceId) => void loadOverview(workspaceId)}
            onWorkspaceContextMenu={openWorkspaceNavContextMenu}
            onFolderContextMenu={(event, folderId) => openContextMenu(event, folderId, { allowInteractiveTarget: true })}
            onFileContextMenu={openFileActionMenu}
            onOpenFile={openFile}
            isRenameEditing={inlineRename.isEditing}
            onStartRename={inlineRename.start}
            onCommitRename={inlineRename.commit}
            onCancelRename={inlineRename.cancel}
          />

          <section
            className={`workspace-content ${dragDrop.dropTarget === "root" ? "drop-active" : ""}`}
            aria-label={t("nav.workspaceManagement")}
            onContextMenu={(event) => openContextMenu(event, currentFolderContextId)}
            onClick={(event) => {
              // Clicking empty space (background, group gaps, the header
              // area) clears the selection; clicks that land on an actual
              // file/folder card or list row are handled by that item's own
              // onClick instead.
              if (!isSelectableItemTarget(event.target)) {
                selection.clearSelection();
              }
            }}
            {...dragDrop.dropProps("root")}
          >
            {overview.catalog?.state === "offline" && (activeWorkspace?.sharing || activeWorkspaceId === SHARED_ITEMS_WORKSPACE_ID) && <p role="status">{tc("collaboration.offlineHierarchy")}</p>}
            <WorkspaceContentHeader
              canEditFolder={canEditItem(selectedFolder, "rename") && canEditItem(selectedFolder, "move")}
              canDeleteFolder={canDeleteItem(selectedFolder ?? undefined)}
              workspaceName={workspaceName}
              folderPath={folderPath}
              selectedFolder={selectedFolder}
              searchActive={searchActive}
              dropTarget={dragDrop.dropTarget}
              dropProps={dragDrop.dropProps}
              onNavigateRoot={() => {
                setFolderFilter(ALL_FOLDERS);
                setSearchQuery("");
              }}
              onNavigateFolder={(folderId) => {
                setFolderFilter(folderId);
                setSearchQuery("");
              }}
              viewMode={viewPreference.mode}
              onViewModeChange={(mode) => setViewPreference({ mode })}
              onEditFolder={() => selectedFolder && startEditingFolder(selectedFolder)}
              onDeleteFolder={() => selectedFolder && void removeFolder(selectedFolder)}
            />

            {selectedFolder && editingFolderId === selectedFolder.id && (
              <div className="folder-edit-row">
                <input
                  aria-label={t("label.folderName")}
                  value={folderNameDraft}
                  onChange={(event) => setFolderNameDraft(event.target.value)}
                />
                <Select
                  aria-label={t("label.parentFolder")}
                  value={folderParentDraft}
                  options={[
                    { value: "", label: t("label.folderRoot") },
                    ...folders
                      .filter((folder) => folder.id !== selectedFolder.id)
                      .map((folder) => ({ value: folder.id, label: folder.name })),
                  ]}
                  onChange={setFolderParentDraft}
                />
                <button type="button" className="button primary" onClick={() => void saveFolder(selectedFolder)}>
                  {t("action.save")}
                </button>
                <button type="button" className="button secondary" onClick={() => setEditingFolderId(null)}>
                  {t("action.cancel")}
                </button>
              </div>
            )}

            {viewPreference.mode === "grid" ? (
              <WorkspaceItemGrid
            menuKey={menuKey}
                folders={visibleFolders}
                files={filteredFiles}
                sortKey={viewPreference.sortKey}
                sortDirection={viewPreference.sortDirection}
                emptyVariant={emptyVariant}
                dragItem={dragDrop.dragItem}
                dropTarget={dragDrop.dropTarget}
                dragProps={dragDrop.dragProps}
                dropProps={dragDrop.dropProps}
                selectedKeys={selection.selectedKeys}
                focusedKey={selection.focusedKey}
                onItemClick={(event, key, rows) => selection.handleItemClick(event, key, rows)}
                onItemKeyDown={itemKeyboardHandler}
                onOpenFolder={(folderId) => {
                  setFolderFilter(folderId);
                  setSearchQuery("");
                }}
                onFolderContextMenu={(event, folderId) => openContextMenu(event, folderId, { allowInteractiveTarget: true })}
                onOpenFile={openFile}
                savingFileId={savingFileId}
                saving={status === "saving"}
                fileActionMenuFileId={fileActionMenu?.fileId ?? null}
                onOpenFileActionMenu={openFileActionMenu}
                canCreate={canCreateAt(currentFolderContextId)}
                canMove={(kind, id) => canMutateDragItem(kind === "file" ? { type: "file", fileId: id } : { type: "folder", folderId: id }, "move")}
                onCreateDocument={() => openCreateDialog("document", currentFolderContextId)}
                onClearSearch={() => setSearchQuery("")}
                isRenameEditing={inlineRename.isEditing}
                onCommitRename={inlineRename.commit}
                onCancelRename={inlineRename.cancel}
              />
            ) : (
              <WorkspaceItemList
            menuKey={menuKey}
                folders={visibleFolders}
                files={filteredFiles}
                allFolders={folders}
                workspaceName={workspaceName}
                sortKey={viewPreference.sortKey}
                sortDirection={viewPreference.sortDirection}
                onRequestSort={(sortKey, sortDirection) => setViewPreference({ sortKey, sortDirection })}
                searchActive={searchActive}
                emptyVariant={emptyVariant}
                dragItem={dragDrop.dragItem}
                dropTarget={dragDrop.dropTarget}
                dragProps={dragDrop.dragProps}
                dropProps={dragDrop.dropProps}
                selectedKeys={selection.selectedKeys}
                focusedKey={selection.focusedKey}
                onItemClick={(event, key, rows) => selection.handleItemClick(event, key, rows)}
                onItemKeyDown={itemKeyboardHandler}
                onOpenFolder={(folderId) => {
                  setFolderFilter(folderId);
                  setSearchQuery("");
                }}
                onFolderContextMenu={(event, folderId) => openContextMenu(event, folderId, { allowInteractiveTarget: true })}
                onOpenFile={openFile}
                savingFileId={savingFileId}
                saving={status === "saving"}
                fileActionMenuFileId={fileActionMenu?.fileId ?? null}
                onOpenFileActionMenu={openFileActionMenu}
                canCreate={canCreateAt(currentFolderContextId)}
                canMove={(kind, id) => canMutateDragItem(kind === "file" ? { type: "file", fileId: id } : { type: "folder", folderId: id }, "move")}
                onCreateDocument={() => openCreateDialog("document", currentFolderContextId)}
                onClearSearch={() => setSearchQuery("")}
                isRenameEditing={inlineRename.isEditing}
                onCommitRename={inlineRename.commit}
                onCancelRename={inlineRename.cancel}
              />
            )}

          </section>
        </main>
      )}
      {overview && status !== "idle" && (
        <div className={`workspace-status-toast ${status}`} role="status" aria-live="polite">
          {status === "loading" || status === "saving"
            ? <Loader2 className="workspace-spin" size={15} />
            : status === "error"
              ? <AlertTriangle size={15} />
              : <Check size={15} />}
          <span>{message}</span>
        </div>
      )}
      {workspaceNavContextMenu && (() => {
        const workspace = visibleWorkspaces.find((candidate) => candidate.id === workspaceNavContextMenu.workspaceId);
        if (!workspace) {
          return null;
        }
        const targetIsActive = workspace.id === activeWorkspace?.id;
        const isLastWorkspace = workspaceCount <= 1;
        const deleteDisabled = isLastWorkspace;
        const deleteDisabledReason = isLastWorkspace
          ? t("error.lastWorkspace")
          : null;
        return (
          <WorkspaceNavContextMenu
            menu={workspaceNavContextMenu}
            workspace={workspace}
            canRename={workspace.id !== SHARED_ITEMS_WORKSPACE_ID && canEditItem(workspace, "rename")}
            canDelete={workspace.id !== SHARED_ITEMS_WORKSPACE_ID && canEditItem(workspace, "deleteRootShare")}
            canCreate={workspace.id !== SHARED_ITEMS_WORKSPACE_ID && canEditItem(workspace, "createChildren")}
            targetIsActive={targetIsActive}
            onShare={workspace.id === SHARED_ITEMS_WORKSPACE_ID ? undefined : () => share(workspace.sharing
              ? { source: "shared", shared: workspace.sharing.target }
              : { source: "local", local: { kind: "workspace", workspaceId: workspace.id } }, workspace.name)}
            saving={status === "saving"}
            deleteDisabled={deleteDisabled}
            deleteDisabledReason={deleteDisabledReason}
            onRename={() => {
              setWorkspaceNavContextMenu(null);
              inlineRename.start({ type: "workspace", id: workspace.id }, workspace.name);
            }}
            onCreateFolder={() => openCreateDialog("folder", null)}
            onCreateDocument={() => openCreateDialog("document", null)}
            onDelete={() => void openDeleteWorkspaceDialog(workspace)}
          />
        );
      })()}
      {fileActionMenu && (() => {
        const file = files.find((candidate) => candidate.fileId === fileActionMenu.fileId);
        if (!file) {
          return null;
        }
        const busy = savingFileId === file.fileId;
        return (
          <WorkspaceFileActionMenu
            menu={fileActionMenu}
            file={file}
            canRename={canEditItem(file, "rename")}
            canDelete={canDeleteItem(file)}
            onShare={() => share(file.sharing ? { source: "shared", shared: file.sharing.target }
              : { source: "local", local: { kind: "document", fileId: file.fileId } }, resolveFileDisplayName(file, t))}
            busy={busy}
            saving={status === "saving"}
            onRename={() => {
              setFileActionMenu(null);
              inlineRename.start({ type: "file", id: file.fileId }, resolveFileDisplayName(file, t));
            }}
            onAddToTemplate={() => void addFileToTemplate(file)}
            onDelete={() => void removeFile(file)}
          />
        );
      })()}
      {contextMenu && (
        <WorkspaceCreateContextMenu
          menu={contextMenu}
          canRename={canEditItem(folders.find((item) => item.id === contextMenu.folderId), "rename")}
          canDelete={canDeleteItem(folders.find((item) => item.id === contextMenu.folderId))}
          canCreate={canCreateAt(contextMenu.folderId)}
          onShare={contextMenu.folderId ? () => {
            const folder = folders.find((candidate) => candidate.id === contextMenu.folderId);
            if (folder && activeWorkspaceId) share(folder.sharing ? { source: "shared", shared: folder.sharing.target }
              : { source: "local", local: { kind: "folder", workspaceId: activeWorkspaceId, folderId: folder.id } }, folder.name);
          } : undefined}
          onCreateFolder={(folderId) => openCreateDialog("folder", folderId)}
          onCreateDocument={(folderId) => openCreateDialog("document", folderId)}
          onCreateWorkspace={() => openCreateDialog("workspace", null)}
          onRenameFolder={(folderId) => {
            const folder = folders.find((candidate) => candidate.id === folderId);
            setContextMenu(null);
            if (folder) {
              inlineRename.start({ type: "folder", id: folder.id }, resolveFolderDisplayName(folder));
            }
          }}
          onDeleteFolder={(folderId) => {
            const folder = folders.find((candidate) => candidate.id === folderId);
            setContextMenu(null);
            if (folder) {
              void removeFolder(folder);
            }
          }}
        />
      )}
      {joinOpen && <WorkspaceJoinDialog onClose={() => setJoinOpen(false)} onJoined={(result) => {
        setJoinOpen(false); setSearchQuery(""); setFolderFilter(result.folderId ?? ALL_FOLDERS);
        setWorkspaceTreeExpanded(true); if (result.folderId) setExpandedFolderIds(new Set([result.folderId]));
        void loadOverview(result.workspaceId);
      }} />}
      {sharingSelection && <WorkspaceSharingDialog target={sharingSelection.target} name={sharingSelection.name}
        onClose={() => setSharingSelection(null)} onChanged={() => void loadOverview(activeWorkspaceId ?? undefined)} />}
      {createDialog && (
        <WorkspaceCreateDialog
          dialog={createDialog}
          folders={folders}
          saving={status === "saving"}
          onNameChange={(name) => setCreateDialog({ ...createDialog, name })}
          onSubmit={(event) => void submitCreateDialog(event)}
          onClose={() => setCreateDialog(null)}
        />
      )}
      {deleteDialog && (
        <WorkspaceDeleteDialog
          dialog={deleteDialog}
          saving={status === "saving"}
          onConfirm={() => void confirmDeleteWorkspace()}
          onClose={() => setDeleteDialog(null)}
        />
      )}
      {pendingDeleteConfirmation && (
        <WorkspaceConfirmDialog
          title={pendingDeleteConfirmation.kind === "folder"
            ? t("action.deleteFolder")
            : pendingDeleteConfirmation.kind === "file"
              ? t("action.deleteMaterial")
              : t("action.deleteSelected")}
          itemLabel={pendingDeleteConfirmation.kind === "folder"
            ? pendingDeleteConfirmation.folder.name
            : pendingDeleteConfirmation.kind === "file"
              ? resolveFileDisplayName(pendingDeleteConfirmation.file, t)
              : t("label.itemCount", { count: pendingDeleteConfirmation.keys.length })}
          warning={t("confirm.deleteWarning")}
          confirmLabel={t("action.delete")}
          saving={pendingDeleteSaving}
          onConfirm={() => void confirmPendingDelete()}
          onClose={() => setPendingDeleteConfirmation(null)}
        />
      )}
    </div>
  );
}
