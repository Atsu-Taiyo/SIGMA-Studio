"use client";

import { useEffect, useMemo, useState } from "react";

import type { CommentUserIdentity, UserCommentThread } from "@/features/document";
import { loadSharedWorkspacePreviewDocument, loadWorkspacePreviewDocument, type WorkspaceFileSummary } from "@/lib/workspace-repository";

import { createCommentScanStore } from "./workspace-comment-scan-store";
import { WorkspaceCommentScanner, type CommentScanDeps, type CommentScanFile } from "./workspace-comment-scanner";

type ThreadsByFile = ReadonlyMap<string, readonly UserCommentThread[]>;

const NO_THREADS: ThreadsByFile = new Map();
/** 画面を見ている間は、他の人の新しいコメントが届くよう定期的に読み直す。 */
const BACKGROUND_POLL_MS = 120_000;
/** コメント一覧を開いている間は、共有教材を短い周期で読み直す。 */
const PANEL_POLL_MS = 30_000;

const SCAN_DEPS: CommentScanDeps = {
  loadLocal: loadWorkspacePreviewDocument,
  // コメントの走査に画像は要らない。
  loadShared: (fileId) => loadSharedWorkspacePreviewDocument(fileId, { assets: false }),
  now: () => Date.now(),
};

/**
 * 全ワークスペースの教材から、自分に関係するコメントスレッドを集める。サインインしていなければ
 * (identity が無ければ) 何も読まない。`active` は一覧を開いているとき: 共有教材の読み直しを早める。
 * 読み直しは画面が見えている間だけで、前回の結果は読み直しの間も出し続ける。
 */
export function useWorkspaceComments({ files, identity, active }: {
  files: readonly WorkspaceFileSummary[] | null;
  identity: CommentUserIdentity | null;
  active: boolean;
}): { threadsByFile: ThreadsByFile; scanning: boolean } {
  // 名前が変わったとき (プロフィール更新) は別のスキャナに替えて、古い名前での結果を持ち越さない。
  const identityKey = identity ? JSON.stringify([identity.userId, ...identity.authorNames]) : null;
  const scanner = useMemo(() => {
    if (!identityKey) return null;
    const [userId, ...authorNames] = JSON.parse(identityKey) as string[];
    // 前回の結果を置いておき、次に開いたときはそれを先に出して古いものだけ読み直す。
    return new WorkspaceCommentScanner({ userId, authorNames }, { ...SCAN_DEPS, store: createCommentScanStore(userId) });
  }, [identityKey]);

  // 共有カタログの更新などで `files` が作り直されても、中身が同じなら走査をやり直さない (走査は途中で中断されるため)。
  const scanKey = useMemo(() => files
    ? JSON.stringify(files.map((file) => [file.fileId, file.revision, file.updatedAt, Boolean(file.sharing)]))
    : null, [files]);
  const scanFiles = useMemo<CommentScanFile[] | null>(() => scanKey
    ? (JSON.parse(scanKey) as [string, number, string, boolean][]).map(([fileId, revision, updatedAt, shared]) => ({ fileId, revision, updatedAt, shared }))
    : null, [scanKey]);

  const [scanned, setScanned] = useState<{
    scanner: WorkspaceCommentScanner;
    threads: ThreadsByFile;
    settledFor: CommentScanFile[] | null;
  } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!scanner) return;
    const refresh = () => { if (document.visibilityState === "visible") setTick((value) => value + 1); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, active ? PANEL_POLL_MS : BACKGROUND_POLL_MS);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [scanner, active]);

  useEffect(() => {
    if (!scanner || !scanFiles) return;
    const controller = new AbortController();
    const publish = (settledFor: CommentScanFile[] | null) => setScanned((current) => ({
      scanner,
      threads: scanner.snapshot(scanFiles),
      settledFor: settledFor ?? (current?.scanner === scanner ? current.settledFor : null),
    }));
    // 保存してある前回の結果は、読み直しを待たずに先に出す。
    publish(null);
    void scanner.scan(scanFiles, {
      signal: controller.signal,
      sharedTtlMs: active ? PANEL_POLL_MS / 2 : undefined,
      onProgress: () => publish(null),
    }).then(() => { if (!controller.signal.aborted) publish(scanFiles); });
    return () => controller.abort();
  }, [scanner, scanFiles, tick, active]);

  const current = scanned && scanned.scanner === scanner ? scanned : null;
  return {
    threadsByFile: current?.threads ?? NO_THREADS,
    scanning: Boolean(scanner && scanFiles) && current?.settledFor !== scanFiles,
  };
}
