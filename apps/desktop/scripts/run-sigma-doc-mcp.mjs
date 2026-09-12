#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const outfile = path.join(root, "dist-mcp", "sigma-doc-mcp-server.cjs");

const external = [
  ...Object.keys(pkg.dependencies ?? {}).filter((name) => name !== "mathlive"),
  ...Object.keys(pkg.devDependencies ?? {}),
];

await build({
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  entryPoints: [path.join(root, "mcp/sigma-doc-mcp-server.ts")],
  outfile,
  external,
  logLevel: "silent",
  alias: {
    "@": path.join(root, "src"),
    "mathlive/ssr": path.join(root, "electron/mathlive-main-stub.ts"),
    "mathlive": path.join(root, "electron/mathlive-main-stub.ts"),
  },
});

const child = spawn(process.execPath, [outfile], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
