import { describe, expect, it } from "vitest";

import { buildCodexAgentConfigToml } from "./codex-mcp-config";

const BASE_INPUT = {
  execPath: "/Applications/Sigma Studio.app/Contents/MacOS/Sigma Studio",
  scriptPath: "/app/dist-electron/sigma-doc-mcp-server.cjs",
  userDataDir: "/Users/teacher/Library/Application Support/Sigma Studio",
  runContextFile: "/data/data/ai-run-context/chatgpt.run-context.json",
  renderBridgeFile: "/data/data/ai-run-context/render-bridge.json",
  provider: "chatgpt" as const,
  uiLocale: "ja" as const,
  webSearchEnabled: false,
};

describe("buildCodexAgentConfigToml", () => {
  it("includes the base agent flags", () => {
    const toml = buildCodexAgentConfigToml(BASE_INPUT);

    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain('sandbox_mode = "read-only"');
    expect(toml).toContain('web_search = "disabled"');
    expect(toml).toContain("[tools]");
    expect(toml).toContain("view_image = true");
    expect(toml).toContain('SIGMA_STUDIO_MCP_TOOL_PROFILE = "app"');
  });

  it("registers the sigma-studio-local MCP server with command/args and timeouts", () => {
    const toml = buildCodexAgentConfigToml(BASE_INPUT);

    expect(toml).toContain("[mcp_servers.sigma-studio-local]");
    expect(toml).toContain(`command = ${JSON.stringify(BASE_INPUT.execPath)}`);
    expect(toml).toContain(`args = [${JSON.stringify(BASE_INPUT.scriptPath)}]`);
    expect(toml).toContain("startup_timeout_sec = 30");
    expect(toml).toContain("tool_timeout_sec = 240");
  });

  it("auto-approves sigma-studio-local MCP tools inside the server table scope", () => {
    const toml = buildCodexAgentConfigToml(BASE_INPUT);

    const approvalIndex = toml.indexOf('default_tools_approval_mode = "approve"');
    const serverHeaderIndex = toml.indexOf("[mcp_servers.sigma-studio-local]");
    const envHeaderIndex = toml.indexOf("[mcp_servers.sigma-studio-local.env]");

    expect(approvalIndex).toBeGreaterThan(serverHeaderIndex);
    expect(approvalIndex).toBeLessThan(envHeaderIndex);
  });

  it("writes the env table with ELECTRON_RUN_AS_NODE, user data dir, run-context and render-bridge paths", () => {
    const toml = buildCodexAgentConfigToml(BASE_INPUT);

    expect(toml).toContain("[mcp_servers.sigma-studio-local.env]");
    expect(toml).toContain('ELECTRON_RUN_AS_NODE = "1"');
    expect(toml).toContain(`SIGMA_STUDIO_USER_DATA_DIR = ${JSON.stringify(BASE_INPUT.userDataDir)}`);
    expect(toml).toContain(`SIGMA_STUDIO_RUN_CONTEXT_FILE = ${JSON.stringify(BASE_INPUT.runContextFile)}`);
    expect(toml).toContain(`SIGMA_STUDIO_RENDER_BRIDGE_FILE = ${JSON.stringify(BASE_INPUT.renderBridgeFile)}`);
  });

  it("writes the env table with SIGMA_STUDIO_MCP_PROVIDER as chatgpt", () => {
    const toml = buildCodexAgentConfigToml(BASE_INPUT);

    expect(toml).toContain('SIGMA_STUDIO_MCP_PROVIDER = "chatgpt"');
  });

  it("uses the chatgpt run-context file, not the claude one", () => {
    const toml = buildCodexAgentConfigToml(BASE_INPUT);

    expect(toml).toContain("chatgpt.run-context.json");
    expect(toml).not.toContain("claude.run-context.json");
  });

  it("escapes Windows-style backslash paths as valid TOML basic strings", () => {
    const winInput = {
      ...BASE_INPUT,
      execPath: String.raw`C:\Users\山田\app.exe`,
      scriptPath: String.raw`C:\Users\山田\dist-electron\sigma-doc-mcp-server.cjs`,
      userDataDir: String.raw`C:\Users\山田\AppData\Roaming\Sigma Studio`,
    };
    const toml = buildCodexAgentConfigToml(winInput);

    expect(toml).toContain(`command = ${JSON.stringify(winInput.execPath)}`);
    expect(toml).toContain(`SIGMA_STUDIO_USER_DATA_DIR = ${JSON.stringify(winInput.userDataDir)}`);
    expect(() => JSON.parse(`"${toml.match(/command = "((?:[^"\\]|\\.)*)"/)![1]}"`)).not.toThrow();
  });

  it("ends with a trailing newline and is stable across calls", () => {
    const first = buildCodexAgentConfigToml(BASE_INPUT);
    const second = buildCodexAgentConfigToml(BASE_INPUT);

    expect(first.endsWith("\n")).toBe(true);
    expect(first).toBe(second);
  });

  it('writes web_search = "live" when webSearchEnabled is true', () => {
    const toml = buildCodexAgentConfigToml({ ...BASE_INPUT, webSearchEnabled: true });

    expect(toml).toContain('web_search = "live"');
    expect(toml).not.toContain('web_search = "disabled"');
  });

  it('writes web_search = "disabled" when webSearchEnabled is false', () => {
    const toml = buildCodexAgentConfigToml({ ...BASE_INPUT, webSearchEnabled: false });

    expect(toml).toContain('web_search = "disabled"');
    expect(toml).not.toContain('web_search = "live"');
  });
});
