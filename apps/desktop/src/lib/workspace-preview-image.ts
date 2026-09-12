export function workspacePreviewCacheKey(fileId: string, revision: number): string {
  return `${fileId}:${revision}`;
}

const memory = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

export function readWorkspacePreviewMemory(fileId: string, revision: number): string | null {
  return memory.get(workspacePreviewCacheKey(fileId, revision)) ?? null;
}

export function writeWorkspacePreviewMemory(fileId: string, revision: number, dataUrl: string): void {
  memory.set(workspacePreviewCacheKey(fileId, revision), dataUrl);
}

export async function readWorkspacePreviewDisk(fileId: string, revision: number): Promise<string | null> {
  const api = window.desktopAPI?.workspacePreview;
  if (!api?.get) {
    return null;
  }
  try {
    const value = await api.get(fileId, revision);
    return typeof value === "string" && value.startsWith("data:image/png") ? value : null;
  } catch {
    return null;
  }
}

export async function writeWorkspacePreviewDisk(
  fileId: string,
  revision: number,
  dataUrl: string,
): Promise<void> {
  const api = window.desktopAPI?.workspacePreview;
  if (!api?.put) {
    return;
  }
  try {
    await api.put(fileId, revision, dataUrl);
  } catch {
    /* ignore disk failures; memory still holds the raster */
  }
}

export async function lookupWorkspacePreviewImage(
  fileId: string,
  revision: number,
): Promise<string | null> {
  const cached = readWorkspacePreviewMemory(fileId, revision);
  if (cached) {
    return cached;
  }
  const key = workspacePreviewCacheKey(fileId, revision);
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const lookup = readWorkspacePreviewDisk(fileId, revision).then((dataUrl) => {
    if (dataUrl) {
      writeWorkspacePreviewMemory(fileId, revision, dataUrl);
    }
    return dataUrl;
  }).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, lookup);
  return lookup;
}

export async function persistWorkspacePreviewImage(
  fileId: string,
  revision: number,
  dataUrl: string,
): Promise<void> {
  writeWorkspacePreviewMemory(fileId, revision, dataUrl);
  await writeWorkspacePreviewDisk(fileId, revision, dataUrl);
}
