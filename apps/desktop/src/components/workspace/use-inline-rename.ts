import { useCallback, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import {
  renameDocumentInWorkspace,
  updateFolder,
  updateWorkspaceName,
  type WorkspaceOverview,
  type WorkspaceOverviewResult,
} from "@/lib/workspace-repository";

import { applyPendingRenames } from "./workspace-list-model";
import type { LedgerSchemaErrorResult } from "./workspace-overview-result";
import { useT } from "@/lib/i18n/react";
import type { Translate } from "@/lib/i18n/translator";

export type WorkspaceRenameTargetType = "file" | "folder" | "workspace";

export interface WorkspaceInlineRenameTarget {
  type: WorkspaceRenameTargetType;
  id: string;
}

export interface WorkspaceInlineRenameState {
  type: WorkspaceRenameTargetType;
  id: string;
  original: string;
  committing: boolean;
  error: string | null;
}

export interface UseInlineRenameOptions {
  activeWorkspaceId: string | null;
  // Owned by the caller (WorkspaceManager), not this hook: applyOverview
  // must be able to read the same pending-renames map to re-apply it on top
  // of ANY incoming overview, not just this hook's own success path -- and a
  // ref populated after a hook call returns is a render-time ref mutation,
  // which is disallowed. Threading the ref down instead of back up avoids
  // the ordering problem entirely.
  pendingRenamesRef: MutableRefObject<Map<string, string>>;
  setOverview: Dispatch<SetStateAction<WorkspaceOverview | null>>;
  applyOverview: (overview: WorkspaceOverview, message?: string) => void;
  handleLedgerSchemaError: (
    result: WorkspaceOverviewResult,
  ) => result is LedgerSchemaErrorResult;
  setStatus: (status: "saved" | "error") => void;
  setMessage: (message: string) => void;
}

export interface WorkspaceInlineRenameControls {
  renameState: WorkspaceInlineRenameState | null;
  isEditing: (key: string) => boolean;
  start: (target: WorkspaceInlineRenameTarget, currentName: string) => void;
  cancel: () => void;
  commit: (nextName: string) => void;
}

function keyFor(type: WorkspaceRenameTargetType, id: string): string {
  return `${type}:${id}`;
}

async function performRename(
  target: WorkspaceInlineRenameTarget,
  name: string,
  activeWorkspaceId: string | null,
  t: Translate<"workspace">,
): Promise<WorkspaceOverviewResult> {
  if (target.type === "workspace") {
    return updateWorkspaceName(target.id, name);
  }
  if (!activeWorkspaceId) {
    return { state: "unavailable", error: t("error.workspaceMissing") };
  }
  if (target.type === "folder") {
    return updateFolder(activeWorkspaceId, target.id, { name });
  }
  return renameDocumentInWorkspace(activeWorkspaceId, target.id, name);
}

/**
 * Inline (dialog-free) rename for files, folders, and workspace entries.
 *
 * The commit flow is optimistic:
 * 1. Patch `overview` in place and record the pending name in
 *    `pendingRenamesRef` (itemKey -> pending name).
 * 2. Close the editor immediately (renameState -> null).
 * 3. Call the repository.
 * 4. On success, applyOverview() with the server-confirmed overview and
 *    clear the pending entry.
 * 5. On error, restore the pre-rename name in `overview`, clear the pending
 *    entry, and surface the error via status/message. The editor is not
 *    reopened (Drive reverts with a toast rather than re-editing).
 *
 * pendingRenamesRef exists because the store's file watcher drives a 400ms
 * debounced silent overview reload (see the storage-change effect in
 * WorkspaceManager.tsx); that reload can land mid-flight, before this
 * rename's own repository call resolves, carrying a still-stale name. The
 * caller's applyOverview must re-apply pendingRenamesRef.current on top of
 * every overview it receives (not just this hook's own success path), or the
 * stale reload will visibly revert the name for a frame.
 */
export function useInlineRename(options: UseInlineRenameOptions): WorkspaceInlineRenameControls {
  const t = useT("workspace");
  const [renameState, setRenameState] = useState<WorkspaceInlineRenameState | null>(null);
  const { pendingRenamesRef } = options;

  const isEditing = useCallback((key: string) => {
    return renameState !== null && keyFor(renameState.type, renameState.id) === key;
  }, [renameState]);

  const start = useCallback((target: WorkspaceInlineRenameTarget, currentName: string) => {
    setRenameState({ type: target.type, id: target.id, original: currentName, committing: false, error: null });
  }, []);

  const cancel = useCallback(() => {
    setRenameState(null);
  }, []);

  const commit = useCallback((rawNextName: string) => {
    const current = renameState;
    if (!current) {
      return;
    }

    const trimmed = rawNextName.trim();
    // Close the editor immediately regardless of outcome: a no-op commit
    // (empty, or unchanged) is treated as a cancel, no repository call.
    setRenameState(null);
    if (!trimmed || trimmed === current.original) {
      return;
    }

    const target: WorkspaceInlineRenameTarget = { type: current.type, id: current.id };
    const itemKey = keyFor(target.type, target.id);
    const original = current.original;

    pendingRenamesRef.current.set(itemKey, trimmed);
    options.setOverview((prev) => (prev ? applyPendingRenames(prev, new Map([[itemKey, trimmed]])) : prev));

    void (async () => {
      const result = await performRename(target, trimmed, options.activeWorkspaceId, t);
      if (result.state === "ready") {
        pendingRenamesRef.current.delete(itemKey);
        options.applyOverview(result.overview, t("status.renamed"));
        options.setStatus("saved");
        return;
      }

      pendingRenamesRef.current.delete(itemKey);
      options.setOverview((prev) => (prev ? applyPendingRenames(prev, new Map([[itemKey, original]])) : prev));
      if (options.handleLedgerSchemaError(result)) {
        return;
      }
      options.setStatus("error");
      options.setMessage(result.state === "unavailable"
        ? t("error.renameFailed")
        : result.error);
    })();
    // options's fields (setOverview/applyOverview/setStatus/setMessage) are
    // stable setters/callbacks from the caller; activeWorkspaceId and
    // pendingRenamesRef are read fresh via `options` and the ref itself, so
    // only renameState needs to be a dependency here.
  }, [renameState, options, pendingRenamesRef, t]);

  return {
    renameState,
    isEditing,
    start,
    cancel,
    commit,
  };
}
