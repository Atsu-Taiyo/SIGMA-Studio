import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBlankDocument } from "@/lib/blank-document";

test("shared workspace cards render and refresh previews without opening editable bodies", async ({}, testInfo) => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-shared-preview-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    const document = createBlankDocument("共有プレビュー確認");
    document.content = [{ type: "heading", id: "preview_title", level: 1, children: [{ type: "text", text: "共有教材のプレビュー" }] }, { type: "paragraph", id: "preview_text", children: [{ type: "text", text: "本文と数式がワークスペースから確認できます。" }, { type: "mathInline", id: "preview_math", tex: "y=x^2+1", display: "inline" }] }];
    const overview = await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      return window.desktopAPI!.storage.getWorkspaceOverview();
    });
    if (overview.state !== "ready") throw new Error("Fixture library unavailable");
    const base = overview.overview.files[0];
    overview.overview.files = [{ ...base, fileId: "catalog_preview", docId: document.docId, title: document.metadata.title, revision: 1,
      sharing: { target: { kind: "document", catalogNodeId: "preview" as never, sharedDocumentId: "preview" as never }, ownerId: "owner", createdBy: "owner", role: "viewer", capabilities: { read: true } as never, state: "active", placement: "incoming", isShareRoot: true, bodyCached: false },
    }];
    await app.evaluate(({ ipcMain }, data) => {
      const state = globalThis as typeof globalThis & { previewCalls: number; bodyCalls: number };
      state.previewCalls = 0; state.bodyCalls = 0;
      ipcMain.removeHandler("storage:get-workspace-overview");
      ipcMain.handle("storage:get-workspace-overview", () => data.overview);
      ipcMain.removeHandler("workspace-preview:shared-document");
      ipcMain.handle("workspace-preview:shared-document", () => { state.previewCalls++; return data.document; });
      ipcMain.removeHandler("storage:load-document");
      ipcMain.handle("storage:load-document", () => { state.bodyCalls++; throw new Error("Preview must not open document"); });
    }, { overview, document });
    const workspaceUrl = new URL(page.url());
    workspaceUrl.pathname = env.SIGMA_STUDIO_DEV_SERVER_URL ? "/workspace" : workspaceUrl.pathname.replace(/index\.html$/, "workspace.html");
    await page.goto(workspaceUrl.href);
    const card = page.getByRole("button", { name: "共有プレビュー確認 を開く" });
    const preview = card.getByTestId("workspace-file-preview-image");
    await expect(preview).toBeVisible({ timeout: 60000 });
    await expect(preview).toHaveAttribute("src", /^data:image\/png/);
    await page.screenshot({ path: testInfo.outputPath("shared-preview.png") });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.send("collaboration:event", { type: "update", fileId: "catalog_preview", update: "", kind: "manual" }); });
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { previewCalls: number }).previewCalls)).toBeGreaterThan(1);
    await expect(preview).toBeVisible();
    await page.reload();
    await expect(preview).toBeVisible({ timeout: 60000 });
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { bodyCalls: number }).bodyCalls)).toBe(0);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
