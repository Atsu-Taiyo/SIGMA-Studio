import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApplicationFontStore } from "./application-font-store";
import { describe, expect, it, vi } from "vitest";
import { sampleDocument } from "@/lib/sample-document";
import { DocumentConversionClient, type DocumentConversionAuth } from "./document-conversion-client";

const TOKEN = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature";
const input = { bytes: Uint8Array.from([0x50, 0x52, 0x54]), filename: "数列.prt" };
const success = { ok: true, result: { document: sampleDocument, issues: [] } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

function auth(loggedIn = true): DocumentConversionAuth {
  return { user: () => loggedIn ? { id: "user" } : null, authorization: vi.fn(async () => TOKEN) };
}

function client(fetchImpl: typeof fetch, options?: { url?: string; auth?: DocumentConversionAuth | null; allowLoopbackHttp?: boolean }) {
  return new DocumentConversionClient({
    url: options?.url ?? "https://private.example.test/",
    auth: options?.auth === undefined ? auth() : options.auth,
    allowLoopbackHttp: options?.allowLoopbackHttp,
    fetchImpl,
  });
}

describe("DocumentConversionClient", () => {
  it("refuses missing login, unsafe URLs, and invalid bytes before any network request", async () => {
    const fetchImpl = vi.fn(async () => json(success)) as unknown as typeof fetch;
    expect(await client(fetchImpl, { auth: auth(false) }).capability()).toEqual({ available: false, reason: "unauthorized" });
    expect(await client(fetchImpl, { auth: auth(false) }).convert(input)).toEqual({ ok: false, error: "unauthorized" });
    for (const url of ["http://private.example.test/", "https://private.example.test/path", "https://private.example.test/?x=1", "https://user:pass@private.example.test/"]) {
      expect(await client(fetchImpl, { url }).convert(input)).toEqual({ ok: false, error: "unavailable" });
    }
    expect(await client(fetchImpl).convert({ ...input, filename: "../数列.prt" })).toEqual({ ok: false, error: "invalid-input" });
    expect(await client(fetchImpl).convert({ ...input, bytes: new Uint8Array(0) })).toEqual({ ok: false, error: "invalid-input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows dev loopback HTTP only when explicitly enabled", async () => {
    const fetchImpl = vi.fn(async () => json({ available: true })) as unknown as typeof fetch;
    expect(await client(fetchImpl, { url: "http://127.0.0.1:4312/" }).capability()).toEqual({ available: false, reason: "unavailable" });
    expect(await client(fetchImpl, { url: "http://127.0.0.1:4312/", allowLoopbackHttp: true }).capability()).toEqual({ available: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes on only a short single-line display name chosen by the service", async () => {
    const named = (displayName: unknown) => vi.fn(async () => json({ available: true, displayName })) as unknown as typeof fetch;
    expect(await client(named("  Print Pages  ")).capability()).toEqual({ available: true, displayName: "Print Pages" });
    for (const bad of ["", "   ", "x".repeat(41), "two\nlines", "ctl\u0007", 42, null, { name: "x" }]) {
      expect(await client(named(bad)).capability()).toEqual({ available: true });
    }
  });

  it("maps capability denial and rejects an oversized capability response", async () => {
    for (const [status, reason] of [[401, "unauthorized"], [403, "not-allowed"]] as const) {
      const fetchImpl = vi.fn(async () => json({ available: false, reason }, status)) as unknown as typeof fetch;
      expect(await client(fetchImpl).capability()).toEqual({ available: false, reason });
    }
    const oversized = vi.fn(async () => new Response("{}", { headers: {
      "content-type": "application/json", "content-length": String(64 * 1024 + 1),
    } })) as unknown as typeof fetch;
    expect(await client(oversized).capability()).toEqual({ available: false, reason: "unavailable" });
  });

  it("posts raw bytes to the fixed route with an encoded filename and private bearer", async () => {
    const fetchImpl = vi.fn(async () => json(success)) as unknown as typeof fetch;
    expect(await client(fetchImpl).convert(input)).toMatchObject({ ok: true, result: { issues: [] } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe("https://private.example.test/v1/convert");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(input.bytes);
    expect(init?.headers).toMatchObject({
      Authorization: TOKEN,
      "Content-Type": "application/octet-stream",
      "X-Document-Filename": encodeURIComponent("数列.prt"),
    });
  });

  it("maps server status without exposing response text and rejects invalid successful documents", async () => {
    const errors: Array<[number, string]> = [
      [400, "invalid-input"], [401, "unauthorized"], [403, "not-allowed"],
      [413, "invalid-input"], [429, "busy"], [503, "unavailable"], [504, "timeout"],
    ];
    for (const [status, error] of errors) {
      const fetchImpl = vi.fn(async () => json({ secret: TOKEN }, status)) as unknown as typeof fetch;
      expect(await client(fetchImpl).convert(input)).toEqual({ ok: false, error });
    }
    const invalid = vi.fn(async () => json({ ok: true, result: { document: { version: "2.0" }, issues: [] } })) as unknown as typeof fetch;
    expect(await client(invalid).convert(input)).toEqual({ ok: false, error: "import-failed" });
    const echoed = vi.fn(async () => json({ ...success, debug: TOKEN })) as unknown as typeof fetch;
    expect(await client(echoed).convert(input)).toEqual({ ok: false, error: "import-failed" });
  });

  it("rejects oversized responses and concurrent conversions", async () => {
    const large = vi.fn(async () => new Response("{}", { headers: {
      "content-type": "application/json", "content-length": String(128 * 1024 * 1024 + 1),
    } })) as unknown as typeof fetch;
    expect(await client(large).convert(input)).toEqual({ ok: false, error: "import-failed" });
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async () => pending) as unknown as typeof fetch;
    const conversion = client(fetchImpl);
    const first = conversion.convert(input);
    expect(await conversion.convert(input)).toEqual({ ok: false, error: "busy" });
    release(json(success));
    expect(await first).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

it("downloads referenced fonts once into the application store and keeps them out of SigmaDoc", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-conversion-fonts-"));
  try {
    const bytes = Buffer.alloc(32); bytes[1] = 1;
    const id = createHash("sha256").update(bytes).digest("hex");
    const document = structuredClone(sampleDocument);
    if (!document.pageLayout) throw new Error("Sample layout is required");
    document.pageLayout.overlay = { overlaySnapshot: { version: 1, shapes: [], assets: {}, extensions: {
      "sigma.font-references": [{ family: "Source-123", resourceId: id }],
    } } };
    const fetchImpl = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      expect(options?.headers).toMatchObject({ Authorization: TOKEN });
      return String(url).endsWith(`/v1/fonts/${id}`) ? new Response(bytes)
        : json({ ok: true, result: { document, issues: [] } });
    }) as unknown as typeof fetch;
    const store = new ApplicationFontStore(directory);
    const conversion = new DocumentConversionClient({ url: "https://private.example.test", auth: auth(), fetchImpl, fontStore: store });
    expect(await conversion.convert(input)).toMatchObject({ ok: true });
    expect(await conversion.convert(input)).toMatchObject({ ok: true });
    expect(vi.mocked(fetchImpl).mock.calls.filter(([url]) => String(url).includes("/v1/fonts/"))).toHaveLength(1);
    expect(await store.read(id)).toEqual(bytes);
    expect(JSON.stringify(document)).not.toContain("base64");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
