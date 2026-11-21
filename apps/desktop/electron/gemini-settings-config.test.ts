import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGeminiWorkspaceSettings,
  cleanupStaleGeminiAttachments,
  withAntigravitySessionSettings,
  writeGeminiWorkspaceSettings,
} from "./gemini-settings-config";
import { ANTIGRAVITY_WORKSPACE_SERVER_NAME } from "./sigma-studio-mcp-launch";
import { setAppLocale } from "@/lib/i18n";

const BASE_INPUT = {
  execPath: "/Applications/Sigma Studio.app/Contents/MacOS/Sigma Studio",
  scriptPath: "/app/dist-electron/sigma-doc-mcp-server.cjs",
  userDataDir: "/Users/teacher/Library/Application Support/Sigma Studio",
  runContextFile: "/data/data/ai-run-context/antigravity.run-context.json",
  renderBridgeFile: "/data/data/ai-run-context/render-bridge.json",
  provider: "antigravity" as const,
  uiLocale: "ja" as const,
};
const RUN_CONTEXT_READ_PERMISSION =
  "read_file(/Users/teacher/Library/Application Support/Sigma Studio/data/ai-run-context)";
describe("buildGeminiWorkspaceSettings", () => {
  it("registers the workspace MCP server with command/args", () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);

    const server = settings.mcpServers[ANTIGRAVITY_WORKSPACE_SERVER_NAME];
    expect(server.command).toBe(BASE_INPUT.execPath);
    expect(server.args).toEqual([BASE_INPUT.scriptPath]);
  });

  it("sets the shared sigma-studio MCP env vars (ELECTRON_RUN_AS_NODE, user data dir, run-context, render-bridge)", () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    const env = settings.mcpServers[ANTIGRAVITY_WORKSPACE_SERVER_NAME].env;

    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.SIGMA_STUDIO_USER_DATA_DIR).toBe(BASE_INPUT.userDataDir);
    expect(env.SIGMA_STUDIO_RUN_CONTEXT_FILE).toBe(BASE_INPUT.runContextFile);
    expect(env.SIGMA_STUDIO_RENDER_BRIDGE_FILE).toBe(BASE_INPUT.renderBridgeFile);
  });

  it("uses the Antigravity run-context file, not claude's", () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    const env = settings.mcpServers[ANTIGRAVITY_WORKSPACE_SERVER_NAME].env;

    expect(env.SIGMA_STUDIO_RUN_CONTEXT_FILE).toContain("antigravity.run-context.json");
  });

  it("sets SIGMA_STUDIO_MCP_PROVIDER as antigravity", () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    const env = settings.mcpServers[ANTIGRAVITY_WORKSPACE_SERVER_NAME].env;

    expect(env.SIGMA_STUDIO_MCP_PROVIDER).toBe("antigravity");
  });

});

describe("writeGeminiWorkspaceSettings", () => {
  let workspaceDir: string;
  let sharedConfigDir: string;
  let cliSettingsPath: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-gemini-workspace-"));
    sharedConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-antigravity-config-"));
    cliSettingsPath = path.join(sharedConfigDir, "cli-settings.json");
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(sharedConfigDir, { recursive: true, force: true });
  });

  it("creates .agents/mcp_config.json under the workspace dir", async () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    await writeGeminiWorkspaceSettings(workspaceDir, settings);

    const filePath = path.join(workspaceDir, ".agents", "mcp_config.json");
    const raw = await fs.readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual(settings);
  });

  it("overwrites stale settings from a previous run", async () => {
    const first = buildGeminiWorkspaceSettings(BASE_INPUT);
    await writeGeminiWorkspaceSettings(workspaceDir, first);

    const second = buildGeminiWorkspaceSettings({ ...BASE_INPUT, execPath: "/new/exec/path" });
    await writeGeminiWorkspaceSettings(workspaceDir, second);

    const filePath = path.join(workspaceDir, ".agents", "mcp_config.json");
    const raw = await fs.readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual(second);
  });

  it("writes atomically: no leftover tmp file and the written file always parses", async () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    await writeGeminiWorkspaceSettings(workspaceDir, settings);

    const dir = path.join(workspaceDir, ".agents");
    const entries = await fs.readdir(dir);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);

    const raw = await fs.readFile(path.join(dir, "mcp_config.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("gives concurrent edits a complete workspace config", async () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    await Promise.all(Array.from({ length: 8 }, () => writeGeminiWorkspaceSettings(workspaceDir, settings)));
    expect(JSON.parse(await fs.readFile(path.join(workspaceDir, ".agents/mcp_config.json"), "utf8"))).toEqual(settings);
  });

  it("preserves restrictions from a BOM-prefixed user profile without modifying it", async () => {
    const profile = "\uFEFF" + JSON.stringify({ model: "custom", permissions: {
      deny: ["mcp(sigma-studio-local/remove)", "command(rm)"], ask: ["mcp(other/*)"], allow: ["command(git)"],
    } });
    await fs.writeFile(cliSettingsPath, profile);
    let session = "";
    await expect(withAntigravitySessionSettings(BASE_INPUT.userDataDir, async (file) => {
      session = file;
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ permissions: {
        deny: ["mcp(sigma-studio-local/remove)", "mcp(sigma-studio-workspace/remove)", "command(rm)", "mcp(sigma-studio-local/*)"],
        ask: ["mcp(other/*)"],
        allow: ["command(git)", "mcp(sigma-studio-workspace/*)", RUN_CONTEXT_READ_PERMISSION],
      } });
      throw new Error("cancelled");
    }, cliSettingsPath)).rejects.toThrow("cancelled");
    await expect(fs.stat(session)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(cliSettingsPath, "utf8")).toBe(profile);
  });

  it("denies MCP tools for skill drafts even when the user has a legacy global registration", async () => {
    await withAntigravitySessionSettings(null, async (file) => {
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ permissions: { deny: ["mcp(*)"] } });
    }, cliSettingsPath);
  });

  it("leaves a malformed user settings file intact and stops before spawning", async () => {
    await fs.writeFile(cliSettingsPath, "{");
    const run = vi.fn();
    await expect(withAntigravitySessionSettings(BASE_INPUT.userDataDir, run, cliSettingsPath)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(await fs.readFile(cliSettingsPath, "utf8")).toBe("{");
  });
});

describe("cleanupStaleGeminiAttachments", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-gemini-workspace-"));
  });

  afterEach(async () => {
    setAppLocale("ja");
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("removes stale attachments left behind by a crashed run", async () => {
    const staleRunDir = path.join(workspaceDir, "attachments", "run_crashed");
    await fs.mkdir(staleRunDir, { recursive: true });
    await fs.writeFile(path.join(staleRunDir, "img-0.png"), "stale", "utf8");

    await cleanupStaleGeminiAttachments(workspaceDir);

    await expect(fs.access(path.join(workspaceDir, "attachments"))).rejects.toThrow();
  });

  it("never touches .agents/mcp_config.json", async () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    await writeGeminiWorkspaceSettings(workspaceDir, settings);
    await fs.mkdir(path.join(workspaceDir, "attachments", "run_1"), { recursive: true });

    await cleanupStaleGeminiAttachments(workspaceDir);

    const filePath = path.join(workspaceDir, ".agents", "mcp_config.json");
    const raw = await fs.readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual(settings);
  });

  it("is a no-op (does not throw) when there is no attachments directory", async () => {
    await expect(cleanupStaleGeminiAttachments(workspaceDir)).resolves.toBeUndefined();
  });

  it("resolves cleanup warnings in the locale active when cleanup runs", async () => {
    const cleanupError = new Error("disk busy");
    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(cleanupError);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      setAppLocale("en");
      await cleanupStaleGeminiAttachments(workspaceDir);
      expect(warn).toHaveBeenCalledWith(
        "Failed to clean up attachments in the Antigravity workspace.",
        cleanupError,
      );
    } finally {
      rm.mockRestore();
      warn.mockRestore();
    }
  });
});
