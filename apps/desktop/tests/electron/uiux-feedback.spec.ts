import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("workspace and editor feedback flows persist through the real desktop bridge", async () => {
  test.setTimeout(180_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-uiux-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  let app: ElectronApplication | undefined;
  const screenshot = async (page: Page, name: string) => {
    const destination = process.env.SIGMA_UIUX_SCREENSHOTS || test.info().outputDir;
    await mkdir(destination, { recursive: true });
    await page.screenshot({ path: path.join(destination, `${name}.png`) });
  };
  try {
    app = await electron.launch({ args: [root], cwd: root, env });
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(profile);
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1440, 1000); win.show(); win.focus(); });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const seed = await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:usage-guide-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const workspace = await window.desktopAPI!.storage.createWorkspace("UI/UX確認");
      if (workspace.state !== "ready") throw new Error("No workspace");
      const first = await window.desktopAPI!.storage.createDocument({ title: "既存の教材", workspaceId: workspace.overview.activeWorkspaceId });
      return { fileId: first.file.fileId, workspaceId: first.file.workspaceId };
    });
    const base = new URL(page.url());
    const go = async (route: string, query = "") => {
      const url = new URL(base);
      url.pathname = base.protocol === "file:" ? base.pathname.replace(/[^/]+$/, route === "/workspace" ? "workspace.html" : "index.html") : route;
      url.search = query; await page.goto(url.href);
    };
    await go("/workspace", `workspaceId=${seed.workspaceId}`);
    await expect(page.locator(`[data-item-key="file:${seed.fileId}"]`)).toBeVisible();
    const workspaceLogo = await page.locator(".workspace-brand-icon svg").boundingBox();
    const toggle = page.locator(".workspace-sidebar-toggle");
    expect(await toggle.evaluate(el => Boolean(el.closest("#workspace-sidebar")))).toBe(true);
    await toggle.click(); await expect(page.locator("#workspace-sidebar")).toHaveAttribute("data-collapsed", "true");
    await toggle.click();
    await page.locator(".workspace-page-main").evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const create = async (name: string) => {
      await page.locator(".workspace-new-button").click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.getByRole("menuitem", { name: "新しい教材", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "新しい教材", exact: true });
      await dialog.getByRole("textbox", { name: "教材名" }).fill(name);
      return dialog;
    };
    let dialog = await create("作成のみの教材");
    await dialog.getByRole("button", { name: "作成のみ", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(new URL(page.url()).pathname).toContain("workspace");
    const onlyRow = page.locator(".workspace-list-row").filter({ hasText: "作成のみの教材" });
    await expect(onlyRow).toHaveAttribute("aria-selected", "true");
    await expect(onlyRow).toBeFocused();
    const onlyId = (await onlyRow.getAttribute("data-item-key"))!.slice(5);
    await page.mouse.move(1400, 900); await page.locator(".workspace-search").click();
    const bookmark = onlyRow.locator(".workspace-bookmark-button");
    await expect.poll(() => bookmark.evaluate(el => getComputedStyle(el).opacity)).toBe("0");
    await onlyRow.hover(); await expect.poll(() => bookmark.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
    await screenshot(page, "after-unbookmarked-hover");
    await bookmark.click(); await page.locator(".workspace-search").click(); await page.mouse.move(1400, 900);
    await expect.poll(() => bookmark.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
    await screenshot(page, "after-workspace-bookmarked");
    await page.reload(); await expect(onlyRow).toBeVisible();
    await expect(onlyRow.locator(".workspace-bookmark-button")).toHaveClass(/is-active/);
    // Both creation actions store real materials; Enter uses create-and-open.
    dialog = await create("開いて編集する教材");
    await screenshot(page, "after-create-actions");
    await dialog.getByRole("textbox", { name: "教材名" }).press("Enter");
    await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("開いて編集する教材");
    await expect(page.locator(".startup-splash")).toBeHidden();
    const logo = page.locator("button.document-icon");
    await expect(logo).toHaveAccessibleName("ワークスペース");
    const editorLogo = await logo.locator("svg").boundingBox();
    expect(Math.abs(editorLogo!.x - workspaceLogo!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(editorLogo!.y - workspaceLogo!.y)).toBeLessThanOrEqual(1);
    const stroke = page.locator(".quick-toolbar-row .toolbar-icon-color").filter({ has: page.locator("svg.lucide-pen-line") });
    await expect(stroke).toBeDisabled(); await expect(stroke).toHaveAttribute("aria-disabled", "true");
    const disabledStyle = await stroke.evaluate(el => ({ opacity: getComputedStyle(el).opacity, events: getComputedStyle(el).pointerEvents, background: getComputedStyle(el).backgroundColor }));
    expect(disabledStyle.events).toBe("none"); expect(Number(disabledStyle.opacity)).toBeLessThan(1);
    const rect = await stroke.boundingBox(); await page.mouse.move(rect!.x + 5, rect!.y + 5);
    expect(await stroke.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(disabledStyle.background);
    await screenshot(page, "after-editor-disabled-toolbar");
    await logo.click(); await expect(onlyRow).toBeVisible();
    await onlyRow.dblclick();
    await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("作成のみの教材");
    // Catch the short animation at its actual running state without slowing edits.
    await page.evaluate(() => {
      const observed: string[] = [];
      Object.assign(window, { uiuxAnimations: observed });
      document.addEventListener("animationstart", event => { if ((event as AnimationEvent).animationName === "document-tab-created") observed.push((event.target as HTMLElement).dataset.new ?? ""); });
    });
    await page.getByRole("button", { name: "新規教材", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "教材を作成しました", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { uiuxAnimations: string[] }).uiuxAnimations.length)).toBeGreaterThan(0);
    await page.getByRole("dialog", { name: "教材を作成しました", exact: true }).getByRole("button", { name: "閉じる", exact: true }).click();
    const active = page.locator(".document-tab.active");
    await expect(active).toHaveCount(1);
    expect(await active.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
    await screenshot(page, "after-editor-tabs");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await active.evaluate(el => { el.setAttribute("data-new", "true"); return getComputedStyle(el).animationName; })).toBe("none");
    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "エクスポート", exact: true }).hover();
    await expect(page.getByRole("menuitem", { name: "sigmaファイルをエクスポート", exact: true })).toBeVisible();
    await screenshot(page, "after-export-wording");
    await page.keyboard.press("Escape");
    // Actual scroll events resolve nested headings and update a single TOC link.
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("menuitem", { name: "使い方マニュアル", exact: true }).click();
    const manual = page.getByRole("dialog", { name: "使い方マニュアル", exact: true });
    await expect(manual).toBeVisible();
    await manual.getByRole("link", { name: "教材タブと新規作成", exact: true }).click();
    await expect(manual.locator('nav a[aria-current="location"]')).toHaveText("教材タブと新規作成");
    await screenshot(page, "after-manual-toc");
    await manual.locator("[data-manual-viewport]").evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(manual.locator('nav a[aria-current="location"]')).toHaveText("sigmaファイルを書き出す");
    await manual.locator("[data-manual-viewport]").evaluate(el => { el.scrollTop = 0; });
    await expect(manual.locator('nav a[aria-current="location"]')).toHaveText("ワークスペース");
    await page.keyboard.press("Escape");
    // Verify both saved workspace-created documents survive reload through storage.
    const files = await page.evaluate(async () => window.desktopAPI!.storage.listFiles());
    expect(files.some(file => file.fileId === onlyId && file.title === "作成のみの教材")).toBe(true);
    expect(files.some(file => file.title === "開いて編集する教材")).toBe(true);
    await page.reload(); await expect(page.locator(".document-tab.active")).toHaveCount(1);
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
