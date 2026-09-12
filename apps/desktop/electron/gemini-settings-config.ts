import fs from "node:fs/promises";
import path from "node:path";

import {
  buildSigmaStudioMcpEnv,
  SIGMA_DOC_MCP_SERVER_NAME,
  type SigmaStudioMcpLaunchSpec,
} from "./sigma-studio-mcp-launch";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

export type GeminiSettingsConfigInput = SigmaStudioMcpLaunchSpec;

export interface GeminiMcpStdioServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface GeminiWorkspaceSettings {
  mcpServers: {
    "sigma-studio-local": GeminiMcpStdioServer;
  };
}

export { SIGMA_DOC_MCP_SERVER_NAME };

export function buildGeminiWorkspaceSettings(input: GeminiSettingsConfigInput): GeminiWorkspaceSettings {
  return {
    mcpServers: {
      [SIGMA_DOC_MCP_SERVER_NAME]: {
        command: input.execPath,
        args: [input.scriptPath],
        env: buildSigmaStudioMcpEnv(input),
      },
    },
  };
}

export interface WriteGeminiWorkspaceSettingsOptions {
  sharedConfigDir?: string | null;
  cliSettingsPath?: string | null;
}

export const SIGMA_STUDIO_ANTIGRAVITY_MCP_PERMISSION = `mcp(${SIGMA_DOC_MCP_SERVER_NAME}/*)`;

export async function writeGeminiWorkspaceSettings(
  workspaceDir: string,
  settings: GeminiWorkspaceSettings,
  options: WriteGeminiWorkspaceSettingsOptions = {},
): Promise<void> {
  await writeMcpConfigFile(path.join(workspaceDir, ".agents", "mcp_config.json"), settings, { mergeExisting: false });

  const sharedConfigDir = options.sharedConfigDir === undefined ? defaultAntigravitySharedConfigDir() : options.sharedConfigDir;
  if (sharedConfigDir) {
    await writeMcpConfigFile(path.join(sharedConfigDir, "mcp_config.json"), settings, { mergeExisting: true });
  }

  const cliSettingsPath = options.cliSettingsPath === undefined
    ? defaultAntigravityCliSettingsPath()
    : options.cliSettingsPath;
  if (cliSettingsPath) {
    await writeAntigravityCliPermissionSettings(cliSettingsPath, settings);
  }
}

// gemini-edit.ts は各 turn の attachments/<runId> を成功後に自分で削除するが、途中で
// クラッシュしたrunは削除されずに残り続ける。app起動のたびに attachments ディレクトリ
// 全体を一括で消して積み残しを片付ける。.agents/mcp_config.json と共有 mcp_config.json は
// 絶対に触らない (MCPサーバー起動設定なので消えるとAntigravity編集が壊れる)。ベストエフォートであり、
// 失敗しても起動を止めない。
export async function cleanupStaleGeminiAttachments(workspaceDir: string): Promise<void> {
  try {
    await fs.rm(path.join(workspaceDir, "attachments"), { recursive: true, force: true });
  } catch (error) {
    console.warn(te("electron.antigravity.attachmentCleanupFailed"), error);
  }
}

/**
 * cleanupStaleGeminiAttachments をフォールバックワークスペース1つだけでなく、
 * data/agent-workspaces/<workspaceId>/antigravity/ 配下の全ワークスペース分にも広げる。
 * ワークスペースIDの一覧をこのモジュールは知らないため、ディスク上に実在するディレクトリを
 * そのまま列挙する(agent-workspacesディレクトリ自体が無ければ何もしない)。起動時に
 * main.ts から呼ばれ、ベストエフォート(失敗してもアプリ起動は止めない)。
 */
export async function cleanupStaleAgentWorkspaceGeminiAttachments(dataDir: string): Promise<void> {
  const agentWorkspacesDir = path.join(dataDir, "agent-workspaces");
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(agentWorkspacesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    await cleanupStaleGeminiAttachments(path.join(agentWorkspacesDir, entry.name, "antigravity"));
  }
}

async function writeMcpConfigFile(
  filePath: string,
  settings: GeminiWorkspaceSettings,
  options: { mergeExisting: boolean },
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const current = options.mergeExisting ? await readExistingMcpConfig(filePath) : {};
  const next = mergeMcpSettings(current, settings);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

async function readExistingMcpConfig(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAntigravityCliPermissionSettings(
  filePath: string,
  settings: GeminiWorkspaceSettings,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const current = await readExistingMcpConfig(filePath);
  const currentPermissions = isRecord(current.permissions) ? current.permissions : {};
  const currentAllow = Array.isArray(currentPermissions.allow) ? currentPermissions.allow : [];
  const requiredPermissions = buildSigmaStudioAntigravityPermissionRules(settings);
  const obsoletePermissions = buildObsoleteSigmaStudioAntigravityPermissionRules(settings);
  const retainedAllow = currentAllow.filter((permission) => !obsoletePermissions.includes(permission));
  const nextAllow = [
    ...retainedAllow,
    ...requiredPermissions.filter((permission) => !retainedAllow.includes(permission)),
  ];
  const next = {
    ...current,
    permissions: {
      ...currentPermissions,
      allow: nextAllow,
    },
  };
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

function buildSigmaStudioAntigravityPermissionRules(settings: GeminiWorkspaceSettings): string[] {
  const userDataDir = settings.mcpServers[SIGMA_DOC_MCP_SERVER_NAME].env.SIGMA_STUDIO_USER_DATA_DIR?.trim();
  const rules = [SIGMA_STUDIO_ANTIGRAVITY_MCP_PERMISSION];
  if (userDataDir) {
    const runContextDir = path.join(userDataDir, "data", "ai-run-context").replaceAll("\\", "/");
    rules.push(`read_file(${runContextDir})`);
  }
  return rules;
}

function buildObsoleteSigmaStudioAntigravityPermissionRules(settings: GeminiWorkspaceSettings): string[] {
  const userDataDir = settings.mcpServers[SIGMA_DOC_MCP_SERVER_NAME].env.SIGMA_STUDIO_USER_DATA_DIR?.trim();
  if (!userDataDir) {
    return [];
  }
  const previewDir = path.join(userDataDir, "data", "ai-run-context", "previews").replaceAll("\\", "/");
  return [`read_file(${previewDir})`];
}

function mergeMcpSettings(current: Record<string, unknown>, settings: GeminiWorkspaceSettings): GeminiWorkspaceSettings & Record<string, unknown> {
  const currentServers = isRecord(current.mcpServers) ? current.mcpServers : {};
  return {
    ...current,
    mcpServers: {
      ...currentServers,
      ...settings.mcpServers,
    },
  } as GeminiWorkspaceSettings & Record<string, unknown>;
}

function defaultAntigravitySharedConfigDir(): string | null {
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return home ? path.join(home, ".gemini", "config") : null;
}

function defaultAntigravityCliSettingsPath(): string | null {
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return home ? path.join(home, ".gemini", "antigravity-cli", "settings.json") : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
