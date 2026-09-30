"use client";

import { Download, FileText, FolderOpen, Trash2, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { IconButton } from "@/components/ui/Button";
import type { DesktopBrowserAPI, InAppBrowserDownload } from "@/lib/browser/in-app-browser-contract";
import { useT } from "@/lib/i18n/react";
import { downloadFraction, formatBytes } from "../model/browser-format";
import styles from "./BrowserPanel.module.css";

export interface BrowserDownloadsProps {
  bridge: DesktopBrowserAPI;
  downloads: readonly InAppBrowserDownload[];
  onClose(): void;
}

/** ダウンロードした・している最中のファイルの一覧。完了したものはそのまま開ける。 */
export function BrowserDownloads({ bridge, downloads, onClose }: BrowserDownloadsProps) {
  const t = useT("chrome");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const finished = downloads.some((download) => download.state !== "progressing" && download.state !== "interrupted");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      // ダウンロードボタン自身の押下は、ボタン側の開閉に任せる。
      if (target && !rootRef.current?.contains(target) && !(target as Element).closest?.("[data-downloads-toggle]")) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [onClose]);

  return (
    <div ref={rootRef} className={styles.downloads} role="dialog" aria-label={t("rightDock.browser.downloads")}>
      <div className={styles.downloadsHeader}>
        <span>{t("rightDock.browser.downloads")}</span>
        <IconButton
          label={t("rightDock.browser.downloadClear")}
          tone="ghost"
          size="sm"
          disabled={!finished}
          onClick={() => void bridge.clearDownloads()}
        >
          <Trash2 size={14} aria-hidden="true" />
        </IconButton>
      </div>
      {downloads.length === 0 ? (
        <div className={styles.emptyDownloads}>{t("rightDock.browser.downloadsEmpty")}</div>
      ) : (
        <ul className={styles.downloadList}>
          {downloads.map((download) => (
            <DownloadRow key={download.id} download={download} bridge={bridge} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DownloadRow({ download, bridge }: { download: InAppBrowserDownload; bridge: DesktopBrowserAPI }) {
  const t = useT("chrome");
  const running = download.state === "progressing" || download.state === "interrupted";
  const fraction = downloadFraction(download);
  const status = download.state === "completed"
    ? `${t("rightDock.browser.downloadCompleted")} · ${formatBytes(download.receivedBytes)}`
    : download.state === "cancelled"
      ? t("rightDock.browser.downloadCancelled")
      : download.state === "interrupted" && !running
        ? t("rightDock.browser.downloadFailed")
        : fraction === null
          ? t("rightDock.browser.downloadProgressUnknown", { received: formatBytes(download.receivedBytes) })
          : t("rightDock.browser.downloadProgress", { received: formatBytes(download.receivedBytes), total: formatBytes(download.totalBytes) });

  return (
    <li className={styles.downloadRow}>
      <FileText size={16} className={styles.suggestionIcon} aria-hidden="true" />
      <div className={styles.downloadMain}>
        <span className={styles.downloadName} title={download.filename}>{download.filename}</span>
        {running && fraction !== null ? (
          <div className={styles.downloadBar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
            <span style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
        ) : null}
        <span className={styles.downloadMeta}>{status}</span>
      </div>
      <div className={styles.downloadActions}>
        {running ? (
          <IconButton label={t("rightDock.browser.downloadCancel")} tone="ghost" size="sm" onClick={() => void bridge.cancelDownload(download.id)}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        ) : download.state === "completed" ? (
          <>
            <IconButton label={t("rightDock.browser.downloadOpen")} tone="ghost" size="sm" onClick={() => void bridge.openDownload(download.id)}>
              <Download size={14} aria-hidden="true" />
            </IconButton>
            <IconButton label={t("rightDock.browser.downloadReveal")} tone="ghost" size="sm" onClick={() => void bridge.revealDownload(download.id)}>
              <FolderOpen size={14} aria-hidden="true" />
            </IconButton>
          </>
        ) : null}
      </div>
    </li>
  );
}
