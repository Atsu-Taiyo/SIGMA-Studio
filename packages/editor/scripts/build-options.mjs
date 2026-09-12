import { resolve } from "node:path";

const packageJson = (
  await import("../package.json", { with: { type: "json" } })
).default;
const external = [
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {}),
].flatMap((packageName) => [packageName, `${packageName}/*`]);
const desktopSource = resolve(import.meta.dirname, "../../../apps/desktop/src");
const disabledDesktopAi = resolve(import.meta.dirname, "../src/desktop-ai-disabled.tsx");
const privateDesktopAiAliases = {
  "@/features/ai-edit": disabledDesktopAi,
  "@/components/editor/AiEditPanel": disabledDesktopAi,
  "@/components/editor/AiTaskDock": disabledDesktopAi,
  "@/components/editor/AiSettingsDialog": disabledDesktopAi,
  "@/components/editor/ai-inline-placement": disabledDesktopAi,
  "@/lib/ai/ai-surface": disabledDesktopAi,
  "@/lib/ai/codex-ai-edit-client": disabledDesktopAi,
  "@/lib/ai/ai-source-reference-navigation": disabledDesktopAi,
  "@/lib/ai/ai-run-controller": disabledDesktopAi,
  "@/lib/ai/ai-run-session-store": disabledDesktopAi,
  "@/lib/ai/ai-connection": disabledDesktopAi,
  "@/lib/ai/ai-providers": disabledDesktopAi,
};
const runtimeAliases = {
  "@": desktopSource,
  "@sigma-studio/editor-internal/tex-import": resolve(desktopSource, "lib/tex-import.ts"),
  ...privateDesktopAiAliases,
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
    target: ["es2021"],
  };
}
