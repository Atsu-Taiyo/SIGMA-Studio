import { describe, expect, it } from "vitest";

import { buildSigmaStudioMcpEnv } from "./sigma-studio-mcp-launch";

describe("buildSigmaStudioMcpEnv", () => {
  it.each(["chatgpt", "claude", "antigravity"] as const)("launches %s with only the shared app MCP env", (provider) => {
    const env = buildSigmaStudioMcpEnv({
      provider, uiLocale: "en", execPath: "/electron", scriptPath: "/server.cjs",
      userDataDir: "/data", runContextFile: `/data/${provider}.run-context.json`, renderBridgeFile: "/data/render.json",
    });
    expect(env).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      SIGMA_STUDIO_USER_DATA_DIR: "/data",
      SIGMA_STUDIO_RUN_CONTEXT_FILE: `/data/${provider}.run-context.json`,
      SIGMA_STUDIO_RENDER_BRIDGE_FILE: "/data/render.json",
      SIGMA_STUDIO_MCP_PROVIDER: provider,
      SIGMA_STUDIO_UI_LOCALE: "en",
    });
  });
});
