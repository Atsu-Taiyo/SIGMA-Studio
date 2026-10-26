"use client";

import { Clock3, Loader2, Users, X } from "lucide-react";
import { Shimmer } from "@/components/ui/Shimmer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SigmaDocument } from "@/features/document";
import type { DocumentSessionVersionHistory } from "@/features/document-session/contracts";
import {
  groupDocumentVersionsByDate,
  type DocumentVersionOrigin,
} from "@/lib/document-version-history";
import { getAppRuntime } from "@/lib/runtime";
import { getDocumentVersion, listDocumentVersions } from "@/lib/storage";
import { useAppLocale, useT } from "@/lib/i18n/react";

/** 共有サーバーが残す版は 10 分ごとに増える。開いている間はこの間隔で一覧を読み直す。 */
const SHARED_VERSION_REFRESH_MS = 60_000;

/**
 * どこの版を見せるか。ローカル教材は端末の版履歴、共有教材は共有サーバーが残す版 (セッションの
 * `versionHistory`)。共有教材の版は端末の版履歴には無い (#244)。
 */
export type VersionHistorySource =
  | { kind: "local"; fileId: string }
  | { kind: "shared"; fileId: string; history: DocumentSessionVersionHistory };

/** 一覧で選んで、編集面の代わりに表示している版。 */
export interface VersionHistorySelection {
  versionId: string;
  capturedAt: string;
  /** 一覧の行と同じ種類の名前 (「自動で保存」など)。表示中の帯に添える。 */
  label: string;
  document: SigmaDocument;
  shared: boolean;
}

interface VersionHistoryRow {
  versionId: string;
  capturedAt: string;
  label: string;
}

export function VersionHistoryPanel({
  busy,
  source,
  historyWarning,
  onClose,
  onPreviewChange,
  selectedVersionId,
}: {
  busy: boolean;
  source: VersionHistorySource;
  historyWarning?: string | null;
  onClose: () => void;
  onPreviewChange: (version: VersionHistorySelection | null) => void;
  selectedVersionId: string | null;
}) {
  const t = useT("chrome");
  const locale = useAppLocale();
  const [versions, setVersions] = useState<VersionHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingVersionId, setPendingVersionId] = useState<string | null>(null);
  const [failedSelection, setFailedSelection] = useState<VersionHistoryRow | null>(null);
  const refreshRequestRef = useRef(0);
  const selectionRequestRef = useRef(0);
  const { fileId } = source;
  const shared = source.kind === "shared" ? source.history : null;

  const refresh = useCallback(async () => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    setLoading(true);
    try {
      const nextVersions: VersionHistoryRow[] = shared
        ? (await shared.list()).map((version) => ({
          versionId: version.versionId,
          capturedAt: version.capturedAt,
          label: t(`versionHistory.kind.${version.kind}`),
        }))
        : (await listDocumentVersions(fileId)).map((version) => ({
          versionId: version.versionId,
          capturedAt: version.capturedAt,
          label: t(`versionHistory.origin.${version.origin satisfies DocumentVersionOrigin}`),
        }));
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
  }, [fileId, shared, t]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void refresh(), 0);
    // ローカルの版は保存のたびに知らせが来る。共有サーバーの版は知らせが無いので、開いている間だけ読み直す。
    const unsubscribe = shared
      ? (() => {
        const intervalId = window.setInterval(() => void refresh(), SHARED_VERSION_REFRESH_MS);
        return () => window.clearInterval(intervalId);
      })()
      : getAppRuntime().library.onChange((event) => {
        if (event.type === "documentVersion" && event.fileId === fileId) void refresh();
      });
    return () => {
      refreshRequestRef.current += 1;
      selectionRequestRef.current += 1;
      window.clearTimeout(timeoutId);
      unsubscribe();
    };
  }, [fileId, refresh, shared]);

  const selectVersion = useCallback(async (row: VersionHistoryRow) => {
    const requestId = selectionRequestRef.current + 1;
    selectionRequestRef.current = requestId;
    setError(null);
    setFailedSelection(null);
    setPendingVersionId(row.versionId);
    try {
      const document = shared
        ? await shared.get(row.versionId)
        : (await getDocumentVersion(fileId, row.versionId))?.document ?? null;
      if (selectionRequestRef.current !== requestId) return;
      if (!document) {
        setFailedSelection(row);
        setError(t("versionHistory.loadFailed"));
        return;
      }
      onPreviewChange({ versionId: row.versionId, capturedAt: row.capturedAt, label: row.label, document, shared: Boolean(shared) });
      setFailedSelection(null);
      setError(null);
    } catch {
      if (selectionRequestRef.current !== requestId) return;
      setFailedSelection(row);
      setError(t("versionHistory.loadFailed"));
    } finally {
      if (selectionRequestRef.current === requestId) setPendingVersionId(null);
    }
  }, [fileId, onPreviewChange, shared, t]);

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
        {error && (
          <div className="version-history-error" role="alert">
            <span>{error}</span>
            <button type="button" className="button subtle" disabled={loading || pendingVersionId !== null} onClick={() => {
              if (failedSelection) void selectVersion(failedSelection);
              else void refresh();
            }}>
              {t("versionHistory.retry")}
            </button>
          </div>
        )}
        {/* 版を縦の線でつないだ時系列。先頭は常に編集中の「現在の版」で、線の点が塗られている。 */}
        <div className="version-history-list" aria-label={t("versionHistory.list")} aria-busy={busy}>
          <button
            type="button"
            className="version-history-row version-history-current-row"
            aria-pressed={selectedVersionId === null}
            disabled={busy}
            onClick={selectCurrentVersion}
          >
            <span className="version-history-marker" aria-hidden="true" />
            <span className="version-history-time">{t("versionHistory.currentVersion")}</span>
          </button>
          {loading && versions.length === 0 && (
            <div className="version-history-state version-history-skeleton" role="status">
              <span className="visually-hidden">{t("versionHistory.loading")}</span>
              {[0, 1, 2].map((index) => (
                <span key={index} className="version-history-skeleton-row" aria-hidden="true">
                  <Shimmer variant="surface" className="version-history-skeleton-time" />
                  <Shimmer variant="surface" className="version-history-skeleton-label" />
                </span>
              ))}
            </div>
          )}
          {!loading && !error && versions.length === 0 && (
            <div className="version-history-state version-history-empty">
              <Clock3 size={18} aria-hidden="true" />
              <strong>{t("versionHistory.emptyTitle")}</strong>
              <span>{shared ? t("versionHistory.sharedEmptyBody") : t("versionHistory.emptyBody")}</span>
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
                  <span className="version-history-marker" aria-hidden="true" />
                  <span className="version-history-time">{formatTime(version.capturedAt)}</span>
                  <span className="version-history-label">{version.label}</span>
                  {pendingVersionId === version.versionId && <Loader2 className="save-state-spinner" size={13} aria-hidden="true" />}
                </button>
              ))}
            </section>
          ))}
        </div>
      </div>
      {/* 共有教材の版: 誰が見られて誰が戻せるか。一覧の邪魔をしないよう、下端に小さく置く。 */}
      {shared && (
        <p className="version-history-note">
          <Users size={13} aria-hidden="true" />
          <span>{shared.canRestore() ? t("versionHistory.sharedNote") : t("versionHistory.sharedNoteReadOnly")}</span>
        </p>
      )}
    </aside>
  );
}
