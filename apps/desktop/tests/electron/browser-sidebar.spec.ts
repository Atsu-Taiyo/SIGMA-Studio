import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";
import type { WebPreferences } from "electron";

const APP_ROOT = path.resolve(__dirname, "../..");

test("large site icons stay inside the address bar and remote pages stay isolated", async ({}, testInfo) => {
  const requests: { path: string; method: string; body: string }[] = [];
  const server = createServer((request, response) => {
    const entry = { path: request.url ?? "", method: request.method ?? "", body: "" };
    requests.push(entry);
    request.on("data", data => { entry.body += String(data); });
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/redirected" });
      response.end();
      return;
    }
    if (request.url === "/icon.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="256" viewBox="0 0 512 256"><rect width="512" height="256" fill="#555"/></svg>');
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><title>Large icon fixture</title><link rel="icon" href="/icon.svg"><h1>Sidebar security fixture</h1><a id="next" href="/next">Next</a><a id="redirect" href="/redirect">Redirect</a><form method="POST" action="/posted"><input name="message" value="preserved"></form><a id="share" href="sigma-studio://share/document/12345678-1234-4234-8234-123456789012">Shared item</a>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const url = `http://127.0.0.1:${address.port}/`;
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-browser-sidebar-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_DEV_SERVER_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_DEV_SERVER_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const document: SigmaDocument = {
      version: "2.0", docId: "browser_sidebar", metadata: { title: "ブラウザ確認" },
      content: [{ type: "paragraph", id: "body", children: [{ type: "text", text: "サイドバー確認" }] }],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    };
    await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const storage = window.desktopAPI!.storage;
      const { file } = await storage.createFileFromDocument({ document });
      await storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.getByRole("button", { name: "サイドバーを開く", exact: true }).click();
    const dock = page.locator("[data-right-dock]");
    await dock.getByRole("button", { name: "新しいタブを開く", exact: true }).click();
    await dock.locator('[data-tool="browser"]').click();
    const input = dock.getByRole("combobox");
    await input.fill(url);
    await input.press("Enter");
    const confirmation = page.getByRole("dialog", { name: "リンク先を確認", exact: true });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText(url);
    await expect(confirmation).toContainText("通信が暗号化されません");
    expect(requests.filter(request => request.path === "/")).toHaveLength(0);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("link-confirmation.png") });
    await confirmation.getByRole("button", { name: "確認して開く", exact: true }).click();
    const icon = dock.locator('img[src^="data:image/"][width="14"]');
    await expect(icon).toBeVisible();
    await expect.poll(() => icon.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(512);
    const checkSize = async () => {
      expect(await icon.evaluate(image => {
        const rect = image.getBoundingClientRect();
        const parent = image.parentElement!.getBoundingClientRect();
        return { width: rect.width, height: rect.height, parentWidth: parent.width, parentHeight: parent.height };
      })).toEqual({ width: 14, height: 14, parentWidth: 14, parentHeight: 14 });
    };
    await checkSize();
    await page.setViewportSize({ width: 900, height: 800 });
    await checkSize();
    await dock.getByRole("button", { name: "再読み込み", exact: true }).click();
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "確認して開く", exact: true }).click();
    await expect.poll(() => requests.filter(request => request.path === "/").length).toBe(2);
    await checkSize();
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.getByRole("button", { name: "サイドバーを開く", exact: true }).click();
    await dock.locator('[role="tab"][data-kind="browser"]').click();
    await expect(icon).toBeVisible();
    await checkSize();
    await page.screenshot({ path: testInfo.outputPath("bounded-favicon.png") });

    const security = await app.evaluate(async ({ webContents, session }, url) => {
      const remote = webContents.getAllWebContents().find(contents => contents.getURL() === url)!;
      const prefs = (remote as typeof remote & { getLastWebPreferences(): WebPreferences }).getLastWebPreferences();
      const globals = await remote.executeJavaScript('({ node: typeof process, require: typeof require, bridge: typeof window.desktopAPI })');
      const permissions = await remote.executeJavaScript('Promise.all(["camera", "microphone", "geolocation"].map(async name => ({ name, state: (await navigator.permissions.query({ name })).state })))');
      await remote.session.cookies.set({ url, name: "sidebar-test", value: "isolated" });
      const mainCookies = await session.defaultSession.cookies.get({ url, name: "sidebar-test" });
      return {
        preferences: { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity, preload: prefs.preload ?? "" },
        globals, permissions, separateSession: remote.session !== session.defaultSession, mainCookies,
      };
    }, url);
    expect(security.preferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, preload: "" });
    expect(security.globals).toEqual({ node: "undefined", require: "undefined", bridge: "undefined" });
    expect(security.permissions).toEqual(["camera", "microphone", "geolocation"].map(name => ({ name, state: "denied" })));
    expect(security.separateSession).toBe(true);
    expect(security.mainCookies).toEqual([]);

    // Canceling must neither contact the new destination nor replace the loaded page.
    await input.fill(`${url}cancelled`);
    await input.press("Enter");
    await expect(confirmation).toContainText(`${url}cancelled`);
    expect(requests.some(request => request.path === "/cancelled")).toBe(false);
    await confirmation.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(input).toHaveValue(/127\.0\.0\.1/);
    expect(await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(contents => contents.getURL() === url), url)).toBe(true);
    expect(requests.some(request => request.path === "/cancelled")).toBe(false);

    const remoteAction = async (code: string) => app.evaluate(async ({ webContents }, { url, code }) => {
      const remote = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url))!;
      await remote.executeJavaScript(code);
    }, { url, code });
    await remoteAction('document.getElementById("next").click()');
    await expect(confirmation).toContainText(`${url}next`);
    expect(requests.some(request => request.path === "/next")).toBe(false);
    await confirmation.getByRole("button", { name: "確認して開く", exact: true }).click();
    await expect.poll(() => requests.some(request => request.path === "/next")).toBe(true);
    await expect(input).toHaveValue(/\/next$/);

    await remoteAction('document.getElementById("redirect").click()');
    await expect(confirmation).toContainText(`${url}redirect`);
    await confirmation.getByRole("button", { name: "確認して開く", exact: true }).click();
    await expect(confirmation).toContainText(`${url}redirected`);
    expect(requests.some(request => request.path === "/redirected")).toBe(false);
    await confirmation.getByRole("button", { name: "確認して開く", exact: true }).click();
    await expect(input).toHaveValue(/\/redirected$/);

    await remoteAction('document.querySelector("form").requestSubmit()');
    await expect(confirmation).toContainText(`${url}posted`);
    expect(requests.some(request => request.path === "/posted")).toBe(false);
    await confirmation.getByRole("button", { name: "確認して開く", exact: true }).click();
    await expect.poll(() => requests.find(request => request.path === "/posted")).toEqual({ path: "/posted", method: "POST", body: "message=preserved" });
    await expect(input).toHaveValue(/\/posted$/);

    await remoteAction('document.getElementById("share").click()');
    const share = page.getByRole("dialog", { name: "共有項目を開く", exact: true });
    await expect(share).toBeVisible();
    await expect(share).toContainText("共有元の所有者を確認できません");
    await expect(share.getByRole("button", { name: "共有項目を開く", exact: true })).toBeDisabled();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("shared-link-confirmation.png") });
    await share.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(share).toBeHidden();
    expect(requests.some(request => request.path === "/cancelled")).toBe(false);

    const external = page.evaluate(() => window.desktopAPI!.shell.openExternal("https://example.test/external"));
    await expect(confirmation).toContainText("https://example.test/external");
    await confirmation.getByRole("button", { name: "キャンセル", exact: true }).click();
    expect(await external).toEqual({ ok: false });

    await app.evaluate(({ app }) => app.emit("open-url", { preventDefault() {} }, `sigma-studio://share/document/12345678-1234-4234-8234-123456789012#invitation=${"a".repeat(43)}`));
    const invitation = page.getByRole("dialog", { name: "招待に参加", exact: true });
    await expect(invitation).toBeVisible();
    await expect(invitation.getByRole("button", { name: "参加する", exact: true })).toBeDisabled();
    await invitation.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(invitation).toBeHidden();

    await input.fill(`${url}reload-cancelled`);
    await input.press("Enter");
    await expect(confirmation).toBeVisible();
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    expect(await page.evaluate(() => window.desktopAPI!.linkConfirmation!.pending())).toBeNull();
    expect(requests.some(request => request.path === "/reload-cancelled")).toBe(false);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
