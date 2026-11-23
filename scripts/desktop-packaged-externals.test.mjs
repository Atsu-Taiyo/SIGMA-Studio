import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { findUnpackagedExternals } from "../apps/desktop/scripts/build-electron.mjs";

const metafile = (imports) => ({ outputs: { "dist-electron/main.cjs": { imports } } });

test("reports a runtime import that the packaged app would not contain", () => {
  const found = findUnpackagedExternals(metafile([
    { path: "electron", external: true },
    { path: "node:fs", external: true },
    { path: "fs", external: true },
    { path: "zod/v4", external: true },
    { path: "@modelcontextprotocol/sdk/server/index.js", external: true },
    { path: "three", external: true },
    { path: "@tiptap/core", external: true },
    { path: "./bundled.js" },
  ]), ["zod", "@modelcontextprotocol/sdk"]);
  assert.deepEqual(found, [{ name: "@tiptap/core", outputs: ["main.cjs"] }, { name: "three", outputs: ["main.cjs"] }]);
});

test("screen-only packages stay out of the packaged dependencies", () => {
  // 画面 (Next の静的出力 `out/`) にだけ束ねられるもの。`dependencies` に戻すと、使われない
  // コピーが配布物の node_modules に入る (next と SWC だけで約 200MB)。
  const desktop = JSON.parse(readFileSync(new URL("../apps/desktop/package.json", import.meta.url), "utf8"));
  for (const name of ["next", "@fontsource/noto-serif-jp", "@fontsource/m-plus-1p", "pptx-viewer-core", "pptx-svg", "three"]) {
    assert.equal(desktop.dependencies[name], undefined, `${name} must not be a packaged dependency`);
    assert.ok(desktop.devDependencies[name], `${name} must be a build-time dependency`);
  }
});
