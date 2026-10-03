import { resolve } from "node:path";

const packageJson = (
  await import("../package.json", { with: { type: "json" } })
).default;
const external = [
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {}),
].flatMap((packageName) => [packageName, `${packageName}/*`]);
const desktopSource = resolve(import.meta.dirname, "../../../apps/desktop/src");
const runtimeAliases = {
  "@": desktopSource,
  "@sigma-studio/editor-internal/tex-import": resolve(desktopSource, "lib/tex-import.ts"),
  "@sigma-studio/editor-internal/editor-shell": resolve(import.meta.dirname, "../../../apps/desktop/src/components/editor/EditorShell.tsx"),
  "@sigma-studio/editor-internal/page-canvas-editor": resolve(import.meta.dirname, "../../../apps/desktop/src/components/editor/PageCanvasEditor.tsx"),
  "@sigma-studio/editor-internal/i18n": resolve(import.meta.dirname, "../../../apps/desktop/src/lib/i18n/index.ts"),
  "next/dynamic": resolve(import.meta.dirname, "../src/next-dynamic-shim.tsx"),
};

/** The shipping bundle configuration, also exercised by package-boundary tests. */
export function createBuildOptions() {
  return {
    entryPoints: { index: resolve(import.meta.dirname, "../src/index.ts") },
    outdir: resolve(import.meta.dirname, "../dist"),
    alias: runtimeAliases,
    assetNames: "assets/[name]-[hash]",
    banner: {
      js: 'import * as __sigmaReactRuntime from "react"; const require = (id) => { if (id === "react") return __sigmaReactRuntime; throw new Error(`Unsupported bundled require: ${id}`); };',
    },
    bundle: true,
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_SIGMA_PERF": '"0"',
      // emf-converter's optional raster alignment diagnostics are Node env reads.
      "process.env.HDX": '"0"',
      "process.env.HDY": '"0"',
    },
    entryNames: "[name]",
    external,
    format: "esm",
    jsx: "automatic",
    loader: {
      ".eot": "file",
      ".gif": "file",
      ".jpeg": "file",
      ".jpg": "file",
      ".png": "file",
      ".svg": "file",
      ".ttf": "file",
      ".woff": "file",
      ".woff2": "file",
    },
    logLevel: "info",
    metafile: true,
    minify: true,
    platform: "browser",
    plugins: [{
      name: "browser-optional-native-canvas",
      setup(build) {
        // emf-converter uses DOM/OffscreenCanvas in browsers and catches this
        // optional import on Node. An external import would still make consumers
        // such as Vite try to bundle the native addon, so preserve the rejection.
        build.onResolve({ filter: /^@napi-rs\/canvas$/ }, ({ importer }) => {
          if (!/[\\/]emf-converter[\\/]/.test(importer)) return;
          return { path: "native-canvas", namespace: "browser-optional-native" };
        });
        build.onLoad({ filter: /.*/, namespace: "browser-optional-native" }, () => ({
          contents: 'throw new Error("Native canvas is unavailable in the browser bundle");',
          loader: "js",
        }));
      },
    }],
    target: ["es2021"],
  };
}
