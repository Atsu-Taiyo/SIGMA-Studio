"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  Check,
  Loader2,
  PenLine,
  PlusCircle,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { PrintPreviewThumbnail } from "@/components/print/PrintPreview";
import { getAppRuntime } from "@/lib/runtime";
import { listWorkspaceOverview } from "@/lib/workspace-repository";
import type { SigmaDocument } from "@/features/document";
import type { TemplateItem } from "@/types/template";
import { useT } from "@/lib/i18n/react";
import type { Translate } from "@/lib/i18n/translator";

interface WorkspaceTab {
  id: string;
  name: string;
}

export interface TemplateGalleryProps {
  open: boolean;
  onClose: () => void;
  /** "insert" merges the template into the open document; "use" spins up a new document. */
  mode: "insert" | "use";
  /** Workspace tab to open on first render (defaults to the first participating workspace). */
  activeWorkspaceId?: string | null;
  /** The document offered for "save as template" — only used in insert mode. */
  currentDocument?: SigmaDocument | null;
  onInsert?: (template: TemplateItem) => void;
  onUse?: (template: TemplateItem) => void | Promise<void>;
}

export function TemplateGallery({
  open,
  onClose,
  mode,
  activeWorkspaceId,
  currentDocument,
  onInsert,
  onUse,
}: TemplateGalleryProps) {
  const t = useT("workspace");

  const [workspaces, setWorkspaces] = useState<WorkspaceTab[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(activeWorkspaceId ?? null);
  // Holds templates across ALL participating workspaces so search can span them.
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [busy, setBusy] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const resetTransientState = useCallback(() => {
    setSearch("");
    setSearchOpen(false);
    setEditingId(null);
    setEditingName("");
    setError(null);
  }, []);

  const toggleSearch = useCallback(() => {
    setSearchOpen((isOpen) => {
      if (isOpen) {
        setSearch("");
      }
      return !isOpen;
    });
  }, []);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  const closeGallery = useCallback(() => {
    resetTransientState();
    onClose();
  }, [onClose, resetTransientState]);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await listWorkspaceOverview(activeWorkspaceId ?? undefined);
      if (cancelled) {
        return;
      }
      if (result.state === "ready") {
        const tabs = result.overview.workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
        }));
        setWorkspaces(tabs);
        setSelectedWorkspaceId((current) => {
          if (current && tabs.some((tab) => tab.id === current)) {
            return current;
          }
          if (activeWorkspaceId && tabs.some((tab) => tab.id === activeWorkspaceId)) {
            return activeWorkspaceId;
          }
          return result.overview.activeWorkspaceId || tabs[0]?.id || null;
        });
      } else {
        setWorkspaces([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeWorkspaceId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    void (async () => {
      if (!cancelled) {
        setLoading(true);
      }
      try {
        const next = await getAppRuntime().templates.listTemplates();
        if (!cancelled) {
          setTemplates(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("template.loadFailed"));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  const workspaceNameById = useCallback(
    (id: string) => workspaces.find((workspace) => workspace.id === id)?.name ?? "",
    [workspaces],
  );

  const searchActive = search.trim().length > 0;

  const visibleTemplates = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      // No search → show only the selected workspace's templates.
      return templates.filter((template) => template.workspaceId === selectedWorkspaceId);
    }
    // Searching spans every workspace and matches template or workspace name.
    return templates.filter((template) =>
      template.name.toLowerCase().includes(query) ||
      workspaceNameById(template.workspaceId).toLowerCase().includes(query),
    );
  }, [templates, search, selectedWorkspaceId, workspaceNameById]);

  const saveCurrentAsTemplate = useCallback(async () => {
    if (!selectedWorkspaceId) {
      setError(t("template.selectWorkspace"));
      return;
    }
    if (!currentDocument) {
      setError(t("template.noDocument"));
      return;
    }

    const name = currentDocument.metadata.title || t("untitledTemplate");
    setBusy(true);
    try {
      const template = await getAppRuntime().templates.createTemplate({
        workspaceId: selectedWorkspaceId,
        name,
        document: currentDocument,
      });
      setTemplates((current) => [template, ...current.filter((item) => item.id !== template.id)]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("template.saveFailed"));
    } finally {
      setBusy(false);
    }
  }, [selectedWorkspaceId, currentDocument, t]);

  const renameTemplate = useCallback(async (template: TemplateItem) => {
    const name = editingName.trim();
    if (!name) {
      return;
    }
    setBusy(true);
    try {
      const next = await getAppRuntime().templates.renameTemplate(template.id, name);
      setTemplates((current) => current.map((item) => (item.id === next.id ? next : item)));
      setEditingId(null);
      setEditingName("");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("template.renameFailed"));
    } finally {
      setBusy(false);
    }
  }, [editingName, t]);

  const deleteTemplate = useCallback(async (template: TemplateItem) => {
    setBusy(true);
    try {
      const result = await getAppRuntime().templates.deleteTemplate(template.id);
      if (!result.ok) {
        throw new Error(result.error ?? t("template.deleteFailed"));
      }
      setTemplates((current) => current.filter((item) => item.id !== template.id));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("template.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const applyTemplate = useCallback(async (template: TemplateItem) => {
    if (mode === "insert") {
      onInsert?.(template);
    } else {
      await onUse?.(template);
    }
    closeGallery();
  }, [mode, onInsert, onUse, closeGallery]);

  if (!open) {
    return null;
  }

  const canSave = mode === "insert" && Boolean(currentDocument);

  return (
    <div className="template-gallery-backdrop" data-modal-backdrop="" role="presentation" onPointerDown={closeGallery}>
      <section
        className="template-gallery-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("action.openTemplateGallery")}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="template-gallery-header">
          <div>
            <h2>{t("action.openTemplateGallery")}</h2>
            <p>{mode === "insert" ? t("template.insertHint") : t("template.createHint")}</p>
          </div>
          <div className="template-gallery-header-actions">
            {canSave && (
              <button
                type="button"
                className="button primary template-gallery-save-button"
                disabled={busy || !selectedWorkspaceId}
                onClick={() => void saveCurrentAsTemplate()}
              >
                {busy ? <Loader2 className="save-state-spinner" size={14} /> : <PlusCircle size={15} />}
                <span>{t("action.saveCurrentDocument")}</span>
              </button>
            )}
            <button type="button" className="icon-button" title={t("action.close")} aria-label={t("action.close")} onClick={closeGallery}>
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="template-gallery-tabs">
          <div className="template-gallery-tabs-scroll" role="tablist" aria-label={t("template.workspaces")}>
            {workspaces.length === 0 ? (
              <span className="template-gallery-tabs-empty">{t("label.noWorkspaces")}</span>
            ) : (
              workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  role="tab"
                  aria-selected={workspace.id === selectedWorkspaceId}
                  className={`template-gallery-tab ${workspace.id === selectedWorkspaceId ? "active" : ""}`}
                  onClick={() => setSelectedWorkspaceId(workspace.id)}
                >
                  <Building2 size={14} />
                  <span>{workspace.name}</span>
                </button>
              ))
            )}
          </div>
          <div className={`template-gallery-search ${searchOpen ? "open" : ""}`}>
            <input
              ref={searchInputRef}
              type="search"
              className="template-gallery-search-input"
              value={search}
              placeholder={t("template.searchPlaceholder")}
              aria-label={t("template.searchPlaceholder")}
              aria-hidden={!searchOpen}
              tabIndex={searchOpen ? 0 : -1}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearch("");
                  setSearchOpen(false);
                }
              }}
            />
            <button
              type="button"
              className="template-gallery-search-toggle"
              aria-label={searchOpen ? t("template.closeSearch") : t("template.search")}
              aria-expanded={searchOpen}
              onClick={toggleSearch}
            >
              <Search size={15} />
            </button>
          </div>
        </div>

        {error && <p className="template-gallery-error" role="alert">{error}</p>}

        <div className="template-gallery-body">
          {loading && templates.length === 0 ? (
            <div className="template-gallery-empty">{t("label.loading")}</div>
          ) : visibleTemplates.length === 0 ? (
            <div className="template-gallery-empty">
              {searchActive
                ? t("template.noMatches")
                : mode === "insert"
                  ? t("template.emptyInsert")
                  : t("template.emptyCreate")}
            </div>
          ) : (
            <div className="template-gallery-grid">
              {visibleTemplates.map((template) => (
                <article className="template-gallery-card" key={template.id}>
                  <button
                    type="button"
                    className="template-gallery-card-apply"
                    title={mode === "insert" ? t("template.insertIntoDocument") : t("template.createFromTemplate")}
                    onClick={() => void applyTemplate(template)}
                  >
                    <div className="template-gallery-card-preview" aria-hidden="true">
                      <div className="template-gallery-card-thumbnail-scaler">
                        <PrintPreviewThumbnail document={template.document} profile="student" maxPages={1} />
                      </div>
                    </div>
                    {editingId !== template.id && (
                      <div className="template-gallery-card-meta">
                        <strong>{template.name}</strong>
                        <span>
                          {searchActive ? `${workspaceNameById(template.workspaceId)} ${t("asset.previewSeparator")} ` : ""}
                          {formatTemplateSummary(template, t)}
                        </span>
                      </div>
                    )}
                  </button>

                  {editingId === template.id && (
                    <div className="template-gallery-card-rename">
                      <input
                        type="text"
                        value={editingName}
                        aria-label={t("template.editName")}
                        autoFocus
                        onChange={(event) => setEditingName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void renameTemplate(template);
                          } else if (event.key === "Escape") {
                            setEditingId(null);
                            setEditingName("");
                          }
                        }}
                      />
                      <button type="button" className="icon-button small" title={t("action.save")} aria-label={t("action.save")} onClick={() => void renameTemplate(template)}>
                        <Check size={14} />
                      </button>
                    </div>
                  )}

                  <div className="template-gallery-card-actions">
                    <button
                      type="button"
                      className="icon-button small"
                      title={t("action.rename")}
                      aria-label={t("action.rename")}
                      onClick={() => {
                        setEditingId(template.id);
                        setEditingName(template.name);
                      }}
                    >
                      <PenLine size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button small danger"
                      title={t("action.deleteShort")}
                      aria-label={t("action.deleteShort")}
                      onClick={() => void deleteTemplate(template)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function formatTemplateSummary(template: TemplateItem, t: Translate<"workspace">): string {
  const flow = template.document.pageLayout?.flow;
  const columnCount = flow?.type === "columns" ? flow.columnCount : 1;
  const layoutLabel = columnCount > 1
    ? t("template.columns", { replace: { count: columnCount } })
    : t("template.singleColumn");
  // 「段組」と「ブロック n」の語順・区切りは言語で変わるので、連結せず 1 キーに埋める。
  return t("template.summary", { replace: { layout: layoutLabel, blocks: template.document.content.length } });
}
