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

import { buildSigmaStudioMcpEnv, SIGMA_DOC_MCP_SERVER_NAME, type SigmaStudioMcpLaunchSpec } from "./sigma-studio-mcp-launch";

export type CodexAgentConfigInput = SigmaStudioMcpLaunchSpec & { webSearchEnabled: boolean };

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
