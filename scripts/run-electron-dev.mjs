#!/usr/bin/env node
import { spawn } from "node:child_process";

const mode = process.argv[2] === "dist" ? "dist" : "dev";
const workspace = "@sigma-studio/desktop";
const script = `electron:${mode}`;

const child = spawn(npmCommand(), ["--workspace", workspace, "run", script], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  shell: false,
});

child.on("error", (error) => {
  console.error(`[desktop] failed to start ${script}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
