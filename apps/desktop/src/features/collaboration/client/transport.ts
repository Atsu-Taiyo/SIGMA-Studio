import type { SaveState } from "../model/protocol";

/** Bounded reads apply to decoded response bytes, including chunked/compressed bodies. */
export async function readResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel();
    throw new Error("RESPONSE_LIMIT");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("RESPONSE_LIMIT");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readResponseJson<T>(response: Response, limit: number): Promise<T> {
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json" && !type?.endsWith("+json")) {
    await response.body?.cancel();
    throw new Error("INVALID_RESPONSE_TYPE");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readResponseBytes(response, limit))) as T;
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

/**
 * What a refusal of the document's images names (#251). A server that predates these fields sends only
 * the code, so every field is optional.
 */
export interface AssetRefusalDetails {
  /** `sigma-doc-storage://` image ids the document would refer to that the server never received. */
  missingAssetIds?: string[];
  /** Ids of the objects whose `src` is no image reference of this document at all. */
  invalidAssetReferences?: string[];
  /** The refused operation of the batch. */
  operationId?: string;
}

export class CollaborationHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs = 0, readonly details: AssetRefusalDetails = {}) { super(message); }
}

const ASSET_ID = /^[A-Za-z0-9_-]{1,180}$/;
function boundedIds(value: unknown, pattern: RegExp): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && pattern.test(item)).slice(0, 100) : undefined;
}

export async function responseError(response: Response): Promise<CollaborationHttpError> {
  const value = await readResponseJson<unknown>(response, 64 * 1024).catch(() => null);
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const code = body.error;
  const missingAssetIds = boundedIds(body.missingAssetIds, ASSET_ID);
  const invalidAssetReferences = boundedIds(body.invalidAssetReferences, /^[^\0]{0,200}$/);
  const operationId = typeof body.operationId === "string" && /^[0-9a-f-]{36}$/i.test(body.operationId) ? body.operationId : undefined;
  return new CollaborationHttpError(
    typeof code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : `HTTP_${response.status}`,
    response.status, retryAfterMilliseconds(response.headers.get("retry-after")),
    { ...(missingAssetIds ? { missingAssetIds } : {}), ...(invalidAssetReferences ? { invalidAssetReferences } : {}), ...(operationId ? { operationId } : {}) },
  );
}

/**
 * The server refused the request itself (400/409/413): resending it unchanged gets the same answer until
 * the request or the server changes. A shared document whose oldest unsent edit is refused cannot send
 * any later edit either, so this is told apart from being unreachable (network, 5xx, 429) and from
 * access (401/403) — e.g. a server whose document schema is older than this app (MISS.md R20).
 */
export function isServerRejection(error: unknown): error is CollaborationHttpError {
  return error instanceof CollaborationHttpError && [400, 409, 413].includes(error.status);
}

/**
 * Raised on this device instead of resending edits the server already refused for their images, and
 * that could not be repaired automatically (#251). Nothing changes until the user edits, adds an image
 * or retries, so asking again would only get the same 400.
 */
export const ASSET_RECOVERY_REQUIRED = "ASSET_RECOVERY_REQUIRED";

/**
 * The server refused an edit for the images it refers to (#251): an image it never received
 * (`MISSING_ASSET`, the only code older servers send) or a `src` that is no image of the document.
 */
export function isAssetRefusal(error: unknown): error is CollaborationHttpError {
  return error instanceof CollaborationHttpError && error.status === 400
    && ["MISSING_ASSET", "INVALID_ASSET_REFERENCE", ASSET_RECOVERY_REQUIRED].includes(error.message);
}

/** The server will not store this image (type, size, or an id it holds with other bytes). */
export function isAssetUploadRefusal(error: unknown): error is CollaborationHttpError {
  return error instanceof CollaborationHttpError && [400, 409, 413, 415].includes(error.status);
}

/** The save state a failed synchronization leaves a shared document in. */
export function syncFailureStatus(error: unknown): SaveState {
  if (/EPOCH/.test(String(error))) return "epoch-error";
  if (
    (error instanceof CollaborationHttpError && [401, 403].includes(error.status))
    || /ACCESS|MEMBERSHIP|READ_ONLY|DOCUMENT_UNAVAILABLE|AUTH_REQUIRED|ACCOUNT_CHANGED/.test(String(error))
  )
    return "permission-error";
  return isServerRejection(error) ? "sync-rejected" : "offline";
}

/** Equal jitter avoids synchronized clients; server Retry-After remains a minimum. */
export function retryDelay(failures: number, error?: unknown): number {
  const ceiling = Math.min(60_000, 10_000 * 2 ** Math.min(Math.max(0, failures - 1), 4));
  return Math.max(ceiling / 2 + Math.random() * ceiling / 2,
    error instanceof CollaborationHttpError ? error.retryAfterMs : 0);
}
