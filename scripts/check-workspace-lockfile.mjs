import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { checkDesktopRuntimeLockfile } from "./check-desktop-runtime-lock.mjs";

const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies"];

export function lockedSnapshotKey(name, reference) {
  if (reference.startsWith("link:")) return undefined;
  return /^\d/.test(reference) ? `${name}@${reference}` : reference;
}

export function checkWorkspaceLockfile(root) {
  const readJson = file => JSON.parse(readFileSync(path.join(root, file), "utf8"));
  const workspace = load(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"));
  const lock = load(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  assert.equal(String(lock.lockfileVersion), "9.0", "Expected pnpm lockfile v9");
  const workspaces = globSync(workspace.packages, { cwd: root }).map(entry => entry.replaceAll("\\", "/"));
  assert.deepEqual(Object.keys(lock.importers).sort(), [".", ...workspaces].sort(), "Root workspace list differs from lockfile");
  for (const location of [".", ...workspaces]) {
    const source = readJson(path.join(location, "package.json"));
    const locked = lock.importers[location];
    assert.ok(locked, `Missing workspace in lockfile: ${location}`);
    for (const field of dependencyFields) {
      assert.deepEqual(Object.keys(locked[field] ?? {}).sort(), Object.keys(source[field] ?? {}).sort(),
        `Workspace ${field} differ: ${location}`);
      for (const [name, entry] of Object.entries(locked[field] ?? {})) {
        // Overrides can legitimately replace the manifest's original specifier;
        // frozen install is authoritative for those ranges.
        assert.equal(typeof entry.specifier, "string", `Missing dependency specifier: ${location} -> ${name}`);
        if (entry.version.startsWith("link:")) {
          const target = path.posix.normalize(path.posix.join(location, entry.version.slice(5)));
          assert.ok(lock.importers[target], `Missing workspace link: ${location} -> ${name}`);
          assert.equal(readJson(`${target}/package.json`).name, name, `Wrong workspace link: ${name}`);
        } else {
          assert.ok(lock.snapshots[lockedSnapshotKey(name, entry.version)], `Missing required dependency: ${location} -> ${name}`);
        }
      }
    }
    if (location === "apps/desktop") checkDesktopRuntimeLockfile(source, locked.devDependencies?.electron);
    // Keep the React 18 consumer independent of the React 19 workspace graph.
    for (const name of ["react", "react-dom", "@types/react", "@types/react-dom"]) {
      const range = source.dependencies?.[name] ?? source.devDependencies?.[name];
      const major = range?.match(/^[~^]?(\d+)\./)?.[1];
      const entry = locked.dependencies?.[name] ?? locked.devDependencies?.[name];
      if (major) assert.equal(entry?.version?.split(".")[0], major, `React major differs: ${location} -> ${name}`);
    }
  }
  for (const [key, entry] of Object.entries(lock.snapshots)) {
    assert.ok(lock.packages[key.split("(")[0]], `Missing package resolution: ${key}`);
    for (const [name, reference] of Object.entries(entry.dependencies ?? {})) {
      assert.ok(lock.snapshots[lockedSnapshotKey(name, reference)], `Missing required dependency: ${key} -> ${name}`);
    }
  }
  return workspaces.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Lockfile retains all ${checkWorkspaceLockfile(fileURLToPath(new URL("../", import.meta.url)))} workspaces, their links, and required dependencies.`);
}
