"use client";

import { ChevronRight, FileText, Folder, FolderOpen, LayoutGrid, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { IconButton } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { DocumentTitleText } from "@/features/rendering/adapters/react";
import { useT } from "@/lib/i18n/react";
import { getAppRuntime, type WorkspaceSummary } from "@/lib/runtime";
import type { DocumentMetadata } from "@/lib/storage";
import {
  listWorkspaceOverview,
  type WorkspaceFolderSummary,
  type WorkspaceFileSummary,
} from "@/lib/workspace-repository";
import {
  ancestorFolderIds,
  buildFileTree,
  flattenVisibleRows,
  searchFiles,
  type FileTreeRow,
} from "../model/files-tree-model";
import styles from "./FilesPanel.module.css";

export interface FilesPanelProps {
  /** 全教材のメタデータ。保存のたびに更新されるので、題名はここの最新値を優先して出す。 */
  documents: readonly DocumentMetadata[];
  activeFileId: string;
  openFileIds: readonly string[];
  onOpenFile(fileId: string): void;
  onOpenWorkspaces(): void;
}

interface Loaded {
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  folders: WorkspaceFolderSummary[];
  files: WorkspaceFileSummary[];
}

type LoadState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: Loaded };

/**
 * サイドバーの「ファイル」。ワークスペース内のフォルダと教材を木で見せ、名前で絞り込み、
 * 押した教材を開く。教材を開く処理・保存・切り替えの確認は EditorShell に任せる。
 */
export function FilesPanel({ documents, activeFileId, openFileIds, onOpenFile, onOpenWorkspaces }: FilesPanelProps) {
  const t = useT("chrome");
  const tWorkspace = useT("workspace");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const restoreSearchFocusRef = useRef(false);
  // フォルダの開閉。利用者が操作したものだけを持ち、操作していないものは「開いている教材までの道」を開く。
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  // 見ているワークスペース。未選択なら、開いている教材のあるワークスペースを見せる。
  const [chosenWorkspaceId, setChosenWorkspaceId] = useState<string | null>(null);
  const requestRef = useRef(0);
  const activeWorkspaceId = documents.find((document) => document.fileId === activeFileId)?.workspaceId ?? null;
  const workspaceId = chosenWorkspaceId ?? activeWorkspaceId;

  const load = useCallback(async (silent: boolean) => {
    const request = ++requestRef.current;
    try {
      const result = await listWorkspaceOverview(workspaceId);
      if (request !== requestRef.current) return;
      if (result.state !== "ready") {
        setState((current) => (silent && current.kind === "ready" ? current : { kind: "error" }));
        return;
      }
      const { overview } = result;
      setState({
        kind: "ready",
        data: {
          workspaces: overview.workspaces,
          workspaceId: overview.activeWorkspaceId,
          folders: overview.folders,
          files: overview.files,
        },
      });
    } catch {
      if (request === requestRef.current) setState((current) => (silent && current.kind === "ready" ? current : { kind: "error" }));
    }
  }, [workspaceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadはawait後にsetStateする非同期関数
    void load(false);
  }, [load]);

  const reload = () => {
    setState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    void load(false);
  };
  const chooseWorkspace = (id: string) => {
    setState({ kind: "loading" });
    setChosenWorkspaceId(id);
  };

  // 別の操作 (作成・改名・移動・削除) は保存先の変更通知で届く。
  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = getAppRuntime().library.onChange((event) => {
      const type = (event as { type?: unknown } | null)?.type;
      if (type !== "library" && type !== "workspace") return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(true), 400);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  // 教材の増減 (教材メタデータの変化) にも追従する。題名だけの変更は下の titleById で足りる。
  const documentCount = documents.length;
  const countSeenRef = useRef(documentCount);
  useEffect(() => {
    if (countSeenRef.current === documentCount) return;
    countSeenRef.current = documentCount;
    void load(true);
  }, [documentCount, load]);

  const data = state.kind === "ready" ? state.data : null;
  const titleById = useMemo(() => new Map(documents.map((document) => [document.fileId, document.title])), [documents]);
  const tree = useMemo(() => {
    if (!data) return [];
    return buildFileTree(
      data.folders,
      data.files.map((file) => ({ fileId: file.fileId, folderId: file.folderId, title: titleById.get(file.fileId) ?? file.title })),
      tWorkspace("untitledMaterial"),
    );
  }, [data, titleById, tWorkspace]);

  const expanded = useMemo(() => {
    const open = new Set<string>();
    const active = data?.files.find((file) => file.fileId === activeFileId);
    if (data && active) for (const id of ancestorFolderIds(data.folders, active.folderId)) open.add(id);
    for (const [id, value] of toggled) {
      if (value) open.add(id);
      else open.delete(id);
    }
    return open;
  }, [activeFileId, data, toggled]);

  const searching = query.trim().length > 0;
  const rows: FileTreeRow[] = useMemo(
    () => (searching ? searchFiles(tree, query) : flattenVisibleRows(tree, expanded)),
    [expanded, query, searching, tree],
  );

  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
  };

  // 開いた直後は入力欄へ、キーボードで閉じたときは虫眼鏡のボタンへ焦点を渡す。
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus({ preventScroll: true });
    } else if (restoreSearchFocusRef.current) {
      restoreSearchFocusRef.current = false;
      searchToggleRef.current?.focus({ preventScroll: true });
    }
  }, [searchOpen]);

  const toggleFolder = (id: string) => setToggled((current) => new Map(current).set(id, !expanded.has(id)));

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-tree-item]")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.workspaceRow}>
          {data && (
            <Select
              className={styles.workspaceSelect}
              aria-label={t("rightDock.files.workspace")}
              value={data.workspaceId}
              onChange={chooseWorkspace}
              options={data.workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
            />
          )}
          {!data && <span className={`shimmer-line ${styles.workspaceSkeleton}`} aria-hidden="true" />}
          {/* 検索は虫眼鏡のアイコンだけを置き、押すと空いている幅いっぱいに広がる。 */}
          <div className={styles.search} data-open={searchOpen || undefined}>
            {searchOpen ? (
              <div className={styles.searchField}>
                <Search size={14} className={styles.searchIcon} aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  type="search"
                  className={styles.searchInput}
                  value={query}
                  aria-label={t("rightDock.files.searchLabel")}
                  placeholder={t("rightDock.files.searchPlaceholder")}
                  onChange={(event) => setQuery(event.target.value)}
                  // 絞り込み中はそのまま開いておく。空のまま離れたときだけ、アイコンへ畳む。
                  onBlur={() => {
                    if (!query.trim()) closeSearch();
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.stopPropagation();
                    if (query) {
                      setQuery("");
                    } else {
                      restoreSearchFocusRef.current = true;
                      closeSearch();
                    }
                  }}
                />
                <IconButton label={t("rightDock.files.closeSearch")} tone="ghost" size="sm" onClick={closeSearch}>
                  <X size={14} aria-hidden="true" />
                </IconButton>
              </div>
            ) : (
              <IconButton
                ref={searchToggleRef}
                label={t("rightDock.files.searchLabel")}
                tone="ghost"
                size="sm"
                aria-expanded={false}
                onClick={() => setSearchOpen(true)}
              >
                <Search size={14} aria-hidden="true" />
              </IconButton>
            )}
          </div>
          <IconButton label={t("rightDock.files.refresh")} tone="ghost" size="sm" onClick={reload}>
            <RefreshCw size={14} aria-hidden="true" />
          </IconButton>
          <IconButton label={t("rightDock.files.openWorkspaces")} tone="ghost" size="sm" onClick={onOpenWorkspaces}>
            <LayoutGrid size={14} aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      {state.kind === "loading" && (
        <div className={styles.skeleton} aria-hidden="true">
          {[72, 58, 84, 64, 76].map((width, index) => (
            <span key={index} className="shimmer-line" style={{ width: `${width}%` }} />
          ))}
        </div>
      )}
      {state.kind === "error" && (
        <div className={styles.state} role="alert">
          <span>{t("rightDock.files.loadFailed")}</span>
          <button type="button" className="button" onClick={reload}>{t("rightDock.files.retry")}</button>
        </div>
      )}
      {data && rows.length === 0 && (
        <div className={styles.state}>{searching ? t("rightDock.files.noResults") : t("rightDock.files.empty")}</div>
      )}
      {data && rows.length > 0 && (
        <ul className={styles.list} role="tree" aria-label={t("rightDock.files.list")} onKeyDown={onListKeyDown}>
          {rows.map(({ node, depth }) => {
            const style = { "--depth": depth } as React.CSSProperties;
            if (node.kind === "folder") {
              const open = expanded.has(node.id);
              return (
                <li key={`folder:${node.id}`} role="none">
                  <button
                    type="button"
                    role="treeitem"
                    aria-expanded={open}
                    aria-selected={false}
                    aria-label={open ? t("rightDock.files.collapseFolder", { name: node.name }) : t("rightDock.files.expandFolder", { name: node.name })}
                    data-tree-item=""
                    className={styles.row}
                    style={style}
                    onClick={() => toggleFolder(node.id)}
                  >
                    <ChevronRight size={13} className={styles.chevron} data-open={open} aria-hidden="true" />
                    {open ? <FolderOpen size={15} className={styles.icon} aria-hidden="true" /> : <Folder size={15} className={styles.icon} aria-hidden="true" />}
                    <span className={styles.label}><span className={styles.title}>{node.name}</span></span>
                    <span className={styles.count}>{node.fileCount}</span>
                  </button>
                </li>
              );
            }
            const isActive = node.id === activeFileId;
            const isOpen = openFileIds.includes(node.id);
            return (
              <li key={`file:${node.id}`} role="none">
                <button
                  type="button"
                  role="treeitem"
                  aria-selected={isActive}
                  aria-current={isActive ? "true" : undefined}
                  aria-label={t("rightDock.files.open", { title: node.title })}
                  data-tree-item=""
                  className={styles.row}
                  style={style}
                  onClick={() => onOpenFile(node.id)}
                >
                  {searching ? null : <span style={{ width: 13 }} aria-hidden="true" />}
                  <FileText size={15} className={styles.icon} aria-hidden="true" />
                  <span className={styles.label}>
                    <span className={styles.title}><DocumentTitleText title={node.title} /></span>
                    {searching && node.folderPath.length > 0 && <span className={styles.path}>{node.folderPath.join(" / ")}</span>}
                  </span>
                  {isActive ? <span className={styles.badge}>{t("rightDock.files.editing")}</span> : isOpen ? <span className={styles.badge}>{t("rightDock.files.openInTab")}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
