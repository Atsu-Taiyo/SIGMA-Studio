"use client";
import { normalizeOverlaySnapshot, type OverlayExtensions, type PageOverlay } from "@/features/document";
import { isOverlayRichTextShape } from "@/features/drawing";
import { areStructurallyEqual } from "@/lib/structural-equality";
import type { Editor as TiptapEditor } from "@tiptap/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect } from "react";
import { type OverlaySelectionStylePatch } from "../page-overlay-types";
import { normalizeOverlayGroups } from "./grouping";
import { type OverlayInteractionAction, type OverlayInteractionMode } from "./interaction-mode";
import type { PendingOverlaySave } from "./pending-save";
import type { OverlayAsset, OverlayShape, OverlaySnapshot } from "./types";

interface Dependencies {
  setPreview: Dispatch<SetStateAction<{ style: OverlaySelectionStylePatch; targetIds: Set<string>; } | null>>;
  clearQueuedOverlaySave: () => void;
  imageCropDirtyRef: RefObject<boolean>;
  suppressNextSaveRef: RefObject<boolean>;
  modeRef: RefObject<OverlayInteractionMode>;
  selectedIdsRef: RefObject<string[]>;
  shapesRef: RefObject<OverlayShape[]>;
  assetsRef: RefObject<Record<string, OverlayAsset>>;
  extensionsRef: RefObject<OverlayExtensions | undefined>;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  setAssets: Dispatch<SetStateAction<Record<string, OverlayAsset>>>;
  setSelectedIds: Dispatch<SetStateAction<string[]>>;
  setAppliedSnapshotRevision: Dispatch<SetStateAction<number>>;
  transitionMode: (action: OverlayInteractionAction) => void;
  activeTextEditorRef: RefObject<TiptapEditor | null>;
  overlay: PageOverlay;
  reconciledDocumentSnapshotRef: RefObject<OverlaySnapshot | undefined>;
  lastEmittedSnapshotRef: RefObject<OverlaySnapshot | null>;
  saveTimeoutRef: RefObject<number | undefined>;
  pendingOverlayHistoryRef: RefObject<PendingOverlaySave | null>;
  externalRevisionRef: RefObject<number>;
  externalRevision: number;
  seenDocumentSnapshotRef: RefObject<OverlaySnapshot | undefined>;
  mode: OverlayInteractionMode;
}

export function useDocumentSnapshotSync({
  setPreview,
  clearQueuedOverlaySave,
  imageCropDirtyRef,
  suppressNextSaveRef,
  modeRef,
  selectedIdsRef,
  shapesRef,
  assetsRef,
  extensionsRef,
  setShapes,
  setAssets,
  setSelectedIds,
  setAppliedSnapshotRevision,
  transitionMode,
  activeTextEditorRef,
  overlay,
  reconciledDocumentSnapshotRef,
  lastEmittedSnapshotRef,
  saveTimeoutRef,
  pendingOverlayHistoryRef,
  externalRevisionRef,
  externalRevision,
  seenDocumentSnapshotRef,
  mode,
}: Dependencies) {


  const applyExternalSnapshot = useCallback((snapshot: OverlaySnapshot) => {
    // The incoming shapes are authoritative; a half-dragged preview over them would be showing a
    // value that no longer has anything to do with the document.
    setPreview(null);
    clearQueuedOverlaySave();
    imageCropDirtyRef.current = false;

    suppressNextSaveRef.current = true;
    const currentMode = modeRef.current;
    const textEditingShapeId = currentMode.id === "overlay.textEditing" ? currentMode.shapeId : null;
    const nextShapes = normalizeOverlayGroups(snapshot.shapes);
    const nextShapeIds = new Set(nextShapes.map((shape) => shape.id));
    const nextTextEditingShape = textEditingShapeId
      ? nextShapes.find((shape) => shape.id === textEditingShapeId && isOverlayRichTextShape(shape))
      : null;
    // An undo/redo swaps the whole snapshot in, but it is still the same shape on screen: keeping
    // it selected is what lets ⌘Z after ⌘Z keep walking back through its edits. A 3D material also
    // stays in its direct-edit mode, so its live window is never torn down and rebuilt (a rebuild
    // costs a WebGL context and blanks the preview for a moment).
    const survivingSelection = selectedIdsRef.current.filter((id) => nextShapeIds.has(id));
    const graph3DEditingShape = currentMode.id === "overlay.graph3dEditing"
      && nextShapes.some((shape) => shape.id === currentMode.shapeId && shape.type === "graph3dShape")
      ? currentMode.shapeId
      : null;
    shapesRef.current = nextShapes;
    assetsRef.current = snapshot.assets;
    extensionsRef.current = snapshot.extensions;
    selectedIdsRef.current = nextTextEditingShape ? [nextTextEditingShape.id] : survivingSelection;
    setShapes(nextShapes);
    setAssets(snapshot.assets);
    setSelectedIds(selectedIdsRef.current);
    setAppliedSnapshotRevision((current) => current + 1);
    if (nextTextEditingShape) {
      transitionMode({ type: "editText", shapeId: nextTextEditingShape.id });
    } else {
      // 破棄済みの tiptap editor が残っていることがある (`commands` getter が view 無しで throw する)。
      const activeTextEditor = activeTextEditorRef.current;
      if (activeTextEditor && !activeTextEditor.isDestroyed) {
        activeTextEditor.commands.blur();
      }
      activeTextEditorRef.current = null;
      transitionMode({ type: "select" });
      if (graph3DEditingShape) {
        transitionMode({ type: "editGraph3D", shapeId: graph3DEditingShape });
      }
    }
  }, [activeTextEditorRef, assetsRef, clearQueuedOverlaySave, extensionsRef, imageCropDirtyRef, modeRef, selectedIdsRef, setAppliedSnapshotRevision, setAssets, setPreview, setSelectedIds, setShapes, shapesRef, suppressNextSaveRef, transitionMode]);


  /**
   * 文書側の overlay が外から書き換えられていたら (AI提案の適用など)、自分の状態を捨てて採用する。
   *
   * 見送る条件が 3 つ。(1) 自分の書き込みの反響 — `writeOverlay` は overlay をそのまま文書へ置く
   * ので配列の同一性で分かる。(2) 中身が同じ — 再アンカー等の派生書き戻しで編集状態を壊さない。
   * (3) 自分が作業中 — ドラッグ中や保存待ちの 250ms に外部スナップショットを被せると、
   * その操作が途中で巻き戻る (グラフの移動直後にシェルがラベル位置を書き戻す、など)。
   * その場合は操作が終わって select に戻ったときに `mode` の effect からもう一度ここへ来る。
   */
  const reconcileWithDocument = useCallback(() => {
    const documentSnapshot = overlay.overlaySnapshot;
    if (reconciledDocumentSnapshotRef.current === documentSnapshot || !documentSnapshot) {
      reconciledDocumentSnapshotRef.current = documentSnapshot;
      return;
    }
    const emitted = lastEmittedSnapshotRef.current;
    if (emitted && documentSnapshot.shapes === emitted.shapes && documentSnapshot.assets === emitted.assets) {
      reconciledDocumentSnapshotRef.current = documentSnapshot;
      return;
    }
    if (modeRef.current.id !== "overlay.select" || saveTimeoutRef.current !== undefined || pendingOverlayHistoryRef.current) {
      return;
    }
    reconciledDocumentSnapshotRef.current = documentSnapshot;
    const normalized = normalizeOverlaySnapshot(documentSnapshot);
    if (
      areStructurallyEqual(normalizeOverlayGroups(normalized.shapes), shapesRef.current)
      && areStructurallyEqual(normalized.assets, assetsRef.current)
    ) {
      return;
    }
    applyExternalSnapshot(normalized);
  }, [applyExternalSnapshot, assetsRef, lastEmittedSnapshotRef, modeRef, overlay.overlaySnapshot, pendingOverlayHistoryRef, reconciledDocumentSnapshotRef, saveTimeoutRef, shapesRef]);


  useEffect(() => {
    const documentSnapshot = overlay.overlaySnapshot;
    const revisionChanged = externalRevisionRef.current !== externalRevision;
    const snapshotChanged = seenDocumentSnapshotRef.current !== documentSnapshot;
    externalRevisionRef.current = externalRevision;
    seenDocumentSnapshotRef.current = documentSnapshot;

    if (revisionChanged) {
      reconciledDocumentSnapshotRef.current = documentSnapshot;
      applyExternalSnapshot(normalizeOverlaySnapshot(documentSnapshot));
      return;
    }
    if (snapshotChanged) {
      reconcileWithDocument();
    }
  }, [applyExternalSnapshot, externalRevision, externalRevisionRef, overlay.overlaySnapshot, reconcileWithDocument, reconciledDocumentSnapshotRef, seenDocumentSnapshotRef]);


  useEffect(() => {
    if (mode.id === "overlay.select") {
      reconcileWithDocument();
    }
  }, [mode.id, reconcileWithDocument]);

}
