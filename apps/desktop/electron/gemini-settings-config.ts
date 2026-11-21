import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  ANTIGRAVITY_WORKSPACE_SERVER_NAME,
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
    [ANTIGRAVITY_WORKSPACE_SERVER_NAME]: GeminiMcpStdioServer;
  };
}

export function buildGeminiWorkspaceSettings(input: GeminiSettingsConfigInput): GeminiWorkspaceSettings {
  return {
    mcpServers: {
      [ANTIGRAVITY_WORKSPACE_SERVER_NAME]: {
        command: input.execPath,
        args: [input.scriptPath],
        env: buildSigmaStudioMcpEnv(input),
      },
    },
  };
}

export async function writeGeminiWorkspaceSettings(
  workspaceDir: string,
  settings: GeminiWorkspaceSettings,
): Promise<void> {
  const dir = path.join(workspaceDir, ".agents");
  await fs.mkdir(dir, { recursive: true });
  // This is Studio's generated workspace. Replace the old registration atomically,
  // including when two edits start together.
  const filePath = path.join(dir, "mcp_config.json");
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await fs.rename(tmp, filePath);
  } finally {
    await fs.rm(tmp, { force: true });
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

// --settings replaces the permissions object for this process. Retain the user's
// lists, including restrictions on the old registration, and never resave their profile.
export async function withAntigravitySessionSettings<T>(
  editUserDataDir: string | null,
  run: (settingsPath: string) => Promise<T>,
  cliSettingsPath = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json"),
): Promise<T> {
  let permissions: Record<string, string[]> = {};
  try {
    const contents = await fs.readFile(cliSettingsPath, "utf8");
    const settings = JSON.parse(contents.replace(/^\uFEFF/, ""));
    permissions = settings.permissions ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const previousServer = `mcp(${SIGMA_DOC_MCP_SERVER_NAME}/`;
  const workspaceServer = `mcp(${ANTIGRAVITY_WORKSPACE_SERVER_NAME}/`;
  const restrictions = (rules: string[] = []) => rules.flatMap((rule) =>
    rule.startsWith(previousServer) ? [rule, rule.replace(previousServer, workspaceServer)] : [rule]);
  const scoped = editUserDataDir ? {
    ...permissions,
    allow: [...new Set([...(permissions.allow ?? []), `${workspaceServer}*)`, `read_file(${path.join(editUserDataDir, "data", "ai-run-context").replaceAll("\\", "/")})`])],
    ask: restrictions(permissions.ask),
    deny: [...restrictions(permissions.deny), `${previousServer}*)`],
  } : {
    ...permissions,
    deny: [...(permissions.deny ?? []), "mcp(*)"],
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-agy-"));
  try {
    const filePath = path.join(dir, "settings.json");
    await fs.writeFile(filePath, JSON.stringify({ permissions: scoped }), { mode: 0o600 });
    return await run(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
