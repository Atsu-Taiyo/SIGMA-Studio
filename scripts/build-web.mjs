import { spawnSync } from "node:child_process";

const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--workspace", "@sigma-studio/desktop", "run", "build"], {
  stdio: "inherit", env: { ...process.env, NEXT_PUBLIC_TARGET: "web", NEXT_PUBLIC_SIGMA_WEB_SHARED_ONLY: "true", SIGMA_STUDIO_DEV_SESSION: "" },
});
process.exitCode = result.status ?? 1;
