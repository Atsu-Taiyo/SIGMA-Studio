import { build } from "esbuild";
import { rename } from "node:fs/promises";

import { createBuildOptions } from "./build-options.mjs";

const buildResult = await build(createBuildOptions());

// WebMCP intentionally reuses these pure SigmaDoc execution modules. Keep the
// allowlist exact so provider/runtime AI code still cannot enter the public package.
const allowedWebMcpExecutionModules = new Set([
  "ai-edit-attachment-names.ts",
  "ai-edit-reference.ts",
  "ai-overlay-placement.ts",
  "sigma-doc-agent-tools.ts",
  "sigma-doc-edit-schema.ts",
  "sigma-doc-search.ts",
  "svg-image.ts",
  "validation-locale.ts",
]);
const forbiddenPrivateAiInputs = Object.keys(buildResult.metafile.inputs).filter((inputPath) => {
  if (inputPath.includes("/features/ai-edit/") || /\/components\/editor\/(?:Ai|ai-)/.test(inputPath)) {
    return true;
  }
  if (!inputPath.includes("/lib/ai/")) return false;
  const fileName = inputPath.slice(inputPath.lastIndexOf("/") + 1);
  return !allowedWebMcpExecutionModules.has(fileName);
});
if (forbiddenPrivateAiInputs.length > 0) {
  throw new Error(
    `公開Editorのbundleにデスクトップ専用AI実装が混入しています:\n${forbiddenPrivateAiInputs.join("\n")}`,
  );
}

await rename(
  new URL("../dist/index.css", import.meta.url),
  new URL("../dist/styles.css", import.meta.url),
);
