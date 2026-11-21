"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Shimmer } from "@/components/ui/Shimmer";
import { getExtensionBridge, type FolderImportProgress, type FolderImportResult } from "@/lib/extension-contracts";
import { useT } from "@/lib/i18n/react";
import styles from "./FolderImportDialog.module.css";

const PAGE_SIZE = 100;
export function FolderImportDialog({ progress, result, onClose }: {
  progress: FolderImportProgress | null; result: FolderImportResult | null; onClose(): void;
}) {
  const t = useT("editor");
  const [page, setPage] = useState(0);
  const [openFailed, setOpenFailed] = useState(false);
  const busy = !result;
  const counts = result?.counts ?? progress?.counts ?? { success: 0, skipped: 0, failed: 0 };
  const title = t(busy ? "extensions.folder.running" : "extensions.folder.title");
  const dismiss = () => { if (!busy) onClose(); };
  const open = async (target: "folder" | "report") => {
    try { setOpenFailed(!(await getExtensionBridge()?.openFolderResult?.(result!.jobId, target))); }
    catch { setOpenFailed(true); }
  };
  const pages = Math.max(1, Math.ceil((result?.entries.length ?? 0) / PAGE_SIZE));
  return <ModalFrame open size="lg" onDismiss={dismiss} closeOnEscape={!busy} ariaLabel={title}>
    <ModalHeader title={title} onClose={dismiss} hideCloseButton={busy} />
    <ModalBody padding="none">
      <div className={styles.content}>
        <div role="status" aria-live="polite">
          <p>{t("extensions.folder.summary", counts)}</p>
          {busy && <>
            <Shimmer variant="surface" className={styles.loading} />
            <p>{progress?.phase === "scanning" ? t("extensions.folder.scanning") : t("extensions.folder.progress", { completed: progress?.completed ?? 0, total: progress?.total ?? 0 })}</p>
            {progress?.phase === "converting" && <progress aria-label={title} value={progress.completed} max={Math.max(1, progress.total)} />}
            <p className={styles.path}>{progress?.currentPath}</p>
          </>}
        </div>
        {result && <>
          <p className={styles.path}>{t("extensions.folder.destination", { path: result.outputDirectory })}</p>
          {result.truncated && <p role="alert">{t("extensions.folder.truncated")}</p>}
          {result.reportError && <p role="alert">{t("extensions.folder.reportError")}</p>}
          <div className={styles.table}>
            <table>
              <thead><tr><th>{t("extensions.folder.path")}</th><th>{t("extensions.folder.status")}</th><th>{t("extensions.folder.reason")}</th></tr></thead>
              <tbody>{result.entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((entry, index) => <tr key={`${page}-${index}`}>
                <td className={styles.path}>{entry.relativePath}{entry.scope === "subtree" && <small>{t("extensions.folder.subtree")}</small>}</td>
                <td>{t(`extensions.folder.${entry.status}`)}</td>
                <td>{t(`extensions.folder.reasons.${entry.reason}`)}{Boolean(entry.issueCount) && <small>{t("extensions.folder.issues", { count: entry.issueCount, path: entry.issueReportPath ?? "conversion-report.json" })}</small>}</td>
              </tr>)}</tbody>
            </table>
          </div>
          {result.entries.length === 0 && <p>{t("extensions.folder.empty")}</p>}
          {pages > 1 && <div className={styles.actions}>
            <Button disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t("extensions.folder.previous")}</Button>
            <span>{page + 1} / {pages}</span>
            <Button disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>{t("extensions.folder.next")}</Button>
          </div>}
          {openFailed && <p role="alert">{t("extensions.folder.openFailed")}</p>}
          <div className={styles.actions}>
            <Button onClick={() => void open("folder")}>{t("extensions.folder.openFolder")}</Button>
            <Button disabled={Boolean(result.reportError)} onClick={() => void open("report")}>{t("extensions.folder.openReport")}</Button>
            <Button tone="primary" onClick={onClose}>{t("extensions.folder.close")}</Button>
          </div>
        </>}
      </div>
    </ModalBody>
  </ModalFrame>;
}
