"use client";
import { useEffect, type RefObject } from "react";
import { FLUSH_OVERLAY_CHANGES_EVENT, type OverlayChangeOptions } from "../page-overlay-types";
import type { OverlayAsset, OverlayShape } from "./types";
interface Dependencies { assets: Record<string, OverlayAsset>; shapes: OverlayShape[]; assetsRef: RefObject<Record<string, OverlayAsset>>; shapesRef: RefObject<OverlayShape[]>; mountedRef: RefObject<boolean>; pendingOverlaySaveHistoryGroupRef: RefObject<string | null>; explicitlySavedShapeStatesRef: RefObject<WeakSet<OverlayShape[]>>; suppressNextSaveRef: RefObject<boolean>; commitOverlayChangeNow(options?: OverlayChangeOptions): void; queueOverlaySave(options?: OverlayChangeOptions): void; flushOverlayChange(): void; saveTimeoutRef: RefObject<number | undefined>; imageCropDirtyRef: RefObject<boolean>; }

/** Run after external snapshot adoption so echoes/Undo never queue a new save. */
export function useOverlaySaveEffects({
  assets,
  shapes,
  assetsRef,
  shapesRef,
  mountedRef,
  pendingOverlaySaveHistoryGroupRef,
  explicitlySavedShapeStatesRef,
  suppressNextSaveRef,
  commitOverlayChangeNow,
  queueOverlaySave,
  flushOverlayChange,
  saveTimeoutRef,
  imageCropDirtyRef,
}: Dependencies) {

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }

    // 混在ペースト / 混在カットが置いていったコアレスキーを読み切る。**ガードより先に**
    // 読んで必ず消す — 下の早期 return に取り残すと、次の無関係な図形編集がそのキーを
    // 継承し、その編集だけを戻せなくなる。
    const historyGroup = pendingOverlaySaveHistoryGroupRef.current;
    pendingOverlaySaveHistoryGroupRef.current = null;

    // Snapshot adoption runs before this effect and updates refs immediately,
    // while its setState is rendered next. Do not consume the suppression flag
    // or queue a save from the superseded render: that echo would clear Redo.
    if (shapes !== shapesRef.current || assets !== assetsRef.current) {
      return;
    }

    if (explicitlySavedShapeStatesRef.current.delete(shapes)) {
      return;
    }

    if (suppressNextSaveRef.current) {
      suppressNextSaveRef.current = false;
      return;
    }

    if (historyGroup) {
      // 混在クリップボード操作は離散イベントなので 250ms 待つ理由が無い。むしろ待つと
      // **窓の後ろ側を縛るものが無く**、続けて起きた無関係な図形編集まで同じ undo
      // エントリへ畳まれてしまう。ここで確定させれば窓が操作そのものに閉じる
      // (直前から pending だったキー無しの保存は一緒に畳まれる — それは意図どおり)。
      commitOverlayChangeNow({ historyGroup });
      return;
    }

    queueOverlaySave();
  }, [assets, commitOverlayChangeNow, explicitlySavedShapeStatesRef, mountedRef, pendingOverlaySaveHistoryGroupRef, queueOverlaySave, shapes, suppressNextSaveRef, assetsRef, shapesRef]);

  useEffect(() => {
    window.addEventListener(FLUSH_OVERLAY_CHANGES_EVENT, flushOverlayChange);
    return () => window.removeEventListener(FLUSH_OVERLAY_CHANGES_EVENT, flushOverlayChange);
  }, [flushOverlayChange]);

  useEffect(() => () => {
    if (saveTimeoutRef.current !== undefined || imageCropDirtyRef.current) {
      flushOverlayChange();
    }
  }, [flushOverlayChange, imageCropDirtyRef, saveTimeoutRef]);
}
