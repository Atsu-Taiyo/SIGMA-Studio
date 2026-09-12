import fs from "node:fs/promises";
import path from "node:path";

import { SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV } from "../electron/ai-edit-run-context";

const MAX_FILE_COMPONENT_LENGTH = 200;

export function sanitizeMcpFileComponent(value: string, fallback = "run"): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_FILE_COMPONENT_LENGTH);
  return sanitized.length > 0 ? sanitized : fallback;
}

export function resolveRunContextDirectory(env: Record<string, string | undefined>): string | null {
  const runContextFile = env[SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]?.trim();
  return runContextFile ? path.dirname(path.resolve(runContextFile)) : null;
}

export function scopedRunContextPreviewDirectory(runContextDirectory: string, scope: string): string {
  return path.join(runContextDirectory, "previews", sanitizeMcpFileComponent(scope));
}

export async function writeRunContextPreviewFile(
  runContextDirectory: string,
  scope: string,
  fileName: string,
  content: Uint8Array,
): Promise<string> {
  const directory = scopedRunContextPreviewDirectory(runContextDirectory, scope);
  await fs.mkdir(directory, { recursive: true });
  const safeFileName = fileName.trim().replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, MAX_FILE_COMPONENT_LENGTH) || "preview.png";
  const filePath = path.join(directory, safeFileName);
  await fs.writeFile(filePath, content);
  return filePath;
}
