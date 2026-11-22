/* eslint-disable @typescript-eslint/no-require-imports -- the Electron packaging hook runs in CommonJS. */
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const nodeVersion = "24.22.1";
// https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
const nodeArchives = {
  "darwin-arm64": "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
  "darwin-x64": "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
  "win32-x64": "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5",
};
const source = path.resolve(__dirname, "../dsh-runtime");
const installOptions = { timeout: 300_000, maxBuffer: 1024 * 1024 };

async function packageDshRuntime(resources, platform, arch) {
  const checksum = nodeArchives[`${platform}-${arch}`];
  if (!checksum) throw new Error(`No pinned SIGMA AI runtime for ${platform}-${arch}.`);
  if (process.env.SIGMA_STUDIO_REQUIRE_RELEASE_AUDIT === "true") {
    const health = await fetch("https://sigma-studio-ai-gateway.sigma-studio-experiment.workers.dev/health", {
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    const status = health.ok ? await health.json() : {};
    if (status.ok !== true || status.protocol !== 1) throw new Error("The authenticated SIGMA AI production gateway is not ready.");
  }
  const windows = platform === "win32";
  const distribution = `node-v${nodeVersion}-${windows ? "win" : platform}-${arch}`;
  const archive = distribution + (windows ? ".zip" : ".tar.gz");
  const executable = windows ? "node.exe" : "bin/node";
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-dsh-package-"));
  const destination = path.join(resources, "dsh-runtime");
  try {
    const download = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${archive}`, { signal: AbortSignal.timeout(90_000) });
    if (!download.ok) throw new Error(`Node download failed (HTTP ${download.status}).`);
    const bytes = Buffer.from(await download.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== checksum) throw new Error("Bundled Node checksum mismatch.");
    const downloaded = path.join(temp, archive);
    await fs.writeFile(downloaded, bytes);
    const files = [`${distribution}/${executable}`, `${distribution}/LICENSE`];
    if (windows && process.platform === "linux") {
      await exec("unzip", ["-q", downloaded, ...files, "-d", temp], installOptions);
    } else {
      await exec("tar", ["-xf", downloaded, "-C", temp, ...files], installOptions);
    }

    await fs.mkdir(destination, { recursive: true });
    for (const name of ["bridge.mjs", "package.json", "package-lock.json", "stubs", "licenses", "NOTICES.md"]) {
      await fs.cp(path.join(source, name), path.join(destination, name), { recursive: true });
    }
    const node = path.join(destination, "node");
    await fs.mkdir(path.dirname(path.join(node, executable)), { recursive: true });
    for (const name of [executable, "LICENSE"]) {
      await fs.copyFile(path.join(temp, distribution, name), path.join(node, name));
    }
    if (!windows) await fs.chmod(path.join(node, executable), 0o755);

    const options = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", `--os=${platform}`, `--cpu=${arch}`];
    await exec(process.platform === "win32" ? "npm.cmd" : "npm", options, {
      ...installOptions, shell: process.platform === "win32", cwd: destination,
    });
    // npm links file: dependencies to their build path on Windows. Ship an ordinary directory.
    const officeStub = path.join(destination, "node_modules", "@deepseek-ai", "libreoffice-kit");
    if ((await fs.lstat(officeStub)).isSymbolicLink()) {
      await fs.unlink(officeStub);
      await fs.cp(path.join(destination, "stubs", "libreoffice-kit"), officeStub, { recursive: true });
    }
    const prebuilds = path.join(destination, "node_modules", "node-pty", "prebuilds");
    for (const name of await fs.readdir(prebuilds)) {
      if (name !== `${platform}-${arch}`) await fs.rm(path.join(prebuilds, name), { recursive: true, force: true });
    }
    for (const entry of await fs.readdir(path.join(destination, "node_modules"), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".map")) await fs.unlink(path.join(entry.parentPath, entry.name));
    }
    // Restore the target helper's executable bit without running registry install scripts.
    if (!windows) {
      const helper = path.join(destination, "node_modules", "node-pty", "prebuilds", `${platform}-${arch}`, "spawn-helper");
      await fs.chmod(helper, 0o755);
    }
    // On the native runners exercise the shipped Node and both the SDK and image addon.
    const native = platform === process.platform && (arch === process.arch || (platform === "darwin" && arch === "x64" && process.arch === "arm64"));
    if (native) {
      const { stdout } = await exec(path.join(node, executable), ["--input-type=module", "-e", [
        'const { DeepSeekHarness } = await import("@deepseek-ai/dsh-sdk-client");',
        'if (typeof DeepSeekHarness !== "function") throw Error("DSH SDK is missing");',
        'const { default: sharp } = await import("sharp");',
        'await sharp({ create: { width: 2, height: 2, channels: 3, background: "#123456" } }).png().toBuffer();',
        'console.log(process.version + " " + process.platform + "-" + process.arch);',
      ].join(" ")], { ...installOptions, cwd: destination });
      if (stdout.trim() !== `v${nodeVersion} ${platform}-${arch}`) throw new Error("Bundled Node does not match the package target.");
    }
    console.log(`[sigma-ai] staged DSH and Node v${nodeVersion} for ${platform}-${arch}`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { packageDshRuntime };
