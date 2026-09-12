#!/usr/bin/env node
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const external = [
  "electron",
  // mathlive / i18next は main.cjs へ束ねる。external のままだと実行時に node_modules を
  // 要求し、electron-builder の `files` に載っていないパッケージング事故になる。
  ...Object.keys(pkg.dependencies ?? {}).filter((name) => name !== "mathlive" && name !== "i18next"),
  ...Object.keys(pkg.devDependencies ?? {}),
];
const emitSourceMaps = process.env.SIGMA_STUDIO_ELECTRON_SOURCEMAP === "true";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: emitSourceMaps,
  external,
  logLevel: "info",
  alias: {
    "@": path.join(root, "src"),
    "mathlive/ssr": path.join(root, "electron/mathlive-main-stub.ts"),
    "mathlive": path.join(root, "electron/mathlive-main-stub.ts"),
  },
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, "electron/main.ts")],
    outfile: path.join(root, "dist-electron/main.cjs"),
  }),
  build({
    ...common,
    entryPoints: [path.join(root, "electron/preload.ts")],
    outfile: path.join(root, "dist-electron/preload.cjs"),
  }),
  // Claude Code に渡す MCP サーバーも main と同じ dist-electron/ に同梱する
  // (electron-builder の files は dist-electron/** を既に含むため packaged app にも入る)。
  // 実行時は process.execPath (Electron バイナリ) + ELECTRON_RUN_AS_NODE=1 で起動する。
  build({
    ...common,
    entryPoints: [path.join(root, "mcp/sigma-doc-mcp-server.ts")],
    outfile: path.join(root, "dist-electron/sigma-doc-mcp-server.cjs"),
  }),
]);

// LocalAiResourceStore が起動時に公式skill本文をseedできるよう、main.cjsと同じ
// dist-electron配下へ正本のSKILL.mdをコピーする。electron-builderは同ディレクトリを同梱する。
await rm(path.join(root, "dist-electron", "official-skills"), { recursive: true, force: true });
await cp(
  path.join(root, "electron", "official-skills"),
  path.join(root, "dist-electron", "official-skills"),
  { recursive: true },
);

if (!emitSourceMaps) {
  await Promise.all([
    rm(path.join(root, "dist-electron/main.cjs.map"), { force: true }),
    rm(path.join(root, "dist-electron/preload.cjs.map"), { force: true }),
  ]);
}

console.log("[electron] build complete");
