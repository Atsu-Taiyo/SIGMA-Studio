// 重要:
// - command は process.execPath (Electron バイナリ)。.cjs を Node として実行させるため
//   env に ELECTRON_RUN_AS_NODE=1 を必ず入れる (これが無いと Electron が GUI として起動する)。
// - SIGMA_STUDIO_USER_DATA_DIR は main プロセスの USER_DATA_PATH と一致させること。
//   一致しないと MCP サーバーが書く pending proposal を main の watcher が監視できない。

import type { AppLocale } from "@/lib/i18n";
import { VALIDATION_LOCALE_ENV } from "@/lib/ai/validation-locale";
import { MCP_TOOL_PROFILE_ENV } from "@/lib/ai/mcp-tool-profile";
import { SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV } from "./ai-render-bridge";
import { SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV } from "./ai-edit-run-context";
import type { McpEditProposalProvider } from "./local-sigma-doc-proposal-store";

// local-sigma-doc-proposal-store.ts の McpEditProposalProvider を再エクスポートする別名。
// 起動元のprovider指定と提案の保存先providerは同じ値集合でなければならないため、型を分けない。
export type SigmaStudioMcpProvider = McpEditProposalProvider;

export const SIGMA_STUDIO_MCP_PROVIDER_ENV = "SIGMA_STUDIO_MCP_PROVIDER";

export interface SigmaStudioMcpLaunchSpec {
  /**
   * 検証フィードバックを組む言語。**必須** — optional にすると 4 つの呼び出し元のうち
   * 3 つが渡し忘れても型が黙り、Codex と Antigravity だけ日本語のままになる
   * (WI-8b の code-review で実際にそうなっていた)。
   */
  uiLocale: AppLocale;
  execPath: string;
  scriptPath: string;
  userDataDir: string;
  runContextFile: string;
  renderBridgeFile: string;
  provider: SigmaStudioMcpProvider;
}

export const SIGMA_DOC_MCP_SERVER_NAME = "sigma-studio-local";

export function buildSigmaStudioMcpEnv(input: SigmaStudioMcpLaunchSpec): Record<string, string> {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    SIGMA_STUDIO_USER_DATA_DIR: input.userDataDir,
    [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: input.runContextFile,
    [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: input.renderBridgeFile,
    [SIGMA_STUDIO_MCP_PROVIDER_ENV]: input.provider,
    [MCP_TOOL_PROFILE_ENV]: "app",
    // 検証フィードバックの言語。**MCP サーバーは別プロセス**で renderer とメモリを
    // 共有しないので、起動時に渡すしかない (`src/lib/ai/validation-locale.ts`)。
    [VALIDATION_LOCALE_ENV]: input.uiLocale,
  };
}
