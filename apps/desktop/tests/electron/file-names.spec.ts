import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

test("preserves spaces through real UI rename, storage and restart", async () => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")) || (!process.env.SIGMA_STUDIO_DEV_SERVER_URL && !existsSync(path.join(APP_ROOT, "out/index.html"))), "Build Electron and provide a dev server or static renderer first.");
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-file-names-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env, chromiumSandbox: true });
    let page = await app.firstWindow();
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 90_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const records = await page.evaluate(async () => {
      const api = window.desktopAPI!.storage;
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const first = await api.createDocument({ title: "数学 演習.sigma" });
      const second = await api.createDocument({ title: "数学\u3000演習.sigma" });
      const copy = await api.duplicateFile(first.file.fileId);
      await api.renameDocument!(first.file.workspaceId, first.file.fileId, "改名 後.sigma");
      return { first, second, copy, loaded: await api.loadDocument(first.file.fileId) };
    });
    expect(records.first.file.title).toBe("数学 演習.sigma");
    expect(records.second.file.title).toBe("数学\u3000演習.sigma");
    expect(records.copy.file.title).toBe("数学 演習 のコピー.sigma");
    expect(records.loaded?.metadata.title).toBe("改名 後.sigma");
    // Main settings and renderer locale preferences are independent. Set both
    // before navigation so a fresh static renderer cannot reset the UI to English.
    await page.evaluate(() => localStorage.setItem("sigma-studio:ui-locale", "ja"));
    const workspaceUrl = new URL(page.url());
    workspaceUrl.pathname = env.SIGMA_STUDIO_DEV_SERVER_URL ? "/workspace" : workspaceUrl.pathname.replace(/index\.html$/, "workspace.html");
    workspaceUrl.search = `workspaceId=${records.first.file.workspaceId}`;
    await page.goto(workspaceUrl.href);
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    const card = page.getByRole("button", { name: "改名 後.sigma を開く", exact: true });
    await expect(card).toBeVisible();
    await card.hover();
    await card.getByRole("button", { name: "改名 後.sigma の操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "名前を変更", exact: true }).click();
    const input = page.getByLabel("教材名", { exact: true });
    await input.pressSequentially("高校数学　高校3年 A-B組");
    await expect(input).toHaveValue("高校数学　高校3年 A-B組");
    await input.press("Enter");
    await expect(page.getByRole("button", { name: "高校数学　高校3年 A-B組 を開く", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(async fileId => (await window.desktopAPI!.storage.loadDocument(fileId))?.metadata.title, records.first.file.fileId)).toBe("高校数学　高校3年 A-B組");
    await app.close();
    app = undefined;

    // Verify the on-disk name before reopening the app.
    const libraryPath = path.join(profile, "data/library.json");
    const library = JSON.parse(readFileSync(libraryPath, "utf8"));
    const file = library.files.find((item: { fileId: string }) => item.fileId === records.first.file.fileId);
    const documentPath = path.join(profile, "data", file.documentPath);
    const document = JSON.parse(readFileSync(documentPath, "utf8"));
    expect(file.title).toBe("高校数学　高校3年 A-B組");
    expect(document.metadata.title).toBe("高校数学　高校3年 A-B組");

    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env, chromiumSandbox: true });
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const restored = await page.evaluate(async fileId => {
      const api = window.desktopAPI!.storage;
      const loaded = await api.loadDocumentWithRecovery!(fileId);
      if (!loaded.ok) throw new Error(loaded.error);
      const saved = await api.saveDocument(fileId, loaded.document, { expectedRevision: loaded.revision });
      return { saved, document: await api.loadDocument(fileId), files: await api.listFiles() };
    }, records.first.file.fileId);
    expect(restored.saved.ok).toBe(true);
    expect(restored.document?.metadata.title).toBe("高校数学　高校3年 A-B組");
    expect(restored.files.find(file => file.fileId === records.first.file.fileId)?.title).toBe("高校数学　高校3年 A-B組");
    expect(restored.files.some(file => file.title === "数学\u3000演習.sigma")).toBe(true);
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
