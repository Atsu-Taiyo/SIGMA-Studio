import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { checkDesktopRuntimeLockfile } from "./check-workspace-lockfile.mjs";

const root = new URL("../", import.meta.url);
const readJson = (file) => JSON.parse(readFileSync(new URL(file, root), "utf8"));
const desktop = readJson("apps/desktop/package.json");
const lock = readJson("package-lock.json");
const require = createRequire(new URL("apps/desktop/package.json", root));
const builder = require("./electron-builder.config.cjs");
const runtime = checkDesktopRuntimeLockfile(desktop, lock.packages);

// Packaging must use the runtime that passed the Electron and native-lock checks.
assert.equal(builder.electronVersion, runtime, "Packaging runtime differs from the desktop manifest");
assert.equal(require("electron/package.json").version, runtime, "Installed runtime differs from packaging");
console.log(`Desktop development, lockfile, installed runtime, and packaging use Electron ${runtime}.`);
