import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGeminiWorkspaceSettings,
  cleanupStaleGeminiAttachments,
  SIGMA_STUDIO_ANTIGRAVITY_MCP_PERMISSION,
  writeGeminiWorkspaceSettings,
} from "./gemini-settings-config";
import { SIGMA_DOC_MCP_SERVER_NAME } from "./sigma-studio-mcp-launch";
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
const OBSOLETE_PREVIEW_READ_PERMISSION =
  "read_file(/Users/teacher/Library/Application Support/Sigma Studio/data/ai-run-context/previews)";

describe("buildGeminiWorkspaceSettings", () => {
  it("registers the sigma-studio-local MCP server with command/args", () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);

    const server = settings.mcpServers[SIGMA_DOC_MCP_SERVER_NAME];
    expect(server.command).toBe(BASE_INPUT.execPath);
    expect(server.args).toEqual([BASE_INPUT.scriptPath]);
  });

  it("sets the shared sigma-studio MCP env vars (ELECTRON_RUN_AS_NODE, user data dir, run-context, render-bridge)", () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    const env = settings.mcpServers[SIGMA_DOC_MCP_SERVER_NAME].env;

    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.SIGMA_STUDIO_USER_DATA_DIR).toBe(BASE_INPUT.userDataDir);
    expect(env.SIGMA_STUDIO_RUN_CONTEXT_FILE).toBe(BASE_INPUT.runContextFile);
    expect(env.SIGMA_STUDIO_RENDER_BRIDGE_FILE).toBe(BASE_INPUT.renderBridgeFile);
    expect(env.SIGMA_STUDIO_MCP_TOOL_PROFILE).toBe("app");
  });

  it("uses the Antigravity run-context file, not claude's", () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    const env = settings.mcpServers[SIGMA_DOC_MCP_SERVER_NAME].env;

    expect(env.SIGMA_STUDIO_RUN_CONTEXT_FILE).toContain("antigravity.run-context.json");
  });

  it("sets SIGMA_STUDIO_MCP_PROVIDER as antigravity", () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    const env = settings.mcpServers[SIGMA_DOC_MCP_SERVER_NAME].env;

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
    await writeGeminiWorkspaceSettings(workspaceDir, settings, { sharedConfigDir: null, cliSettingsPath: null });

    const filePath = path.join(workspaceDir, ".agents", "mcp_config.json");
    const raw = await fs.readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual(settings);
  });

  it("upserts sigma-studio-local into the Antigravity shared mcp_config.json without dropping other servers", async () => {
    await fs.mkdir(sharedConfigDir, { recursive: true });
    const sharedPath = path.join(sharedConfigDir, "mcp_config.json");
    await fs.writeFile(sharedPath, JSON.stringify({ mcpServers: { other: { command: "other-mcp" } } }), "utf8");

    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    await writeGeminiWorkspaceSettings(workspaceDir, settings, { sharedConfigDir, cliSettingsPath: null });

    const parsed = JSON.parse(await fs.readFile(sharedPath, "utf8"));
    expect(parsed.mcpServers.other.command).toBe("other-mcp");
    expect(parsed.mcpServers[SIGMA_DOC_MCP_SERVER_NAME]).toEqual(settings.mcpServers[SIGMA_DOC_MCP_SERVER_NAME]);
  });

  it("overwrites stale settings from a previous run", async () => {
    const first = buildGeminiWorkspaceSettings(BASE_INPUT);
    await writeGeminiWorkspaceSettings(workspaceDir, first, { sharedConfigDir: null, cliSettingsPath: null });

    const second = buildGeminiWorkspaceSettings({ ...BASE_INPUT, execPath: "/new/exec/path" });
    await writeGeminiWorkspaceSettings(workspaceDir, second, { sharedConfigDir: null, cliSettingsPath: null });

    const filePath = path.join(workspaceDir, ".agents", "mcp_config.json");
    const raw = await fs.readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual(second);
  });

  it("writes atomically: no leftover tmp file and the written file always parses", async () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    await writeGeminiWorkspaceSettings(workspaceDir, settings, { sharedConfigDir: null, cliSettingsPath: null });

    const dir = path.join(workspaceDir, ".agents");
    const entries = await fs.readdir(dir);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);

    const raw = await fs.readFile(path.join(dir, "mcp_config.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("allows only the Sigma Studio MCP server and AI run-context directory while preserving existing settings and permission lists", async () => {
    await fs.writeFile(cliSettingsPath, JSON.stringify({
      model: "Gemini 3.5 Flash (Medium)",
      trustedWorkspaces: ["/workspace"],
      permissions: {
        allow: ["command(git)"],
        deny: ["mcp(other/*)"],
        ask: ["read_url(*)"],
      },
    }), "utf8");

    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    await writeGeminiWorkspaceSettings(workspaceDir, settings, { sharedConfigDir: null, cliSettingsPath });

    const parsed = JSON.parse(await fs.readFile(cliSettingsPath, "utf8"));
    expect(parsed.model).toBe("Gemini 3.5 Flash (Medium)");
    expect(parsed.trustedWorkspaces).toEqual(["/workspace"]);
    expect(parsed.permissions).toEqual({
      allow: ["command(git)", SIGMA_STUDIO_ANTIGRAVITY_MCP_PERMISSION, RUN_CONTEXT_READ_PERMISSION],
      deny: ["mcp(other/*)"],
      ask: ["read_url(*)"],
    });
  });

  it("does not duplicate the Sigma Studio MCP permission on repeated writes", async () => {
    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);

    await writeGeminiWorkspaceSettings(workspaceDir, settings, { sharedConfigDir: null, cliSettingsPath });
    await writeGeminiWorkspaceSettings(workspaceDir, settings, { sharedConfigDir: null, cliSettingsPath });

    const parsed = JSON.parse(await fs.readFile(cliSettingsPath, "utf8"));
    expect(parsed.permissions.allow).toEqual([
      SIGMA_STUDIO_ANTIGRAVITY_MCP_PERMISSION,
      RUN_CONTEXT_READ_PERMISSION,
    ]);
  });

  it("migrates the obsolete preview-only read rule to the AI run-context directory", async () => {
    await fs.writeFile(cliSettingsPath, JSON.stringify({
      permissions: {
        allow: [SIGMA_STUDIO_ANTIGRAVITY_MCP_PERMISSION, OBSOLETE_PREVIEW_READ_PERMISSION],
      },
    }), "utf8");

    const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
    await writeGeminiWorkspaceSettings(workspaceDir, settings, { sharedConfigDir: null, cliSettingsPath });

    const parsed = JSON.parse(await fs.readFile(cliSettingsPath, "utf8"));
    expect(parsed.permissions.allow).toEqual([
      SIGMA_STUDIO_ANTIGRAVITY_MCP_PERMISSION,
      RUN_CONTEXT_READ_PERMISSION,
    ]);
    expect(parsed.permissions.allow).not.toContain(OBSOLETE_PREVIEW_READ_PERMISSION);
  });

  it("writes the shared MCP config and least-privilege CLI permission to their HOME-based default paths", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = sharedConfigDir;
    delete process.env.USERPROFILE;

    try {
      const settings = buildGeminiWorkspaceSettings(BASE_INPUT);
      await writeGeminiWorkspaceSettings(workspaceDir, settings);

      const sharedMcpPath = path.join(sharedConfigDir, ".gemini", "config", "mcp_config.json");
      const sharedMcp = JSON.parse(await fs.readFile(sharedMcpPath, "utf8"));
      expect(sharedMcp.mcpServers[SIGMA_DOC_MCP_SERVER_NAME]).toEqual(
        settings.mcpServers[SIGMA_DOC_MCP_SERVER_NAME],
      );

      const defaultCliSettingsPath = path.join(
        sharedConfigDir,
        ".gemini",
        "antigravity-cli",
        "settings.json",
      );
      const cliSettings = JSON.parse(await fs.readFile(defaultCliSettingsPath, "utf8"));
      expect(cliSettings.permissions.allow).toEqual([
        SIGMA_STUDIO_ANTIGRAVITY_MCP_PERMISSION,
        RUN_CONTEXT_READ_PERMISSION,
      ]);
      expect(cliSettings.permissions.allow).not.toContain("mcp(*)");
      expect(cliSettings.permissions.allow).not.toContain("read_file(*)");
      expect(cliSettings).not.toHaveProperty("toolPermission");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
    }
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
    await writeGeminiWorkspaceSettings(workspaceDir, settings, { sharedConfigDir: null, cliSettingsPath: null });
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
