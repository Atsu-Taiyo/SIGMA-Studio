import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");
const MAIN_ENTRY = path.join(APP_ROOT, "dist-electron/main.cjs");
const DEV_URL = process.env.SIGMA_STUDIO_DEV_SERVER_URL;
const PREPARED = existsSync(MAIN_ENTRY) && (Boolean(DEV_URL) || existsSync(path.join(APP_ROOT, "out/index.html")));
const BODY = ".page-flow .ProseMirror";

function source(text: string) {
  return {
    version: "2.0", docId: "shared-source-id", metadata: { title: "Original" },
    content: [{ type: "paragraph", id: "paragraph", children: [{ type: "text", text }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

test("opens startup/second-instance/macOS files through real storage and preserves originals after editing and reload", async () => {
  test.skip(!PREPARED, "Build Electron and either the static renderer or a private development server first.");
  test.setTimeout(180_000);
  const root = mkdtempSync(path.join(os.tmpdir(), "sigma-os-open-"));
  const first = path.join(root, "起動 数学.sigma");
  const second = path.join(root, "既存 教材.sigma.json");
  const third = path.join(root, "追加 教材.sigmadoc.json");
  const fourth = path.join(root, "一覧から.sigma");
  const invalid = path.join(root, "invalid.sigma");
  const ordinary = path.join(root, "ordinary.json");
  const originals = [
    [first, JSON.stringify(source("STARTUP_CONTENT"))],
    [second, JSON.stringify(source("SECOND_CONTENT"))],
    [third, JSON.stringify(source("THIRD_CONTENT"))],
    [fourth, JSON.stringify(source("WORKSPACE_CONTENT"))],
    [invalid, "invalid JSON"], [ordinary, JSON.stringify({ unrelated: true })],
  ];
  for (const [filePath, data] of originals) writeFileSync(filePath, data);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = path.join(root, "profile");
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [APP_ROOT, first, first, ordinary], cwd: APP_ROOT, env });
    const page = await app.firstWindow();
    await expect(page.locator(BODY).first()).toContainText("STARTUP_CONTENT", { timeout: 90_000 });
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 30_000 });
    const filesBefore = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
    expect(filesBefore.filter((file) => file.title === "起動 数学")).toHaveLength(1);
    expect(filesBefore.some((file) => file.title.includes("ordinary"))).toBe(false);
    const imported = filesBefore.find((file) => file.title === "起動 数学")!;
    expect(imported.docId).not.toBe("shared-source-id");
    const userData = await app.evaluate(({ app }) => app.getPath("userData"));
    expect(userData).toBe(env.SIGMA_STUDIO_USER_DATA_DIR);
    await page.locator(BODY).first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" EDIT_BEFORE_OPEN");

    // A real second process exercises Electron's lock and additionalData transport.
    const executable = app.process().spawnfile;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, [APP_ROOT, second, third], {
        cwd: root, env: { ...env, NODE_ENV: process.env.NODE_ENV }, stdio: "ignore",
      });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Secondary launch did not exit")); }, 30_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Secondary exit ${code}`));
      });
    });
    await expect(page.locator(BODY).first()).toContainText("THIRD_CONTENT");
    const files = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
    expect(files.filter((file) => ["既存 教材", "追加 教材"].includes(file.title))).toHaveLength(2);
    const savedFirst = await page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId), imported.fileId);
    expect(JSON.stringify(savedFirst)).toContain("EDIT_BEFORE_OPEN");
    const dataDir = await page.evaluate(() => window.desktopAPI!.storage.getDataDir());
    const workspace = JSON.parse(readFileSync(path.join(dataDir.path, "workspace.json"), "utf8"));
    for (const file of files.filter((file) => ["起動 数学", "既存 教材", "追加 教材"].includes(file.title))) {
      expect(workspace.openFileIds).toContain(file.fileId);
    }

    if (process.platform === "darwin") {
      // This tests the native event handler, not LaunchServices/Finder registration.
      await app.evaluate(({ app }, filePath) => { app.emit("open-file", { preventDefault() {} }, filePath); }, invalid);
      await expect.poll(() => page.evaluate(() => window.desktopAPI!.file.getPendingOpenDocument!())).toBeNull();
      await expect(page.locator(BODY).first()).toContainText("THIRD_CONTENT");
    }

    // The workspace screen must forward pending opens to the editor without consuming them.
    await page.goto(DEV_URL ? new URL("/workspace", DEV_URL).href : new URL("workspace.html", page.url()).href);
    await page.waitForLoadState("domcontentloaded");
    await app.evaluate(({ app }, filePath) => { app.emit("open-file", { preventDefault() {} }, filePath); }, fourth);
    await expect(page.locator(BODY).first()).toContainText("WORKSPACE_CONTENT");
    await page.reload();
    await expect(page.locator(BODY).first()).toContainText("WORKSPACE_CONTENT");
    expect(JSON.stringify(await page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId), imported.fileId)))
      .toContain("EDIT_BEFORE_OPEN");
    await expect(page.locator('[data-testid="app-crash-screen"]')).toHaveCount(0);
    for (const [filePath, data] of originals) expect(readFileSync(filePath, "utf8")).toBe(data);
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
