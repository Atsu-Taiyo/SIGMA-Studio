import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PluginManager, type PluginManagerOptions } from "./manager";
import { digest, verifyCatalog, type CatalogMenuSection, type CatalogPlugin } from "./manifest";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PEM = publicKey.export({ type: "spki", format: "pem" }) as string;
const ID = "sample-tool";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const MENU: CatalogMenuSection[] = [{
  title: "取り込み",
  items: [
    { type: "text", text: "ファイルを選んで取り込みます。" },
    { type: "button", id: "import-sample", label: "サンプルを取り込む", icon: "file-input", action: { type: "import-file", command: "convert", extensions: [".smp"] } },
    { type: "separator" },
  ],
}];

function fixture(version = "1.0.0", sequence = 1, fontText = "font-content-v1", contributes: CatalogPlugin["contributes"] | null = { menu: { sections: MENU } }) {
  const worker = Buffer.from(`// worker ${version}\nmodule.exports = {};\n`);
  const font = Buffer.from(fontText);
  const fontId = digest(font);
  const plugin: CatalogPlugin = {
    id: ID, name: "サンプル変換", description: "PCで変換", version, minAppVersion: "0.510.0",
    entry: "worker.cjs", capabilities: ["document-conversion"],
    files: [
      { path: "worker.cjs", kind: "code", sha256: digest(worker), bytes: worker.length },
      { path: `fonts/${fontId}.ttf`, kind: "font", sha256: fontId, bytes: font.length, family: "Sample Test Font", displayName: "Sample Test Font", portable: true },
    ],
    ...(contributes ? { contributes } : {}),
  };
  return { plugin, ...envelopeFor(plugin, sequence), assets: new Map([[`${ID}/${version}/worker.cjs`, worker], [`${ID}/${version}/fonts/${fontId}.ttf`, font]]) };
}

function envelopeFor(plugin: CatalogPlugin, sequence: number) {
  const payload = Buffer.from(JSON.stringify({ schema: 1, sequence, plugins: [plugin] }));
  return { envelope: { payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") } };
}

interface Server {
  fixture: ReturnType<typeof fixture>;
  signedIn: boolean;
  granted: boolean;
  userId: string;
  corrupt: boolean;
  code: number;
  organizations?: unknown[];
  fonts: Array<{ version: string; folder: string }>;
  requests: string[];
}

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function setup(options: Partial<PluginManagerOptions> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-plugins-"));
  directories.push(directory);
  const state: Server = { fixture: fixture(), signedIn: true, granted: true, userId: USER, corrupt: false, code: 200, fonts: [], requests: [] };
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; redirect: string }) => {
    state.requests.push(url);
    expect(init.headers.Authorization).toBe("Bearer a.b.c");
    expect(init.redirect).toBe("error");
    if (state.code !== 200) return new Response(null, { status: state.code });
    if (url.endsWith("/access")) return Response.json({ userId: state.userId, plugins: state.granted ? [ID] : [], organizations: state.organizations ?? [] });
    if (url.endsWith("/catalog")) return Response.json(state.fixture.envelope);
    const bytes = state.fixture.assets.get(url.split("/assets/")[1]);
    expect(bytes).toBeDefined();
    return new Response(new Uint8Array(state.corrupt ? Buffer.alloc((bytes as Buffer).length) : (bytes as Buffer)));
  }) as unknown as typeof fetch;
  const base: PluginManagerOptions = {
    directory, appVersion: "0.510.0", catalogUrl: "https://example.test/plugins/catalog", publicKey: PEM,
    signedIn: () => state.signedIn, authorization: async () => "Bearer a.b.c", now: () => 2 * 24 * 60 * 60 * 1000,
    userId: () => (state.signedIn ? state.userId : null),
    registerFonts: async (plugin, folder) => { state.fonts.push({ version: plugin.version, folder }); },
    fetchImpl,
  };
  const manager = new PluginManager({ ...base, ...options });
  await manager.initialize();
  return { manager, state, directory, base: { ...base, ...options } };
}

describe("PluginManager", () => {
  it("requires a current grant even for installed plugins and after restart", async () => {
    const { manager, state, directory, base } = await setup({ runWorker: async () => ({ document: "local" }) });
    state.signedIn = false;
    const requests = state.requests.length;
    expect((await manager.check()).error).toBe("unauthorized");
    expect(state.requests).toHaveLength(requests);
    state.signedIn = true;
    expect((await manager.check()).plugins).toHaveLength(1);
    expect((await manager.install(ID)).plugins[0].installedVersion).toBe("1.0.0");
    expect(await manager.run(ID, {})).toEqual({ document: "local" });
    state.granted = false;
    await expect(manager.run(ID, {})).rejects.toThrow("forbidden");
    state.signedIn = false;
    await expect(manager.run(ID, {})).rejects.toThrow("unauthorized");
    const reopened = new PluginManager({ ...base, directory, runWorker: async () => "reopened" });
    await reopened.initialize();
    expect(reopened.status().plugins).toEqual([]);
    expect(reopened.state.installed[ID].version).toBe("1.0.0");
    await expect(reopened.run(ID, {})).rejects.toThrow("unauthorized");
    state.signedIn = true;
    state.granted = true;
    expect(await reopened.run(ID, {})).toBe("reopened");
    await reopened.setEnabled(ID, false);
    await expect(reopened.run(ID, {})).rejects.toThrow("unavailable");
  });

  it("fails closed on role failures and user switches without starting a worker", async () => {
    let runs = 0;
    const { manager, state } = await setup({ runWorker: async () => { runs += 1; } });
    await manager.check();
    await manager.install(ID);
    state.code = 503;
    await expect(manager.run(ID, {})).rejects.toThrow("unavailable");
    expect(manager.status().plugins).toEqual([]);
    state.code = 200;
    state.granted = false;
    await expect(manager.setEnabled(ID, true)).rejects.toThrow("forbidden");
    await expect(manager.run(ID, {})).rejects.toThrow("forbidden");
    expect(runs).toBe(0);
  });

  it("does not let a previous user's grant authorize another user or a session switch mid-request", async () => {
    let runs = 0;
    const { manager, state } = await setup({ runWorker: async () => { runs += 1; } });
    await manager.check();
    await manager.install(ID);
    const previous = state.userId;
    state.userId = OTHER_USER;
    expect(manager.hasAccess(ID)).toBe(false);
    manager.fetchImpl = (async () => Response.json({ userId: previous, plugins: [ID] })) as unknown as typeof fetch;
    await expect(manager.run(ID, {})).rejects.toThrow("forbidden");
    manager.fetchImpl = (async () => {
      const userId = state.userId;
      state.userId = previous;
      return Response.json({ userId, plugins: [ID] });
    }) as unknown as typeof fetch;
    await expect(manager.run(ID, {})).rejects.toThrow("forbidden");
    expect(runs).toBe(0);
  });

  it("never replaces an installed version with invalid bytes and cleans staging files", async () => {
    const { manager, state, directory } = await setup();
    await manager.check();
    await manager.install(ID);
    state.fixture = fixture("1.1.0", 2);
    await manager.check();
    state.corrupt = true;
    expect((await manager.install(ID)).error).toBe("verification-failed");
    expect(manager.status().plugins[0].installedVersion).toBe("1.0.0");
    expect((await fs.readdir(directory)).some((name) => name.startsWith(".staging"))).toBe(false);
    const plugin = await manager.installedPlugin(ID);
    await fs.writeFile(path.join(manager.versionDir(plugin), "worker.cjs"), "corrupt");
    await expect(manager.run(ID, {})).rejects.toThrow("verification-failed");
  });

  it("waits for an active job before activating an update and retains the old version and fonts", async () => {
    let release!: (value: string) => void;
    let started!: (value: string) => void;
    const start = new Promise<string>((resolve) => { started = resolve; });
    const result = new Promise<string>((resolve) => { release = resolve; });
    const { manager, state, directory } = await setup({ runWorker: async (filename) => { started(filename); return result; } });
    await manager.check();
    await manager.install(ID);
    const running = manager.run(ID, {});
    expect(await start).toMatch(/1\.0\.0/);
    state.fixture = fixture("1.1.0", 2, "font-content-v2");
    await manager.check();
    const updating = manager.install(ID);
    while (!manager.idleWaiters.length) await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await manager.check()).error).toBe("busy");
    expect(manager.status().plugins[0].installedVersion).toBe("1.0.0");
    release("old-result");
    expect(await running).toBe("old-result");
    const updated = await updating;
    expect(updated.plugins[0].installedVersion).toBe("1.1.0");
    expect(updated.error).toBeUndefined();
    expect((await fs.readdir(path.join(directory, ID))).sort()).toEqual(["1.0.0", "1.1.0"]);
    expect(state.fonts.map((font) => font.version)).toEqual(["1.0.0", "1.1.0"]);
  });

  it("auto-updates only installed, enabled plugins and persists the opt-out", async () => {
    const { manager, state } = await setup();
    await manager.refreshAutomatically();
    expect(manager.status().plugins[0].installedVersion).toBeUndefined();
    await manager.install(ID);
    await manager.setAutoUpdate(false);
    state.fixture = fixture("1.1.0", 2);
    manager.state.lastChecked = 0;
    await manager.refreshAutomatically();
    expect(manager.status().plugins[0].installedVersion).toBe("1.0.0");
    await manager.setAutoUpdate(true);
    manager.state.lastChecked = 0;
    await manager.refreshAutomatically();
    expect(manager.status().plugins[0].installedVersion).toBe("1.1.0");
  });

  it("does not let a new job race with font registration during activation", async () => {
    let release!: () => void;
    let entered!: () => void;
    const registering = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager, state } = await setup({
      registerFonts: async (plugin) => { if (plugin.version === "1.1.0") { entered(); await gate; } },
      runWorker: async (filename) => filename,
    });
    await manager.check();
    await manager.install(ID);
    state.fixture = fixture("1.1.0", 2);
    await manager.check();
    const installation = manager.install(ID);
    await registering;
    await expect(manager.run(ID, {})).rejects.toThrow("busy");
    expect(manager.status().plugins[0].installedVersion).toBe("1.0.0");
    release();
    await installation;
    expect(await manager.run(ID, {})).toMatch(/1\.1\.0/);
  });

  it("fails closed on catalog tampering, rollback, unsafe paths and an incompatible version", async () => {
    const { manager, state } = await setup();
    await manager.check();
    state.fixture = fixture("1.1.0", 2);
    await manager.check();
    state.fixture = fixture();
    expect((await manager.check()).error).toBe("verification-failed");
    const tampered = fixture("1.1.0", 3);
    tampered.envelope.payload = Buffer.from("{}").toString("base64");
    expect(() => verifyCatalog(tampered.envelope, PEM)).toThrow("verification-failed");
    const unsafe = fixture();
    unsafe.plugin.files[0].path = "../worker.cjs";
    expect(() => verifyCatalog(envelopeFor(unsafe.plugin, 3).envelope, PEM)).toThrow("verification-failed");
    const newer = fixture("1.2.0", 4);
    newer.plugin.minAppVersion = "9.0.0";
    state.fixture = { ...newer, ...envelopeFor(newer.plugin, 4) };
    await manager.check();
    expect((await manager.install(ID)).error).toBe("incompatible");
  });

  it("keeps organization identity server-owned and keeps the name when a logo fails", async () => {
    const { manager, state } = await setup();
    state.organizations = [{ id: ORGANIZATION, name: "学校A", logoPath: null }];
    await manager.refreshAccess();
    expect(manager.status().organizations).toEqual([{ id: ORGANIZATION, name: "学校A", logoUrl: null }]);
    state.userId = OTHER_USER;
    expect(manager.status().organizations).toEqual([]);
    state.organizations = [];
    await manager.refreshAccess();
    expect(manager.status().organizations).toEqual([]);
    state.organizations = [{ id: ORGANIZATION, name: "学校A", logoPath: `${ORGANIZATION}/${"a".repeat(64)}.png` }];
    await manager.refreshAccess();
    expect(manager.status().organizations?.[0].name).toBe("学校A");
    expect(manager.status().organizations?.[0].logoUrl).toBeNull();
    state.signedIn = false;
    expect(manager.status().organizations).toEqual([]);
  });

  it("hides cached and installed metadata after revocation, logout, failure and account change", async () => {
    const { manager, state } = await setup();
    await manager.check();
    await manager.install(ID);
    expect(manager.status().plugins[0].fonts).toContain("Sample Test Font");
    state.granted = false;
    await manager.refreshAccess();
    expect(manager.status().plugins).toEqual([]);
    expect(JSON.stringify(manager.status())).not.toContain("サンプル変換");
    expect(manager.menuGroups()).toEqual([]);
    state.granted = true;
    await manager.refreshAccess();
    expect(manager.status().plugins).toHaveLength(1);
    state.userId = OTHER_USER;
    expect(manager.status().plugins).toEqual([]);
    await manager.refreshAccess();
    expect(manager.status().plugins).toHaveLength(1);
    state.signedIn = false;
    expect(manager.status().plugins).toEqual([]);
    state.signedIn = true;
    state.code = 503;
    await expect(manager.refreshAccess()).rejects.toThrow();
    expect(manager.status().plugins).toEqual([]);
    expect(manager.state.installed[ID].version).toBe("1.0.0");
  });

  it("does not activate an update when access is revoked while it waits for a running job", async () => {
    let release!: (value: string) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const job = new Promise<string>((resolve) => { release = resolve; });
    const { manager, state } = await setup({ runWorker: async () => { started(); return job; } });
    await manager.check();
    await manager.install(ID);
    const running = manager.run(ID, {});
    await ready;
    state.fixture = fixture("1.1.0", 2);
    await manager.check();
    const updating = manager.install(ID);
    while (!manager.idleWaiters.length) await new Promise((resolve) => setTimeout(resolve, 1));
    state.granted = false;
    release("done");
    await running;
    const result = await updating;
    expect(result.error).toBe("forbidden");
    expect(result.plugins).toEqual([]);
    expect(manager.state.installed[ID].version).toBe("1.0.0");
    expect(state.fonts).toHaveLength(1);
  });
});

describe("extension menu", () => {
  it("offers only installed, enabled, authorized extensions, without the actions", async () => {
    const { manager, state } = await setup();
    expect(manager.menuGroups()).toEqual([]);
    await manager.check();
    expect(manager.menuGroups()).toEqual([]);
    await manager.install(ID);
    expect(manager.menuGroups()).toEqual([{
      extensionId: ID,
      name: "サンプル変換",
      sections: [{
        title: "取り込み",
        entries: [
          { type: "text", text: "ファイルを選んで取り込みます。" },
          { type: "button", id: "import-sample", label: "サンプルを取り込む", icon: "file-input" },
          { type: "separator" },
        ],
      }],
    }]);
    expect(JSON.stringify(manager.menuGroups())).not.toContain("import-file");
    await manager.setEnabled(ID, false);
    expect(manager.menuGroups()).toEqual([]);
    await manager.setEnabled(ID, true);
    state.granted = false;
    await manager.refreshAccess();
    expect(manager.menuGroups()).toEqual([]);
  });

  it("resolves an action only from the verified catalog and only while enabled and authorized", async () => {
    const { manager, state } = await setup();
    await manager.check();
    await manager.install(ID);
    expect(manager.resolveAction(ID, "import-sample")).toEqual({ type: "import-file", command: "convert", extensions: [".smp"] });
    expect(manager.resolveAction(ID, "missing")).toBeNull();
    expect(manager.resolveAction("other-tool", "import-sample")).toBeNull();
    state.granted = false;
    await manager.refreshAccess();
    expect(manager.resolveAction(ID, "import-sample")).toBeNull();
  });

  it("restores the menu after a restart once the grant is confirmed, and an extension without a menu adds nothing", async () => {
    const { manager, state, directory, base } = await setup();
    await manager.check();
    await manager.install(ID);
    const reopened = new PluginManager({ ...base, directory });
    await reopened.initialize();
    expect(reopened.menuGroups()).toHaveLength(1);
    state.fixture = fixture("1.1.0", 2, "font-content-v2", null);
    await manager.check();
    await manager.install(ID);
    expect(manager.menuGroups()).toEqual([]);
  });

  it("shows a bundled font only while its extension is enabled and authorized", async () => {
    const { manager, state } = await setup();
    await manager.check();
    await manager.install(ID);
    const sha = [...(await manager.installedPlugin(ID)).files].find((file) => file.kind === "font")?.sha256 as string;
    expect(manager.isFontVisible(sha)).toBe(true);
    expect(manager.isFontVisible("0".repeat(64))).toBe(false);
    await manager.setEnabled(ID, false);
    expect(manager.isFontVisible(sha)).toBe(false);
    await manager.setEnabled(ID, true);
    state.granted = false;
    await manager.refreshAccess();
    expect(manager.isFontVisible(sha)).toBe(false);
  });
});
