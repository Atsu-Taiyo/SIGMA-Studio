import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const installedPackage = builderRequire.resolve("app-builder-lib/package.json");
const installedVersion = JSON.parse(await readFile(installedPackage, "utf8")).version;
const installedSource = await readFile(path.join(path.dirname(installedPackage), "out/codeSign/macCodeSign.js"), "utf8");
const script = await readFile(new URL("./patch-electron-builder-keychain.mjs", import.meta.url), "utf8");

async function fixture(run, version = installedVersion, source = installedSource) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-keychain-patch-"));
  try {
    const files = {
      "scripts/patch.mjs": script,
      "apps/desktop/package.json": "{}",
      "node_modules/electron-builder/package.json": '{}',
      "node_modules/app-builder-lib/package.json": JSON.stringify({ version }),
      "node_modules/app-builder-lib/out/codeSign/macCodeSign.js": source,
    };
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const target = path.join(root, "node_modules/app-builder-lib/out/codeSign/macCodeSign.js");
    await run(() => spawnSync(process.execPath, [path.join(root, "scripts/patch.mjs")], { encoding: "utf8" }), target);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the installed builder supports the keychain backport and repeated execution", async () => {
  await fixture(async (patch, target) => {
    const first = patch();
    assert.equal(first.status, 0, first.stderr);
    const fixed = await readFile(target, "utf8");
    assert.ok(fixed.includes("return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);"));
    assert.ok(fixed.includes('"-s", "-k", keychainPassword, keychainFile]'));
    assert.ok(!fixed.includes('"-s", "-k", password, keychainFile]'));
    assert.equal(patch().status, 0);
    assert.equal(await readFile(target, "utf8"), fixed);
  });
});

test("an unreviewed builder version is rejected without modifying its source", async () => {
  await fixture(async (patch, target) => {
    assert.notEqual(patch().status, 0);
    assert.equal(await readFile(target, "utf8"), installedSource);
  }, "999.0.0");
});

test("unexpected source is rejected without applying a partial patch", async () => {
  await fixture(async (patch, target) => {
    assert.notEqual(patch().status, 0);
    assert.equal(await readFile(target, "utf8"), "unexpected source");
  }, installedVersion, "unexpected source");
});
