// Backport https://github.com/electron-userland/electron-builder/pull/10101
// to the pinned builder. Remove this when upgrading to a release with that fix.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const packagePath = builderRequire.resolve("app-builder-lib/package.json");
const { version } = JSON.parse(await readFile(packagePath, "utf8"));
if (version !== "25.1.8") {
  throw new Error(`Review the keychain backport before using app-builder-lib ${version}`);
}
const sourcePath = path.join(path.dirname(packagePath), "out/codeSign/macCodeSign.js");
const original = await readFile(sourcePath, "utf8");
const replacements = [
  [
    "return await importCerts(keychainFile, certPaths, cscPasswords);",
    "return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);",
  ],
  [
    "async function importCerts(keychainFile, paths, keyPasswords) {",
    "async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {",
  ],
  [
    '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]',
    '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]',
  ],
];
if (replacements.every(([before, after]) => !original.includes(before) && original.split(after).length === 2)) {
  console.log("electron-builder keychain backport already applied");
} else {
  let patched = original;
  for (const [before, after] of replacements) {
    if (patched.split(before).length !== 2 || patched.includes(after)) {
      throw new Error("Unexpected electron-builder source; refusing a partial keychain patch");
    }
    patched = patched.replace(before, after);
  }
  if (await readFile(sourcePath, "utf8") !== original) {
    throw new Error("electron-builder source changed while preparing the keychain patch");
  }
  await writeFile(sourcePath, patched);
  console.log("Applied electron-builder keychain password fix (#10101)");
}
