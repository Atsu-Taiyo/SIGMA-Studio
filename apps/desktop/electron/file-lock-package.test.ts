import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPackage } from "@electron/asar";
import { Arch } from "builder-util";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const checkNativeLockPackage = require("../scripts/check-native-lock-package.cjs");

it("finds a native binary in a real archive using the host path separator", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-lock-package-"));
  // Cross-target mode exercises the archive check without launching a foreign executable.
  const platform = process.platform === "win32" ? "darwin" : "win32";
  const source = path.join(directory, "source");
  const resources = platform === "darwin"
    ? path.join(directory, "Sigma Studio.app", "Contents", "Resources")
    : path.join(directory, "resources");
  const nativeDirectory = path.join(source, "node_modules", "fs-native-extensions", "prebuilds", `${platform}-x64`);
  try {
    await fs.mkdir(nativeDirectory, { recursive: true });
    await fs.mkdir(resources, { recursive: true });
    await fs.writeFile(path.join(nativeDirectory, "fs-native-extensions.node"), "archive-presence-fixture");
    await createPackage(source, path.join(resources, "app.asar"));
    const context = {
      electronPlatformName: platform,
      arch: Arch.x64,
      appOutDir: directory,
      packager: { appInfo: { productFilename: "Sigma Studio" } },
    };
    await expect(checkNativeLockPackage(context)).resolves.toBeUndefined();
    await expect(checkNativeLockPackage({ ...context, arch: Arch.arm64 })).rejects.toThrow("was not found in this archive");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
