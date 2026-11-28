import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

// AI設定の「サブエージェントを使う」: 画面の操作が settings.json に保存され、アプリを開き直しても残ること、
// 既定値へ戻すとキーごと消えることを、実アプリで確かめる。AIのCLIは使わない (実在しないパスを指す)。

function launchEnv(profile: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  delete env.SIGMA_AI_GATEWAY_URL;
  delete env.SIGMA_AI_GATEWAY_TOKEN;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const missing = path.join(profile, "missing-cli");
  env.SIGMA_STUDIO_CODEX_BIN = `${missing}-codex`;
  env.SIGMA_STUDIO_CLAUDE_BIN = `${missing}-claude`;
  env.SIGMA_STUDIO_ANTIGRAVITY_BIN = `${missing}-agy`;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  return env;
}

async function openAiSettings(app: ElectronApplication): Promise<{ page: Page; settings: Locator }> {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktopAPI));
  await page.evaluate(() => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
  });
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("menuitem", { name: "AI設定", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "AI設定", exact: true });
  await expect(settings.getByRole("switch", { name: "サブエージェントを使う" })).toBeVisible();
  return { page, settings };
}

async function keep(testInfo: TestInfo, name: string, body: Buffer) {
  writeFileSync(testInfo.outputPath(`${name}.png`), body);
  await testInfo.attach(name, { body, contentType: "image/png" });
}

function savedSettings(profile: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(profile, "data", "settings.json"), "utf8")) as Record<string, unknown>;
}

test("subagent settings are saved from the AI settings screen and survive a restart", async ({}, testInfo) => {
  // アプリを2回起動する。
  test.setTimeout(300_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-ai-subagent-settings-"));
  mkdirSync(path.join(profile, "data"), { recursive: true });
  writeFileSync(path.join(profile, "data", "settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const env = launchEnv(profile);
  let app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    let { page, settings } = await openAiSettings(app);
    const toggle = () => settings.getByRole("switch", { name: "サブエージェントを使う" });

    // 既定: オン・入れ子なし・同時3つ。既定値は設定ファイルに書かない。
    await expect(toggle()).toBeChecked();
    expect(savedSettings(profile)).not.toHaveProperty("aiSubagents");
    await settings.getByRole("button", { name: "サブエージェントの詳細" }).click();
    const depth = settings.getByTestId("desktop-settings-subagents-depth");
    const concurrent = settings.getByTestId("desktop-settings-subagents-concurrent");
    await expect(depth).toContainText("入れ子なし");
    await expect(concurrent).toContainText("3つまで");
    await toggle().scrollIntoViewIfNeeded();
    await keep(testInfo, "subagent-settings-default", await settings.screenshot());

    // 深さ・同時に動かす数・AIごとのスイッチを変える。
    await depth.click();
    await page.getByRole("option", { name: "2段まで" }).click();
    await concurrent.click();
    await page.getByRole("option", { name: "5つまで" }).click();
    await settings.getByTestId("desktop-settings-subagents-antigravity").click();
    // 内蔵AIは、はじめはオフ (利用料が運営の負担のため)。ここでオンにする。
    await expect(settings.getByTestId("desktop-settings-subagents-sigma")).not.toBeChecked();
    await settings.getByTestId("desktop-settings-subagents-sigma").click();
    await expect.poll(() => savedSettings(profile).aiSubagents).toEqual({
      enabled: true,
      maxDepth: 2,
      maxConcurrent: 5,
      providers: { claude: true, chatgpt: true, antigravity: false, sigma: true },
    });
    await keep(testInfo, "subagent-settings-changed", await settings.screenshot());

    // 開き直しても、画面と main の両方が同じ値を読む。
    await app.close();
    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    ({ page, settings } = await openAiSettings(app));
    await settings.getByRole("button", { name: "サブエージェントの詳細" }).click();
    await expect(settings.getByTestId("desktop-settings-subagents-depth")).toContainText("2段まで");
    await expect(settings.getByTestId("desktop-settings-subagents-concurrent")).toContainText("5つまで");
    await expect(settings.getByTestId("desktop-settings-subagents-antigravity")).not.toBeChecked();
    await expect(settings.getByTestId("desktop-settings-subagents-claude")).toBeChecked();
    await expect(settings.getByTestId("desktop-settings-subagents-sigma")).toBeChecked();
    // Antigravity のロゴはグラデーションで塗る。id をロゴの間で共有していた頃は、同じ画面の
    // 閉じたタブにある1つ目のロゴを指してしまい、この行のロゴだけ塗りが消えた。
    const gradientIds = await page.evaluate(() =>
      [...document.querySelectorAll('linearGradient[id^="sigma-antigravity-mark-gradient"]')].map((element) => element.id));
    expect(gradientIds.length).toBeGreaterThan(1);
    expect(new Set(gradientIds).size).toBe(gradientIds.length);
    expect((await page.evaluate(() => window.desktopAPI!.settings!.get())).aiSubagents).toEqual({
      enabled: true,
      maxDepth: 2,
      maxConcurrent: 5,
      providers: { claude: true, chatgpt: true, antigravity: false, sigma: true },
    });

    // 全体をオフにすると詳細を畳み、オフとして保存する。
    await settings.getByRole("switch", { name: "サブエージェントを使う" }).click();
    await expect(settings.getByRole("button", { name: "サブエージェントの詳細" })).toHaveCount(0);
    await expect.poll(() => (savedSettings(profile).aiSubagents as { enabled?: boolean } | undefined)?.enabled).toBe(false);

    // 既定値へ戻すと、キーごと消える。
    await page.evaluate(() => window.desktopAPI!.settings!.setAiSubagents!({
      enabled: true,
      maxDepth: 1,
      maxConcurrent: 3,
      providers: { claude: true, chatgpt: true, antigravity: true, sigma: false },
    }));
    expect(savedSettings(profile)).not.toHaveProperty("aiSubagents");
    expect(savedSettings(profile).uiLocale).toBe("ja");
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
