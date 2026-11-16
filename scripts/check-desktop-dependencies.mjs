import { load } from "js-yaml";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const readJson = (file) => JSON.parse(readFileSync(new URL(file, root), "utf8"));
const desktop = readJson("apps/desktop/package.json");
const lock = load(readFileSync(new URL("pnpm-lock.yaml", root), "utf8"));
const require = createRequire(new URL("apps/desktop/package.json", root));
const builder = require("./electron-builder.config.cjs");
const runtime = desktop.devDependencies.electron;

// Packaging must use the runtime that passed the Electron and native-lock checks.
assert.match(runtime, /^\d+\.\d+\.\d+$/, "Pin an exact stable Electron runtime");
assert.equal(builder.electronVersion, runtime, "Packaging runtime differs from the desktop manifest");
assert.equal(lock.importers["apps/desktop"].devDependencies.electron.specifier, runtime);
assert.equal(lock.importers["apps/desktop"].devDependencies.electron.version, runtime, "Lockfile runtime differs from packaging");
assert.equal(require("electron/package.json").version, runtime, "Installed runtime differs from packaging");
console.log(`Desktop development, lockfile, installed runtime, and packaging use Electron ${runtime}.`);
