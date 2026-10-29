import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { DEFAULT_SERIF_BODY_FONT_FAMILY, type ParagraphNode, type ProblemNode, type SigmaBlock, type SigmaDocument } from "@/features/document";

/**
 * 問題の上の「番号の右隣の1行」(導入文) を、問題設定からオン・オフできることを実機で固定する。
 *
 * オフにすると、導入文の行を畳み (文字があれば捨てる)、番号は問題文の先頭に付く。
 * 設定は教材に保存され、開き直しても変わらない。
 */

const APP_ROOT = path.resolve(__dirname, "../..");

function paragraph(id: string, text: string): ParagraphNode {
  return { type: "paragraph", id, children: text ? [{ type: "text", text }] : [] };
}

function problem(id: string, lead: string, prompt: string): ProblemNode {
  return { type: "problem", id, tags: [], lead: lead ? [paragraph(`${id}_lead`, lead)] : [], prompt: [paragraph(`${id}_prompt`, prompt)], solution: [], hints: [] };
}

async function launch(content: SigmaBlock[]): Promise<{ app: ElectronApplication; page: Page; fileId: string; profile: string }> {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-lead-line-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const page = await app.firstWindow();
  await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1200, 900));
  await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
  // 起動直後のアプリは、空のprofileに最初の教材を作る。その後に自分の教材を開かないと、先に保存した
  // ワークスペースを起動処理が上書きし、空の「無題の教材」が開くことがある。
  await expect(page.locator(".startup-splash")).toBeHidden();
  const source: SigmaDocument = {
    version: "2.0", docId: "problem_lead_line",
    metadata: { title: "導入文の行", styleUnits: { fontSize: "pt" } },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
  const fileId = await page.evaluate(async document => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    await window.desktopAPI!.settings!.setUiLocale!("ja");
    const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
    await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
    return file.fileId;
  }, source);
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
  return { app, page, fileId, profile };
}

const area = (page: Page, problemId: string, name: string) => page.locator(`section[data-problem-id="${problemId}"][data-problem-area="${name}"]`);

/** 問題の「…」から問題設定を開く。 */
async function openProblemSettings(page: Page, problemId: string) {
  // 問題が短いと、選択時に出る浮動バー (AIに依頼・コメント) が「…」の上に重なる。座標でなく要素へ送る。
  await area(page, problemId, "prompt").locator(".problem-action-button").dispatchEvent("click");
  await page.getByRole("menuitem", { name: "問題の設定…" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function closeDialog(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
}

/** 保存済みの教材から問題を読む。 */
async function savedProblem(page: Page, fileId: string, problemId: string): Promise<ProblemNode | undefined> {
  const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
  return saved?.content.find((block): block is ProblemNode => block.type === "problem" && block.id === problemId);
}

test("the lead line next to the problem number can be turned off and on from the problem settings", async ({}, testInfo) => {
  const { app, page, fileId, profile } = await launch([
    problem("q1", "", "一つ目の問題文"),
    problem("q2", "次の問いに答えよ。", "二つ目の問題文"),
  ]);
  try {
    // 既定では、どちらの問題も番号の右隣に導入文の行がある。
    await expect(area(page, "q1", "lead")).toHaveCount(1);
    await expect(area(page, "q1", "lead").locator(".problem-number-marker")).toHaveText("1");
    await expect(area(page, "q2", "lead").locator(".problem-number-marker")).toHaveText("2");

    // q1: 空の導入文はオフにできる。行ごと畳み、番号は問題文の先頭へ移る。
    await openProblemSettings(page, "q1");
    const lead = page.getByTestId("problem-lead-shown");
    await expect(lead).toBeChecked();
    await expect(lead).toBeEnabled();
    await lead.uncheck();
    await expect(lead).not.toBeChecked();
    await closeDialog(page);
    await expect(area(page, "q1", "lead")).toHaveCount(0);
    await expect(area(page, "q1", "prompt").locator(".problem-number-marker")).toHaveText("1");
    await expect(area(page, "q2", "lead").locator(".problem-number-marker")).toHaveText("2");
    await page.screenshot({ path: testInfo.outputPath("lead-off.png") });

    // q2: 文字がある導入文も、オフにすれば文字ごと捨てて畳む。
    await openProblemSettings(page, "q2");
    await expect(page.getByTestId("problem-lead-shown")).toBeChecked();
    await expect(page.getByTestId("problem-lead-shown")).toBeEnabled();
    await expect(page.getByRole("dialog")).toContainText("導入文の文字は削除されます");
    await page.getByTestId("problem-lead-shown").uncheck();
    await closeDialog(page);
    await expect(area(page, "q2", "lead")).toHaveCount(0);
    await expect(page.locator(".page-flow")).not.toContainText("次の問いに答えよ。");
    await expect(area(page, "q2", "prompt").locator(".problem-number-marker")).toHaveText("2");

    // 保存され、開き直しても同じ。
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(async () => (await savedProblem(page, fileId, "q1"))?.areaLayout).toEqual({ lead: { hidden: true } });
    await expect.poll(async () => (await savedProblem(page, fileId, "q2"))?.areaLayout).toEqual({ lead: { hidden: true } });
    expect((await savedProblem(page, fileId, "q2"))?.lead).toEqual([]);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(area(page, "q1", "lead")).toHaveCount(0);
    await expect(area(page, "q1", "prompt").locator(".problem-number-marker")).toHaveText("1");
    await expect(area(page, "q2", "lead")).toHaveCount(0);
    await expect(area(page, "q2", "prompt").locator(".problem-number-marker")).toHaveText("2");

    // 畳んだ問題文の先頭にもふつうに打てる。
    await area(page, "q1", "prompt").locator("p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("追記");
    await expect(area(page, "q1", "prompt")).toContainText("一つ目の問題文追記");

    // もう一度オンにすると行が戻り、設定の跡は残らない。
    await openProblemSettings(page, "q1");
    await page.getByTestId("problem-lead-shown").check();
    await closeDialog(page);
    await expect(area(page, "q1", "lead").locator(".problem-number-marker")).toHaveText("1");
    await expect(area(page, "q1", "prompt").locator(".problem-number-marker")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(async () => (await savedProblem(page, fileId, "q1"))?.areaLayout).toBeUndefined();
    expect((await savedProblem(page, fileId, "q1"))?.prompt[0]).toMatchObject({ children: [{ type: "text", text: "一つ目の問題文追記" }] });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("turning the lead line off with text in it can be undone", async () => {
  const { app, page, profile } = await launch([problem("q1", "次の問いに答えよ。", "問題文")]);
  try {
    await expect(area(page, "q1", "lead").locator(".problem-number-marker")).toHaveText("1");
    await openProblemSettings(page, "q1");
    await page.getByTestId("problem-lead-shown").uncheck();
    await closeDialog(page);
    await expect(area(page, "q1", "lead")).toHaveCount(0);

    // 設定ダイアログからの変更も、ふつうの編集と同じ取り消し履歴に入る。
    await page.getByRole("button", { name: "元に戻す" }).first().click();
    await expect(area(page, "q1", "lead")).toHaveCount(1);
    await expect(area(page, "q1", "lead")).toContainText("次の問いに答えよ。");
    await expect(area(page, "q1", "lead").locator(".problem-number-marker")).toHaveText("1");
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

/** 番号の箱と、その右の行 (文字) の縦の中心。 */
async function leadCenters(page: Page, problemId: string) {
  return area(page, problemId, "lead").evaluate((section) => {
    const marker = section.querySelector(".problem-number-marker")!.getBoundingClientRect();
    const line = section.querySelector(".text-flow-editor p")!.getBoundingClientRect();
    return { marker: marker.top + marker.height / 2, line: line.top + line.height / 2, area: section.getBoundingClientRect().height };
  });
}

test("the lead line sits at the vertical middle of a large number box without changing the area height", async () => {
  const { app, page, profile } = await launch([
    problem("small", "次の問いに答えよ。", "問題文"),
    { ...problem("large", "次の問いに答えよ。", "問題文"), numbering: { fontSize: 28 } },
    { ...problem("empty", "", "問題文"), numbering: { fontSize: 28 } },
  ]);
  try {
    for (const id of ["large", "empty"]) {
      await expect.poll(async () => {
        const { marker, line } = await leadCenters(page, id);
        return Math.abs(marker - line);
      }).toBeLessThan(1);
    }
    // ふだんの大きさの番号は今まで通り (行が箱を包むので、動かさない)。
    const small = await leadCenters(page, "small");
    expect(Math.abs(small.marker - small.line)).toBeLessThan(2);
    // 下げるのは translate だけ。エリアの高さ (ページ割り) は番号の箱の高さのまま。
    const large = await leadCenters(page, "large");
    const markerHeight = await area(page, "large", "lead").locator(".problem-number-marker").evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(large.area - markerHeight)).toBeLessThan(1);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("the problem font is chosen in the problem settings, drawn on the page, shown in the toolbar and saved", async () => {
  const source = problem("q1", "次の問いに答えよ。", "問題文");
  source.prompt.push({ type: "paragraph", id: "q1_own", children: [{ type: "text", text: "等幅の文字", fontFamily: "monospace" }] });
  const { app, page, fileId, profile } = await launch([source, problem("q2", "", "ほかの問題")]);
  try {
    await openProblemSettings(page, "q1");
    await page.getByTestId("problem-font-family").click();
    await page.getByRole("option", { name: "Noto Serif JP" }).click();
    await expect(page.getByTestId("problem-settings-preview").locator("p, .problem-area-paper-body").first()).toHaveCSS("font-family", DEFAULT_SERIF_BODY_FONT_FAMILY);
    await closeDialog(page);

    const promptLine = area(page, "q1", "prompt").locator("p").first();
    await expect(promptLine).toHaveCSS("font-family", DEFAULT_SERIF_BODY_FONT_FAMILY);
    await expect(area(page, "q1", "lead").locator("p").first()).toHaveCSS("font-family", DEFAULT_SERIF_BODY_FONT_FAMILY);
    // 文字に付けた書体は問題の書体より強い。ほかの問題は変わらない。
    await expect(area(page, "q1", "prompt").getByText("等幅の文字")).toHaveCSS("font-family", "monospace");
    await expect(area(page, "q2", "prompt").locator("p").first()).not.toHaveCSS("font-family", DEFAULT_SERIF_BODY_FONT_FAMILY);

    // カーソルを置くと、ツールバーはその問題の書体を出す。
    await promptLine.click();
    await page.keyboard.press("End");
    await expect(page.getByRole("button", { name: /フォント: Noto Serif JP/ })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(async () => (await savedProblem(page, fileId, "q1"))?.fontFamily).toBe(DEFAULT_SERIF_BODY_FONT_FAMILY);
    expect((await savedProblem(page, fileId, "q2"))?.fontFamily).toBeUndefined();
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(area(page, "q1", "prompt").locator("p").first()).toHaveCSS("font-family", DEFAULT_SERIF_BODY_FONT_FAMILY);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
