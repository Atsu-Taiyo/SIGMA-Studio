import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("long workspace lists scroll in both view modes and after a dialog closes", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-workspace-scroll-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({args: [root], cwd: root, env});
  try {
    const page = await app.firstWindow();
    const mainWindow = await app.browserWindow(page);
    await mainWindow.evaluate(window => window.setContentSize(1100, 700));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      for (let i = 0; i < 45; i++) await window.desktopAPI!.storage.createDocument({title: `教材 ${i.toString().padStart(2, "0")}`});
    });
    await page.goto(new URL("/workspace", page.url()).href);
    await expect(page.locator(".workspace-view-toggle")).toBeVisible();
    for (const toggle of await page.locator(".workspace-view-toggle button").all()) {
      await toggle.click();
      const content = page.locator(".workspace-content");
      const target = await content.evaluateHandle(element => {
        for (let node: Element | null = element; node; node = node.parentElement) {
          if (node.scrollHeight > node.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
        }
        return document.scrollingElement!;
      });
      await target.evaluate(element => {element.scrollTop = 0;});
      await page.mouse.move(800, 450);
      await page.mouse.wheel(0, 500);
      await expect.poll(() => target.evaluate(element => element.scrollTop)).toBeGreaterThan(150);
      await page.mouse.wheel(0, -500);
      await expect.poll(() => target.evaluate(element => element.scrollTop)).toBeLessThan(50);
    }
    const item = page.locator('[data-item-key^="file:"]').first();
    await item.locator(".workspace-item-menu-button").click();
    await page.getByRole("menuitem", {name: "削除", exact: true}).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", {name: "取消", exact: true}).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".workspace-page-shell")).not.toHaveAttribute("inert");
    await page.mouse.move(800, 450);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => page.evaluate(() => Math.max(document.scrollingElement!.scrollTop, document.querySelector(".workspace-content")!.scrollTop))).toBeGreaterThan(150);
  } finally { await app.close(); await rm(profile, {recursive: true, force: true}); }
});
