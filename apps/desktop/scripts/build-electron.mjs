#!/usr/bin/env node
import { build, context } from "esbuild";
import { releaseCollaborationDefaults } from "./collaboration-build-config.mjs";
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

export async function buildElectron({ watch = false, onBuilt } = {}) {
  const options = {
    ...common,
    define: { __SIGMA_COLLABORATION_DEFAULTS__: JSON.stringify(releaseCollaborationDefaults()) },
    entryPoints: {
      main: path.join(root, "electron/main.ts"),
      preload: path.join(root, "electron/preload.ts"),
      "sigma-doc-mcp-server": path.join(root, "mcp/sigma-doc-mcp-server.ts"),
    },
    outdir: path.join(root, "dist-electron"),
    outExtension: { ".js": ".cjs" },
    plugins: watch ? [{
      name: "desktop-restart",
      setup(builder) {
        builder.onEnd(async (result) => {
          if (!result.errors.length) await onBuilt?.();
        });
      },
    }] : [],
  };
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

  if (watch) {
    const builder = await context(options);
    await builder.watch();
    return builder;
  }
  await build(options);
  console.log("[electron] build complete");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildElectron();
}
