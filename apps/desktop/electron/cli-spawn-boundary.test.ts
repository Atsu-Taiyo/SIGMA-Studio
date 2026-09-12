import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `shell: true` を立てる判断と、shell へ渡すコマンド行の組み立ては **必ず同じ場所に居なければ
 * ならない**。別々に置くと「shell を立てたのにエスケープを通していない」組み合わせが生まれる —
 * 実際 `claude-stream-client` は `--mcp-config <JSON>` (引用符だらけ) を素のまま渡していた。
 *
 * そこで spawn の入口を `cli-spawn.ts` 1 つに固定する。ここが緑である限り、教材本文が
 * cmd.exe のコマンド行へ生で載る経路は構造的に作れない。
 */

const electronDir = import.meta.dirname;
const SPAWN_ENTRY_POINT = "cli-spawn.ts";

function productionSources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const entryPath = path.join(directory, entry);
    if (statSync(entryPath).isDirectory()) {
      return entry === "node_modules" ? [] : productionSources(entryPath);
    }
    return entry.endsWith(".ts") && !entry.includes(".test.") ? [entryPath] : [];
  });
}

const SOURCES = productionSources(electronDir).map((file) => ({
  name: path.relative(electronDir, file).replace(/\\/g, "/"),
  source: readFileSync(file, "utf8"),
}));

describe("CLI spawn boundary", () => {
  it("scans the electron sources it is supposed to guard", () => {
    expect(SOURCES.length).toBeGreaterThan(20);
    expect(SOURCES.some((file) => file.name === SPAWN_ENTRY_POINT)).toBe(true);
  });

  it("imports the process-spawning primitives in exactly one module", () => {
    const importers = SOURCES
      // `node:` 無し・シングルクォート・`require()`・動的 `import()` も同じ入口。
      .filter((file) => /(?:from\s+|require\s*\(\s*|import\s*\(\s*)["'](?:node:)?child_process["']/.test(file.source))
      .map((file) => file.name)
      .sort();

    // `input-source.ts` は macOS の入力ソース切り替え (`execFile` で OS のユーティリティを
    // 叩くだけ) で、CLI の bin パスも教材由来の文字列も一切扱わない。
    expect(importers).toEqual(["cli-spawn.ts", "input-source.ts"]);
  });

  it("never pairs a shell with an argv the caller assembled itself", () => {
    const offenders = SOURCES
      .filter((file) => file.name !== SPAWN_ENTRY_POINT)
      // Electron の `shell` モジュール (`shell.openExternal`) と紛れないよう、spawn の
      // オプションとして書かれた形だけを見る。
      .filter((file) => /\bshell:\s*(?:true|should|use)/.test(file.source))
      .map((file) => file.name);

    expect(offenders).toEqual([]);
  });

  it("routes every CLI launch through the single entry point", () => {
    // 呼び出し単位で見る。ファイル単位だと、既に `spawnCliProcess` を使っているファイル
    // (= まさに守りたい 4 本) に生 `spawn(` を足しても検査を素通りしてしまう。
    const launchers = SOURCES
      .filter((file) => file.name !== SPAWN_ENTRY_POINT && file.name !== "input-source.ts")
      .flatMap((file) => [...file.source.matchAll(/(?<![\w.])(spawn|exec|execSync|execFile)\s*\(/g)]
        .map((match) => `${file.name}: ${match[1]}(`));

    expect(launchers).toEqual([]);
  });

  it("encodes the argv whenever it asks for a shell", () => {
    const entry = SOURCES.find((file) => file.name === SPAWN_ENTRY_POINT)?.source ?? "";
    // `shell: true` を書いている箇所は 1 つだけで、その直前で必ずエンコードを通している。
    const shellSpawns = entry.match(/\.\.\.options,\s*shell:\s*true/g) ?? [];
    expect(shellSpawns).toHaveLength(1);
    const beforeShellSpawn = entry.slice(0, entry.indexOf("...options, shell: true"));
    expect(beforeShellSpawn).toContain("encodeWindowsShellArgv(");
    expect(beforeShellSpawn).toContain("throw new Error(encoded.reason)");
  });
});
