import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const MAIN_ENTRY = path.join(APP_ROOT, "dist-electron/main.cjs");
const DEV_URL = process.env.SIGMA_STUDIO_DEV_SERVER_URL;
const PREPARED = existsSync(MAIN_ENTRY) && (Boolean(DEV_URL) || existsSync(path.join(APP_ROOT, "out/index.html")));
const BODY = ".page-flow .ProseMirror";

function source(text: string): SigmaDocument {
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
    // Playwright otherwise adds --no-sandbox on Linux. CI grants this exact
    // Electron executable userns permission so both real processes use it.
    app = await electron.launch({ args: [APP_ROOT, first, first, ordinary], cwd: APP_ROOT, env, chromiumSandbox: true });
    expect(await app.evaluate(({ app }) => app.commandLine.hasSwitch("no-sandbox"))).toBe(false);
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
    // Playwright launches through cmd.exe on Windows; use the actual Electron
    // binary, not the test runner's shell wrapper, for the secondary process.
    const executable = await app.evaluate(() => process.execPath);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, [APP_ROOT, second, third], {
        cwd: root, env: { ...env, NODE_ENV: process.env.NODE_ENV }, stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Secondary launch did not exit\n${stderr}`)); }, 30_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Secondary exit ${code}, signal ${signal}\n${stderr}`));
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

test("quitting after a managed document fails to open preserves its bytes and reopens after repair", async () => {
  expect(PREPARED, "Build Electron and either the static renderer or a private development server first.").toBe(true);
  test.setTimeout(150_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-managed-open-failure-"));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SIGMA_STUDIO_USER_DATA_DIR: profile,
    SIGMA_STUDIO_CODEX_BIN: path.join(profile, "no-codex"),
    SIGMA_COLLABORATION_URL: "",
    SIGMA_SUPABASE_URL: "",
    SIGMA_SUPABASE_ANON_KEY: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env, chromiumSandbox: true });
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    const firstPage = await app.firstWindow();
    await expect(firstPage.locator("[data-startup-splash]")).toHaveCount(0);
    const seeded = await firstPage.evaluate(async (document) => {
      const storage = window.desktopAPI!.storage;
      const { file } = await storage.createFileFromDocument({ document });
      await storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return { dataDir: (await storage.getDataDir()).path, fileId: file.fileId };
    }, source("RECOVERED_BODY"));
    await app.close();
    app = undefined;

    const filePath = path.join(seeded.dataDir, "documents", `${encodeURIComponent(seeded.fileId)}.sigmadoc.json`);
    const original = readFileSync(filePath);
    const damaged = Buffer.from('{"version":"2.0","content":[');
    writeFileSync(filePath, damaged);

    app = await launch();
    const failedPage = await app.firstWindow();
    await expect(failedPage.getByTestId("document-open-failure")).toBeVisible({ timeout: 30_000 });
    expect(readFileSync(filePath)).toEqual(damaged);
    const child = app.process();
    await app.close();
    app = undefined;
    expect(child.exitCode).toBe(0);
    expect(readFileSync(filePath)).toEqual(damaged);

    writeFileSync(filePath, original);
    app = await launch();
    const repairedPage = await app.firstWindow();
    await expect(repairedPage.locator(BODY).first()).toContainText("RECOVERED_BODY", { timeout: 30_000 });
    await expect(repairedPage.getByTestId("document-open-failure")).toHaveCount(0);
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});
