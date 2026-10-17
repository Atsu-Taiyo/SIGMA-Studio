"use client";

import { useEffect, useState } from "react";
import type { WorkspaceFileSummary } from "@/lib/workspace-repository";
import { loadNewMaterialTargets, type NewMaterialWorkspaceOption } from "./new-material-destination";

export interface NewMaterialTargets {
  /** 開いてから一度も読めていない間は true (メニューには読み込み中の形を出す)。 */
  loading: boolean;
  options: NewMaterialWorkspaceOption[];
}

/**
 * 「新規教材」のメニュー (と Word風の Backstage の「新規」) を開いている間だけ、作成先に選べるワークスペースを読む。
 * 開くたびに読み直すが、読み直しの間は前に読んだ一覧を出したままにする (メニューの高さを揺らさない)。
 */
export function useNewMaterialTargets(
  open: boolean,
  previous: Pick<WorkspaceFileSummary, "fileId" | "workspaceId" | "folderId"> | undefined,
): NewMaterialTargets {
  const [loaded, setLoaded] = useState<{ options: NewMaterialWorkspaceOption[] } | null>(null);
  const previousWorkspaceId = previous?.workspaceId;
  const previousFolderId = previous?.folderId ?? null;
  const previousFileId = previous?.fileId;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const target = previousWorkspaceId === undefined ? undefined : { workspaceId: previousWorkspaceId, folderId: previousFolderId };
    void loadNewMaterialTargets(target).then(
      (plan) => { if (!cancelled) setLoaded({ options: plan?.options ?? [] }); },
      () => { if (!cancelled) setLoaded({ options: [] }); },
    );
    return () => { cancelled = true; };
  }, [open, previousFileId, previousWorkspaceId, previousFolderId]);

  // 開いていない間 (教材の準備中を含む) は何も出さない。
  return open ? { loading: loaded === null, options: loaded?.options ?? [] } : { loading: false, options: [] };
}
