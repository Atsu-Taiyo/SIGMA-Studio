import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const paths = [
  "package.json",
  "apps/desktop/package.json",
  "packages/viewer/package.json",
  "packages/editor/package.json",
  "examples/editor-react18/package.json",
  "package-lock.json",
];

function manifests(version) {
  const viewerDependency = { "@sigma-studio/viewer": version, katex: "^0.16.0" };
  const editorDependency = { "@sigma-studio/editor": version, react: "^18.3.1" };
  return {
    "package.json": { name: "workspace", private: true, version },
    "apps/desktop/package.json": { name: "desktop", private: true, version },
    "packages/viewer/package.json": { name: "@sigma-studio/viewer", version },
    "packages/editor/package.json": {
      name: "@sigma-studio/editor", version, dependencies: { ...viewerDependency },
    },
    "examples/editor-react18/package.json": {
      name: "example", version: "0.0.0", private: true, dependencies: { ...editorDependency },
    },
    "package-lock.json": {
      name: "workspace", version, lockfileVersion: 3, requires: true,
      packages: {
        "": { name: "workspace", version },
        "apps/desktop": { name: "desktop", version },
        "packages/viewer": { name: "@sigma-studio/viewer", version },
        "packages/editor": { version, dependencies: { ...viewerDependency } },
        "examples/editor-react18": { version: "0.0.0", dependencies: { ...editorDependency } },
        "node_modules/unrelated": { version: "7.8.9", integrity: "unchanged" },
      },
    },
  };
}

async function fixture(t, initial = manifests("1.2.3")) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sigma-release-version-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  // Execute the real CLI source relative to a disposable repository. Tests never
  // write the checkout's manifests or duplicate the synchronization algorithm.
  for (const name of ["set-release-version.mjs", "sync-public-package-versions.mjs"]) {
    await copyFile(new URL(name, import.meta.url), path.join(root, "scripts", name));
  }
  for (const [name, value] of Object.entries(initial)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`);
  }
  return {
    async run(script, ...args) {
      try {
        // CWD is deliberately outside the fixture; file locations belong to the
        // script, not whichever directory a contributor invokes Node from.
        const output = await runFile(process.execPath, [path.join(root, "scripts", script), ...args], {
          cwd: os.tmpdir(),
        });
        return { code: 0, ...output };
      } catch (error) {
        if (typeof error.code !== "number") throw error;
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    },
    async snapshot() {
      return Object.fromEntries(await Promise.all(paths.map(async (name) => [
        name, await readFile(path.join(root, name), "utf8"),
      ])));
    },
  };
}

function parseSnapshot(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).map(([name, text]) => [name, JSON.parse(text)]));
}

test("version check is read-only for an already synchronized repository", async (t) => {
  const repo = await fixture(t);
  const before = await repo.snapshot();
  assert.equal((await repo.run("sync-public-package-versions.mjs", "--check")).code, 0);
  assert.deepEqual(await repo.snapshot(), before);
  const sync = await repo.run("sync-public-package-versions.mjs");
  assert.equal(sync.code, 0, sync.stderr);
  assert.match(sync.stdout, /すでに/);
  assert.deepEqual(await repo.snapshot(), before);
});

test("check reports every stale package/dependency without writing; sync preserves unrelated fields", async (t) => {
  const initial = manifests("1.2.2");
  initial["package.json"].version = "1.2.3";
  initial["apps/desktop/package.json"].version = "1.2.3";
  const repo = await fixture(t, initial);
  const before = await repo.snapshot();
  const check = await repo.run("sync-public-package-versions.mjs", "--check");
  assert.equal(check.code, 1);
  assert.equal(check.stderr.split("\n").filter((line) => line.startsWith("- ")).length, 11);
  assert.deepEqual(await repo.snapshot(), before);

  const sync = await repo.run("sync-public-package-versions.mjs");
  assert.equal(sync.code, 0, sync.stderr);
  assert.deepEqual(parseSnapshot(await repo.snapshot()), manifests("1.2.3"));
  assert.equal((await repo.run("sync-public-package-versions.mjs", "--check")).code, 0);
});

test("root and desktop disagreement stops synchronization before any write", async (t) => {
  const initial = manifests("1.2.3");
  initial["apps/desktop/package.json"].version = "1.2.2";
  const repo = await fixture(t, initial);
  const before = await repo.snapshot();
  for (const args of [[], ["--check"]]) {
    const result = await repo.run("sync-public-package-versions.mjs", ...args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /本体とルートのversionが一致していません/);
    assert.deepEqual(await repo.snapshot(), before);
  }
});

for (const [requested, version] of [
  ["patch", "1.2.4"], ["minor", "1.3.0"], ["major", "2.0.0"],
  ["2.4.6-rc.1+build.12", "2.4.6-rc.1+build.12"],
]) {
  test(`version:set ${requested} synchronizes all manifests and dependency edges`, async (t) => {
    const repo = await fixture(t);
    const result = await repo.run("set-release-version.mjs", requested);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(parseSnapshot(await repo.snapshot()), manifests(version));
    assert.equal((await repo.run("sync-public-package-versions.mjs", "--check")).code, 0);
  });
}

test("increment removes the current prerelease/build suffix", async (t) => {
  const repo = await fixture(t, manifests("1.2.3-rc.4+build.5"));
  const result = await repo.run("set-release-version.mjs", "patch");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(parseSnapshot(await repo.snapshot()), manifests("1.2.4"));
});

for (const requested of [undefined, "invalid", "1.2", "01.2.3", "1.2.3"]) {
  test(`version:set rejects ${String(requested)} without modifying manifests`, async (t) => {
    const repo = await fixture(t);
    const before = await repo.snapshot();
    const result = await repo.run("set-release-version.mjs", ...requested ? [requested] : []);
    assert.equal(result.code, 1);
    assert.deepEqual(await repo.snapshot(), before);
  });
}

test("help does not modify manifests", async (t) => {
  const repo = await fixture(t);
  const before = await repo.snapshot();
  const result = await repo.run("set-release-version.mjs", "--help");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /使い方/);
  assert.deepEqual(await repo.snapshot(), before);
});

test("an invalid current root version is rejected by both commands before writing", async (t) => {
  const repo = await fixture(t, manifests("not-a-version"));
  const before = await repo.snapshot();
  for (const [script, ...args] of [
    ["sync-public-package-versions.mjs"], ["set-release-version.mjs", "patch"],
  ]) {
    const result = await repo.run(script, ...args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /semverではありません/);
    assert.deepEqual(await repo.snapshot(), before);
  }
});
