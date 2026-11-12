import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";

const APP_ROOT = path.resolve(__dirname, "../..");

test("everyday editing automatically reaches the next AI turn and survives a desktop restart", async ({}, testInfo) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "sigma-style-electron-"));
  let app: ElectronApplication | undefined;
  const capture = path.join(profile, "prompts.jsonl");
  try {
    const fakeCodex = path.join(profile, "codex.cjs");
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('codex-test'); process.exit(0); }
let thread = 0, turn = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  let result = {};
  if (m.method === 'account/read') result = { account: { type: 'chatgpt', email: 'test@example.invalid', planType: 'plus' } };
  if (m.method === 'model/list') result = { data: [], nextCursor: null };
  if (m.method === 'thread/start') result = { thread: { id: 'thread_' + (++thread) } };
  if (m.method === 'thread/resume') result = { thread: { id: m.params.threadId } };
  if (m.method === 'turn/start') {
    const id = 'turn_' + (++turn);
    fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(m.params.input) + '\\n');
    send({ id: m.id, result: { turn: { id } } });
    setTimeout(() => {
      send({ method: 'item/completed', params: { turnId: id, item: { type: 'agentMessage', text: 'Recorded the request.' } } });
      send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id, status: 'completed' } } });
    }, 10);
    return;
  }
  send({ id: m.id, result });
});
`);
    await chmod(fakeCodex, 0o755);
    const source = createBlankDocument("書き方の自動学習");
    source.content = [{ type: "paragraph", id: "style_p", children: [{ type: "text", text: "値を求めなさい。" }] }];
    const sourcePath = path.join(profile, "書き方の自動学習.sigma");
    await writeFile(sourcePath, JSON.stringify(source));
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SIGMA_STUDIO_DEV_SERVER_URL;
    env.SIGMA_STUDIO_USER_DATA_DIR = profile;
    env.SIGMA_STUDIO_CODEX_BIN = fakeCodex;
    // Isolate CLI configuration written by the desktop during startup.
    env.HOME = path.join(profile, "home");
    env.USERPROFILE = env.HOME;
    await mkdir(env.HOME, { recursive: true });
    if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
    const launch = async (openFile?: string) => {
      app = await electron.launch({ args: openFile ? [APP_ROOT, openFile] : [APP_ROOT], cwd: APP_ROOT, env });
      const page = await app.firstWindow();
      await page.waitForFunction(() => Boolean(window.desktopAPI));
      await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
      return page;
    };
    const runAi = (page: Page, fileId: string) => page.evaluate(async id => {
      const document = await window.desktopAPI!.storage.loadDocument(id);
      return window.desktopAPI!.aiEdit.run({ provider: "codex", fileId: id, document, instruction: "次の問題文を考えて。" }, () => {});
    }, fileId);
    let page = await launch(sourcePath);
    await expect(page.getByText("値を求めなさい。", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    const file = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find(f => f.title === "書き方の自動学習")!;
    expect(file).toBeDefined();
    await runAi(page, file.fileId);
    expect(await readFile(capture, "utf8")).not.toContain("automatic-authoring-style");

    await page.getByText("値を求めなさい。", { exact: true }).first().click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("値を求めよ。");
    await expect.poll(async () => page.evaluate(async id => JSON.stringify((await window.desktopAPI!.storage.loadDocument(id))?.content), file.fileId)).toContain("値を求めよ。");
    await runAi(page, file.fileId);
    const prompts = (await readFile(capture, "utf8")).trim().split("\n");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("automatic-authoring-style");
    expect(prompts[1]).toContain("値を求めよ。");
    await page.screenshot({ path: testInfo.outputPath("manual-edit-learned.png") });

    // Close without another AI turn flushing the final correction for us.
    await page.getByText("値を求めよ。", { exact: true }).first().click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("値を求めよ。理由も述べよ。");
    await expect.poll(async () => page.evaluate(async id => JSON.stringify((await window.desktopAPI!.storage.loadDocument(id))?.content), file.fileId)).toContain("理由も述べよ。");
    await app!.close();
    page = await launch();
    const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), file.fileId);
    expect(JSON.stringify(saved?.content)).toContain("値を求めよ。");
    await runAi(page, file.fileId);
    const restartedPrompt = (await readFile(capture, "utf8")).trim().split("\n").at(-1)!;
    expect(restartedPrompt).toContain("automatic-authoring-style");
    expect(restartedPrompt).toContain("値を求めよ。");
    expect(restartedPrompt).toContain("理由も述べよ。");

    await page.getByRole("button", { name: "AI", exact: true }).click();
    await page.getByRole("menuitem", { name: "AI設定", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "AI設定", exact: true });
    await settings.getByRole("button", { name: "書き方の学習", exact: true }).first().click();
    await settings.getByLabel("優先するメモ（Markdown）").fill("# 書き方\n解答は常体で短く書く。");
    await settings.getByRole("button", { name: "メモを保存", exact: true }).click();
    await expect(settings.getByRole("button", { name: "メモを保存", exact: true })).toBeDisabled();
    await settings.getByRole("button", { name: "読み直す", exact: true }).click();
    await expect(settings.getByLabel("優先するメモ（Markdown）")).toHaveValue("# 書き方\n解答は常体で短く書く。");
    await settings.getByRole("switch", { name: "書き方を学習してAIに使う" }).click();
    await expect(settings.getByRole("switch")).not.toBeChecked();
    await runAi(page, file.fileId);
    expect((await readFile(capture, "utf8")).trim().split("\n").at(-1)).not.toContain("authoring-style-memory");
    await settings.getByRole("switch").click();
    await expect(settings.getByRole("switch")).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath("authoring-style-settings.png") });
    await settings.getByRole("button", { name: "学習をリセット", exact: true }).click();
    await page.getByRole("dialog", { name: "学習をリセット", exact: true }).getByRole("button", { name: "学習をリセット", exact: true }).click();
    await expect(settings.getByLabel("自動で学んだ特徴")).toHaveValue("");
    const memory = await page.evaluate(() => window.desktopAPI!.authoringStyle!.read(null));
    expect(memory.exampleCount).toBe(0);
    expect(memory.userContent).toContain("解答は常体");
    await expect.poll(() => readFile(memory.userPath, "utf8")).toContain("解答は常体");
  } finally {
    await app?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
