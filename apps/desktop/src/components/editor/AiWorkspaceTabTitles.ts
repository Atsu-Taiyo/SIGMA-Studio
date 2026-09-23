"use client";

import { useMemo, useSyncExternalStore } from "react";

import { aiChatRoomsStore } from "@/lib/ai/ai-run-controller";

/**
 * AIタブの見出しに使う「部屋ID → 表題」。
 *
 * タブ列そのものは AI の実装を知らない (generic なタブの器のまま) ので、購読と
 * 部屋モデルへの依存はこのファイルだけに閉じる。空文字の表題は呼び出し側で既定値へ
 * 落とせるように、ここでは載せない。
 */
export function useAiWorkspaceTabTitles(): ReadonlyMap<string, string> {
  const rooms = useSyncExternalStore(
    aiChatRoomsStore.subscribe,
    aiChatRoomsStore.getSnapshot,
    aiChatRoomsStore.getSnapshot,
  );
  return useMemo(() => new Map(
    rooms.flatMap((room) => {
      const title = room.title?.trim();
      return title ? [[room.id, title] as const] : [];
    }),
  ), [rooms]);
}
