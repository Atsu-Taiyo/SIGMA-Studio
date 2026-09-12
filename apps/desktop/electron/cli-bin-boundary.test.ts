import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * CLI の bin パスを受け取る IPC は 2 系統ある — 共通の `registerCliBinIpc` (claude / gemini) と、
 * login/logout を持つために独自実装のまま残っている `codex:*` (`cli-bin-ipc.ts` 冒頭コメント)。
 * 片方だけ検証を入れると **codex 経路にだけ XSS→RCE の橋渡しが残る**。この形の穴が再発しないよう、
 * 「bin を受け取るハンドラは必ず検証を通す」ことをソースで固定する。
 */

const electronDir = import.meta.dirname;

function read(relativePath: string): string {
  return readFileSync(path.join(electronDir, relativePath), "utf8");
}

const BIN_INPUT_SURFACES = ["cli-bin-ipc.ts", "ipc/codex.ts"] as const;

describe("CLI bin input boundary", () => {
  it("validates the bin path in every handler that accepts one", () => {
    // ハンドラ本体を切り出して 1 つずつ見る。ファイル単位で出現回数を数えるだけだと、
    // 同じファイルの別ハンドラが 2 回検証していれば未検証のハンドラが紛れ込める。
    const unvalidated = BIN_INPUT_SURFACES.flatMap((file) => {
      const source = read(file);
      return [...source.matchAll(/ipcMain\.handle\(\s*[`"']([^`"']*(?:set-bin|select-bin))/g)]
        .filter((match) => {
          const body = source.slice(match.index, source.indexOf("ipcMain.handle(", match.index + 1) + 1 || source.length);
          return !body.includes("assertUsableCliBinPath(");
        })
        .map((match) => `${file}: ${match[1]}`);
    });

    expect(unvalidated).toEqual([]);
  });

  it("validates the persisted bin at load time as well as at write time", () => {
    // IPC だけ塞ぐと、このパッチより前のビルドで書き込まれた値 (= まさにこの穴の成果物) が
    // 更新後も毎回 spawn され続ける。
    const main = read("main.ts");
    expect(main).toContain("assertUsableCliBinPath");
    for (const key of ["codexBin", "claudeBin", "antigravityBin"]) {
      expect(main, key).toContain(`usablePersistedBin(desktopSettings.${key})`);
    }
  });

  it("resolves the bin used at spawn time, not just the candidate list", () => {
    // 設定に残る裸名とフォールバックを PATH 解決へ載せないと、`shell` を外したぶん
    // Windows の `.cmd` インストールが ENOENT になる。
    for (const file of [
      "gemini-headless-client.ts",
      "claude-stream-client.ts",
      "codex-app-server-client.ts",
    ]) {
      expect(read(file), file).toContain("resolveCliBinForSpawn(");
    }
  });

  it("keeps the shell decision in one place", () => {
    // 「絶対パスでなければ shell」の分岐が戻ってくると、裸名がコマンド行として再解釈される
    // 経路が復活する。判断は `cli-spawn.ts` にしか無く、各クライアントは spawn の入口ごと
    // 委譲する (`cli-spawn-boundary.test.ts` が入口の一本化そのものを固定する)。
    for (const file of [
      "gemini-headless-client.ts",
      "claude-stream-client.ts",
      "codex-app-server-client.ts",
    ]) {
      const source = read(file);
      expect(source, file).toContain("spawnCliProcess");
      expect(source, file).not.toMatch(/!path\.isAbsolute\([a-zA-Z]+Bin\)/);
      expect(source, file).not.toMatch(/shell:\s*(?:true|should)/);
    }
  });

  it("prefers the directly spawnable Windows extension over the shim", () => {
    // `.cmd` / `.bat` は Node 18.20.2 / 20.12.2 以降 `shell: false` で spawn できない
    // (CVE-2024-27980)。shell が要る経路へ落ちる機会を減らすため候補順で `.exe` を先に置く。
    for (const [file, stem] of [
      ["gemini-headless-client.ts", "agy"],
      ["codex-app-server-client.ts", "codex"],
      ["claude-stream-client.ts", "claude"],
    ] as const) {
      const source = read(file);
      const exeIndex = source.indexOf(`"${stem}.exe"`);
      const cmdIndex = source.indexOf(`"${stem}.cmd"`);
      expect(exeIndex, file).toBeGreaterThanOrEqual(0);
      expect(cmdIndex, file).toBeGreaterThanOrEqual(0);
      expect(exeIndex, file).toBeLessThan(cmdIndex);
    }
  });
});
