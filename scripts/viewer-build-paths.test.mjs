import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("viewer build emits CSS and fonts from paths containing spaces and URL-special characters", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-viewer-build-"));
  try {
    const fixtureRoot = path.join(temporaryRoot, "SIGMA Studio 日本語 #%");
    const viewerRoot = path.join(fixtureRoot, "packages/viewer");
    await mkdir(viewerRoot, { recursive: true });
    for (const entry of ["package.json", "scripts", "src"]) {
      await cp(path.join(repositoryRoot, "packages/viewer", entry), path.join(viewerRoot, entry), {
        recursive: true,
      });
    }
    // Reuse read-only inputs; the real build writes only to the fixture's dist.
    for (const entry of ["apps", "node_modules"]) {
      await symlink(path.join(repositoryRoot, entry), path.join(fixtureRoot, entry), "junction");
    }

    await run(process.execPath, [path.join(viewerRoot, "scripts/build.mjs")], {
      cwd: fixtureRoot,
      timeout: 30_000,
    });

    const outputRoot = path.join(viewerRoot, "dist");
    assert.ok((await stat(path.join(outputRoot, "index.js"))).size > 0);
    const css = await readFile(path.join(outputRoot, "styles.css"), "utf8");
    assert.match(css, /\.sigma-viewer \.katex/);
    const assets = [...css.matchAll(/url\(["']?(?:\.\/)?(assets\/[^)"']+)["']?\)/g)];
    assert.ok(assets.length > 0, "bundled CSS must reference emitted font assets");
    for (const [, asset] of assets) {
      assert.ok((await stat(path.join(outputRoot, asset))).size > 0, asset);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
