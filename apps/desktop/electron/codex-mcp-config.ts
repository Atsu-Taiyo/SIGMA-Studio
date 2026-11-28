// 重要:
// - TOML の文字列値は JSON.stringify でエスケープする。TOMLのbasic stringはJSON文字列と
//   互換のエスケープ規則を持つため、Windowsのバックスラッシュパスも安全に埋め込める。
// - startup_timeout_sec はElectronをNodeとして起動するコールドスタートを見込んで30秒、
//   tool_timeout_sec は render_visual_edit_session / propose_visual_edit_session が
//   デフォルトの60秒を超えることがあるため240秒にしている。
// - default_tools_approval_mode = "approve" が無いと Codex は MCP ツール呼び出しごとに
//   承認を要求する (approval_policy = "never" は read-only sandbox では MCP 承認を
//   抑止しない)。有効値は auto / prompt / approve のみ。MCPサーバーは各ツールの
//   safety annotationsを宣言するが、最終的な承認判断はCodex側のポリシーが持つ。

// - [agents] はサブエージェント (spawn_agent などの協調ツール) の設定。enabled = false で
//   道具ごと外れる (codex-cli 0.171.0 の実機で確認: 既定では使え、false にすると
//   モデルから協調ツールが見えなくなる)。max_concurrent_threads_per_session は同時に開ける
//   サブエージェントのスレッド数。max_depth は入れ子の深さで、従来方式のサブエージェントだけが
//   読む (設定スキーマの説明: "Maximum nesting depth for V1 agent threads. Ignored by V2")。
//   現行の方式では、アプリ側 (codex-app-server-client.ts) が agentPath の深さでも確かめる。
//   **[agents] の知らないキーは設定エラーになる** (Codex はこのテーブルの未知のキーを
//   エージェントの役割の定義として読むため、`failed to load configuration ... expected struct
//   AgentRoleToml` でスレッドを開始できなくなる)。これらのキーを持たない古いCLIのために、
//   クライアントは設定を拒否されたら subagents を null にして作り直す ([agents] を書かない)。

import type { AiSubagentPolicy } from "@/lib/ai/subagent-settings";
import { buildSigmaStudioMcpEnv, SIGMA_DOC_MCP_SERVER_NAME, type SigmaStudioMcpLaunchSpec } from "./sigma-studio-mcp-launch";

export type CodexAgentConfigInput = SigmaStudioMcpLaunchSpec & {
  webSearchEnabled: boolean;
  /**
   * サブエージェント設定から決めた Codex の扱い。null・未指定のときは [agents] テーブルを
   * 書かない (このテーブルを受け付けないCLI向け。CLIの既定の動作になる)。
   */
  subagents?: AiSubagentPolicy | null;
};

const MCP_STARTUP_TIMEOUT_SEC = 30;
const MCP_TOOL_TIMEOUT_SEC = 240;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** bare key に使える文字だけならそのまま、そうでなければ quoted key にする。 */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key);
}

export function buildCodexAgentConfigToml(input: CodexAgentConfigInput): string {
  const env = buildSigmaStudioMcpEnv(input);
  const envLines = Object.entries(env).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`);

  return [
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    // aiWebSearchEnabled設定 (electron/desktop-settings.ts) に連動する。有効値は
    // `codex app-server generate-json-schema` の WebSearchMode enum で確認済み:
    // "disabled" | "cached" | "indexed" | "live" (codex-cli 0.142.5)。"enabled" という
    // 値は存在しないため、有効時は実際のライブ検索を意味する "live" を使う。
    `web_search = ${tomlString(input.webSearchEnabled ? "live" : "disabled")}`,
    "",
    "[features]",
    "image_generation = true",
    "",
    "[tools]",
    // get_attached_media / render_* が返す run-scoped PNG を、シェルを経由せず
    // Codex の画像閲覧ツールで確認させる。AI編集は read-only sandbox のままなので、
    // 画像閲覧の有効化によって教材ファイルへの書き込み権限は増えない。
    "view_image = true",
    "",
    ...(input.subagents
      ? [
          "[agents]",
          ...(input.subagents.enabled
            ? [
                "enabled = true",
                `max_depth = ${input.subagents.maxDepth}`,
                `max_concurrent_threads_per_session = ${input.subagents.maxConcurrent}`,
              ]
            : ["enabled = false"]),
          "",
        ]
      : []),
    `[mcp_servers.${SIGMA_DOC_MCP_SERVER_NAME}]`,
    `command = ${tomlString(input.execPath)}`,
    `args = [${tomlString(input.scriptPath)}]`,
    `startup_timeout_sec = ${MCP_STARTUP_TIMEOUT_SEC}`,
    `tool_timeout_sec = ${MCP_TOOL_TIMEOUT_SEC}`,
    'default_tools_approval_mode = "approve"',
    "",
    `[mcp_servers.${SIGMA_DOC_MCP_SERVER_NAME}.env]`,
    ...envLines,
    "",
  ].join("\n");
}
