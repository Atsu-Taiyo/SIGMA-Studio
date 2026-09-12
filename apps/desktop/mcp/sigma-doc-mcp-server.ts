import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createSigmaDocMcpServer } from "./sigma-doc-mcp-server-core";

async function main(): Promise<void> {
  const server = createSigmaDocMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
