/**
 * 静的 export (`out/`) を配って playwright を回す実行系。
 *
 * 既定の e2e は `npm run dev` (= `next dev`) を叩くので、**Electron が実際に読む HTML では
 * ない** — meta の CSP も、静的 export 特有のインラインスクリプトも入っていない。CSP の
 * violation を測るにはビルド成果物そのものを配る必要がある。
 *
 * `SIGMA_STUDIO_E2E_BASE_URL` を設定すると playwright は webServer を起動しない
 * (`playwright.config.ts`)。ここではその仕組みに乗って、`out/` を静的に配りながら
 * playwright を子プロセスとして起動する。
 *
 *   npm run test:e2e:export -- tests/e2e/csp-violations.spec.ts
 *
 * `file://` オリジン固有の差 (`'self'` の解決) だけはこの方法では測れないので、Electron 実機の
 * スモークが別途要る。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkStaticExport, startStaticExportServer } from "./static-export-server.mjs";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(desktopDir, "out");

// 直前に perf 計測を回していると `out/` には計測用ビルドが残っている。ここで止める。
const problem = checkStaticExport(outDir, "npm run electron:prepare");
if (problem) {
  console.error(problem);
  process.exit(2);
}

const { server, baseURL } = await startStaticExportServer(outDir);
const child = spawn(
  path.join(desktopDir, "..", "..", "node_modules", ".bin", "playwright"),
  ["test", ...process.argv.slice(2)],
  {
    cwd: desktopDir,
    env: { ...process.env, SIGMA_STUDIO_E2E_BASE_URL: baseURL },
    stdio: "inherit",
  },
);
child.on("error", (error) => {
  console.error(`playwright を起動できませんでした: ${error.message}`);
  server.close();
  process.exit(1);
});
child.on("close", (code) => {
  server.close();
  process.exit(code ?? 1);
});
