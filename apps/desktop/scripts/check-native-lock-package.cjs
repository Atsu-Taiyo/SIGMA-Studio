/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads its packaging hook as CommonJS. */
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");
const { extractFile } = require("@electron/asar");
const { Arch } = require("builder-util");

// electron-builder invokes this before signing/publishing. A source-tree import
// cannot establish that the native binary and its loader made it into app.asar.
module.exports = async function checkNativeLockPackage(context) {
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  const productName = context.packager.appInfo.productFilename;
  const resources = platform === "darwin"
    ? path.join(context.appOutDir, `${productName}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  await require("./audit-release-content.cjs").auditReleaseContent(resources);
  const archive = path.join(resources, "app.asar");
  // asar traverses entries using the host's path separator, including on Windows.
  const nativePath = path.join("node_modules", "fs-native-extensions", "prebuilds", `${platform}-${arch}`, "fs-native-extensions.node");
  assert.ok(extractFile(archive, nativePath).length > 0, `Missing ${nativePath}`);

  // Cross-building can inspect the target binary, but cannot execute another OS
  // or an ARM binary on Intel. macOS ARM hosts can also verify Intel via Rosetta.
  const canExecute = process.platform === platform && (
    process.arch === arch || (platform === "darwin" && process.arch === "arm64" && arch === "x64")
  );
  if (!canExecute) {
    console.log(`[native-lock] ${platform}-${arch}: packaged binary present; runtime check requires its target host`);
    return;
  }

  const executable = platform === "darwin"
    ? path.join(context.appOutDir, `${productName}.app`, "Contents", "MacOS", productName)
    : path.join(context.appOutDir, platform === "win32" ? `${productName}.exe` : context.packager.executableName);
  const { stdout } = await promisify(execFile)(executable, [path.join(__dirname, "check-native-lock.cjs"), archive], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    // The first Intel Electron/addon launch under Rosetta can exceed 30 seconds.
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  console.log(stdout.trim());
};
