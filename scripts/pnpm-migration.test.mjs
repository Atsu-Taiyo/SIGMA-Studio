import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { patchInstalledPackages, patchSource } from "./patch-http-cache-semantics.mjs";

const require = createRequire(import.meta.url);
const { hooks } = require("../.pnpmfile.cjs");

test("pnpm retains the npm TypeScript compiler API for lint tooling only", () => {
  for (const name of ["typescript-eslint", "@typescript-eslint/parser", "eslint-config-next", "ts-api-utils"]) {
    const pkg = { name, version: "unchanged", peerDependencies: { typescript: ">=4.8.4", eslint: ">=9" } };
    assert.equal(hooks.readPackage(pkg), pkg);
    assert.equal(pkg.dependencies.typescript, "5.9.3");
    assert.deepEqual(pkg.peerDependencies, { eslint: ">=9" });
    assert.equal(pkg.version, "unchanged");
  }
  const runtime = { name: "i18next", peerDependencies: { typescript: "^5 || ^6 || ^7" } };
  assert.deepEqual(hooks.readPackage(structuredClone(runtime)), runtime);
});

test("the cache security patch replaces a shared inode without mutating the store", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sigma-pnpm-patch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = readFileSync(require.resolve("http-cache-semantics"), "utf8");
  const original = installed.replace(/        \/\/ SIGMA: max-stale[\s\S]*?(?=        \/\/ In all circumstances)/, "");
  assert.notEqual(original, installed);
  assert.equal(patchSource(original), installed);
  const store = path.join(root, "store-index.js");
  const directory = path.join(root, "node_modules/http-cache-semantics");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "4.3.0" }));
  writeFileSync(store, original);
  const local = path.join(directory, "index.js");
  linkSync(store, local);
  assert.equal(statSync(store).ino, statSync(local).ino);
  patchInstalledPackages(root);
  assert.equal(readFileSync(store, "utf8"), original);
  assert.equal(readFileSync(local, "utf8"), installed);
  assert.notEqual(statSync(store).ino, statSync(local).ino);
  patchInstalledPackages(root);
  assert.equal(readFileSync(local, "utf8"), installed);
});
