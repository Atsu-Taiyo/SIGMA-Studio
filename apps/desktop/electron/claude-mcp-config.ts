import {
  buildSigmaStudioMcpEnv,
  SIGMA_DOC_MCP_SERVER_NAME,
  type SigmaStudioMcpLaunchSpec,
} from "./sigma-studio-mcp-launch";

export type ClaudeMcpConfigInput = SigmaStudioMcpLaunchSpec;

export interface ClaudeMcpStdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ClaudeMcpConfig {
  mcpServers: {
    "sigma-studio-local": ClaudeMcpStdioServer;
  };
}

export { SIGMA_DOC_MCP_SERVER_NAME };

export function buildClaudeMcpConfig(input: ClaudeMcpConfigInput): ClaudeMcpConfig {
  return {
    mcpServers: {
      [SIGMA_DOC_MCP_SERVER_NAME]: {
        type: "stdio",
        command: input.execPath,
        args: [input.scriptPath],
        env: buildSigmaStudioMcpEnv(input),
      },
    },
  };
}
