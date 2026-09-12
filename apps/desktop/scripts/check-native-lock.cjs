/* eslint-disable @typescript-eslint/no-require-imports -- This probe runs directly in packaged Electron's CommonJS Node mode. */
// Run with Node or ELECTRON_RUN_AS_NODE=1; the optional argument selects the
// package root (including app.asar) whose native dependency must actually load.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

async function main() {
  const packageRoot = path.resolve(process.argv[2] ?? path.join(__dirname, ".."));
  const packageRequire = createRequire(path.join(packageRoot, "package.json"));
  const loadedBefore = new Set(Object.keys(require.cache));
  const { tryLock, unlock } = packageRequire("fs-native-extensions");
  if (packageRoot.endsWith(".asar")) {
    const isPackaged = (filename) => filename.startsWith(`${packageRoot}${path.sep}`)
      || filename.startsWith(`${packageRoot}.unpacked${path.sep}`);
    assert.ok(isPackaged(packageRequire.resolve("fs-native-extensions")), "native loader must resolve inside the packaged app");
    for (const filename of Object.keys(require.cache)) {
      if (!loadedBefore.has(filename)) {
        assert.ok(isPackaged(filename), `dependency escaped the packaged app: ${filename}`);
      }
    }
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-native-lock-"));
  const handles = [];
  try {
    const lockPath = path.join(directory, "stable.mutex");
    const first = await fs.open(lockPath, "a+");
    handles.push(first);
    const second = await fs.open(lockPath, "a+");
    handles.push(second);
    assert.equal(tryLock(first.fd), true);
    assert.equal(tryLock(second.fd), false, "separate descriptors must contend");
    await first.close();
    assert.equal(tryLock(second.fd), true, "closing the owner must release the lock");
    unlock(second.fd);
    const third = await fs.open(lockPath, "a+");
    handles.push(third);
    assert.equal(tryLock(third.fd), true, "explicit unlock must release ownership");
    console.log(JSON.stringify({
      nativeLock: "passed",
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
      packageRoot,
    }));
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
