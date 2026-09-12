import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const desktopRoot = fileURLToPath(new URL("../../../", import.meta.url));
const i18nDir = fileURLToPath(new URL("./", import.meta.url));

async function bundleInputs(entryPoint: string): Promise<string[]> {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    logLevel: "silent",
    metafile: true,
    alias: { "@": path.join(desktopRoot, "src") },
  });
  return Object.keys(result.metafile.inputs).map((input) => input.replace(/\\/gu, "/"));
}

describe("i18n barrel boundary", () => {
  it("keeps React out of the non-React entry point", async () => {
    // `electron/main.ts` は esbuild で `dist-electron/main.cjs` に束ねられる。
    // barrel が React を再エクスポートすると main プロセスのバンドルが壊れる。
    const inputs = await bundleInputs(path.join(i18nDir, "index.ts"));
    expect(inputs.filter((input) => /\/node_modules\/(?:react|react-dom|react-i18next)\//u.test(input))).toEqual([]);
  });

  it("still bundles i18next itself from the non-React entry point", async () => {
    const inputs = await bundleInputs(path.join(i18nDir, "index.ts"));
    expect(inputs.some((input) => input.includes("/node_modules/i18next/"))).toBe(true);
  });

  it("proves the React check is meaningful by finding React through the React entry point", async () => {
    const inputs = await bundleInputs(path.join(i18nDir, "react.ts"));
    expect(inputs.some((input) => /\/node_modules\/react\//u.test(input))).toBe(true);
  });
});

describe("electron main bundle configuration", () => {
  it("bundles i18next into main.cjs instead of leaving it external", async () => {
    // `dependencies` は既定で全て external になる。i18next を外しておかないと
    // `dist-electron/main.cjs` が実行時に node_modules を要求し、
    // electron-builder の `files` に載っていないパッケージング事故になる
    // (mathlive に同じ先例がある)。
    const source = await readFile(path.join(desktopRoot, "scripts/build-electron.mjs"), "utf8");
    const externalFilter = /\.filter\(\(name\) => ([^)]*)\)/u.exec(source)?.[1] ?? "";
    expect(externalFilter).toMatch(/name !== "i18next"/u);
    expect(externalFilter).toMatch(/name !== "mathlive"/u);
  });
});
