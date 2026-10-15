import { documentFontReferences } from "@/features/document";
import { ApplicationFontStore, APPLICATION_FONT_MAX_BYTES, isApplicationFontId } from "./application-font-store";
import { SigmaDocumentSchema } from "@/lib/sigma-doc-schema";
import {
  DOCUMENT_CONVERSION_MAX_INPUT_BYTES,
  DOCUMENT_CONVERSION_MAX_RESPONSE_BYTES,
  isConversionFilename,
  type DocumentConversionCapability,
  type DocumentConversionError,
  type DocumentConversionResponse,
  type DocumentConversionIssue,
} from "@/lib/document-conversion-contracts";

const TIMEOUT_MS = 95_000;
const CAPABILITY_TIMEOUT_MS = 8_000;
const MAX_CAPABILITY_RESPONSE_BYTES = 64 * 1024;
const MAX_FILENAME_BYTES = 255;
const MAX_ISSUES = 10_000;
const MAX_ISSUE_DETAIL_LENGTH = 4_096;
const ISSUE_CODES = new Set<DocumentConversionIssue["code"]>([
  "font-substitution", "missing-glyph", "unsupported-math", "unsupported-graphic", "unsupported-style",
]);

export interface DocumentConversionAuth {
  user(): unknown | null;
  authorization(): Promise<string>;
}

export interface DocumentConversionClientOptions {
  url?: string;
  allowLoopbackHttp?: boolean;
  auth: DocumentConversionAuth | null;
  fetchImpl?: typeof fetch;
  fontStore?: ApplicationFontStore;
}

function fixedOrigin(raw: string | undefined, allowLoopbackHttp: boolean): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch { return null; }
}

function validFilename(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { encodeURIComponent(value); } catch { return false; }
  return isConversionFilename(value)
    && Buffer.byteLength(value, "utf8") <= MAX_FILENAME_BYTES
    && !/[\\/\u0000-\u001f\u007f]/u.test(value)
    && value.trim() === value
    && !value.startsWith(".");
}

function validPayload(value: unknown): value is { bytes: Uint8Array; filename: string } {
  if (!value || typeof value !== "object") return false;
  const { bytes, filename } = value as { bytes?: unknown; filename?: unknown };
  return bytes instanceof Uint8Array
    && bytes.byteLength > 0
    && bytes.byteLength <= DOCUMENT_CONVERSION_MAX_INPUT_BYTES
    && validFilename(filename);
}

function statusError(status: number): DocumentConversionError {
  if (status === 400 || status === 413) return "invalid-input";
  if (status === 401) return "unauthorized";
  if (status === 403) return "not-allowed";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "busy";
  if (status === 404 || status === 502 || status === 503) return "unavailable";
  return "import-failed";
}

class InvalidConversionResponseError extends Error {}

async function readJson(response: Response, authorization: string, maxBytes = DOCUMENT_CONVERSION_MAX_RESPONSE_BYTES): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel();
    throw new InvalidConversionResponseError("CONTENT_TYPE");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new InvalidConversionResponseError("RESPONSE_TOO_LARGE");
  }
  if (!response.body) throw new InvalidConversionResponseError("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new InvalidConversionResponseError("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (body.includes(authorization.slice("Bearer ".length))) throw new InvalidConversionResponseError("TOKEN_ECHO");
  try { return JSON.parse(body) as unknown; }
  catch { throw new InvalidConversionResponseError("INVALID_JSON"); }
}

const MAX_DISPLAY_NAME_LENGTH = 40;

/** The service names its own file type; accept only a short single-line label. */
function parseDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_DISPLAY_NAME_LENGTH && !/[\u0000-\u001f\u007f]/u.test(name) ? name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSuccess(value: unknown): DocumentConversionResponse {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.result)) return { ok: false, error: "import-failed" };
  const { document, issues } = value.result;
  if (!Array.isArray(issues) || issues.length > MAX_ISSUES || !issues.every((issue) =>
    isRecord(issue) && ISSUE_CODES.has(issue.code as DocumentConversionIssue["code"])
    && typeof issue.detail === "string" && issue.detail.length <= MAX_ISSUE_DETAIL_LENGTH)) {
    return { ok: false, error: "import-failed" };
  }
  try {
    const parsed = SigmaDocumentSchema.safeParse(document);
    if (!parsed.success) return { ok: false, error: "import-failed" };
    return { ok: true, result: { document: parsed.data, issues: issues.map((issue) => ({
      code: issue.code as DocumentConversionIssue["code"], detail: issue.detail as string,
    })) } };
  } catch { return { ok: false, error: "import-failed" }; }
}

export class DocumentConversionClient {
  private readonly origin: string | null;
  private readonly auth: DocumentConversionAuth | null;
  private readonly fetchImpl: typeof fetch;
  private converting = false;
  private readonly fontStore: ApplicationFontStore | undefined;

  constructor(options: DocumentConversionClientOptions) {
    this.origin = fixedOrigin(options.url, options.allowLoopbackHttp ?? false);
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fontStore = options.fontStore;
  }

  private async authorization(): Promise<string | null> {
    if (!this.auth?.user()) return null;
    try {
      const value = await this.auth.authorization();
      return /^Bearer [A-Za-z0-9._~+/-]+={0,2}$/u.test(value) ? value : null;
    } catch { return null; }
  }

  async ensureFontResources(resourceIds: unknown): Promise<void> {
    if (!Array.isArray(resourceIds) || resourceIds.length > 32 || !resourceIds.every(isApplicationFontId)) throw new Error("INVALID_FONT_IDS");
    if (!resourceIds.length) return;
    if (!this.fontStore) throw new Error("FONT_STORE_UNAVAILABLE");
    for (const id of new Set<string>(resourceIds)) await this.fontStore.ensure(id, async () => {
      const authorization = await this.authorization();
      if (!this.origin || !authorization) throw new Error("FONT_SERVICE_UNAVAILABLE");
      const response = await this.fetchImpl(`${this.origin}/v1/fonts/${id}`, {
        headers: { Authorization: authorization }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== this.origin)
        || Number(response.headers.get("content-length")) > APPLICATION_FONT_MAX_BYTES) {
        await response.body?.cancel(); throw new Error("INVALID_FONT_RESPONSE");
      }
      if (!response.body) throw new Error("EMPTY_FONT_RESPONSE");
      const chunks: Uint8Array[] = [], reader = response.body.getReader();
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > APPLICATION_FONT_MAX_BYTES) throw new Error("FONT_RESPONSE_TOO_LARGE");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return Buffer.concat(chunks, size);
    });
  }

  async capability(): Promise<DocumentConversionCapability> {
    if (!this.origin) return { available: false, reason: "unavailable" };
    const authorization = await this.authorization();
    if (!authorization) return { available: false, reason: "unauthorized" };
    try {
      const response = await this.fetchImpl(`${this.origin}/v1/capabilities`, {
        method: "GET", headers: { Authorization: authorization, Accept: "application/json" },
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
      });
      if (response.redirected || (response.url && new URL(response.url).origin !== this.origin)) return { available: false, reason: "unavailable" };
      if (!response.ok) {
        await response.body?.cancel();
        return { available: false, reason: response.status === 401 ? "unauthorized"
          : response.status === 403 ? "not-allowed" : "unavailable" };
      }
      const data = await readJson(response, authorization, MAX_CAPABILITY_RESPONSE_BYTES);
      if (!isRecord(data) || data.available !== true) return { available: false, reason: "unavailable" };
      const displayName = parseDisplayName(data.displayName);
      return displayName ? { available: true, displayName } : { available: true };
    } catch { return { available: false, reason: "unavailable" }; }
  }

  async convert(payload: unknown): Promise<DocumentConversionResponse> {
    if (!validPayload(payload)) return { ok: false, error: "invalid-input" };
    if (!this.origin) return { ok: false, error: "unavailable" };
    if (this.converting) return { ok: false, error: "busy" };
    this.converting = true;
    try {
      const authorization = await this.authorization();
      if (!authorization) return { ok: false, error: "unauthorized" };
      const response = await this.fetchImpl(`${this.origin}/v1/convert`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          "Content-Type": "application/octet-stream",
          "X-Document-Filename": encodeURIComponent(payload.filename),
        },
        body: Uint8Array.from(payload.bytes).buffer as ArrayBuffer,
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.redirected || (response.url && new URL(response.url).origin !== this.origin)) {
        await response.body?.cancel();
        return { ok: false, error: "unavailable" };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, error: statusError(response.status) };
      }
      const result = parseSuccess(await readJson(response, authorization));
      if (result.ok) {
        const snapshot = result.result.document.pageLayout?.overlay?.overlaySnapshot;
        const references = documentFontReferences(snapshot);
        const raw = snapshot?.extensions?.["sigma.font-references"];
        if (raw !== undefined && (!Array.isArray(raw) || raw.length !== references.length)) return { ok: false, error: "import-failed" };
        await this.ensureFontResources(references.map(({ resourceId }) => resourceId));
      }
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof InvalidConversionResponseError ? "import-failed"
        : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "timeout" : "unavailable" };
    } finally {
      this.converting = false;
    }
  }
}
