"use client";
import type { OverlayExtensions } from "@/features/document";
import {
  syncChartDataSnapshots,
  type PageOverlay
} from "@/features/document";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  useCallback
} from "react";
import {
  type OverlayChangeOptions
} from "../page-overlay-types";
import {
  normalizeOverlayGroups
} from "./grouping";
import type { PendingOverlaySave } from "./pending-save";
import { mergePendingOverlaySave } from "./pending-save";
import { reanchorShapesAgainstCanvas } from "./snapshot-anchors";
import type {
  OverlayAsset,
  OverlayShape,
  OverlaySnapshot
} from "./types";

export interface Dependencies {
  syncBlockAnchors: boolean;
  shapesRef: RefObject<OverlayShape[]>;
  canvasRef: RefObject<HTMLDivElement | null>;
  canvasHeightRef: RefObject<number>;
  canvasWidthRef: RefObject<number>;
  getBlockAnchorScope: () => ParentNode | null;
  suppressNextSaveRef: RefObject<boolean>;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  assetsRef: RefObject<Record<string, OverlayAsset>>;
  extensionsRef: RefObject<OverlayExtensions | undefined>;
  lastEmittedSnapshotRef: RefObject<OverlaySnapshot | null>;
  onChangeRef: RefObject<(overlay: PageOverlay, options?: OverlayChangeOptions) => void>;
  imageCropDirtyRef: RefObject<boolean>;
  saveTimeoutRef: RefObject<number | undefined>;
  pendingOverlayHistoryRef: RefObject<PendingOverlaySave | null>;
  pendingOverlaySaveHistoryGroupRef: RefObject<string | null>;
}

export function useOverlaySaveController({
  syncBlockAnchors,
  shapesRef,
  canvasRef,
  canvasHeightRef,
  canvasWidthRef,
  getBlockAnchorScope,
  suppressNextSaveRef,
  setShapes,
  assetsRef,
  extensionsRef,
  lastEmittedSnapshotRef,
  onChangeRef,
  imageCropDirtyRef,
  saveTimeoutRef,
  pendingOverlayHistoryRef,
  pendingOverlaySaveHistoryGroupRef,
}: Dependencies) {

  const emitOverlayChange = useCallback((options: OverlayChangeOptions = {}) => {
    const reanchored = syncBlockAnchors
      ? normalizeOverlayGroups(reanchorShapesAgainstCanvas(
        shapesRef.current,
        canvasRef.current,
        canvasHeightRef.current,
        canvasWidthRef.current,
        getBlockAnchorScope(),
      ))
      : normalizeOverlayGroups(shapesRef.current);
    // Refresh chart snapshots at the single point every edit funnels through, rather than hooking
    // each path that can change or delete a table. Copy-on-write: an unchanged document keeps its
    // array identity and no save is queued.
    const synced = syncChartDataSnapshots(reanchored);
    if (synced !== shapesRef.current) {
      shapesRef.current = synced;
      suppressNextSaveRef.current = true;
      setShapes(synced);
    }

    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: shapesRef.current,
      assets: assetsRef.current,
      ...(extensionsRef.current ? { extensions: extensionsRef.current } : {}),
    };
    lastEmittedSnapshotRef.current = snapshot;
    onChangeRef.current(
      {
        overlaySnapshot: snapshot,
        // Preview/print SVG is derived from the snapshot on demand. Generating it
        // during every canvas edit makes shape insertion feel sticky on larger docs.
        updatedAt: new Date().toISOString(),
      },
      {
        history: options.history ?? "record",
        ...(options.historyGroup ? { historyGroup: options.historyGroup } : {}),
      },
    );
    imageCropDirtyRef.current = false;
  }, [assetsRef, canvasHeightRef, canvasRef, canvasWidthRef, extensionsRef, getBlockAnchorScope, imageCropDirtyRef, lastEmittedSnapshotRef, onChangeRef, setShapes, shapesRef, suppressNextSaveRef, syncBlockAnchors]);

  const clearQueuedOverlaySave = useCallback(() => {
    if (saveTimeoutRef.current) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    pendingOverlayHistoryRef.current = null;
    pendingOverlaySaveHistoryGroupRef.current = null;
  }, [pendingOverlayHistoryRef, pendingOverlaySaveHistoryGroupRef, saveTimeoutRef]);

  const flushOverlayChange = useCallback(() => {
    // Nothing queued means the document already holds this overlay. Emitting anyway would stamp a
    // fresh `updatedAt` onto an unchanged snapshot, which the shell cannot tell from a real edit:
    // it would record an undo step and mark the document dirty for a flush that changed nothing.
    if (saveTimeoutRef.current === undefined && !imageCropDirtyRef.current) {
      return;
    }
    const pending = pendingOverlayHistoryRef.current;
    clearQueuedOverlaySave();
    emitOverlayChange({
      history: pending?.history ?? "record",
      ...(pending?.historyGroup ? { historyGroup: pending.historyGroup } : {}),
    });
  }, [clearQueuedOverlaySave, emitOverlayChange, imageCropDirtyRef, pendingOverlayHistoryRef, saveTimeoutRef]);

  const commitOverlayChangeNow = useCallback((options: OverlayChangeOptions = {}) => {
    const merged = mergePendingOverlaySave(pendingOverlayHistoryRef.current, options);
    clearQueuedOverlaySave();
    emitOverlayChange({
      history: merged.history,
      ...(merged.historyGroup ? { historyGroup: merged.historyGroup } : {}),
    });
  }, [clearQueuedOverlaySave, emitOverlayChange, pendingOverlayHistoryRef]);

  const queueOverlaySave = useCallback((options: OverlayChangeOptions = {}) => {
    pendingOverlayHistoryRef.current = mergePendingOverlaySave(pendingOverlayHistoryRef.current, options);
    if (saveTimeoutRef.current) {
      window.clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = window.setTimeout(() => {
      saveTimeoutRef.current = undefined;
      const pending = pendingOverlayHistoryRef.current;
      pendingOverlayHistoryRef.current = null;
      emitOverlayChange({
        history: pending?.history ?? "record",
        ...(pending?.historyGroup ? { historyGroup: pending.historyGroup } : {}),
      });
    }, 250);
  }, [emitOverlayChange, pendingOverlayHistoryRef, saveTimeoutRef]);

  const queueDirtyImageCropSave = useCallback(() => {
    if (imageCropDirtyRef.current) {
      queueOverlaySave();
    }
  }, [imageCropDirtyRef, queueOverlaySave]);
  return { queueOverlaySave, clearQueuedOverlaySave, commitOverlayChangeNow, flushOverlayChange, queueDirtyImageCropSave };
}
