import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {},
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
}));

import { sampleDocument } from "@/lib/sample-document";

import { PluginHost } from "./host";
import { digest, type CatalogPlugin } from "./manifest";

/**
 * 署名付きカタログの取得 → 検証 → インストール → メニュー → 実際のワーカースレッドでの変換 → 教材の検証、までを
 * 実ファイル・実スレッドで通す。ネットワークと本人のログインだけが偽物 (メモリ上)。
 */
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PEM = publicKey.export({ type: "spki", format: "pem" }) as string;
const USER = "11111111-1111-4111-8111-111111111111";
const ID = "sample-tool";

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const text = Buffer.from(workerData.bytes).toString("utf8");
const document = ${JSON.stringify(sampleDocument)};
document.metadata = { ...document.metadata, title: "from " + workerData.filename };
document.content = [{ type: "paragraph", id: "p_from_worker", children: [{ type: "text", text }] }];
parentPort.postMessage({ ok: true, result: {
  document,
  issues: [{ code: "font-substitution", detail: "Example Mincho" }],
  seenCommand: workerData.command, seenFonts: workerData.fonts.length,
} });
`;

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function catalog() {
  const worker = Buffer.from(WORKER);
  const font = Buffer.from("font-bytes-for-the-integration-test");
  const fontId = digest(font);
  const plugin: CatalogPlugin = {
    id: ID, name: "サンプル変換", description: "PCで変換", version: "1.0.0", minAppVersion: "0.510.0", entry: "worker.cjs",
    capabilities: ["document-conversion"],
    files: [
      { path: "worker.cjs", kind: "code", sha256: digest(worker), bytes: worker.length },
      { path: `fonts/${fontId}.ttf`, kind: "font", sha256: fontId, bytes: font.length, family: "Sample Font", displayName: "Sample Font", portable: true },
    ],
    contributes: { menu: { sections: [{ title: "取り込み", items: [
      { type: "button", id: "import-sample", label: "サンプルを取り込む", action: { type: "import-file", command: "convert", extensions: [".smp"] } },
    ] }] } },
  };
  const payload = Buffer.from(JSON.stringify({ schema: 1, sequence: 1, plugins: [plugin] }));
  return {
    envelope: { payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") },
    assets: new Map([[`${ID}/1.0.0/worker.cjs`, worker], [`${ID}/1.0.0/fonts/${fontId}.ttf`, font]]),
    fontId,
  };
}

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-host-it-"));
  directories.push(dataDir);
  const served = catalog();
  let signedIn = true;
  const registered: string[] = [];
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/access")) return Response.json({ userId: USER, plugins: [ID], organizations: [] });
    if (url.endsWith("/catalog")) return Response.json(served.envelope);
    return new Response(new Uint8Array(served.assets.get(url.split("/assets/")[1]) as Buffer));
  }) as unknown as typeof fetch;
  const host = new PluginHost({
    dataDir, appVersion: "0.515.1", isPackaged: false,
    config: { catalogUrl: "https://example.test/plugins/catalog", publicKey: PEM },
    auth: { user: () => (signedIn ? { id: USER } : null), authorization: async () => "Bearer a.b.c" },
    fontStore: { ensure: vi.fn(async (id: string, download: () => Promise<Uint8Array>) => { await download(); registered.push(id); }) } as never,
    getMainContents: () => null, partialFontNote: () => "（一部）", fetchImpl, env: {},
  });
  await host.ready;
  return { host, dataDir, served, registered, signOut: () => { signedIn = false; } };
}

describe("PluginHost with a real worker", () => {
  it("installs a signed extension, shows its menu, converts a picked file in a worker thread and returns a verified document", async () => {
    const { host, served, registered, dataDir } = await setup();
    expect(host.manager.menuGroups()).toEqual([]);
    await host.manager.check();
    expect((await host.manager.install(ID)).error).toBeUndefined();
    expect(host.manager.menuGroups()[0]).toMatchObject({ extensionId: ID, name: "サンプル変換" });
    expect(registered).toContain(served.fontId);
    const settings = JSON.parse(await fs.readFile(path.join(dataDir, "settings.json"), "utf8")) as { customFonts: Array<{ id: string; fileName: string }> };
    expect(settings.customFonts.map((font) => font.id)).toEqual([`plugin-${served.fontId}`]);
    expect(host.isFontVisible({ id: `plugin-${served.fontId}` })).toBe(true);

    const picked = { filePath: "/Users/someone/教材.smp", bytes: new TextEncoder().encode("取り込む本文") };
    const result = await host.runItem(ID, "import-sample", async (extensions) => {
      expect(extensions).toEqual([".smp"]);
      return picked;
    });
    expect(result).toMatchObject({ ok: true, sourceName: "教材.smp", issues: [{ code: "font-substitution", detail: "Example Mincho" }] });
    const document = (result as { document: { content: Array<{ children: Array<{ text: string }> }>; metadata: { title: string } } }).document;
    expect(document.metadata.title).toBe("from 教材.smp");
    expect(document.content[0].children[0].text).toBe("取り込む本文");
  });

  it("stops serving the extension as soon as the account loses access", async () => {
    const { host, signOut } = await setup();
    await host.manager.check();
    await host.manager.install(ID);
    signOut();
    expect(host.manager.menuGroups()).toEqual([]);
    const pick = vi.fn();
    expect(await host.runItem(ID, "import-sample", pick)).toEqual({ ok: false, error: "unavailable" });
    expect(pick).not.toHaveBeenCalled();
  });
});
