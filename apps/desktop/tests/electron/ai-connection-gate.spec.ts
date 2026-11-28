import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

// AIがつながっていないときのサイドバー (接続の案内)。どのCLIも見つからない状態で起動し、
// 4つのAIの案内がサイドバーの残りの高さに収まり、切り替えの並びが1行のままであることを確かめる。
// 以前は案内の画面だけ行の割り当てがずれ、AIの切り替えが縦に引き伸ばされて案内が下へ押し出されていた。

function launchEnv(profile: string): Record<string, string> {
  mkdirSync(path.join(profile, "data"), { recursive: true });
  writeFileSync(path.join(profile, "data", "settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  delete env.SIGMA_AI_GATEWAY_URL;
  delete env.SIGMA_AI_GATEWAY_TOKEN;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  // 実在しない実行ファイルを指して、どのAIも「見つからない」状態にする (利用者のログインに触れない)。
  const missing = path.join(profile, "missing-cli");
  env.SIGMA_STUDIO_CODEX_BIN = `${missing}-codex`;
  env.SIGMA_STUDIO_CLAUDE_BIN = `${missing}-claude`;
  env.SIGMA_STUDIO_ANTIGRAVITY_BIN = `${missing}-agy`;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  return env;
}

async function openSideChat(page: Page): Promise<Locator> {
  const sidebar = page.locator(".ai-chat-host--sidebar");
  if (!(await sidebar.isVisible().catch(() => false))) {
    const toolbarButton = page.getByRole("button", { name: "AIチャットを開く" }).first();
    if (await toolbarButton.isVisible().catch(() => false)) {
      await toolbarButton.click();
    } else {
      await page.locator(".app-menu-button", { hasText: /^AI$/ }).click();
      await page.getByRole("menuitem", { name: "AIチャットを開く" }).click();
    }
  }
  await expect(sidebar).toBeVisible();
  return sidebar;
}

async function keep(testInfo: TestInfo, name: string, body: Buffer) {
  writeFileSync(testInfo.outputPath(`${name}.png`), body);
  await testInfo.attach(name, { body, contentType: "image/png" });
}

test("the sidebar's connection guide fits the panel for every AI that is not connected", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-ai-gate-"));
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env: launchEnv(profile) });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const sidebar = await openSideChat(page);
    const panel = sidebar.locator('.ai-edit-panel[data-gated="true"]');
    await expect(panel).toBeVisible();

    const providers = [
      { name: "ChatGPT", title: "Codex CLI が見つかりません" },
      { name: "Claude", title: "Claude Code が見つかりません" },
      { name: "Antigravity", title: "Antigravity CLI が見つかりません" },
      { name: "SIGMA AI", title: null },
    ];
    for (const provider of providers) {
      await panel.getByRole("radio", { name: provider.name, exact: true }).click();
      const gate = panel.locator(".ai-connection-gate");
      await expect(gate).not.toHaveAttribute("data-state", "checking");
      if (provider.title) {
        await expect(gate.getByRole("heading", { name: provider.title })).toBeVisible();
      }
      await keep(testInfo, `gate-${provider.name.replace(/\s+/g, "-").toLowerCase()}`, await sidebar.screenshot());

      const layout = await panel.evaluate((element) => {
        const rect = (target: Element | null) => {
          const box = target?.getBoundingClientRect();
          return box ? { top: box.top, bottom: box.bottom, height: box.height } : null;
        };
        return {
          panel: rect(element),
          providerSwitch: rect(element.querySelector(".ai-provider-switch")),
          gate: rect(element.querySelector(".ai-connection-gate")),
          card: rect(element.querySelector(".ai-connection-gate-card")),
        };
      });
      expect(layout.panel && layout.providerSwitch && layout.gate && layout.card).toBeTruthy();
      // AIの切り替えは1行の高さのまま (案内の代わりに残りの高さを取らない)。
      expect(layout.providerSwitch!.height).toBeLessThan(64);
      // 案内がサイドバーの残りを使い、内容がパネルの中に収まっている。
      expect(layout.gate!.height).toBeGreaterThan(layout.panel!.height / 2);
      expect(layout.gate!.bottom).toBeLessThanOrEqual(layout.panel!.bottom + 1);
      expect(layout.card!.top).toBeGreaterThanOrEqual(layout.gate!.top - 1);
    }
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
