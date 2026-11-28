import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { AiProvider } from "@/lib/ai/ai-providers";
import {
  AI_USAGE_PROVIDERS,
  dropExpiredUsageWindows,
  emptyAiAccountUsage,
  parseAiUsageSnapshot,
  type AiAccountUsage,
  type AiUsageSnapshot,
} from "@/lib/ai/ai-usage";

// AIごとの利用枠 (使用率とリセットの時刻) を覚えておく場所。
//
// 値の出どころは AI ごとに違う: Claude は実行中に届く知らせだけ、ChatGPT と内蔵AIは問い合わせられる。
// 起動直後の設定画面にも出せるよう、最後に受け取った値をファイルに残す。リセットの時刻を過ぎた窓は
// 読むときに外す (覚えた値を、過ぎた後まで正しいものとして見せない)。
// 残すのは割合・時刻・プラン名だけで、アカウントの識別子や金額は持たない。

/** 受け取った時刻を除いた中身。同じ値の受け取り直しを見分ける。 */
function comparable(usage: AiAccountUsage): string {
  return JSON.stringify({ ...usage, observedAt: null });
}

export class AiUsageStore {
  private snapshot: AiUsageSnapshot;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly onChange: (snapshot: AiUsageSnapshot) => void = () => {},
  ) {
    this.snapshot = parseAiUsageSnapshot(readJson(filePath));
  }

  get(now: number = Date.now()): AiUsageSnapshot {
    const next = {} as AiUsageSnapshot;
    for (const provider of AI_USAGE_PROVIDERS) {
      next[provider] = dropExpiredUsageWindows(this.snapshot[provider], now);
    }
    return next;
  }

  set(usage: AiAccountUsage): void {
    const changed = comparable(this.snapshot[usage.provider]) !== comparable(usage);
    this.snapshot = { ...this.snapshot, [usage.provider]: usage };
    // 同じ値の受け取り直しでは、時刻だけを進めて画面には知らせない。
    if (!changed) return;
    this.persist();
    this.onChange(this.get());
  }

  /** サインアウト・アカウントの切り替えの後に、前の人の値を残さない。 */
  reset(provider: AiProvider): void {
    this.set(emptyAiAccountUsage(provider));
  }

  /** 書き込みが終わるまで待つ (テストとアプリ終了時)。 */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  private persist(): void {
    const body = `${JSON.stringify(this.snapshot, null, 2)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, body, "utf8");
      await fs.rename(temporary, this.filePath);
    }).catch(() => {
      // 表示用の控え。書けなくても、いまの値はメモリにある。
    });
  }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}
