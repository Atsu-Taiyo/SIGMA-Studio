import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sigmaUsageFromGateway, type AiUsageSnapshot } from "@/lib/ai/ai-usage";
import { AiUsageStore } from "./ai-usage-store";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function file(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-usage-"));
  temporary.push(dir);
  return path.join(dir, "nested", "ai-usage.json");
}
// 画面への知らせは実際の時刻で読むので、リセットの時刻は「いま」から先に置く。
const NOW = Date.now();
const weekly = (usedRatio: number, resetsAt: number) =>
  sigmaUsageFromGateway({ plan: "pro", included: true, weekly: { usedRatio, resetsAt: new Date(resetsAt).toISOString(), reached: usedRatio >= 1 } }, NOW)!;

describe("AiUsageStore", () => {
  it("remembers the latest value across restarts and tells the screens when it changes", async () => {
    const target = file();
    const seen: AiUsageSnapshot[] = [];
    const store = new AiUsageStore(target, snapshot => seen.push(snapshot));
    expect(store.get(NOW).sigma.state).toBe("unknown");

    const reset = NOW + 3600_000;
    store.set(weekly(0.4, reset));
    // 同じ値を受け取り直しても、画面には知らせない。
    store.set({ ...weekly(0.4, reset), observedAt: NOW + 5 });
    await store.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sigma.windows[0]!.usedRatio).toBe(0.4);

    const reopened = new AiUsageStore(target);
    expect(reopened.get(NOW).sigma).toMatchObject({ state: "available", plan: "pro" });
    // 保存するのは割合・時刻・プラン名だけ。
    expect(Object.keys(JSON.parse(readFileSync(target, "utf8")).sigma).sort()).toEqual(["limitReached", "observedAt", "plan", "provider", "state", "windows"]);
  });

  it("does not show a remembered window after its reset time", async () => {
    const target = file();
    const store = new AiUsageStore(target);
    store.set(weekly(1, NOW + 1000));
    await store.flush();
    expect(new AiUsageStore(target).get(NOW + 500).sigma.limitReached).toBe(true);
    expect(new AiUsageStore(target).get(NOW + 2000).sigma).toMatchObject({ state: "unknown", windows: [], limitReached: false });
  });

  it("forgets one account's value on sign-out, and starts clean from an unreadable file", async () => {
    const target = file();
    const store = new AiUsageStore(target);
    store.set(weekly(0.9, NOW + 1000));
    store.reset("sigma");
    await store.flush();
    expect(new AiUsageStore(target).get(NOW).sigma.state).toBe("unknown");

    writeFileSync(target, "{ not json");
    expect(new AiUsageStore(target).get(NOW).claude.state).toBe("unknown");
  });
});
