import { load, dump } from "js-yaml";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkDesktopRuntimeBeforeInstall } from "./check-desktop-runtime-lock.mjs";
import { checkWorkspaceLockfile } from "./check-workspace-lockfile.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = { workspaces: load(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")).packages };
const baseline = load(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));

function withLock(t, mutate, check = checkWorkspaceLockfile) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sigma-lock-regression-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const location of ["", ...manifest.workspaces]) {
    cpSync(path.join(root, location, "package.json"), path.join(directory, location, "package.json"));
  }
  cpSync(path.join(root, "pnpm-workspace.yaml"), path.join(directory, "pnpm-workspace.yaml"));
  const lock = structuredClone(baseline);
  mutate(lock);
  writeFileSync(path.join(directory, "pnpm-lock.yaml"), dump(lock));
  return () => check(directory);
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
    delete lock.importers["tests/fixtures/editor-react18"];

  }), /Root workspace list differs/);
});

test("a broken workspace link fails even if its manifest remains", (t) => {
  assert.throws(withLock(t, lock => {
    lock.importers["tests/fixtures/editor-react18"].dependencies["@sigma-studio/editor"].version = "link:../../../packages/missing";
  }), /Missing workspace link/);
});

test("a missing React 18 install cannot be replaced by the hoisted React 19 graph", (t) => {
  assert.throws(withLock(t, (lock) => {
    lock.importers["tests/fixtures/editor-react18"].dependencies["react-dom"].version = "19.3.0";
  }), /Missing required dependency.*react-dom|React major differs.*react-dom/);
});

test("React 18's scheduler cannot disappear during regeneration", (t) => {
  assert.throws(withLock(t, (lock) => {
    for (const location of Object.keys(lock.snapshots)) {
      if (location.startsWith("scheduler@")) delete lock.snapshots[location];
    }
  }), /Missing required dependency.*scheduler/);
});

test("declared workspace dependencies cannot be omitted from lock metadata", (t) => {
  assert.throws(withLock(t, (lock) => {
    delete lock.importers["tests/fixtures/editor-react18"].dependencies.react;
  }), /Workspace dependencies differ/);
});

test("new workspaces cannot be silently omitted from the root lock entry", (t) => {
  assert.throws(withLock(t, (lock) => {
    delete lock.importers["tests/fixtures/editor-react18"];
  }), /Root workspace list differs/);
});

test("a missing transitive required dependency fails", (t) => {
  assert.throws(withLock(t, (lock) => {
    for (const location of Object.keys(lock.snapshots)) {
      if (location.startsWith("csstype@")) delete lock.snapshots[location];
    }
  }), /Missing required dependency.*csstype/);
});

// Only the Electron runtime requires an exact declaration at this stage.
test("ordinary dependencies may have range notation in lock metadata", (t) => {
  assert.equal(withLock(t, (lock) => {
    lock.importers["apps/desktop"].dependencies.ws.specifier = `^${baseline.importers["apps/desktop"].dependencies.ws.specifier}`;
  })(), manifest.workspaces.length);
});

test("the Electron pin can be checked before installing any dependency", (t) => {
  assert.equal(withLock(t, () => {}, checkDesktopRuntimeBeforeInstall)(),
    baseline.importers["apps/desktop"].devDependencies.electron.version);
});

test("Electron range metadata fails in both lockfile checks", (t) => {
  const modify = (lock) => { lock.importers["apps/desktop"].devDependencies.electron.specifier = "^45.3.0"; };
  for (const check of [checkDesktopRuntimeBeforeInstall, checkWorkspaceLockfile]) {
    assert.throws(withLock(t, modify, check), /Electron lockfile declaration differs/);
  }
});

test("an incorrect resolved Electron version fails before installation", (t) => {
  const modify = (lock) => { lock.importers["apps/desktop"].devDependencies.electron.version = "0.0.0"; };
  assert.throws(withLock(t, modify, checkDesktopRuntimeBeforeInstall), /Lockfile runtime differs from packaging/);
});
