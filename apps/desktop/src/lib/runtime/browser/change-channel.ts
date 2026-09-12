import type { DesktopStorageChangeEvent } from "@/types/desktop";

export interface StorageChangeChannel {
  publish(event: DesktopStorageChangeEvent): void;
  subscribe(handler: (event: DesktopStorageChangeEvent) => void): () => void;
  close(): void;
}

export const BROWSER_STORAGE_CHANNEL_NAME = "sigma-studio:storage";

/**
 * 保存先の変更通知。デスクトップ版の `fs.watch` に対応する。
 *
 * `BroadcastChannel` は**送信元のタブには配信しない**ので、購読者への通知は
 * 自前で行う。エディタ画面と /workspace 画面は別ページなので、同一タブ内の
 * 配信は「同じページに載っている購読者どうし」のためにある。
 */
export function createStorageChangeChannel(
  channelName = BROWSER_STORAGE_CHANNEL_NAME,
): StorageChangeChannel {
  const handlers = new Set<(event: DesktopStorageChangeEvent) => void>();
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(channelName);

  const deliver = (event: DesktopStorageChangeEvent): void => {
    for (const handler of [...handlers]) {
      handler(event);
    }
  };

  channel?.addEventListener("message", (event) => {
    deliver(event.data as DesktopStorageChangeEvent);
  });

  return {
    publish(event) {
      channel?.postMessage(event);
      deliver(event);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    close() {
      handlers.clear();
      channel?.close();
    },
  };
}
