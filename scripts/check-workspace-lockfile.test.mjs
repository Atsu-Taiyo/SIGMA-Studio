import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkWorkspaceLockfile } from "./check-workspace-lockfile.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const baseline = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));

function withLock(t, mutate) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sigma-lock-regression-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const location of ["", ...manifest.workspaces]) {
    cpSync(path.join(root, location, "package.json"), path.join(directory, location, "package.json"));
  }
  const lock = structuredClone(baseline);
  mutate(lock);
  writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify(lock));
  return () => checkWorkspaceLockfile(directory);
}

test("complete React 18 and React 19 workspace graph passes without node_modules", (t) => {
  assert.equal(withLock(t, () => {})(), manifest.workspaces.length);
});

test("Dependabot must scan workspace manifests and preserve React majors", () => {
  const config = readFileSync(path.join(root, ".github/dependabot.yml"), "utf8");
  const npm = config.split("package-ecosystem: npm")[1].split("package-ecosystem: github-actions")[0];
  assert.doesNotMatch(npm, /^\s*exclude-paths:/m, "Excluding a workspace drops it during lockfile generation");
  for (const name of ["react", "react-dom", "@types/react", "@types/react-dom"]) {
    assert.ok(npm.includes(`dependency-name: ${name.startsWith("@") ? `"${name}"` : name}\n        update-types: ["version-update:semver-major"]`));
  }
});

test("the actual Dependabot regression (excluded fixture and link) fails", (t) => {
  assert.throws(withLock(t, (lock) => {
    delete lock.packages["tests/fixtures/editor-react18"];
    delete lock.packages["node_modules/@sigma-studio/editor-react18-fixture"];
  }), /Missing workspace.*editor-react18/);
});

test("a missing workspace symlink fails even if its manifest remains", (t) => {
  assert.throws(withLock(t, (lock) => {
    delete lock.packages["node_modules/@sigma-studio/editor-react18-fixture"];
  }), /Missing workspace link/);
});

test("a missing React 18 install cannot be replaced by the hoisted React 19 graph", (t) => {
  assert.throws(withLock(t, (lock) => {
    for (const [location, entry] of Object.entries(lock.packages)) {
      if (location.endsWith("node_modules/react-dom") && entry.version.startsWith("18.")) {
        delete lock.packages[location];
      }
    }
  }), /React major differs.*react-dom/);
});

test("React 18's scheduler cannot disappear during regeneration", (t) => {
  assert.throws(withLock(t, (lock) => {
    for (const location of Object.keys(lock.packages)) {
      if (location.endsWith("node_modules/scheduler")) delete lock.packages[location];
    }
  }), /Missing required dependency.*scheduler/);
});

test("declared workspace dependencies cannot be omitted from lock metadata", (t) => {
  assert.throws(withLock(t, (lock) => {
    delete lock.packages["tests/fixtures/editor-react18"].dependencies.react;
  }), /Workspace dependencies differ/);
});

test("new workspaces cannot be silently omitted from the root lock entry", (t) => {
  assert.throws(withLock(t, (lock) => {
    lock.packages[""].workspaces = lock.packages[""].workspaces.filter((p) => !p.includes("react18"));
  }), /Root workspace list differs/);
});

test("a missing transitive required dependency fails", (t) => {
  assert.throws(withLock(t, (lock) => {
    for (const location of Object.keys(lock.packages)) {
      if (location.endsWith("node_modules/csstype")) delete lock.packages[location];
    }
  }), /Missing required dependency.*csstype/);
});

// Dependabot can generate this harmless metadata difference for a pinned runtime.
test("exact manifest pins may have range notation in lock metadata", (t) => {
  assert.equal(withLock(t, (lock) => {
    lock.packages["apps/desktop"].devDependencies.electron = `^${baseline.packages["apps/desktop"].devDependencies.electron}`;
  })(), manifest.workspaces.length);
});
