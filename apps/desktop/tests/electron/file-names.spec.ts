import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

test("assigns space-free names through real storage and preserves legacy names across restart", async () => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")) || !existsSync(path.join(APP_ROOT, "out/index.html")), "Build the static renderer and Electron first.");
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
    expect(records.first.file.title).toBe("数学-演習.sigma");
    expect(records.second.file.title).toBe("数学-演習-2.sigma");
    expect(records.copy.file.title).toBe("数学-演習-のコピー.sigma");
    expect(records.loaded?.metadata.title).toBe("改名-後.sigma");
    await app.close();
    app = undefined;

    // Represent an existing pre-policy file without running a migration or using a new-name API.
    const libraryPath = path.join(profile, "data/library.json");
    const library = JSON.parse(readFileSync(libraryPath, "utf8"));
    const file = library.files.find((item: { fileId: string }) => item.fileId === records.first.file.fileId);
    const documentPath = path.join(profile, "data", file.documentPath);
    const document = JSON.parse(readFileSync(documentPath, "utf8"));
    file.title = document.metadata.title = "既存 名前 2";
    writeFileSync(documentPath, JSON.stringify(document));
    writeFileSync(libraryPath, JSON.stringify(library));

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
    expect(restored.document?.metadata.title).toBe("既存 名前 2");
    expect(restored.files.find(file => file.fileId === records.first.file.fileId)?.title).toBe("既存 名前 2");
    expect(restored.files.some(file => file.title === "数学-演習-2.sigma")).toBe(true);
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
