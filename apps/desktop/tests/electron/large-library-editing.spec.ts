import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBlankDocument } from "@/lib/blank-document";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");

test("editing and autosave do not reload the full library, and survive undo and reload", async ({}, testInfo) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "sigma-large-library-"));
  const now = new Date().toISOString();
  const document = createBlankDocument("大量教材の編集確認");
  document.content = [{ id: "library_body", type: "paragraph", children: [{ type: "text", text: "元の本文" }] }];
  const fileId = "file_library-0", workspaceId = "workspace_library";
  const files = Array.from({ length: 54_000 }, (_, index) => ({
    fileId: `file_library-${index}`, workspaceId, folderId: null,
    docId: index === 0 ? document.docId : `doc_library_${index}`,
    title: index === 0 ? document.metadata.title : `教材-${index}`,
    documentPath: `documents/file_library-${index}.sigmadoc.json`,
    revision: 1, createdAt: now, updatedAt: now, deletedAt: null,
  }));
  const bodyPath = path.join(profile, "data", files[0].documentPath);
  await mkdir(path.dirname(bodyPath), { recursive: true });
  // The other generated rows are metadata-only: this test never opens them.
  await writeFile(bodyPath, JSON.stringify(document));
  await writeFile(path.join(profile, "data/library.json"), JSON.stringify({
    version: 4, activeWorkspaceId: workspaceId,
    workspaces: [{ id: workspaceId, name: "大量教材", createdAt: now, updatedAt: now, deletedAt: null }], folders: [], files,
  }));
  await writeFile(path.join(profile, "data/workspace.json"), JSON.stringify({ id: "default", openFileIds: [fileId], activeFileId: fileId }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const savedText = async () => {
    const saved = JSON.parse(await readFile(bodyPath, "utf8")) as SigmaDocument;
    return JSON.stringify(saved.content);
  };
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(() => localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true })));
    await page.reload();
    const paragraph = page.locator('.page-flow [data-sigma-doc-id="library_body"]').first();
    await expect(paragraph).toBeVisible();
    // Count the real registered IPC handlers; forward through their trusted wrapper.
    await app.evaluate(({ ipcMain }) => {
      const handlers = Reflect.get(ipcMain, "_invokeHandlers") as Map<string, (...args: unknown[]) => unknown>;
      const state = { lists: 0, saves: 0, metadata: 0, saveMs: [] as number[] };
      Reflect.set(globalThis, "libraryEditingMetrics", state);
      for (const channel of ["storage:list-files", "storage:save-document"]) {
        const original = handlers.get(channel)!;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => {
          const start = performance.now();
          if (channel === "storage:list-files") state.lists++;
          const result = await original(...args) as { ok?: boolean; metadata?: unknown };
          if (channel === "storage:save-document" && result.ok) {
            state.saves++; state.saveMs.push(performance.now() - start);
            if (result.metadata) state.metadata++;
          }
          return result;
        });
      }
    });
    await paragraph.click();
    await page.keyboard.press("End");
    const start = performance.now();
    await page.keyboard.type("alpha", { delay: 40 });
    await expect(paragraph).toHaveText("元の本文alpha");
    const inputMs = performance.now() - start;
    await expect.poll(savedText).toContain("元の本文alpha");
    await page.keyboard.press(`${modifier}+z`);
    await expect(paragraph).toHaveText("元の本文");
    await expect.poll(savedText).not.toContain("alpha");
    await page.keyboard.press(`${modifier}+Shift+z`);
    await expect(paragraph).toHaveText("元の本文alpha");
    await expect.poll(savedText).toContain("元の本文alpha");
    // Durable body writes precede the IPC response and its post-save hooks.
    // Wait for that response before reading the final counters.
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "libraryEditingMetrics").saves)).toBeGreaterThanOrEqual(3);
    const metrics = await app.evaluate(() => Reflect.get(globalThis, "libraryEditingMetrics") as {
      lists: number; saves: number; metadata: number; saveMs: number[];
    });
    expect(metrics.lists).toBe(0);
    expect(metrics.metadata).toBe(metrics.saves);
    await testInfo.attach("large-library-metrics", { body: JSON.stringify({ documents: files.length, inputMs, ...metrics }), contentType: "application/json" });
    await page.reload();
    await expect(paragraph).toHaveText("元の本文alpha");
    const library = JSON.parse(await readFile(path.join(profile, "data/library.json"), "utf8"));
    expect(library.files).toHaveLength(files.length);
    expect(library.files[1]).toEqual(files[1]);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
