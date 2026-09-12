import { useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";

import type { WorkspaceSummary } from "@/lib/runtime/types";
import type { WorkspaceFileSummary, WorkspaceFolderSummary } from "@/lib/workspace-repository";

import {
  canDropItem,
  isWorkspaceDragItem,
  parseWorkspaceItemKey,
  workspaceItemKey,
  type WorkspaceDragItem,
  type WorkspaceDropTarget,
} from "./workspace-drag";

const WORKSPACE_DRAG_DATA_TYPE = "application/x-sigma-studio-studio-workspace-item";

export interface UseWorkspaceDragAndDropOptions {
  folders: WorkspaceFolderSummary[];
  files: WorkspaceFileSummary[];
  workspaces: WorkspaceSummary[];
  hasActiveWorkspace: boolean;
  // The current multi-selection (see use-workspace-selection.ts), keyed by
  // the shared "file:<id>" / "folder:<id>" vocabulary. When the dragged item
  // is part of a >1-sized selection, the whole selection moves together via
  // onMoveSelection instead of the single-item callbacks below.
  selectedKeys: ReadonlySet<string>;
  onMoveFile: (file: WorkspaceFileSummary, folderId: string) => void | Promise<void>;
  onMoveFolder: (folderId: string, parentFolderId: string | null) => void | Promise<void>;
  onMoveFileToWorkspace: (file: WorkspaceFileSummary, targetWorkspaceId: string) => void | Promise<void>;
  onMoveSelection: (items: WorkspaceDragItem[], target: WorkspaceDropTarget) => void | Promise<void>;
}

export interface UseWorkspaceDragAndDropResult {
  dragItem: WorkspaceDragItem | null;
  dropTarget: WorkspaceDropTarget;
  dragProps: (item: WorkspaceDragItem) => {
    onDragStart: (event: ReactDragEvent) => void;
    onDragEnd: () => void;
  };
  dropProps: (target: WorkspaceDropTarget) => {
    onDragOver: (event: ReactDragEvent) => void;
    onDragLeave: (event: ReactDragEvent) => void;
    onDrop: (event: ReactDragEvent) => void;
  };
}

export function useWorkspaceDragAndDrop(options: UseWorkspaceDragAndDropOptions): UseWorkspaceDragAndDropResult {
  const [dragItem, setDragItem] = useState<WorkspaceDragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<WorkspaceDropTarget>(null);

  const readDragItem = (event: ReactDragEvent): WorkspaceDragItem | null => {
    if (dragItem) {
      return dragItem;
    }
    const raw = event.dataTransfer.getData(WORKSPACE_DRAG_DATA_TYPE);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as WorkspaceDragItem;
      return isWorkspaceDragItem(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const startDragItem = (event: ReactDragEvent, item: WorkspaceDragItem) => {
    setDragItem(item);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(WORKSPACE_DRAG_DATA_TYPE, JSON.stringify(item));
    event.dataTransfer.setData("text/plain", item.type === "file" ? item.fileId : item.folderId);
  };

  const finishDragItem = () => {
    setDragItem(null);
    setDropTarget(null);
  };

  const evaluateDrop = (item: WorkspaceDragItem | null, target: WorkspaceDropTarget): boolean => {
    return canDropItem({
      item,
      target,
      folders: options.folders,
      files: options.files,
      workspaces: options.workspaces,
      hasActiveWorkspace: options.hasActiveWorkspace,
    });
  };

  const acceptDragOver = (event: ReactDragEvent, target: WorkspaceDropTarget) => {
    const item = readDragItem(event);
    if (!evaluateDrop(item, target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(target);
  };

  const clearDropTarget = (event: ReactDragEvent, target: WorkspaceDropTarget) => {
    if (event.currentTarget instanceof Element) {
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
        return;
      }
    }
    setDropTarget((current) => current === target ? null : current);
  };

  const dropWorkspaceItem = (event: ReactDragEvent, target: WorkspaceDropTarget) => {
    const item = readDragItem(event);
    if (!evaluateDrop(item, target)) {
      finishDragItem();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    finishDragItem();
    if (!item || !target) {
      return;
    }

    // Dragging any selected item moves the whole selection: if the item
    // being dropped is part of a multi-selection, hand every selected item
    // that's still valid for this target to onMoveSelection (which
    // sequences the repository calls itself and applies only the last
    // resulting overview) instead of falling through to the single-item
    // branches below.
    const draggedKey = workspaceItemKey(item);
    if (options.selectedKeys.size > 1 && options.selectedKeys.has(draggedKey)) {
      const selectionItems = Array.from(options.selectedKeys)
        .map((key) => parseWorkspaceItemKey(key))
        .filter((candidate): candidate is WorkspaceDragItem => candidate !== null && evaluateDrop(candidate, target));
      if (selectionItems.length > 0) {
        void options.onMoveSelection(selectionItems, target);
      }
      return;
    }

    if (target === "root") {
      if (item.type === "file") {
        const file = options.files.find((candidate) => candidate.fileId === item.fileId);
        if (file) {
          void options.onMoveFile(file, "");
        }
      } else {
        void options.onMoveFolder(item.folderId, null);
      }
      return;
    }

    if (target.startsWith("folder:")) {
      const folderId = target.slice("folder:".length);
      if (item.type === "file") {
        const file = options.files.find((candidate) => candidate.fileId === item.fileId);
        if (file) {
          void options.onMoveFile(file, folderId);
        }
      } else {
        void options.onMoveFolder(item.folderId, folderId);
      }
      return;
    }

    if (target.startsWith("workspace:") && item.type === "file") {
      const targetWorkspaceId = target.slice("workspace:".length);
      const file = options.files.find((candidate) => candidate.fileId === item.fileId);
      if (file) {
        void options.onMoveFileToWorkspace(file, targetWorkspaceId);
      }
    }
  };

  return {
    dragItem,
    dropTarget,
    dragProps: (item: WorkspaceDragItem) => ({
      onDragStart: (event: ReactDragEvent) => startDragItem(event, item),
      onDragEnd: () => finishDragItem(),
    }),
    dropProps: (target: WorkspaceDropTarget) => ({
      onDragOver: (event: ReactDragEvent) => acceptDragOver(event, target),
      onDragLeave: (event: ReactDragEvent) => clearDropTarget(event, target),
      onDrop: (event: ReactDragEvent) => dropWorkspaceItem(event, target),
    }),
  };
}
