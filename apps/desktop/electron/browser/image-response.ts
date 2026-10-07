const FAVICON_MAX_BYTES = 128 * 1024;

/** 外部画像は全体を確保する前にサイズを制限する。Content-Length の無い応答にも適用する。 */
export async function readImageDataUrl(response: Response): Promise<string | null> {
  const type = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
  const length = Number(response.headers.get("content-length"));
  if (!response.ok || !type.startsWith("image/") || length > FAVICON_MAX_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FAVICON_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return size > 0 ? `data:${type};base64,${Buffer.concat(chunks, size).toString("base64")}` : null;
  } finally {
    reader.releaseLock();
  }
}
