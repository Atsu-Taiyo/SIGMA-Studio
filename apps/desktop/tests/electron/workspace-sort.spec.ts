import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function chipStyle(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.height, style.borderRadius, style.borderWidth, style.padding, style.fontSize, style.fontWeight];
  });
}

test("list sorting uses the editor's workspace chips and persists across reload", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-workspace-sort-"));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SIGMA_STUDIO_USER_DATA_DIR: profile,
    SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    });
    await page.reload();
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
    const workspaceButton = page.getByRole("button", { name: "ワークスペース", exact: true });
    const editorChipStyle = await chipStyle(workspaceButton);
    const fixture = await page.evaluate(async () => {
      const api = window.desktopAPI!.storage;
      const initial = await api.getWorkspaceOverview();
      if (initial.state !== "ready") throw new Error("No workspace");
      const workspaceId = initial.overview.activeWorkspaceId;
      const ids: string[] = [];
      // Natural name order differs from update order, including the numeric part.
      for (const title of ["教材2", "教材10", "教材1"]) {
        const created = await api.createDocument({ workspaceId, title });
        ids.push(created.file.fileId);
      }
      return { ids };
    });
    await workspaceButton.click();
    const nameHeader = page.getByRole("columnheader", { name: "名前", exact: true });
    const updatedHeader = page.getByRole("columnheader", { name: "更新日時", exact: true });
    const nameChip = nameHeader.getByRole("button");
    const updatedChip = updatedHeader.getByRole("button");
    const templateChip = page.getByRole("button", { name: "テンプレートギャラリー", exact: true });
    const returnChip = page.getByRole("button", { name: "編集画面に戻る", exact: true });
    for (const chip of [nameChip, updatedChip, templateChip, returnChip]) {
      await expect(chip).toBeVisible();
      expect(await chipStyle(chip)).toEqual(editorChipStyle);
    }
    await expect(page.locator(".workspace-view-toggle, .workspace-file-card, .workspace-sort-select")).toHaveCount(0);
    const rows = page.locator(fixture.ids.map((id) => `.workspace-content [data-item-key="file:${id}"]`).join(", "));
    const order = () => rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-item-key")));
    const keys = (indices: number[]) => indices.map((index) => `file:${fixture.ids[index]}`);
    await expect(updatedHeader).toHaveAttribute("aria-sort", "descending");
    await expect(updatedChip).toHaveAttribute("title", "更新日時：新しい順");
    await expect(updatedChip.locator(".workspace-list-sort-icon")).toBeVisible();
    await expect.poll(order).toEqual(keys([2, 1, 0]));
    await nameChip.click();
    await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    await expect(nameChip).toHaveAttribute("title", "名前：昇順");
    await expect(updatedChip.locator(".workspace-list-sort-icon")).toHaveCount(0);
    await expect.poll(order).toEqual(keys([2, 0, 1]));
    await page.reload();
    await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    await expect.poll(order).toEqual(keys([2, 0, 1]));
    await nameChip.focus();
    await page.keyboard.press("Enter");
    await expect(nameHeader).toHaveAttribute("aria-sort", "descending");
    await expect.poll(order).toEqual(keys([1, 0, 2]));
    await updatedChip.click();
    await updatedChip.click();
    await expect(updatedHeader).toHaveAttribute("aria-sort", "ascending");
    await expect(updatedChip).toHaveAttribute("title", "更新日時：古い順");
    await expect.poll(order).toEqual(keys([0, 1, 2]));
    await page.reload();
    await expect(updatedHeader).toHaveAttribute("aria-sort", "ascending");
    await templateChip.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await returnChip.click();
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await page.getByRole("button", { name: "ワークスペース", exact: true }).click();
    await expect(updatedHeader).toHaveAttribute("aria-sort", "ascending");
    await page.mouse.move(400, 500);
    await page.screenshot({ path: test.info().outputPath("workspace-list-chips.png") });
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
