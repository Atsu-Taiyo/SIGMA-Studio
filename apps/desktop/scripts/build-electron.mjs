#!/usr/bin/env node
import { build, context } from "esbuild";
import { releaseCollaborationDefaults } from "./collaboration-build-config.mjs";
import { releaseExtensionDefaults } from "./extension-build-config.mjs";
import { normalizeExportedCssAssets } from "./static-assets.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isBuiltin } from "node:module";
import { readFileSync } from "node:fs";
import { cp, readdir, rm } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const external = [
  "electron",
  // mathlive / i18next は main.cjs へ束ねる。external のままだと実行時に node_modules を
  // 要求し、electron-builder の `files` に載っていないパッケージング事故になる。
  // unused-filename はESM専用なので、配布用CJSへの同梱方針を維持する。
  // yjs は、yjs を使う y-protocols・lib0 と一緒に束ねる。配布物の CJS 版 (dist/yjs.cjs) は lib0 の
  // 関数を名前空間の getter 越しに呼ぶので、起動時に共有教材の journal を全部復号する処理が
  // ESM 版の約2.5倍かかる (#204)。3つとも束ねて Yjs の実体を1つに保つ (2つ読むと型判定が壊れる)。
  ...Object.keys(pkg.dependencies ?? {}).filter((name) => name !== "mathlive" && name !== "i18next" && name !== "unused-filename" && name !== "yjs" && name !== "y-protocols" && name !== "lib0"),
  ...Object.keys(pkg.devDependencies ?? {}),
];
const emitSourceMaps = process.env.SIGMA_STUDIO_ELECTRON_SOURCEMAP === "true";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: emitSourceMaps,
  external,
  logLevel: "info",
  alias: {
    "@": path.join(root, "src"),
    "mathlive/ssr": path.join(root, "electron/mathlive-main-stub.ts"),
    "mathlive": path.join(root, "electron/mathlive-main-stub.ts"),
  },
};

/**
 * 束ねずに残した import (external) は、配布物の node_modules から実行時に読まれる。
 * electron-builder が配布物へ入れるのは `dependencies` だけなので、`devDependencies` の
 * パッケージを main / preload / MCP サーバーが読むと、開発では動いて配布版でだけ落ちる。
 * 画面 (Next の静的出力) だけが使うパッケージは `devDependencies` に置いて配布物を小さく
 * 保ち、その取り違えをここでビルドの失敗にする。
 */
export function findUnpackagedExternals(metafile, dependencyNames) {
  const packaged = new Set(dependencyNames);
  const missing = new Map();
  for (const [output, entry] of Object.entries(metafile.outputs)) {
    for (const item of entry.imports ?? []) {
      if (!item.external) continue;
      const specifier = item.path;
      if (specifier === "electron" || specifier.startsWith("node:") || isBuiltin(specifier)) continue;
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (!packaged.has(name)) missing.set(name, [...(missing.get(name) ?? []), path.basename(output)]);
    }
  }
  return [...missing].map(([name, outputs]) => ({ name, outputs: [...new Set(outputs)].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}

function assertPackagedExternals(metafile) {
  const missing = findUnpackagedExternals(metafile, Object.keys(pkg.dependencies ?? {}));
  if (missing.length === 0) return;
  throw new Error([
    "These packages are loaded at runtime by the Electron bundles but are not in `dependencies`, so the packaged app would not contain them:",
    ...missing.map(({ name, outputs }) => `  - ${name} (${outputs.join(", ")})`),
    "Move them back to `dependencies` in apps/desktop/package.json, or bundle them.",
  ].join("\n"));
}

export async function buildElectron({ watch = false, onBuilt } = {}) {
  const options = {
    ...common,
    define: {
      __SIGMA_COLLABORATION_DEFAULTS__: JSON.stringify(releaseCollaborationDefaults()),
      __SIGMA_EXTENSIONS_CONFIG__: JSON.stringify(releaseExtensionDefaults()),
    },
    entryPoints: {
      main: path.join(root, "electron/main.ts"),
      preload: path.join(root, "electron/preload.ts"),
      "preview-preload": path.join(root, "electron/preview-preload.ts"),
      "tikz-worker": path.join(root, "electron/tikz-worker.ts"),
      "workspace-body-search-worker": path.join(root, "electron/workspace-body-search-worker.ts"),
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
  // An old local build may still contain a former import-worker entry, which is no
  // longer built. Remove stale ones before either the watch or release build.
  for (const name of await readdir(path.join(root, "dist-electron")).catch(() => [])) {
    if (/-import-worker\.cjs(?:\.map)?$/u.test(name)) await rm(path.join(root, "dist-electron", name), { force: true });
  }
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
      rm(path.join(root, "dist-electron/preview-preload.cjs.map"), { force: true }),
    ]);
  }

  if (watch) {
    const builder = await context(options);
    await builder.watch();
    return builder;
  }
  const result = await build({ ...options, metafile: true });
  assertPackagedExternals(result.metafile);
  const assets = await normalizeExportedCssAssets(path.join(root, "out"));
  if (assets.rewrittenUrls) console.log(`[electron] fixed ${assets.rewrittenUrls} static asset URLs in ${assets.rewrittenFiles} stylesheets`);
  console.log("[electron] build complete");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildElectron();
}
