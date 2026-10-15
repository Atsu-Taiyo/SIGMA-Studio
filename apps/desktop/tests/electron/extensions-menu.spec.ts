import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

const GROUPS = [{
  extensionId: "sample-tool",
  name: "サンプル変換",
  sections: [{
    title: "取り込み",
    entries: [
      { type: "text", text: "ファイルを選んで教材として取り込みます。" },
      { type: "button", id: "import-sample", label: "サンプルを取り込む", description: "対応するファイルを選びます", icon: "file-input" },
      { type: "separator" },
      { type: "button", id: "import-other", label: "別の形式を取り込む" },
    ],
  }],
}];

const RESULT = {
  ok: true,
  sourceName: "取り込み元.smp",
  issues: [{ code: "font-substitution", detail: "Example Mincho" }],
  document: {
    version: "2.0",
    docId: "from_extension",
    metadata: { title: "拡張機能の教材" },
    content: [{ type: "paragraph", id: "p_from_extension", children: [{ type: "text", text: "拡張機能から取り込んだ本文" }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  },
};

async function stubExtensionHost(app: ElectronApplication, groups: unknown, result: unknown) {
  // 取得・署名・ワーカーはホストの単体/結合テストが実物で通している。ここでは画面と IPC の経路を実物で確かめる。
  await app.evaluate(({ ipcMain }, { groups: menu, result: runResult }) => {
    (globalThis as { __runs?: unknown[] }).__runs = [];
    ipcMain.removeHandler("extensions:menu");
    ipcMain.handle("extensions:menu", () => menu);
    ipcMain.removeHandler("extensions:run");
    ipcMain.handle("extensions:run", (_event, extensionId, itemId) => {
      (globalThis as { __runs?: unknown[] }).__runs!.push([extensionId, itemId]);
      return runResult;
    });
  }, { groups, result });
}

test("the Extensions menu at the right end of the menu bar is drawn from the extension's data and imports a document", async () => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")) || !existsSync(path.join(APP_ROOT, "out/index.html")), "Build the static renderer and Electron first.");
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-extensions-menu-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env, chromiumSandbox: true });
    const page = await app.firstWindow();
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 90_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI && window.sigmaExtensions && window.sigmaPlugins));
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
    });

    // 拡張機能が何も足していないあいだは、メニューは出ない。
    await stubExtensionHost(app, [], { ok: false, error: "canceled" });
    await page.reload();
    const bar = page.getByRole("navigation", { name: "メニュー" });
    await expect(bar.getByRole("button", { name: "設定", exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: "拡張機能", exact: true })).toHaveCount(0);

    // 足されると、メニューバーの一番右に出る。
    await stubExtensionHost(app, GROUPS, RESULT);
    await page.reload();
    await expect(bar.getByRole("button", { name: "拡張機能", exact: true })).toBeVisible();
    const labels = await bar.getByRole("button").allTextContents();
    expect(labels.at(-1)).toBe("拡張機能");
    expect(labels.at(-2)).toBe("設定");

    // 中身は拡張機能のデータどおり (名前・見出し・説明文・ボタン・区切り線) で、管理への入口が最後にある。
    await bar.getByRole("button", { name: "拡張機能", exact: true }).click();
    const menu = page.getByRole("menu", { name: "拡張機能" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("group", { name: "サンプル変換" })).toBeVisible();
    await expect(menu.getByText("取り込み", { exact: true })).toBeVisible();
    await expect(menu.getByText("ファイルを選んで教材として取り込みます。")).toBeVisible();
    await expect(menu.getByRole("separator")).toHaveCount(2);
    const items = await menu.getByRole("menuitem").allTextContents();
    expect(items).toEqual(["サンプルを取り込む", "別の形式を取り込む", "拡張機能を管理…"]);
    await expect(menu.getByRole("menuitem", { name: "サンプルを取り込む" })).toHaveAttribute("title", "対応するファイルを選びます");
    // 開く動き (ui-menu-in) が終わってから撮る。
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/extensions-menu.png" });

    // 管理への入口は、設定の拡張機能と同じダイアログを開く。
    await menu.getByRole("menuitem", { name: "拡張機能を管理…" }).click();
    await expect(page.getByRole("dialog", { name: "拡張機能" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "拡張機能" })).toHaveCount(0);

    // 項目を押すと、id だけがホストへ渡り、返った教材が別の教材として開く。取り込みの所見は通知で見せる。
    const before = await page.evaluate(async () => (await window.desktopAPI!.storage.listFiles()).length);
    await bar.getByRole("button", { name: "拡張機能", exact: true }).click();
    await page.getByRole("menuitem", { name: "サンプルを取り込む" }).click();
    const notice = page.getByRole("dialog", { name: "取り込み結果" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Example Mincho");
    expect(await app.evaluate(() => (globalThis as { __runs?: unknown[] }).__runs)).toEqual([["sample-tool", "import-sample"]]);
    await notice.locator('button[data-tone="primary"]').click();
    await expect(page.locator(".text-flow-editor")).toContainText("拡張機能から取り込んだ本文");

    // 保存され、読み直しても残っている。取り込み元のファイル名が題名になり、元の教材 id は引き継がない。
    const saved = await page.evaluate(async () => {
      const files = await window.desktopAPI!.storage.listFiles();
      const file = files.find((item) => item.title === "取り込み元");
      const loaded = file ? await window.desktopAPI!.storage.loadDocument(file.fileId) : null;
      return { count: files.length, docId: loaded?.docId, text: JSON.stringify(loaded?.content) };
    });
    expect(saved.count).toBe(before + 1);
    expect(saved.docId).not.toBe("from_extension");
    expect(saved.text).toContain("拡張機能から取り込んだ本文");
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    const reloaded = await page.evaluate(async () => (await window.desktopAPI!.storage.listFiles()).some((item) => item.title === "取り込み元"));
    expect(reloaded).toBe(true);

    // ホストが失敗を返したら、文書を作らずに理由を伝える。
    await stubExtensionHost(app, GROUPS, { ok: false, error: "forbidden" });
    await page.reload();
    await bar.getByRole("button", { name: "拡張機能", exact: true }).click();
    await page.getByRole("menuitem", { name: "別の形式を取り込む" }).click();
    await expect(page.getByText("このアカウントではこの拡張機能を使えません。")).toBeVisible();
    expect(await page.evaluate(async () => (await window.desktopAPI!.storage.listFiles()).length)).toBe(before + 1);

    // 権限が外れた通知が来たら、メニューはその場で消える。
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("extensions:menu-change", []);
    });
    await expect(bar.getByRole("button", { name: "拡張機能", exact: true })).toHaveCount(0);
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
