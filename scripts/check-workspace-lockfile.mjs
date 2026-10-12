import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

// Resolve from the package's location, including nested React 18 installations.
export function resolveLockedPackage(packages, location, name) {
  let directory = location;
  for (;;) {
    if (path.posix.basename(directory) !== "node_modules") {
      const candidate = path.posix.join(directory, "node_modules", name);
      if (packages[candidate]) return packages[candidate];
    }
    if (!directory || directory === ".") return undefined;
    directory = path.posix.dirname(directory);
  }
}

export function checkWorkspaceLockfile(root) {
  const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
  const manifest = readJson("package.json");
  const lock = readJson("package-lock.json");
  assert.equal(lock.lockfileVersion, 3, "Expected npm lockfile v3");
  const packages = lock.packages;
  assert.ok(packages, "Missing lockfile package graph");
  assert.deepEqual(packages[""]?.workspaces, manifest.workspaces, "Root workspace list differs from lockfile");
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces.packages;
  const workspaces = globSync(patterns, { cwd: root }).map((entry) => entry.replaceAll("\\", "/"));
  for (const location of ["", ...workspaces]) {
    const source = location ? readJson(`${location}/package.json`) : manifest;
    const locked = packages[location];
    assert.ok(locked, `Missing workspace in lockfile: ${location || "root"}`);
    assert.equal(locked.version, source.version, `Workspace version differs: ${location || "root"}`);
    for (const field of dependencyFields) {
      assert.deepEqual(locked[field] ?? {}, source[field] ?? {}, `Workspace ${field} differ: ${location || "root"}`);
    }
    // React 18 must not silently fall back to the hoisted React 19 install.
    for (const name of ["react", "react-dom", "@types/react", "@types/react-dom"]) {
      const range = source.dependencies?.[name] ?? source.devDependencies?.[name];
      const major = range?.match(/^[~^]?(\d+)\./)?.[1];
      if (major) {
        assert.equal(resolveLockedPackage(packages, location, name)?.version?.split(".")[0], major,
          `React major differs: ${location || "root"} -> ${name}`);
      }
    }
    if (location) {
      const link = packages[`node_modules/${source.name}`];
      assert.ok(link?.link && link.resolved === location, `Missing workspace link: ${source.name}`);
    }
  }
  for (const [location, entry] of Object.entries(packages)) {
    if (entry.link) {
      assert.ok(packages[entry.resolved], `Broken workspace link: ${location}`);
      continue;
    }
    // npm ci remains the authority for version ranges and optional/peer installs.
    // Required edges must exist even for dependencies of dependencies.
    const required = { ...entry.dependencies, ...entry.devDependencies };
    for (const name of Object.keys(required)) {
      if (Object.hasOwn(entry.optionalDependencies ?? {}, name)) continue;
      assert.ok(resolveLockedPackage(packages, location, name), `Missing required dependency: ${location || "root"} -> ${name}`);
    }
  }
  return workspaces.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  console.log(`Lockfile retains all ${checkWorkspaceLockfile(root)} workspaces, their links, and required dependencies.`);
}
