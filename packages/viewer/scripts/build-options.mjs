import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageJson = JSON.parse(
  await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"),
);
const packageNames = [
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {}),
];
const external = packageNames.flatMap((packageName) => [packageName, `${packageName}/*`]);
const desktopSource = resolve(import.meta.dirname, "../../../apps/desktop/src");
export const runtimeAliases = {
  "@/lib/i18n/react": resolve(import.meta.dirname, "../src/i18n-react.ts"),
  "@/lib/i18n": resolve(import.meta.dirname, "../src/i18n.ts"),
  "@": desktopSource,
  "@sigma-studio/viewer-internal/print-surface": resolve(import.meta.dirname, "../../../apps/desktop/src/components/print/PrintPreview.tsx"),
  "@sigma-studio/viewer-internal/schema": resolve(import.meta.dirname, "../../../apps/desktop/src/lib/sigma-doc-schema.ts"),
  "@sigma-studio/viewer-internal/css-safety": resolve(import.meta.dirname, "../../../apps/desktop/src/features/document/css-safety.ts"),
};
const browserDefines = {
  "process.env.NODE_ENV": '"production"',
  "process.env.NEXT_PUBLIC_SIGMA_PERF": '"0"',
};

/** The shipping bundle configuration, also exercised by package-boundary tests. */
export function createBuildOptions() {
  return {
    entryPoints: { index: resolve(import.meta.dirname, "../src/index.ts") },
    outdir: resolve(import.meta.dirname, "../dist"),
    alias: runtimeAliases,
    bundle: true,
    define: browserDefines,
    entryNames: "[name]",
    assetNames: "assets/[name]-[hash]",
    external,
    format: "esm",
    jsx: "automatic",
    logLevel: "info",
    minify: true,
    platform: "browser",
    target: ["es2021"],
  };
}
