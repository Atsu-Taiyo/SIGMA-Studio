import { generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";
import { digest, type CatalogPlugin } from "../../electron/plugins/manifest";

test("a signed installed extension keeps its organization, menu and real local worker after an offline restart with an expired token", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(os.tmpdir(), "sigma-offline-extensions-"));
  const source = path.join(profile, "sample.smp");
  await writeFile(source, "切断中に変換した本文");
  const actor = "55555555-5555-4555-8555-555555555555";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const worker = Buffer.from(`const { parentPort, workerData } = require("node:worker_threads");
    const document = ${JSON.stringify(createBlankDocument("オフライン変換"))};
    document.content = [{type:"paragraph",id:"converted",children:[{type:"text",text:Buffer.from(workerData.bytes).toString()}]}];
    parentPort.postMessage({ok:true,result:{document,issues:[]}});`);
  const plugin: CatalogPlugin = { id: "offline-sample", version: "1.0.0", name: "オフライン変換", description: "ローカル変換の検証用", minAppVersion: "0.510.0",
    entry: "worker.cjs", capabilities: ["document-conversion"],
    files: [{ path: "worker.cjs", kind: "code", bytes: worker.length, sha256: digest(worker) }],
    contributes: { menu: { sections: [{ items: [{ type: "button", id: "convert", label: "サンプルを変換", action: { type: "import-file", command: "convert", extensions: [".smp"] } }] }] } } };
  const payload = Buffer.from(JSON.stringify({ schema: 1, sequence: 1, plugins: [plugin] }));
  const envelope = { payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") };
  let offline = false;
  const server = createServer((request, response) => {
    if (offline) { request.socket.destroy(); return; }
    const json = (value: unknown) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (request.url === "/plugins/access") json({ userId: actor, plugins: [plugin.id], organizations: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "テスト所属" }] });
    else if (request.url === "/plugins/catalog") json(envelope);
    else if (request.url === "/plugins/assets/offline-sample/1.0.0/worker.cjs") response.writeHead(200).end(worker);
    else if (request.url?.startsWith("/auth/v1/token")) json({ access_token: "fixture", refresh_token: "fixture", expires_in: 3600, user: { id: actor } });
    else response.writeHead(503).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("PORT_REQUIRED");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined)),
    NODE_ENV: "development", SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_COLLABORATION_URL: endpoint,
    SIGMA_SUPABASE_URL: endpoint, SIGMA_SUPABASE_ANON_KEY: "sb_publishable_fixture",
    SIGMA_EXTENSIONS_CATALOG_URL: `${endpoint}/plugins/catalog`, SIGMA_EXTENSIONS_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }) as string };
  delete (env as Record<string, string>).ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) (env as Record<string, string>).SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  let app: ElectronApplication | undefined;
  const launch = async () => {
    const nativeKeyring = process.platform === "linux"
      ? { executablePath: createRequire(path.join(root, "package.json"))("electron") as string } : {};
    app = await electron.launch({ ...nativeKeyring, args: [root], cwd: root, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI && window.sigmaPlugins));
    return page;
  };
  try {
    let page = await launch();
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    await page.evaluate(async document => {
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
    }, createBlankDocument("オフラインの元教材"));
    const encrypt = (expires: number) => app!.evaluate(({ safeStorage }, tokens) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("SECURE_STORAGE_REQUIRED");
      return safeStorage.encryptString(JSON.stringify(tokens)).toString("base64");
    }, { access_token: "fixture", refresh_token: "fixture", expires_at: expires, expires_in: 3600, user: { id: actor } });
    let encrypted = await encrypt(Math.floor(Date.now() / 1000) + 3600);
    await app!.close(); app = undefined;
    await mkdir(path.join(profile, "collaboration-v1"), { recursive: true });
    await writeFile(path.join(profile, "collaboration-v1/auth.enc"), encrypted);
    page = await launch();
    expect((await page.evaluate(() => window.sigmaPlugins!.check())).error).toBeUndefined();
    expect((await page.evaluate(() => window.sigmaPlugins!.install("offline-sample"))).plugins[0].installedVersion).toBe("1.0.0");
    encrypted = await encrypt(Math.floor(Date.now() / 1000) - 60);
    await app!.close(); app = undefined;
    await writeFile(path.join(profile, "collaboration-v1/auth.enc"), encrypted);
    offline = true;
    page = await launch();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const status = await page.evaluate(() => window.sigmaPlugins!.status());
    expect(status).toMatchObject({ requiresLogin: false, requiresRole: false, offline: true, organizations: [{ name: "テスト所属" }] });
    const bar = page.getByRole("navigation", { name: "メニュー" });
    await bar.getByRole("button", { name: "拡張機能", exact: true }).click();
    await expect(page.getByRole("group", { name: "オフライン変換" })).toBeVisible();
    await page.getByRole("menuitem", { name: "拡張機能を管理…" }).click();
    const dialog = page.getByRole("dialog", { name: "拡張機能", exact: true });
    await expect(dialog).toContainText("テスト所属");
    await expect(dialog).toContainText("オフラインです");
    await page.screenshot({ path: testInfo.outputPath("extensions-offline-restarted.png") });
    await page.keyboard.press("Escape");
    await app!.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, source);
    const result = await page.evaluate(() => window.sigmaExtensions!.run("offline-sample", "convert"));
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain("切断中に変換した本文");
    if (!result.ok) throw new Error("CONVERSION_FAILED");
    const fileId = await page.evaluate(async document => {
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      return created.file.fileId;
    }, result.document);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    expect(JSON.stringify(await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId))).toContain("切断中に変換した本文");
    offline = false;
    expect(await page.evaluate(() => window.sigmaPlugins!.check())).toMatchObject({ offline: false });
  } finally {
    await app?.close().catch(() => {});
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
