import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// 起動画面 (静的HTMLのスプラッシュ) は窓を開いた直後に描かれる。共有教材の復元のように教材の数に
// 比例する準備をその前に待つと、アプリを押してから何も出ない時間が秒単位で伸びる (#204)。
it("opens the main window before slow startup work and holds privileged IPC until that work is done", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const ready = source.slice(source.indexOf("app.whenReady().then("));
  const at = (needle: string) => {
    const index = ready.indexOf(needle);
    expect(index, needle).toBeGreaterThanOrEqual(0);
    return index;
  };
  expect(at("holdTrustedIpcUntil(")).toBeLessThan(at("registerIpc();"));
  expect(ready.slice(0, at("createWindow();"))).not.toMatch(/\bawait\b/u);
  expect(at("createWindow();")).toBeLessThan(at("await collaborationSessions.initialize()"));
  for (const step of ["await startSessionBridge(", "startLocalStoreWatch();", "startAiSettingsWatch();"]) {
    expect(at(step)).toBeLessThan(at("finishStartup();"));
  }
});
