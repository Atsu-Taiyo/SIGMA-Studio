"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * 識別子が変わらないコールバック。呼ばれた瞬間の最新の実装へ委譲する。
 *
 * memo 済みの子 (本文ユニット・紙面) へ渡すハンドラは、識別子が変わるだけで子を描き直す。
 * かといって中身の依存を全部 `useCallback` に畳み込むのは、AI 提案のように状態が絡む処理では
 * 現実的でない。**「値は最新・識別子は不変」**という React の event callback 相当をここで用意する。
 *
 * 使ってよいのはイベント/コマンドの実行だけ。レンダー中に呼ぶ値の計算には使わない
 * (最新の実装が反映されるのは commit 後なので、レンダー中に呼ぶと 1 フレーム古い結果になる)。
 */
export function useStableCallback<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  return useCallback((...args: TArgs) => callbackRef.current(...args), []);
}
