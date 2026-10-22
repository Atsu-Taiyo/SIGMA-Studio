"use client";
import {
  pageIndexForModelY,
  pageShift,
  type PageArrangement,
} from "@/features/rendering/core";
import type { ReactNode } from "react";

/**
 * 図形の層をページの並び (`features/rendering/core/page-arrangement.ts`) に合わせて描く。
 *
 * 図形・選択枠・注記の座標はモデル座標 (縦 1 列) のまま持ち、描くときだけ、その y が載る
 * ページのずらしで動かした箱に入れる。1 列では箱を作らない (DOM は従来と同じ)。2 ページ並びでは
 * ずらしが 0 のページでも箱に入れる — ドラッグでページをまたいだときに要素を作り直さないため。
 *
 * 箱は寸法 0 の絶対配置で、`left/top` だけで動かす (transform を使うと重なりの文脈が分かれて
 * 図形どうしの重なり順が崩れる)。
 */
export function OverlayPageShift({
  arrangement,
  y,
  children,
}: {
  arrangement: PageArrangement | null | undefined;
  /** モデル座標の y。これが載るページで動かす。 */
  y: number;
  children: ReactNode;
}) {
  if (!arrangement || arrangement.columns === 1) return <>{children}</>;
  const shift = pageShift(arrangement, pageIndexForModelY(arrangement, y));
  return (
    <div className="overlay-page-shift" style={{ left: shift.x, top: shift.y }}>
      {children}
    </div>
  );
}
