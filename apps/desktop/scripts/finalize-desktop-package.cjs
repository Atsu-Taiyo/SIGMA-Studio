/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads this hook as CommonJS. */
const { Arch } = require("builder-util");
const checkNativeLockPackage = require("./check-native-lock-package.cjs");
const { packageDshRuntime } = require("./package-dsh-runtime.cjs");

module.exports = async function finalizeDesktopPackage(context) {
  const { electronPlatformName: platform, appOutDir, arch, packager } = context;
  if (platform === "darwin" || platform === "win32") {
    await packageDshRuntime(packager.getResourcesDir(appOutDir), platform, Arch[arch]);
  }
  await checkNativeLockPackage(context);
};
