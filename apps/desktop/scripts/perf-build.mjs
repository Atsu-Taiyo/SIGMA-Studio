/**
 * 性能計測用の本番ビルド。
 *
 * `next build` に `NEXT_PUBLIC_SIGMA_PERF=1` を付けるだけでなく、**成果物に印を残す**ところまでを
 * 1 つの操作にしてある。`next build` の出力先は `out/` ひとつしかないので、計測ビルドと配布ビルドは
 * 同じ場所を奪い合う。印を付ける役目を実行系 (perf-probe.mjs) 側に置くと、`npm run perf:build` を
 * 単独で叩いた場合や途中で止めた場合に、印の無い計測ビルドが `out/` に残り、
 * `test:e2e:export` / `csp:smoke` がそれを黙ってテストしてしまう。
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PERF_BUILD_MARKER_FILE } from "./static-export-server.mjs";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(desktopDir, "out");

const child = spawn(
  path.join(desktopDir, "..", "..", "node_modules", ".bin", "next"),
  ["build"],
  {
    cwd: desktopDir,
    env: { ...process.env, NEXT_PUBLIC_TARGET: "desktop", NEXT_PUBLIC_SIGMA_PERF: "1" },
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(`next build を起動できませんでした: ${error.message}`);
  process.exit(1);
});

child.on("close", (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }
  if (!existsSync(outDir)) {
    console.error("out/ が生成されませんでした。");
    process.exit(2);
  }
  writeFileSync(path.join(outDir, PERF_BUILD_MARKER_FILE), `${new Date().toISOString()}\n`);
  console.log(`[perf:build] 計測用ビルドの印を書きました: ${path.join(outDir, PERF_BUILD_MARKER_FILE)}`);
});
