import {
  type OverlayChangeHistory,
  type OverlayChangeOptions
} from "../page-overlay-types";

/**
 * 250ms の保存窓に積まれた変更をまとめる規則。`history` は今までどおり `record` が勝つ。
 *
 * `historyGroup` の合成は下の {@link mergeOverlayHistoryGroup}。
 */
export function mergePendingOverlaySave(
  pending: PendingOverlaySave | null,
  options: OverlayChangeOptions,
): PendingOverlaySave {
  const requestedHistory = options.history ?? "record";
  const requestedGroup = options.historyGroup ?? null;
  if (!pending) {
    return { history: requestedHistory, historyGroup: requestedGroup };
  }
  return {
    history: pending.history === "record" || requestedHistory === "record" ? "record" : "coalesce",
    historyGroup: mergeOverlayHistoryGroup(pending.historyGroup, requestedGroup),
  };
}

/**
 * 同じ 250ms 窓に落ちた 2 つの保存要求のコアレスキーを合成する。
 *
 * - **片方だけがキーを持つ → そのキーを採る。** キー無しの保存 (オーバーレイ編集に入った
 *   ときの再アンカーなど) が窓に残っているのは普通のことで、実測でもペースト直前に 1 本
 *   積まれている。ここでキーを捨てると混在ペーストが畳めず、⌘Z が 2 回必要になる。
 *   採った場合の代償は「その無関係な変更も同じ undo エントリで一緒に戻る」ことだけで、
 *   **失われるものは無い** (エントリは操作前のスナップショットを持っている)。
 * - **両方がキーを持ち、違う → `null`。** 別々の混在操作が同じ窓で衝突したときは畳まず、
 *   独立した undo エントリにするのが安全側。
 */
export function mergeOverlayHistoryGroup(pending: string | null, requested: string | null): string | null {
  if (pending === requested) {
    return pending;
  }
  if (pending === null) {
    return requested;
  }
  if (requested === null) {
    return pending;
  }
  return null;
}
export interface PendingOverlaySave { history: OverlayChangeHistory; historyGroup: string | null; }
