"use client";
import { normalizeOverlaySnapshot, type PageOverlay } from "@/features/document";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OverlayChangeOptions } from "../page-overlay-types";
import { createOverlayShapeId } from "./ids";
import type { PendingOverlaySave } from "./pending-save";
import { createGraphOwnedTextLabelReconciler } from "./shapes/graph-labels";
import type { OverlayAsset, OverlayShape, OverlaySnapshot } from "./types";

/** Derived editing session only. SigmaDoc and history remain owned by the host. */
interface SnapshotStateOptions {
  overlay: PageOverlay;
  canvasWidth: number;
  canvasHeight: number;
  documentId?: string;
  externalRevision: number;
  onChange(overlay: PageOverlay, options?: OverlayChangeOptions): void;
}

export function useOverlaySnapshotState({
  overlay, canvasWidth, canvasHeight, documentId, externalRevision, onChange,
}: SnapshotStateOptions) {

  const initialSnapshot = useMemo(() => normalizeOverlaySnapshot(overlay.overlaySnapshot), [overlay.overlaySnapshot]);
  const [shapes, setShapes] = useState<OverlayShape[]>(initialSnapshot.shapes);
  const [assets, setAssets] = useState<Record<string, OverlayAsset>>(initialSnapshot.assets);
  const [reconcileGraphLabels] = useState(() => createGraphOwnedTextLabelReconciler(createOverlayShapeId));

  const canvasWidthRef = useRef(canvasWidth);
  const canvasHeightRef = useRef(canvasHeight);
  const documentIdRef = useRef(documentId);
  useEffect(() => {
    documentIdRef.current = documentId;
  }, [documentId]);
  useEffect(() => {
    canvasWidthRef.current = canvasWidth;
  }, [canvasWidth]);
  useEffect(() => {
    canvasHeightRef.current = canvasHeight;
  }, [canvasHeight]);
  const saveTimeoutRef = useRef<number | undefined>(undefined);
  const pendingOverlayHistoryRef = useRef<PendingOverlaySave | null>(null);
  /**
   * 次に積まれる図形変更へ付けるコアレスキー (混在ペースト / 混在カット)。
   *
   * `deleteSelectedShapes` / `setShapes` の**シグネチャを変えずに**キーを運ぶための ref。
   * `deleteSelectedShapes` は `runContextMenuAction(deleteSelectedShapes)` としてコールバック値
   * のまま渡されており、引数を足すとイベントオブジェクトが options として流れ込む。
   */
  const pendingOverlaySaveHistoryGroupRef = useRef<string | null>(null);
  const imageCropDirtyRef = useRef(false);
  const mountedRef = useRef(false);
  const suppressNextSaveRef = useRef(false);
  const explicitlySavedShapeStatesRef = useRef(new WeakSet<OverlayShape[]>());
  const externalRevisionRef = useRef(externalRevision);
  // 直近に自分が文書へ書いたスナップショットと、文書側で最後に見たスナップショット。
  // 文書の overlay が「自分の書き込みの反響」でも「同じ内容」でもなく変わったら、それは
  // 外から来た変更 (AI提案の適用など) なので、自分の状態を捨てて文書に合わせる。
  // ホワイトボードではこの編集面が常設なので、これが無いと外部適用が画面に出ない。
  const lastEmittedSnapshotRef = useRef<OverlaySnapshot | null>(null);
  const seenDocumentSnapshotRef = useRef(overlay.overlaySnapshot);
  // 反響・同内容・採用のいずれかで「見終えた」文書スナップショット。作業中で見送ったものは
  // ここに入らないので、select に戻ったときにそれだけをもう一度見る。
  const reconciledDocumentSnapshotRef = useRef(overlay.overlaySnapshot);
  const onChangeRef = useRef(onChange);
  const shapesRef = useRef(shapes);
  const assetsRef = useRef(assets);
  const extensionsRef = useRef(initialSnapshot.extensions);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // コミットした state を ref へ写す (updater が 2 度呼ばれて ref と state の同一性がずれても揃え直す)。
  // ただし最初の state は写さない。ref はその値で始まっているので写す意味が無く、写すと壊す:
  // 編集面を開いたときのレイアウト effect はアンカーを解いた図形を ref へ先に書いて setShapes する。
  // その描き直しより前に走るこの effect が最初の state (保存座標のまま) で ref を巻き戻し、
  // それを読んだグラフのラベル整合が setShapes すると、本文に付いた図形が保存時の位置へ
  // 戻って見えた (#207)。本文が動くまで解き直されないので、Enter で戻るように見えていた。
  const initialShapesRef = useRef(shapes);
  useEffect(() => {
    if (shapes === initialShapesRef.current) {
      return;
    }
    shapesRef.current = shapes;
  }, [shapes]);

  useEffect(() => {
    const next = reconcileGraphLabels(
      shapesRef.current,
      { width: canvasWidth, height: canvasHeight },
    );
    if (next === shapesRef.current) {
      return;
    }

    shapesRef.current = next;
    setShapes(next);
  }, [canvasWidth, canvasHeight, reconcileGraphLabels, shapes]);

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);
  return {
    shapes,
    setShapes,
    assets,
    setAssets,
    canvasWidthRef,
    canvasHeightRef,
    documentIdRef,
    saveTimeoutRef,
    pendingOverlayHistoryRef,
    pendingOverlaySaveHistoryGroupRef,
    imageCropDirtyRef,
    mountedRef,
    suppressNextSaveRef,
    explicitlySavedShapeStatesRef,
    externalRevisionRef,
    lastEmittedSnapshotRef,
    seenDocumentSnapshotRef,
    reconciledDocumentSnapshotRef,
    onChangeRef,
    shapesRef,
    assetsRef,
    extensionsRef,
  };
}
