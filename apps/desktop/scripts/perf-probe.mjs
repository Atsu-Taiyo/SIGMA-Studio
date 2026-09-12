/**
 * perf-probe のランナー: 本番ビルド → `out/` を空きポートで配信 → playwright で計測 →
 * `perf-reports/<timestamp>/` に JSON と summary.md。
 *
 *   npm run perf:probe                 # ビルドから
 *   npm run perf:probe -- --no-build   # 直前の計測ビルド (perf-out/) を使い回す
 *   npm run perf:probe -- --fixture body
 *   npm run perf:probe -- --report-only  # 予算 assert を外して計測だけする
 *
 * 予算 (`perf-budget.json`) の assert は **既定で有効**。所要時間はビルド込みで 10〜20 分
 * なので `npm run test:e2e` の既定には入れない (`SIGMA_PERF_PROBE` gate を維持)。
 *
 * dev サーバの数値を使わないための実行系である点が肝。`next dev` は React の development
 * ビルドで、打鍵コストが数倍に膨らむ。
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkStaticExport,
  PERF_BUILD_MARKER_FILE,
  startStaticExportServer,
} from "./static-export-server.mjs";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(desktopDir, "out");
// 計測用ビルドは `out/` から退避して配る。`next build` の出力先は 1 つしかないので、
// ここで分けておかないと後続の `test:e2e:export` / `csp:smoke` が計測入りビルドを掴む。
const perfOutDir = path.join(desktopDir, "perf-out");
const specPath = "tests/e2e/perf-probe.spec.ts";

/**
 * 計測対象。`tests/e2e/perf-probe.spec.ts` の `FIXTURES` と同じ並び。
 * ずれると「打ち間違えた名前で 4 件 skip → 何も測らずに緑」になるので、
 * `tests/perf-harness.test.ts` が spec 側との一致を固定している。
 */
const KNOWN_FIXTURES = ["body-150", "body-600", "body", "problem"];

const args = process.argv.slice(2);
const skipBuild = args.includes("--no-build");
// 予算 assert は既定で有効。`--report-only` / `SIGMA_PERF_REPORT_ONLY=1` でだけ外す。
const reportOnly = args.includes("--report-only") || process.env.SIGMA_PERF_REPORT_ONLY === "1";
const fixture = readOption(args, "--fixture") ?? process.env.SIGMA_PERF_FIXTURE ?? "all";

// 名前を打ち間違えると playwright は「全部 skip」で **exit 0** を返す。
// つまり `--fixture bdoy` が「何も測っていないのに緑」になる。ここで落とす。
if (fixture !== "all" && !KNOWN_FIXTURES.includes(fixture)) {
  console.error(`[perf-probe] 未知のフィクスチャ "${fixture}"`);
  console.error(`[perf-probe] 指定できるのは: all, ${KNOWN_FIXTURES.join(", ")}`);
  process.exit(2);
}
const outputDir = process.env.SIGMA_PERF_OUT
  ?? path.join(desktopDir, "perf-reports", new Date().toISOString().replace(/[:.]/g, "-"));

/** 計測対象のソース revision。dirty なら印を付ける (比較の基準にするため)。 */
function describeSourceRevision() {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: desktopDir }).toString().trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: desktopDir }).toString().trim();
    return dirty ? `${head}-dirty` : head;
  } catch {
    return "unknown";
  }
}

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) {
    return null;
  }
  const value = argv[index + 1];
  // `--fixture --no-build` のように値を書き忘れたとき、次のフラグを値として食わない。
  return value.startsWith("--") ? null : value;
}

function run(command, commandArgs, env) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: desktopDir,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(`${command} を起動できませんでした: ${error.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

if (!skipBuild) {
  console.log("[perf-probe] 本番ビルド (NEXT_PUBLIC_SIGMA_PERF=1) を開始します");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const buildCode = await run(npmCommand, ["run", "perf:build"], {});
  if (buildCode !== 0) {
    console.error("[perf-probe] ビルドに失敗しました");
    process.exit(buildCode);
  }
  // 印は `perf:build` が `out/` に書いている (計測入りビルドのまま e2e / CSP スモークを
  // 回そうとした人はそちらで止まる)。退避先にも書き直すのは、`cpSync` が mtime を
  // 保存しない = コピー後の印と index.html の前後関係が保証されないため。
  rmSync(perfOutDir, { force: true, recursive: true });
  cpSync(outDir, perfOutDir, { recursive: true });
  // 「いつ・どのソースを測ったか」を焼く。`--no-build` で測り直したとき、
  // 実は編集前のビルドを測っていた、という取り違えを artifact 側で見破れるようにする。
  writeFileSync(
    path.join(perfOutDir, PERF_BUILD_MARKER_FILE),
    `${new Date().toISOString()}\n${describeSourceRevision()}\n`,
  );
}

const problem = checkStaticExport(perfOutDir, "npm run perf:probe", { expectPerfBuild: true });
if (problem) {
  console.error(problem);
  process.exit(2);
}

const markerPath = path.join(perfOutDir, PERF_BUILD_MARKER_FILE);
const builtRevision = existsSync(markerPath)
  ? (readFileSync(markerPath, "utf8").split("\n")[1] ?? "unknown").trim()
  : "unknown";
const currentRevision = describeSourceRevision();
if (skipBuild && builtRevision !== currentRevision) {
  // ここで黙って進むと「編集前のビルドの数字」を before/after として PR に貼ることになる。
  console.warn("");
  console.warn("[perf-probe] 警告: 配信するビルドは今のソースから作られていません。");
  console.warn(`[perf-probe]   ビルド時: ${builtRevision}`);
  console.warn(`[perf-probe]   現在:     ${currentRevision}`);
  console.warn("[perf-probe]   --no-build を外して測り直してください。");
  console.warn("");
}

const { server, baseURL } = await startStaticExportServer(perfOutDir);
console.log(`[perf-probe] ${perfOutDir} を ${baseURL} で配信します`);
console.log(`[perf-probe] レポート出力先: ${outputDir}`);
console.log(`[perf-probe] 予算 assert: ${reportOnly ? "報告のみ (無効)" : "有効"}`);

const playwrightCode = await run(
  path.join(desktopDir, "..", "..", "node_modules", ".bin", "playwright"),
  ["test", specPath],
  {
    SIGMA_STUDIO_E2E_BASE_URL: baseURL,
    SIGMA_PERF_PROBE: "1",
    SIGMA_PERF_OUT: outputDir,
    SIGMA_PERF_FIXTURE: fixture,
    // 継承させない。一度 export された `SIGMA_PERF_REPORT_ONLY=1` が、以後ずっと
    // 黙って門を無効化するのを防ぐ (報告のみは今や「危ない側」なので明示だけで入れる)。
    SIGMA_PERF_REPORT_ONLY: reportOnly ? "1" : "",
  },
);
server.close();

// summary は **各フィクスチャが書いた断片から組み直す**。
// spec の `afterAll` が書く summary.md は、落ちたフィクスチャのワーカーが止まった後に
// 次のワーカーが上書きするので、落ちた分が消える (exit 1 なのに「違反なし」と書いてある
// レポートが実際に生成されていた)。断片は assert より前に書かれるので消えない。
const summaryPath = path.join(outputDir, "summary.md");
const fragments = KNOWN_FIXTURES
  .map((name) => path.join(outputDir, `${name}.summary.md`))
  .filter((file) => existsSync(file));

if (fragments.length > 0) {
  const header = [
    `<!-- 予算 assert: ${reportOnly ? "報告のみ (無効)" : "有効"} / 計測ビルド: ${builtRevision} -->`,
    `- 予算 assert: **${reportOnly ? "報告のみ (無効)" : "有効"}**`,
    `- 計測ビルド: \`${builtRevision}\``,
    "",
  ].join("\n");
  // レポートだけを見た人が「これは門が効いた状態の数字か」を判断できるようにする。
  writeFileSync(summaryPath, header + fragments.map((file) => readFileSync(file, "utf8")).join("\n"));
  console.log("");
  console.log(readFileSync(summaryPath, "utf8"));
  console.log(`[perf-probe] summary: ${summaryPath}`);
} else {
  // 1 つも測れていないのに 0 で終わると「緑の空振り」になる。
  console.error(`[perf-probe] 計測結果がありません (summary を作れませんでした): ${outputDir}`);
  process.exit(playwrightCode === 0 ? 3 : playwrightCode);
}

process.exit(playwrightCode);
