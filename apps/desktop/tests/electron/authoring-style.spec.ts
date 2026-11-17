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
    source.content = [{ type: "paragraph", id: "style_p", children: [{ type: "text", text: "値を求めなさい。" }] },
      ...["tex1", "tex2"].map((id, i) => ({ type: "paragraph" as const, id, children: [{ type: "mathInline" as const, id: id + "_math", tex: "\\frac{" + (i + 1) + "}{x}", display: "inline" as const }] })),
    ];
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
      await page.evaluate(async () => {
        await window.desktopAPI!.settings!.setUiLocale!("ja");
        localStorage.setItem("sigma-studio:ui-locale", "ja");
      });
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
      return page;
    };
    const runAi = (page: Page, fileId: string) => page.evaluate(async id => {
      const document = await window.desktopAPI!.storage.loadDocument(id);
      return window.desktopAPI!.aiEdit.run({ provider: "codex", fileId: id, document, instruction: "次の問題文を考えて。" }, () => {});
    }, fileId);
    const selectText = async (page: Page, text: string) => {
      await page.getByText(text, { exact: true }).first().click();
      await page.getByText(text, { exact: true }).first().evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
    };
    let page = await launch(sourcePath);
    await expect(page.getByText("値を求めなさい。", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    const file = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find(f => f.title === "書き方の自動学習")!;
    expect(file).toBeDefined();
    await runAi(page, file.fileId);
    expect(await readFile(capture, "utf8")).not.toContain("automatic-authoring-style");

    await selectText(page, "値を求めなさい。");
    await page.keyboard.insertText("値を求めよ。");
    await expect.poll(async () => page.evaluate(async id => JSON.stringify((await window.desktopAPI!.storage.loadDocument(id))?.content), file.fileId)).toContain("値を求めよ。");
    await runAi(page, file.fileId);
    const prompts = (await readFile(capture, "utf8")).trim().split("\n");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("automatic-authoring-style");
    expect(prompts[1]).toContain("値を求めよ。");
    await page.screenshot({ path: testInfo.outputPath("manual-edit-learned.png") });

    // Close without another AI turn flushing the final correction for us.
    await selectText(page, "値を求めよ。");
    await page.keyboard.insertText("値を求めよ。理由も述べよ。");
    await expect.poll(async () => page.evaluate(async id => JSON.stringify((await window.desktopAPI!.storage.loadDocument(id))?.content), file.fileId)).toContain("理由も述べよ。");
    // Exercise TeX extraction through the real preload/main save path. Two
    // existing, separate blocks are edited; merely inserting formulas is not evidence.
    await page.evaluate(async fileId => {
      const api = window.desktopAPI!.storage;
      const loaded = await api.loadDocument(fileId);
      if (!loaded) throw new Error("Missing document");
      const before = loaded;
      const current = (await api.listFiles()).find(f => f.fileId === fileId)!;
      const after = { ...before, content: before.content.map(block => block.type === "paragraph" && block.id.startsWith("tex")
        ? { ...block, children: block.children.map(run => run.type === "mathInline" ? { ...run, tex: run.tex.replace("\\frac", "\\dfrac") } : run) } : block) };
      const saved = await api.saveDocument(fileId, after, { expectedRevision: current.revision });
      if (!saved.ok) throw new Error("Failed notation save");
    }, file.fileId);
    await app!.close();
    page = await launch();
    const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), file.fileId);
    expect(JSON.stringify(saved?.content)).toContain("値を求めよ。");
    // The memo is refined by a review that runs apart from saving and from AI requests.
    // Start it here instead of waiting for its idle trigger.
    const reviewed = await page.evaluate(id => window.desktopAPI!.authoringStyle!.review(id), file.workspaceId);
    expect(reviewed.generatedContent).toContain("分数は`\\dfrac`を使う。");
    expect(reviewed.items.some(item => item.basis === "corrections")).toBe(true);
    await runAi(page, file.fileId);
    const restartedPrompt = (await readFile(capture, "utf8")).trim().split("\n").at(-1)!;
    expect(restartedPrompt).toContain("automatic-authoring-style");
    expect(restartedPrompt).toContain("値を求めよ。");
    expect(restartedPrompt).toContain("理由も述べよ。");
    expect(restartedPrompt).toContain("TeX数式の書き方");
    expect(restartedPrompt).toContain("分数は");
    expect(restartedPrompt).toContain("dfrac");
    expect(restartedPrompt).not.toContain("update_authoring_style_memory");

    await page.getByRole("button", { name: "AI", exact: true }).click();
    await page.getByRole("menuitem", { name: "AI設定", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "AI設定", exact: true });
    await settings.getByRole("button", { name: "書き方の学習", exact: true }).first().click();
    await settings.getByLabel("優先するメモ（Markdown）").fill("# 書き方\n解答は常体で短く書く。");
    await settings.getByRole("button", { name: "メモを保存", exact: true }).click();
    await expect(settings.getByRole("button", { name: "メモを保存", exact: true })).toBeDisabled();
    await settings.getByRole("button", { name: "読み直す", exact: true }).click();
    await expect(settings.getByLabel("優先するメモ（Markdown）")).toHaveValue("# 書き方\n解答は常体で短く書く。");
    const learning = settings.getByRole("switch", { name: "書き方を学習してAIに使う" });
    await learning.click();
    await expect(learning).not.toBeChecked();
    await runAi(page, file.fileId);
    expect((await readFile(capture, "utf8")).trim().split("\n").at(-1)).not.toContain("authoring-style-memory");
    await learning.click();
    await expect(learning).toBeChecked();
    // Summarizing with the AI already in use can be turned off on its own.
    const summary = settings.getByRole("switch", { name: "AIで書き方を要約する" });
    await expect(summary).toBeChecked();
    await summary.click();
    await expect(summary).not.toBeChecked();
    expect((await page.evaluate(() => window.desktopAPI!.authoringStyle!.read(null))).aiSummary).toBe(false);
    await summary.click();
    await expect(summary).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath("authoring-style-settings.png") });
    // The workspace pane shows what was learned and lets the author make a line their own.
    await settings.getByRole("button", { name: "書き方の学習", exact: true }).nth(1).click();
    const learned = settings.getByLabel("学んだ書き方", { exact: true });
    await expect(learned).toHaveValue(/分数は`\\dfrac`を使う。/);
    await learned.fill((await learned.inputValue()).replace("分数は`\\dfrac`を使う。", "分数は必ず`\\dfrac`で書く。"));
    await settings.getByRole("button", { name: "学んだ書き方を保存", exact: true }).click();
    await expect(settings.getByText("自分で書いた項目").first()).toBeAttached();
    await settings.getByRole("button", { name: "今すぐ見直す", exact: true }).click();
    await expect(learned).toHaveValue(/分数は必ず`\\dfrac`で書く。/);
    await expect(learned).not.toHaveValue(/を使う。/);
    await page.screenshot({ path: testInfo.outputPath("authoring-style-workspace.png") });
    await settings.getByRole("button", { name: "書き方の学習", exact: true }).first().click();
    await settings.getByRole("button", { name: "学習をリセット", exact: true }).click();
    await page.getByRole("dialog", { name: "学習をリセット", exact: true }).getByRole("button", { name: "学習をリセット", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(id => window.desktopAPI!.authoringStyle!.read(id), file.workspaceId)).generatedContent).toBe("");
    const memory = await page.evaluate(() => window.desktopAPI!.authoringStyle!.read(null));
    expect(memory.exampleCount).toBe(0);
    expect(memory.userContent).toContain("解答は常体");
    await expect.poll(() => readFile(memory.userPath, "utf8")).toContain("解答は常体");
  } finally {
    await app?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
