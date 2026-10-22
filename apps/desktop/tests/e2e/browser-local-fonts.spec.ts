import { expect, test, type Page } from "@playwright/test";

async function openFontMenu(page: Page) {
  await page.locator('button[aria-label^="フォント:"]').first().click();
  const menu = page.getByRole("menu", { name: "フォント", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
  });
});

test("renders with a real OS font and preserves the selection in browser storage after reload", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "Local Font Access requires desktop Chromium.");
  const cdp = await context.newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  const browserContextId = targetInfo.browserContextId;
  await cdp.send("Browser.setPermission", { permission: { name: "local-fonts" }, setting: "granted", browserContextId });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  expect(await page.evaluate(() => Boolean(window.desktopAPI))).toBe(false);
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "教材を作成しました" }) }).getByRole("button", { name: "閉じる" }).click();
  const body = page.locator(".page-flow .ProseMirror").first();
  await body.click();
  await page.keyboard.insertText("Local font rendering ABC xyz 123");
  await body.press("ControlOrMeta+A");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("Local font rendering ABC xyz 123");
  let menu = await openFontMenu(page);
  const pcFonts = menu.getByRole("group", { name: "このPCのフォント" });
  await expect(pcFonts).toBeVisible();
  const family = (await pcFonts.getByRole("menuitemradio").first().innerText()).trim();
  expect(family.length).toBeGreaterThan(0);
  await pcFonts.getByRole("menuitemradio").first().click();
  const text = body.locator("span[style*='font-family']").filter({ hasText: "Local font rendering" }).first();
  await expect(text).toBeVisible();
  await expect(text).toHaveCSS("font-family", new RegExp(family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await expect(page.locator(".save-state.saved")).toContainText("自動保存");
  await expect.poll(() => page.evaluate((name) => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open("sigma-studio");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const read = database.transaction("documents").objectStore("documents").getAll();
      read.onerror = () => { database.close(); reject(read.error); };
      read.onsuccess = () => {
        const saved = read.result.some(record => {
          const json = JSON.stringify(record);
          return json.includes("Local font rendering") && json.includes(name);
        });
        database.close();
        resolve(saved);
      };
    };
  }), family)).toBe(true);

  // Computed CSS alone can lie about fallback: ask Chromium which actual OS face drew the Latin text.
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  await text.evaluate(element => { element.id = "os-font-proof"; });
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#os-font-proof" });
  const rendered = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(rendered.fonts.some(font => !font.isCustomFont && font.glyphCount > 0 && font.familyName === family)).toBe(true);

  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".page-flow .ProseMirror span[style*='font-family']").filter({ hasText: "Local font rendering" }).first())
    .toHaveCSS("font-family", new RegExp(family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await body.click();
  menu = await openFontMenu(page);
  await expect(menu.getByRole("menuitemradio", { name: family, exact: true })).toHaveAttribute("aria-checked", "true");
  await cdp.send("Browser.setPermission", { permission: { name: "local-fonts" }, setting: "denied", browserContextId });
  await expect(menu.getByRole("status")).toContainText("許可されていません");
  await expect(menu.getByRole("group", { name: "このPCのフォント" })).toHaveCount(0);
});

test("shows permission denial without losing the normal font menu", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  await cdp.send("Browser.setPermission", { permission: { name: "local-fonts" }, setting: "denied", browserContextId: targetInfo.browserContextId });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.locator(".page-flow .ProseMirror").first().click();
  const menu = await openFontMenu(page);
  await expect(menu.getByRole("status")).toContainText("許可されていません");
  await expect(menu.getByRole("group", { name: "このPCのフォント" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "このPCのフォントを使う" }).click();
  await expect(menu.getByRole("status")).toContainText("許可されていません");
  await expect(menu.getByRole("menuitemradio", { name: "M PLUS 1p", exact: true })).toBeVisible();
});

test("keeps the normal font menu usable when OS enumeration is unsupported", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "queryLocalFonts", { value: undefined }));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.locator(".page-flow .ProseMirror").first().click();
  const menu = await openFontMenu(page);
  await expect(menu.getByRole("status")).toContainText("このブラウザではOSのフォント一覧を読み込めません");
  await expect(menu.getByRole("menuitemradio", { name: "M PLUS 1p", exact: true })).toBeVisible();
});
