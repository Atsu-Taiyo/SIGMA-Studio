import { ipcMain } from "../trusted-ipc";

import type { AiProvider } from "@/lib/ai/ai-providers";
import { AI_USAGE_PROVIDERS, type AiUsageSnapshot } from "@/lib/ai/ai-usage";

export interface RegisterAiUsageIpcDeps {
  /** 覚えている値。 */
  read: () => AiUsageSnapshot;
  /** AI に問い合わせて、覚えている値を更新する。`start` は、止まっている AI を起こしてでも読むか。 */
  refresh: (providers: readonly AiProvider[], options: { start: boolean }) => Promise<void>;
}

function asProvider(value: unknown): AiProvider | null {
  return AI_USAGE_PROVIDERS.find(provider => provider === value) ?? null;
}

export function registerAiUsageIpc(deps: RegisterAiUsageIpcDeps): void {
  ipcMain.handle("ai-usage:get", async () => deps.read());

  // 設定画面・チャットを開いたときの読み直し。利用者が見に来たときなので、止まっている AI も起こして読む。
  ipcMain.handle("ai-usage:refresh", async (_event, provider: unknown) => {
    const one = asProvider(provider);
    await deps.refresh(one ? [one] : AI_USAGE_PROVIDERS, { start: true });
    return deps.read();
  });
}
