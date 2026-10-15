import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {},
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
}));

import { sampleDocument } from "@/lib/sample-document";

import { IMPORT_MAX_INPUT_BYTES, PluginHost, resolvePluginConfig, selectEditingFonts, type PluginHostOptions } from "./host";
import { PluginError, type CatalogFile } from "./manifest";

const ACTION = { type: "import-file", command: "convert", extensions: [".smp"] } as const;
const file = (name: string, bytes = 8) => ({ filePath: `/Users/someone/${name}`, bytes: new Uint8Array(bytes).fill(1) });

function createHost(overrides: Partial<PluginHostOptions> = {}) {
  const ensure = vi.fn(async (_id: string, download: () => Promise<Uint8Array>) => { await download(); });
  const host = new PluginHost({
    dataDir: "/tmp/sigma-host-test", appVersion: "0.515.1", isPackaged: true, config: null, auth: null,
    fontStore: { ensure } as never, getMainContents: () => null, partialFontNote: () => "（一部）", ...overrides,
  });
  return { host, ensure };
}

function stub(host: PluginHost, run: (payload: Record<string, unknown>) => unknown) {
  vi.spyOn(host.manager, "resolveAction").mockReturnValue({ ...ACTION, extensions: [...ACTION.extensions] });
  return vi.spyOn(host.manager, "run").mockImplementation(async (_id, payload) => run(payload));
}

afterEach(() => vi.restoreAllMocks());

describe("resolvePluginConfig", () => {
  const config = { catalogUrl: "https://example.test/plugins/catalog", publicKey: "PEM" };

  it("ignores environment overrides in a packaged app", () => {
    const env = { SIGMA_EXTENSIONS_CATALOG_URL: "http://127.0.0.1:1/plugins/catalog", SIGMA_EXTENSIONS_PUBLIC_KEY: "OTHER" };
    expect(resolvePluginConfig(config, true, env)).toEqual({ config, allowLoopbackHttp: false });
  });

  it("lets development and tests point at a local catalog, with loopback http allowed", () => {
    const env = { SIGMA_EXTENSIONS_CATALOG_URL: "http://127.0.0.1:1/plugins/catalog", SIGMA_EXTENSIONS_PUBLIC_KEY: "A\\nB" };
    expect(resolvePluginConfig(config, false, env)).toEqual({
      config: { catalogUrl: "http://127.0.0.1:1/plugins/catalog", publicKey: "A\nB" }, allowLoopbackHttp: true,
    });
    expect(resolvePluginConfig(config, false, {})).toEqual({ config, allowLoopbackHttp: true });
  });
});

describe("selectEditingFonts", () => {
  const font = (displayName: string, bytes: number, complete?: boolean): CatalogFile => ({
    path: `fonts/${displayName}${bytes}.ttf`, kind: "font", sha256: "a".repeat(64), bytes, family: "F", displayName, portable: true, ...(complete === undefined ? {} : { complete }),
  });

  it("offers one face per name, preferring complete coverage and then the larger file", () => {
    const picked = selectEditingFonts([
      { path: "worker.cjs", kind: "code", sha256: "b".repeat(64), bytes: 20 },
      font("A", 100, false), font("A", 50, true), font("B", 10), font("B", 30),
    ]);
    expect(picked.map((item) => [item.displayName, item.bytes])).toEqual([["A", 50], ["B", 30]]);
  });
});

describe("PluginHost.isFontVisible", () => {
  it("shows the user's own fonts and gates bundled fonts on the owning extension", () => {
    const { host } = createHost();
    vi.spyOn(host.manager, "isFontVisible").mockImplementation((sha) => sha === "visible");
    expect(host.isFontVisible({ id: "font_0123456789abcdef" })).toBe(true);
    expect(host.isFontVisible({ id: "plugin-visible" })).toBe(true);
    expect(host.isFontVisible({ id: "plugin-hidden" })).toBe(false);
  });
});

describe("PluginHost.runItem", () => {
  it.each([[1, "x"], ["x", undefined], [null, null]])("rejects non-string ids %#", async (extensionId, itemId) => {
    const { host } = createHost();
    expect(await host.runItem(extensionId, itemId, async () => file("a.smp"))).toEqual({ ok: false, error: "invalid-input" });
  });

  it("does not ask for a file when the item is unknown, disabled or revoked", async () => {
    const { host } = createHost();
    const pick = vi.fn(async () => file("a.smp"));
    expect(await host.runItem("sample-tool", "import-sample", pick)).toEqual({ ok: false, error: "unavailable" });
    expect(pick).not.toHaveBeenCalled();
  });

  it("reports a canceled picker without starting the worker", async () => {
    const { host } = createHost();
    const run = stub(host, () => ({}));
    expect(await host.runItem("sample-tool", "import-sample", async () => null)).toEqual({ ok: false, error: "canceled" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["a different extension", file("a.txt")],
    ["no extension", file("README")],
    ["an empty file", file("a.smp", 0)],
    ["a file over the limit", { filePath: "/x/a.smp", bytes: { byteLength: IMPORT_MAX_INPUT_BYTES + 1 } as Uint8Array }],
    ["a control character in the name", file("a\u0007.smp")],
  ])("rejects %s before any worker runs", async (_name, picked) => {
    const { host } = createHost();
    const run = stub(host, () => ({}));
    expect(await host.runItem("sample-tool", "import-sample", async () => picked)).toEqual({ ok: false, error: "invalid-input" });
    expect(run).not.toHaveBeenCalled();
  });

  it("treats a failing picker as invalid input", async () => {
    const { host } = createHost();
    stub(host, () => ({}));
    expect(await host.runItem("sample-tool", "import-sample", async () => { throw new Error("denied"); })).toEqual({ ok: false, error: "invalid-input" });
  });

  it("matches the extension case-insensitively and passes only the command, bytes and base name to the worker", async () => {
    const { host } = createHost();
    const run = stub(host, () => ({ document: sampleDocument, issues: [{ code: "font-substitution", detail: "Example" }] }));
    const result = await host.runItem("sample-tool", "import-sample", async () => file("教材.SMP", 4));
    expect(result).toMatchObject({ ok: true, sourceName: "教材.SMP", issues: [{ code: "font-substitution", detail: "Example" }] });
    const [id, payload] = run.mock.calls[0];
    expect(id).toBe("sample-tool");
    expect(Object.keys(payload).sort()).toEqual(["bytes", "command", "filename"]);
    expect(payload).toMatchObject({ command: "convert", filename: "教材.SMP" });
    expect((payload.bytes as ArrayBuffer).byteLength).toBe(4);
  });

  it.each([
    ["timeout", new PluginError("timeout"), "timeout"],
    ["busy", new PluginError("busy"), "busy"],
    ["revoked", new PluginError("forbidden"), "forbidden"],
    ["signed out", new PluginError("unauthorized"), "unauthorized"],
    ["failed verification", new PluginError("verification-failed"), "unavailable"],
    ["incompatible", new PluginError("incompatible"), "unavailable"],
    ["an unexpected error", new Error("boom"), "import-failed"],
  ])("maps %s to a stable error", async (_name, error, expected) => {
    const { host } = createHost();
    stub(host, () => { throw error; });
    expect(await host.runItem("sample-tool", "import-sample", async () => file("a.smp"))).toEqual({ ok: false, error: expected });
  });

  it.each([
    ["a non-object result", "text"],
    ["a document that fails the schema", { document: { version: "unknown" }, issues: [] }],
    ["issues that are not a list", { document: sampleDocument, issues: "none" }],
    ["an issue with an oversized detail", { document: sampleDocument, issues: [{ code: "x", detail: "a".repeat(4097) }] }],
    ["an issue without a code", { document: sampleDocument, issues: [{ code: "", detail: "x" }] }],
    ["too many issues", { document: sampleDocument, issues: Array.from({ length: 10_001 }, () => ({ code: "x", detail: "y" })) }],
    ["a font resource that is not bytes", { document: sampleDocument, issues: [], localFontResources: [{ resourceId: "a".repeat(64), bytes: "no" }] }],
    ["too many font resources", { document: sampleDocument, issues: [], localFontResources: Array.from({ length: 33 }, () => ({ resourceId: "a".repeat(64), bytes: new Uint8Array(1) })) }],
  ])("rejects %s", async (_name, raw) => {
    const { host } = createHost();
    stub(host, () => raw);
    expect(await host.runItem("sample-tool", "import-sample", async () => file("a.smp"))).toEqual({ ok: false, error: "import-failed" });
  });

  it("stores font resources the worker returns, by content hash", async () => {
    const { host, ensure } = createHost();
    const bytes = new Uint8Array([1, 2, 3]);
    stub(host, () => ({ document: sampleDocument, issues: [], localFontResources: [{ resourceId: "c".repeat(64), bytes }] }));
    expect((await host.runItem("sample-tool", "import-sample", async () => file("a.smp"))).ok).toBe(true);
    expect(ensure).toHaveBeenCalledWith("c".repeat(64), expect.any(Function));
  });

  it("refuses font resources when there is no store to verify them", async () => {
    const { host } = createHost({ fontStore: undefined });
    stub(host, () => ({ document: sampleDocument, issues: [], localFontResources: [{ resourceId: "c".repeat(64), bytes: new Uint8Array(1) }] }));
    expect(await host.runItem("sample-tool", "import-sample", async () => file("a.smp"))).toEqual({ ok: false, error: "import-failed" });
  });
});
