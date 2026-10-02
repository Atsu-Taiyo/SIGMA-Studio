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

export class CollaborationHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs = 0) { super(message); }
}

export async function responseError(response: Response): Promise<CollaborationHttpError> {
  const value = await readResponseJson<unknown>(response, 64 * 1024).catch(() => null);
  const code = value && typeof value === "object" && "error" in value ? value.error : undefined;
  return new CollaborationHttpError(
    typeof code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : `HTTP_${response.status}`,
    response.status, retryAfterMilliseconds(response.headers.get("retry-after")),
  );
}

/** Equal jitter avoids synchronized clients; server Retry-After remains a minimum. */
export function retryDelay(failures: number, error?: unknown): number {
  const ceiling = Math.min(60_000, 10_000 * 2 ** Math.min(Math.max(0, failures - 1), 4));
  return Math.max(ceiling / 2 + Math.random() * ceiling / 2,
    error instanceof CollaborationHttpError ? error.retryAfterMs : 0);
}
