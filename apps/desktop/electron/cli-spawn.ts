import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

/**
 * AI CLI をどう起動してよいかの単一の判断。
 *
 * レンダラで任意 JS が動くと `desktopAPI` 経由で `*:set-bin` を呼べる。設定された文字列は
 * そのまま `spawn` のコマンド名になり、`shell: true` の経路ではコマンド行として解釈される —
 * つまり XSS からホスト OS の任意コマンド実行への橋渡しになる。ここはその橋を落とす場所で、
 * 「絶対パス・実在・起動可能」を満たす値だけを受け取り、shell を使う条件そのものを削る。
 *
 * プラットフォームは **引数で受ける** (`process.platform` を直接読まない)。開発機は macOS で
 * Windows 経路の実機検証ができないため、純関数として単体テストで固定できることが必須になる。
 */

export type CliBinValidation = { ok: true; path: string } | { ok: false; reason: string };

/**
 * ファイルシステムの問い合わせ。Windows 向けの規則を macOS の開発機で**実際に評価する**ために
 * 差し替え可能にしてある — 既定は本物の `fs`。この seam が無いと、win32 の検査は `C:\…` が
 * 存在しないせいで常に「見つかりません」で終わり、テストが自明に緑になる。
 */
export interface CliBinProbe {
  isExecutable(binPath: string): boolean;
  isFile(binPath: string): boolean;
}

const defaultProbe: CliBinProbe = {
  isExecutable(binPath) {
    try {
      accessSync(binPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  isFile(binPath) {
    try {
      return statSync(binPath).isFile();
    } catch {
      return false;
    }
  },
};

/** Windows で「そのまま起動できる」拡張子。実行ビットの無い OS ではこれが唯一の判断材料。 */
const WINDOWS_LAUNCHABLE_EXTENSIONS: ReadonlySet<string> = new Set([".exe", ".com", ".cmd", ".bat"]);

/**
 * `shell: false` で spawn できない Windows のシム。Node は 18.20.2 / 20.12.2 以降、これらを
 * shell 無しで spawn すると `EINVAL` を投げる (CVE-2024-27980 の修正) ので、この 2 つに限っては
 * shell を外せない。だからこそ候補順で `.exe` を先に置き、この経路へ落ちる機会自体を減らす。
 */
const WINDOWS_SHELL_ONLY_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat"]);

const MAX_BIN_PATH_LENGTH = 4096;
const UNSAFE_PATH_CHARACTER = /[\u0000\r\n]/u;
const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * この bin を起動するのに cmd.exe を挟む必要があるか。
 *
 * 以前は「絶対パスでなければ shell」も条件に入っていた。裸名を cmd.exe に PATH 解決させるための
 * 分岐だが、shell 経由は引数がコマンド行として再解釈される経路そのものなので、代わりに
 * {@link resolveBareBinNames} で自前に解決して分岐を消す。
 */
export function isShellSpawnRequired(bin: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") {
    return false;
  }
  return WINDOWS_SHELL_ONLY_EXTENSIONS.has(path.win32.extname(bin).toLowerCase());
}

/**
 * ユーザー (あるいはレンダラ) から渡された bin パスを受け入れてよいか。
 *
 * 空文字は「設定を解除する」意図なので **呼び出し側が先に処理する**。ここでは常に拒否する。
 */
export function assertUsableCliBinPath(
  rawPath: string,
  platform: NodeJS.Platform,
  probe: CliBinProbe = defaultProbe,
): CliBinValidation {
  // プラットフォームは **引数** で分岐する。ambient な `path` を使うと、macOS の開発機では
  // `path.isAbsolute("C:\\x")` が false・`path.delimiter` が `:` になり、Windows 向けの規則が
  // どれも「書いてはあるが一度も評価されない」テストになってしまう。
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  // 各クライアントの `normalizeBin` は前後の引用符を剥がしてから使う。検証はその前に走るので、
  // ここでも剥がさないと Windows エクスプローラの「パスのコピー」(引用符付き) が弾かれる。
  const candidate = stripSurroundingQuotes(rawPath.trim());
  if (!candidate) {
    return { ok: false, reason: te("electron.cliSpawn.emptyPath") };
  }
  if (candidate.length > MAX_BIN_PATH_LENGTH) {
    return { ok: false, reason: te("electron.cliSpawn.pathTooLong") };
  }
  if (UNSAFE_PATH_CHARACTER.test(candidate)) {
    return { ok: false, reason: te("electron.cliSpawn.unsafeControlCharacter") };
  }
  if (platform === "win32") {
    // `path.win32.isAbsolute` は UNC (`\\host\share\payload.exe`) も真にする。`statSync` は SMB /
    // WebDAV を透過的に辿るので、それだけでは「攻撃者のホスト上のバイナリ」を受け入れてしまう
    // (しかも到達不能な UNC への同期 stat はメインプロセスを止める)。ドライブ直下に限定すると、
    // UNC・デバイス名前空間 (`\\?\` `\\.\`)・ルート相対 (`\payload.exe`)・ドライブ相対
    // (`C:payload.exe`) をまとめて落とせる。
    if (!/^[A-Za-z]:[\\/]/.test(candidate)) {
      return { ok: false, reason: te("electron.cliSpawn.localAbsolutePathRequired") };
    }
  } else if (!platformPath.isAbsolute(candidate)) {
    // コマンド文字列 (`cmd /c calc &`) と相対パスをここで落とす。絶対パスであることは
    // 「1 個の実行ファイルを指している」ことの最初の必要条件。
    return { ok: false, reason: te("electron.cliSpawn.absolutePathRequired") };
  }

  if (!probe.isFile(candidate)) {
    return { ok: false, reason: te("electron.cliSpawn.executableNotFound") };
  }

  if (platform === "win32") {
    if (!WINDOWS_LAUNCHABLE_EXTENSIONS.has(platformPath.extname(candidate).toLowerCase())) {
      return { ok: false, reason: te("electron.cliSpawn.windowsExtensionRequired") };
    }
    return { ok: true, path: candidate };
  }

  if (!probe.isExecutable(candidate)) {
    return { ok: false, reason: te("electron.cliSpawn.permissionMissing") };
  }
  return { ok: true, path: candidate };
}

/**
 * Windows の候補リストに含まれる裸名を、PATH と PATHEXT を自前で走査して解決する。
 * 解決できない裸名は落とす (shell 無しでは起動できないため)。
 *
 * 解決結果は **必ず絶対パス**にする。裸名を返すと `shell: true` 経路で cmd.exe が
 * **カレントディレクトリを PATH より先に**解決し、spawn の cwd は AI が書けるワークスペース
 * なので、そこへ `codex.cmd` を置かれると次回の起動でそれが動く (binary planting)。
 * 空白を含む絶対パスは `encodeWindowsShellArgv` がコマンド名ごとクォートして扱う。
 *
 * **posix の候補リストには触らない**: shell を使わない `spawn` でも execvp が PATH から裸名を
 * 解決するので、そこは元から shell に依存していない。
 */
export function resolveBareBinNames(
  candidates: readonly string[],
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  probe: CliBinProbe = defaultProbe,
): string[] {
  if (platform !== "win32") {
    return [...candidates];
  }
  const resolved: string[] = [];
  for (const candidate of candidates) {
    if (path.win32.isAbsolute(candidate)) {
      resolved.push(candidate);
      continue;
    }
    const found = resolveThroughPath(candidate, env, probe);
    if (found) {
      resolved.push(found);
    }
  }
  return [...new Set(resolved)];
}

/**
 * spawn 直前の最後の受け皿。設定ファイルに残っている裸名や、候補が 1 つも解決しなかったときの
 * フォールバック (`?? "claude"`) も PATH 解決に載せる — これが無いと、`shell` を外したぶん
 * Windows の `.cmd` インストールが `ENOENT` で起動しなくなる。
 */
export function resolveCliBinForSpawn(
  bin: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  probe: CliBinProbe = defaultProbe,
): string {
  if (platform !== "win32" || path.win32.isAbsolute(bin)) {
    return bin;
  }
  return resolveThroughPath(bin, env, probe) ?? bin;
}

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * 解決できた結果だけを覚える。**否定はキャッシュしない** — アプリを開いたまま CLI を入れた
 * ユーザーが「再確認」しても見つからないままになり、各クライアントが明示している
 * 「否定はキャッシュせず後からインストールした場合に即座に再検出」という不変条件を壊すため。
 */
const pathLookupCache = new Map<string, string>();

function resolveThroughPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  probe: CliBinProbe,
): string | null {
  const pathEnv = env.PATH ?? env.Path ?? "";
  const pathExt = env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT;
  const cacheKey = `${name}\u0000${pathEnv}\u0000${pathExt}`;
  const cached = pathLookupCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = lookUpThroughPath(name, pathEnv, pathExt, probe);
  if (resolved) {
    pathLookupCache.set(cacheKey, resolved);
  }
  return resolved;
}

function lookUpThroughPath(
  name: string,
  pathEnv: string,
  pathExt: string,
  probe: CliBinProbe,
): string | null {
  // 相対エントリ (`.` や `node_modules\\.bin`) は捨てる。相対パスを返すと `shell: true` 経路で
  // cmd.exe がカレントディレクトリ優先で解決し、絶対パス化で防いだ binary planting が戻る。
  // `assertUsableCliBinPath` と同じ規則。`path.win32.isAbsolute` は UNC (`\\\\host\\share`) と
  // ルート起点 (`\\tools`) も真にするので、それだけでは汚染された PATH からリモート共有の
  // `codex.cmd` を拾ってしまう。
  const directories = pathEnv.split(path.win32.delimiter)
    .filter((directory) => /^[A-Za-z]:[\\/]/.test(directory));
  // 拡張子なしの候補は入れない。npm は Windows に `codex` (sh script) と `codex.cmd` を同居させる
  // ので、拡張子なしを先に採ると `CreateProcess` できないスクリプトへ解決してしまう。
  const extensions = path.win32.extname(name)
    ? [""]
    : pathExt.split(";").map((extension) => extension.trim()).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      // 候補を 1 つずつ `stat` する。ディレクトリを列挙すると System32 級の巨大ディレクトリを
      // 毎回舐めることになり、切断されたネットワークドライブが 1 つあるだけでメインプロセスが
      // SMB のタイムアウト分だけ止まる。Windows のファイル名は大文字小文字を区別しないので、
      // 綴りを合わせる必要は無い。
      const candidate = path.win32.join(directory, `${name}${extension}`);
      if (probe.isFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** CLI 子プロセスのハンドル。クライアント側が `node:child_process` を触らずに済むよう再輸出する。 */
export type CliChildProcess = ChildProcessWithoutNullStreams;

export type WindowsShellArgvEncoding =
  | { ok: true; argv: string[] }
  | { ok: false; reason: string };

/** cmd.exe のコマンド行では表現できない文字。無理に通すと黙って壊れる。 */
const CMD_UNREPRESENTABLE = [
  { character: "\u0000", errorKey: "nulArgument" },
  { character: "\r", errorKey: "newlineArgument" },
  { character: "\n", errorKey: "newlineArgument" },
  // `%` は引用符の中でも cmd.exe が環境変数として展開する。`^` でも `%%` でもコマンド行では
  // リテラルにできないので、黙って値が化ける (= 環境変数の中身が混入する) より止める。
  { character: "%", errorKey: "percentArgument" },
] as const;

/**
 * cmd.exe が「引用の外」で意味を持つ文字。**`"` も含める**のが要点で、`^` を付けずに残すと
 * cmd の引用状態が切り替わり、以降の `&` などが再びコマンド区切りとして効いてしまう。
 * すべての `"` を `^"` にすれば cmd は最後まで引用状態に入らないので、規則が一様になる。
 *
 * **空白 (と `,` `;`) も入れる**: `^"` は「リテラルな引用符」であって引用状態を開かないので、
 * 引用符に「トークンをまとめる」働きは無い。`C:\Program Files\...\claude.cmd` のような空白入りの
 * コマンド名がそこで切れてしまうため、区切り文字自体をエスケープして 1 トークンに保つ
 * (cross-spawn と同じ考え方)。
 */
const CMD_METACHARACTER = /["&<>()^|!,; ]/gu;

/**
 * `shell: true` へ渡す argv を、**cmd.exe と `CommandLineToArgvW` の 2 段**に耐える形へ変換する。
 *
 * Node は `shell: true` のとき `cmd /d /s /c "<file> <args...>"` を組み立てるだけで、file も
 * args も一切クォートしない。そのため教材本文がそのままコマンド行に載り、`&` がコマンド区切りに
 * なる。**コマンド名 (先頭要素) も同じ経路を通す** — 空白入りの絶対パスがそこで壊れるため。
 *
 * 変換は 2 段:
 * 1. `CommandLineToArgvW` の規則で引用する (`"` で囲み、`"` の直前と末尾の `\` を倍化、内部の
 *    `"` を `\"` へ) — 起動される側が 1 引数として読み戻せるようにする
 * 2. cmd.exe のメタ文字を `^` でエスケープする — cmd が引用状態にもコマンド区切りにも入らない
 *
 * 表現できない引数は `{ ok: false }` を返す。呼び出し側は spawn せず理由付きで失敗させる。
 */
export function encodeWindowsShellArgv(args: readonly string[]): WindowsShellArgvEncoding {
  const argv: string[] = [];
  for (const arg of args) {
    for (const { character, errorKey } of CMD_UNREPRESENTABLE) {
      if (arg.includes(character)) {
        return { ok: false, reason: te(`electron.cliSpawn.${errorKey}`) };
      }
    }
    argv.push(quoteForCommandLineToArgvW(arg).replace(CMD_METACHARACTER, "^$&"));
  }
  return { ok: true, argv };
}

/**
 * 引用符は `\"` ではなく **`""` (二重化)** で表す。
 *
 * `shell: true` になるのは `.cmd` / `.bat` のときだけ = 必ず npm/pnpm のシム経由で、シムの
 * 末尾の `%*` は **cmd.exe がもう一度パースする**。cmd にバックスラッシュエスケープは無いので
 * `\"` の `"` はそこで引用を閉じてしまい、続く `&` がコマンド区切りとして生き返る
 * (CVE-2024-24576 / BatBadBut と同型)。`""` なら cmd の引用状態は開閉して釣り合い、
 * 最終的な `CommandLineToArgvW` からは引用符 1 個として読める。
 *
 * 直前のバックスラッシュ列は `2n` 個に倍化する — 倍化しないと、最後の `\` が続く `"` を
 * エスケープしたと読まれて引用が閉じなくなる。
 */
function quoteForCommandLineToArgvW(arg: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const character of arg) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2);
      backslashes = 0;
      quoted += '""';
      continue;
    }
    quoted += "\\".repeat(backslashes);
    backslashes = 0;
    quoted += character;
  }
  quoted += "\\".repeat(backslashes * 2);
  return `${quoted}"`;
}

/**
 * CLI 子プロセスを起動する **唯一の入口**。
 *
 * shell を使うかどうかの判断と、shell を使うときのコマンド行の組み立ては必ず一緒に居なければ
 * ならない。別々の場所に置くと「shell を立てたのにエスケープを通していない」組み合わせが生まれ、
 * 実際 `claude-stream-client` は `--mcp-config <JSON>` (引用符だらけ) を素のまま渡していた。
 *
 * - macOS / Linux: 常に `shell: false` で **生の argv をそのまま渡す** (現行と完全に同一)
 * - Windows の `.cmd` / `.bat`: `encodeWindowsShellArgv` を通す。表現できない引数があれば
 *   **spawn せずに理由付きで throw する** — 黙って壊れる / 黙って任意コマンドが走るよりよい
 */
export function spawnCliProcess(
  bin: string,
  args: readonly string[],
  options: SpawnOptions,
  platform: NodeJS.Platform = process.platform,
): ChildProcessWithoutNullStreams {
  if (!isShellSpawnRequired(bin, platform)) {
    return spawn(bin, [...args], { ...options, shell: false }) as ChildProcessWithoutNullStreams;
  }
  const encoded = encodeWindowsShellArgv([bin, ...args]);
  if (!encoded.ok) {
    throw new Error(encoded.reason);
  }
  const [command, ...encodedArgs] = encoded.argv;
  return spawn(command, encodedArgs, { ...options, shell: true }) as ChildProcessWithoutNullStreams;
}
