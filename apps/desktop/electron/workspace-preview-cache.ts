import fs from "node:fs/promises";
import path from "node:path";

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const MAX_PNG_BYTES = 2 * 1024 * 1024;

export function workspacePreviewDiskKey(fileId: string, revision: number): string {
  return `${fileId}:${revision}`;
}

export function sanitizeWorkspacePreviewFileId(fileId: string): string {
  return fileId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

export function workspacePreviewCachePath(
  userDataPath: string,
  fileId: string,
  revision: number,
): string {
  return path.join(
    userDataPath,
    "workspace-previews",
    `${sanitizeWorkspacePreviewFileId(fileId)}.${revision}.png`,
  );
}

export async function readWorkspacePreviewPng(
  userDataPath: string,
  fileId: string,
  revision: number,
): Promise<string | null> {
  if (!fileId || !Number.isInteger(revision) || revision <= 0) {
    return null;
  }
  try {
    const bytes = await fs.readFile(workspacePreviewCachePath(userDataPath, fileId, revision));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PNG_BYTES) {
      return null;
    }
    return `${PNG_DATA_URL_PREFIX}${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function writeWorkspacePreviewPng(
  userDataPath: string,
  fileId: string,
  revision: number,
  dataUrl: string,
): Promise<boolean> {
  if (!fileId || !Number.isInteger(revision) || revision <= 0) {
    return false;
  }
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    return false;
  }
  const payload = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(payload, "base64");
  } catch {
    return false;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PNG_BYTES) {
    return false;
  }
  const directory = path.join(userDataPath, "workspace-previews");
  await fs.mkdir(directory, { recursive: true });
  const target = workspacePreviewCachePath(userDataPath, fileId, revision);
  await fs.writeFile(target, bytes);
  await removeOtherRevisions(directory, fileId, revision);
  return true;
}

async function removeOtherRevisions(
  directory: string,
  fileId: string,
  keepRevision: number,
): Promise<void> {
  const prefix = `${sanitizeWorkspacePreviewFileId(fileId)}.`;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return;
  }
  await Promise.all(entries.map(async (name) => {
    if (!name.startsWith(prefix) || !name.endsWith(".png")) {
      return;
    }
    const revisionText = name.slice(prefix.length, -".png".length);
    if (revisionText === String(keepRevision)) {
      return;
    }
    await fs.unlink(path.join(directory, name)).catch(() => undefined);
  }));
}
