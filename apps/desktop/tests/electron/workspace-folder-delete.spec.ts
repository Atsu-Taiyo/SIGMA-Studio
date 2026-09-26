import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("workspace uses a two-button toggle and deletes nested folders after explicit confirmation", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-folder-delete-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const fixture = await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const initial = await api.getWorkspaceOverview();
      if (initial.state !== "ready") throw new Error("No library");
      const workspaceId = initial.overview.activeWorkspaceId;
      const folder = async (name: string, parent?: string) => {
        const result = await api.createFolder(workspaceId, name, parent);
        if (result.state !== "ready") throw new Error("No folder");
        return result.overview.folders.find(f => f.name === name)!.id;
      };
      const parent = await folder("削除テスト親");
      const child = await folder("削除テスト子", parent);
      const grandchild = await folder("削除テスト孫", child);
      const kept = await folder("残すフォルダ");
      const document = await api.createDocument({ workspaceId, folderId: grandchild, title: "配下の教材" });
      return { workspaceId, parent, child, grandchild, kept, fileId: document.file.fileId };
    });
    const url = new URL(page.url());
    url.pathname = process.env.SIGMA_STUDIO_DEV_SERVER_URL ? "/workspace" : url.pathname.replace(/index\.html$/, "workspace.html");
    await page.goto(url.href);
    const toggle = page.locator(".workspace-view-toggle");
    await expect(toggle.locator("button")).toHaveCount(2);
    expect(await toggle.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);
    const parent = page.locator(`[data-item-key="folder:${fixture.parent}"]`);
    await parent.click({ button: "right" });
    await page.getByRole("menuitem", { name: "削除", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "フォルダを削除" });
    await expect(dialog).toContainText("すべての子フォルダ・教材を削除");
    await dialog.getByRole("button", { name: "削除する", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(parent).toHaveCount(0);
    await page.reload();
    const after = await page.evaluate(id => window.desktopAPI!.storage.getWorkspaceOverview(id), fixture.workspaceId);
    if (after.state !== "ready") throw new Error("Missing library after reload");
    expect(after.overview.folders.map(f => f.id)).toContain(fixture.kept);
    for (const id of [fixture.parent, fixture.child, fixture.grandchild]) expect(after.overview.folders.map(f => f.id)).not.toContain(id);
    expect(after.overview.files.map(f => f.fileId)).not.toContain(fixture.fileId);
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
