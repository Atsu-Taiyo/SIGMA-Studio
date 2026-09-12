import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { visualSessionsFileName, type AiEditRunContextProvider } from "../electron/ai-edit-run-context";
import type { VisualSessionStatusWriteTarget } from "./visual-edit-session-lifecycle";
import { resolveRunContextDirectory } from "./sigma-doc-mcp-files";

/** 保存先の解決は enqueue 時、tmp の生成・I/O は直前の書込みが終わった後に行う。 */
export function resolveVisualSessionStatusFile(
  env: Record<string, string | undefined>,
  provider: AiEditRunContextProvider | null,
  runId: string | undefined,
): VisualSessionStatusWriteTarget | null {
  const runContextDirectory = resolveRunContextDirectory(env);
  if (!provider || !runId || !runContextDirectory) {
    return null;
  }
  const filePath = path.join(runContextDirectory, visualSessionsFileName(provider, runId));
  return {
    key: filePath,
    async write(statusFile) {
      const temporaryFilePath = `${filePath}.tmp-${randomUUID()}`;
      try {
        await fsPromises.mkdir(runContextDirectory, { recursive: true });
        await fsPromises.writeFile(temporaryFilePath, JSON.stringify(statusFile), "utf8");
        await fsPromises.rename(temporaryFilePath, filePath);
      } catch {
        // Status is an observability aid; MCP edits remain valid when it cannot be written.
      } finally {
        // rename removes the temporary path on success. Clean it up on a failed
        // write as well so a transient error does not accumulate temp files.
        await fsPromises.unlink(temporaryFilePath).catch(() => undefined);
      }
    },
  };
}
