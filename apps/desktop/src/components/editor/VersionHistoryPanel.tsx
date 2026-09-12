"use client";

import { Clock3, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  groupDocumentVersionsByDate,
  type DocumentVersion,
  type DocumentVersionMetadata,
} from "@/lib/document-version-history";
import { getAppRuntime } from "@/lib/runtime";
import { getDocumentVersion, listDocumentVersions } from "@/lib/storage";
import { useAppLocale, useT } from "@/lib/i18n/react";

export function VersionHistoryPanel({
  busy,
  fileId,
  historyWarning,
  onClose,
  onPreviewChange,
  selectedVersionId,
}: {
  busy: boolean;
  fileId: string;
  historyWarning?: string | null;
  onClose: () => void;
  onPreviewChange: (version: DocumentVersion | null) => void;
  selectedVersionId: string | null;
}) {
  const t = useT("chrome");
  const locale = useAppLocale();
  const [versions, setVersions] = useState<DocumentVersionMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingVersionId, setPendingVersionId] = useState<string | null>(null);
  const [failedSelection, setFailedSelection] = useState<DocumentVersionMetadata | null>(null);
  const refreshRequestRef = useRef(0);
  const selectionRequestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    setLoading(true);
    try {
      const nextVersions = await listDocumentVersions(fileId);
      if (refreshRequestRef.current !== requestId) return;
      setVersions(nextVersions);
      setError(null);
      setFailedSelection(null);
    } catch {
      if (refreshRequestRef.current !== requestId) return;
      setError(t("versionHistory.loadFailed"));
    } finally {
      if (refreshRequestRef.current === requestId) setLoading(false);
    }
  }, [fileId, t]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = getAppRuntime().library.onChange((event) => {
      if (event.type === "documentVersion" && event.fileId === fileId) void refresh();
    });
    return () => {
      refreshRequestRef.current += 1;
      selectionRequestRef.current += 1;
      window.clearTimeout(timeoutId);
      unsubscribe();
    };
  }, [fileId, refresh]);

  const selectVersion = useCallback(async (metadata: DocumentVersionMetadata) => {
    const requestId = selectionRequestRef.current + 1;
    selectionRequestRef.current = requestId;
    setError(null);
    setFailedSelection(null);
    setPendingVersionId(metadata.versionId);
    try {
      const nextSelected = await getDocumentVersion(fileId, metadata.versionId);
      if (selectionRequestRef.current !== requestId) return;
      if (!nextSelected) {
        setFailedSelection(metadata);
        setError(t("versionHistory.loadFailed"));
        return;
      }
      onPreviewChange(nextSelected);
      setFailedSelection(null);
      setError(null);
    } catch {
      if (selectionRequestRef.current !== requestId) return;
      setFailedSelection(metadata);
      setError(t("versionHistory.loadFailed"));
    } finally {
      if (selectionRequestRef.current === requestId) setPendingVersionId(null);
    }
  }, [fileId, onPreviewChange, t]);

  const selectCurrentVersion = useCallback(() => {
    selectionRequestRef.current += 1;
    setPendingVersionId(null);
    setFailedSelection(null);
    setError(null);
    onPreviewChange(null);
  }, [onPreviewChange]);

  const groups = useMemo(() => groupDocumentVersionsByDate(versions), [versions]);
  const formatTime = (value: string) => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  const formatDate = (value: string) => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(`${value}T12:00:00`));

  return (
    <aside className="ai-sidebar-panel version-history-panel" aria-label={t("versionHistory.title")}>
      <div className="sidebar-panel-header">
        <span>{t("versionHistory.title")}</span>
        <button type="button" className="panel-icon-button sidebar-close-button" aria-label={t("versionHistory.close")} title={t("versionHistory.close")} disabled={busy} onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="version-history-body">
        {historyWarning && <p className="version-history-warning" role="status">{historyWarning}</p>}
        {loading && versions.length === 0 && <p className="version-history-state" role="status"><Loader2 className="save-state-spinner" size={15} aria-hidden="true" />{t("versionHistory.loading")}</p>}
        {error && (
          <div className="version-history-state" role="alert">
            <span>{error}</span>
            <button type="button" className="button" disabled={loading || pendingVersionId !== null} onClick={() => {
              if (failedSelection) void selectVersion(failedSelection);
              else void refresh();
            }}>
              {t("versionHistory.retry")}
            </button>
          </div>
        )}
        <div className="version-history-list" aria-label={t("versionHistory.list")} aria-busy={busy}>
          <button
            type="button"
            className="version-history-row version-history-current-row"
            aria-pressed={selectedVersionId === null}
            disabled={busy}
            onClick={selectCurrentVersion}
          >
            <span className="version-history-time">{t("versionHistory.currentVersion")}</span>
          </button>
          {!loading && !error && versions.length === 0 && (
            <div className="version-history-state">
              <Clock3 size={20} aria-hidden="true" />
              <strong>{t("versionHistory.emptyTitle")}</strong>
              <span>{t("versionHistory.emptyBody")}</span>
            </div>
          )}
          {groups.map((group) => (
            <section key={group.key}>
              <h3>{group.kind === "today" ? t("versionHistory.today") : group.kind === "yesterday" ? t("versionHistory.yesterday") : formatDate(group.date)}</h3>
              {group.versions.map((version) => (
                <button
                  key={version.versionId}
                  type="button"
                  className="version-history-row"
                  aria-pressed={selectedVersionId === version.versionId}
                  aria-busy={pendingVersionId === version.versionId}
                  disabled={busy || pendingVersionId === version.versionId}
                  onClick={() => void selectVersion(version)}
                >
                  <span className="version-history-time">{formatTime(version.capturedAt)}</span>
                  <span>{t(`versionHistory.origin.${version.origin}`)}</span>
                  {pendingVersionId === version.versionId && <Loader2 className="save-state-spinner" size={14} aria-hidden="true" />}
                </button>
              ))}
            </section>
          ))}
        </div>
      </div>
    </aside>
  );
}
