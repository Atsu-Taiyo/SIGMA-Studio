import type { ReactNode } from "react";

import type { OverlayShapeId } from "./types";

/** Visual content supplied by an optional editor feature for one shape. */
export interface OverlayShapeDecoration {
  /** Added to the normal shape class list without changing its geometry. */
  className?: string;
  /** Rendered after the shape body, inside the existing shape bounds. */
  content?: ReactNode;
}

/**
 * Feature-neutral interaction policy for the overlay editor. Keeping the
 * policy outside the canvas lets desktop-only features reserve shapes without
 * making the drawing engine depend on their stores or lifecycle.
 */
export interface OverlayEditPolicy {
  lockedShapeIds: ReadonlySet<OverlayShapeId>;
  /**
   * 選べない図形 (機能が見えなくしたもの)。当たり判定・囲み選択の対象にしない。編集の禁止は
   * `lockedShapeIds` で別に与える。
   */
  unselectableShapeIds?: ReadonlySet<OverlayShapeId>;
  /**
   * 人の編集では保存内容を変えられない図形 (機能が隠していて、文書の変更口が変更を断るもの)。派生の書き換え
   * (削除後の付け替え・保存時の付け替え・固定の補修) もこれを書き換えない (混ざると変更口がそのコミット全体を
   * 断り、無関係な編集まで保存できなくなる)。
   */
  preservedShapeIds?: ReadonlySet<OverlayShapeId>;
  blockedMessage?: string;
  blockedNoticeClassName?: string;
}

export const EMPTY_OVERLAY_EDIT_POLICY: OverlayEditPolicy = {
  lockedShapeIds: new Set(),
};
