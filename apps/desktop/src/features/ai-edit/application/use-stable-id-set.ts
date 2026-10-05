"use client";

import { useMemo } from "react";

/**
 * 中身 (id の集合) が同じ間は同じ `Set` を返す。並び順や入れ物 (配列・Set) は問わない。
 *
 * 紙面の拡張 (図形の印・編集の方針) はこの集合から作るので、毎回新しい `Set` を渡すと、中身が
 * 変わらない描き直し (破棄理由の入力・保存など) のたびに紙面全体が作り直される。
 */
export function useStableIdSet(ids: Iterable<string>): ReadonlySet<string> {
  const sorted = [...new Set(ids)].sort();
  const key = sorted.join("\u0000");
  // 中身の key だけで作り直す (同じ中身の新しい入れ物は無視する)。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo<ReadonlySet<string>>(() => new Set(sorted), [key]);
}
