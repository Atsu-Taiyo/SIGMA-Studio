import { createHash } from "node:crypto";
import { documentFontReferences } from "@/features/document";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import {
  LibraryAccessSchema,
  LibraryFacetsRequestSchema,
  LibraryFacetsResponseSchema,
  LibraryGetRequestSchema,
  LibrarySearchRequestSchema,
  LibrarySearchResponseSchema,
  type LibraryAccess,
  type LibraryFacetsResult,
  type LibraryGetResult,
  type LibrarySearchResult,
} from "@/lib/problem-library-provider";
import { SigmaDocumentSchema } from "@/lib/sigma-doc-schema";
import { APPLICATION_FONT_MAX_BYTES, isApplicationFontId } from "./application-font-store";

/**
 * Main-process client for the members-only problem library (an Edge Function on the
 * collaboration auth project). Every input is validated before the network, routes are fixed, the
 * bearer token is read per request and never stored, and failures reach the renderer only as fixed,
 * localized messages: no status text, response body or token is ever echoed.
 */

export interface ProblemLibraryConnection {
  config: { authUrl: string };
  authorization(): Promise<string>;
}
export interface ProblemLibraryFontStore {
  ensure(resourceId: string, download: () => Promise<Uint8Array>): Promise<void>;
}

type Failure =
  | "unconfigured" | "loginRequired" | "denied" | "invalidRequest" | "notFound" | "rateLimited"
  | "upstreamError" | "invalidResponse" | "tooLarge" | "unsafeResponse" | "connectionFailed" | "fontFailed";

const FUNCTION_PATH = "functions/v1/problem-library/";
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const JSON_TIMEOUT_MS = 15_000;
const FONT_TIMEOUT_MS = 60_000;

const message = (failure: Failure) => createCurrentLocaleTranslator("editor")(`problemLibrary.libraryErrors.${failure}`);
const fail = (failure: Failure) => ({ ok: false as const, error: message(failure) });

/** The Edge Function's base, or null when the configured project URL is not a plain origin. */
function functionBase(authUrl: string): URL | null {
  try {
    const url = new URL(authUrl);
    const local = process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return new URL(FUNCTION_PATH, url.origin + "/");
  } catch {
    return null;
  }
}

type Outcome<T> = { ok: true; data: T } | { ok: false; failure: Failure };

/** JSON escapes must not hide a credential in a value or an object key. */
function containsCredential(value: unknown, token: string): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (current.includes(token)) return true;
    } else if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        if (key.includes(token)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * One call to a fixed route. `route` is built only from validated values in this file. JSON bodies
 * are checked for the bearer token before and after decoding, so encoded values cannot hand it to the renderer.
 */
async function call(
  connection: ProblemLibraryConnection | null | undefined,
  route: string,
  init: { method: "GET" } | { method: "POST"; body: unknown },
  expect: "json" | "bytes",
  fetchImpl: typeof fetch,
): Promise<Outcome<unknown>> {
  if (!connection) return { ok: false, failure: "unconfigured" };
  const base = functionBase(connection.config.authUrl);
  if (!base) return { ok: false, failure: "unconfigured" };
  let authorization: string;
  try { authorization = await connection.authorization(); }
  catch { return { ok: false, failure: "loginRequired" }; }
  const token = authorization.replace(/^Bearer /u, "");
  if (!token) return { ok: false, failure: "loginRequired" };
  try {
    const response = await fetchImpl(new URL(route, base).toString(), {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: expect === "json" ? "application/json" : "application/octet-stream, font/*",
        ...(init.method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.method === "POST" ? { body: JSON.stringify(init.body) } : {}),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(expect === "json" ? JSON_TIMEOUT_MS : FONT_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const failure: Failure = response.status === 401 ? "loginRequired"
        : response.status === 403 ? "denied"
          : response.status === 400 ? "invalidRequest"
            : response.status === 404 ? "notFound"
              : response.status === 429 ? "rateLimited"
                : "upstreamError";
      return { ok: false, failure };
    }
    if (expect === "json" && !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel();
      return { ok: false, failure: "invalidResponse" };
    }
    const bytes = await readBounded(response, expect === "json" ? MAX_JSON_BYTES : APPLICATION_FONT_MAX_BYTES);
    if (!bytes) return { ok: false, failure: "tooLarge" };
    if (expect === "bytes") return { ok: true, data: bytes };
    const text = Buffer.from(bytes).toString("utf8");
    if (text.includes(token)) return { ok: false, failure: "unsafeResponse" };
    try {
      const data: unknown = JSON.parse(text);
      if (containsCredential(data, token)) return { ok: false, failure: "unsafeResponse" };
      return { ok: true, data };
    }
    catch { return { ok: false, failure: "invalidResponse" }; }
  } catch {
    return { ok: false, failure: "connectionFailed" };
  }
}

/** Whether the signed-in user may use the library. Every failure is "not available", never an error. */
export async function fetchLibraryAccess(
  connection: ProblemLibraryConnection | null | undefined, fetchImpl: typeof fetch = fetch,
): Promise<LibraryAccess> {
  const result = await call(connection, "access", { method: "GET" }, "json", fetchImpl);
  if (!result.ok) return { available: false };
  const parsed = LibraryAccessSchema.safeParse(result.data);
  // A library without a name cannot be shown as a source, so it is treated as unavailable.
  if (!parsed.success || !parsed.data.available || !parsed.data.label) return { available: false };
  return { available: true, label: parsed.data.label };
}

export async function fetchLibrarySearch(
  input: unknown, connection: ProblemLibraryConnection | null | undefined, fetchImpl: typeof fetch = fetch,
): Promise<LibrarySearchResult> {
  const request = LibrarySearchRequestSchema.safeParse(input);
  if (!request.success) return fail("invalidRequest");
  const result = await call(connection, "search", { method: "POST", body: request.data }, "json", fetchImpl);
  if (!result.ok) return fail(result.failure);
  const parsed = LibrarySearchResponseSchema.safeParse(result.data);
  if (!parsed.success) return fail("invalidResponse");
  // Duplicate ids would collide as React keys and as import targets; the first occurrence wins.
  const seen = new Set<string>();
  const results = parsed.data.results.filter(problem => !seen.has(problem.id) && Boolean(seen.add(problem.id)));
  return { ok: true, search: { ...parsed.data, results } };
}

export async function fetchLibraryFacets(
  input: unknown, connection: ProblemLibraryConnection | null | undefined, fetchImpl: typeof fetch = fetch,
): Promise<LibraryFacetsResult> {
  const request = LibraryFacetsRequestSchema.safeParse(input);
  if (!request.success) return fail("invalidRequest");
  const result = await call(connection, "facets", { method: "POST", body: request.data }, "json", fetchImpl);
  if (!result.ok) return fail(result.failure);
  const parsed = LibraryFacetsResponseSchema.safeParse(result.data);
  if (!parsed.success) return fail("invalidResponse");
  return { ok: true, facets: parsed.data.facets };
}

/**
 * The full document, validated as SigmaDoc. Fonts it references are downloaded, checked against
 * their sha256 resource id and put into the application font store before the document is returned,
 * so the opened material renders with them and never points at a font the app does not have.
 */
export async function fetchLibraryProblem(
  input: unknown,
  connection: ProblemLibraryConnection | null | undefined,
  fontStore: ProblemLibraryFontStore | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<LibraryGetResult> {
  const request = LibraryGetRequestSchema.safeParse(input);
  if (!request.success) return fail("invalidRequest");
  const result = await call(connection, `problems/${request.data.id}`, { method: "GET" }, "json", fetchImpl);
  if (!result.ok) return fail(result.failure);
  const parsed = SigmaDocumentSchema.safeParse(result.data);
  if (!parsed.success) return fail("invalidResponse");
  const document = parsed.data;
  const snapshot = document.pageLayout?.overlay?.overlaySnapshot;
  const references = documentFontReferences(snapshot);
  const declared = snapshot?.extensions?.["sigma.font-references"];
  // A reference the reader would drop must not be silently ignored: the material would render in a fallback font.
  if (declared !== undefined && (!Array.isArray(declared) || declared.length !== references.length)) return fail("invalidResponse");
  const resourceIds = [...new Set(references.map(reference => reference.resourceId))];
  if (resourceIds.length > 0 && !fontStore) return fail("fontFailed");
  for (const resourceId of resourceIds) {
    if (!isApplicationFontId(resourceId)) return fail("invalidResponse");
    try {
      await fontStore!.ensure(resourceId, async () => {
        const font = await call(connection, `fonts/${resourceId}`, { method: "GET" }, "bytes", fetchImpl);
        if (!font.ok) throw new Error("FONT_DOWNLOAD_FAILED");
        const bytes = font.data as Uint8Array;
        if (createHash("sha256").update(bytes).digest("hex") !== resourceId) throw new Error("FONT_HASH_MISMATCH");
        return bytes;
      });
    } catch {
      return fail("fontFailed");
    }
  }
  return { ok: true, document };
}
