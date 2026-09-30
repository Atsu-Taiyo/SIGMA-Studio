import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

/**
 * 新規インストールの「AIへの指示」には運用ルールの初期文が入り、ユーザーが書き換えた内容は
 * 再起動しても初期文へ戻らない。保存・読み込みは本物のstorageとIPCを通す。
 */
test("a fresh install starts with the default AI instructions, and an edit survives a restart", async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-default-instructions-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const globalFile = path.join(profile, "data", "ai-agent-config", "instructions", "global.md");
  const launch = async () => {
    const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    return { app, page };
  };
  const readInstruction = (page: Awaited<ReturnType<typeof launch>>["page"]) =>
    page.evaluate(() => window.desktopAPI!.aiResources!.readFile("global-instructions")) as Promise<{ content: string }>;

  let session = await launch();
  try {
    await session.page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    const first = await readInstruction(session.page);
    expect(first.content).toContain("頼まれた範囲だけを直す");
    expect(first.content).toContain("未確認");
    expect(readFileSync(globalFile, "utf8")).toBe(first.content);

    await session.page.evaluate(() => window.desktopAPI!.aiResources!.saveInstruction({ content: "# 自分のルール\n常に丁寧語で。\n" }));
    await session.app.close();

    session = await launch();
    const second = await readInstruction(session.page);
    expect(second.content).toBe("# 自分のルール\n常に丁寧語で。\n");
    expect(readFileSync(globalFile, "utf8")).toBe(second.content);
  } finally {
    await session.app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
