import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function checkDesktopRuntimeLockfile(desktop, electron) {
  const runtime = desktop.devDependencies?.electron;
  assert.match(runtime ?? "", /^\d+\.\d+\.\d+$/, "Pin an exact stable Electron runtime");
  assert.equal(electron?.specifier, runtime, "Electron lockfile declaration differs from the pinned runtime");
  assert.equal(electron?.version, runtime, "Lockfile runtime differs from packaging");
  return runtime;
}

// The generated pnpm lockfile uses block mappings with two-space indentation.
// Read only the exact pin before installing dependencies. The full YAML graph
// is checked with js-yaml after the frozen install.
function mapping(lines, key, level) {
  const indent = "  ".repeat(level);
  const start = lines.findIndex(line => line.trimEnd() === indent + key + ":");
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.trim() && !line.startsWith(indent + " "));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

export function checkDesktopRuntimeBeforeInstall(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
  const lock = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8").split(/\r?\n/);
  const importer = mapping(mapping(lock, "importers", 0), "apps/desktop", 1);
  const electron = mapping(mapping(importer, "devDependencies", 2), "electron", 3);
  const pin = Object.fromEntries(electron.flatMap(line => {
    const field = /^ {8}(specifier|version):\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/.exec(line);
    return field ? [[field[1], field[2]]] : [];
  }));
  return checkDesktopRuntimeLockfile(manifest, pin);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const runtime = checkDesktopRuntimeBeforeInstall(fileURLToPath(new URL("../", import.meta.url)));
  console.log(`Lockfile pins desktop Electron ${runtime} before dependency installation.`);
}
