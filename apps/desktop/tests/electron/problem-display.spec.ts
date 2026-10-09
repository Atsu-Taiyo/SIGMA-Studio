import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout, type OverlayShape, type SigmaDocument } from "@/features/document";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;

function paragraph(id: string, text: string) {
  return { type: "paragraph" as const, id, children: [{ type: "text" as const, text }] };
}

function block(id: string, blockId: string): OverlayShape {
  return {
    id,
    type: "geo",
    x: 80,
    y: 200,
    rotation: 0,
    anchor: { type: "block", blockId, dy: 6 },
    props: { w: 60, h: 36, geo: "rectangle", fill: "solid", color: "#1133cc", labelColor: "#111111", dash: "solid", size: "m" },
  };
}

function sourceDocument(): SigmaDocument {
  const source = ensurePageLayout({
    ...sampleDocument,
    version: "2.0",
    docId: "electron_problem_display",
    metadata: { title: "表示の絞り込み 実機検証" },
    content: [
      paragraph("body_intro", "本文GOLF"),
      {
        type: "problem", id: "q1", tags: [],
        lead: [paragraph("q1_lead", "導入ALPHA")],
        prompt: [paragraph("q1_prompt", "問題文BRAVO")],
        hints: [paragraph("q1_hint", "コメントCHARLIE")],
        solution: [paragraph("q1_solution", "解答DELTA")],
      },
      {
        type: "problem", id: "q2", tags: [],
        lead: [],
        prompt: [paragraph("q2_prompt", "問題文ECHO")],
        hints: [],
        solution: [paragraph("q2_solution", "解答FOXTROT")],
      },
      {
        // 箱の中の問題は箱の編集面が 4 つの領域を持ち、隠した領域をそこで畳む。
        type: "boxBlock", id: "box", styleId: "cornerbox",
        blocks: [{
          type: "problem", id: "boxed", tags: [],
          lead: [],
          prompt: [paragraph("boxed_prompt", "箱の問題文HOTEL")],
          hints: [],
          solution: [paragraph("boxed_solution", "箱の解答INDIA")],
        }],
      },
    ],
  });
  source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [
    block("shape_in_prompt", "q1_prompt"),
    block("shape_in_solution", "q1_solution"),
  ] } };
  return source;
}

async function prepare(page: Page) {
  await page.waitForFunction(() => Boolean(window.desktopAPI));
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(async () => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    await window.desktopAPI!.settings!.setUiLocale!("ja");
  });
  await page.reload();
  await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
}

/** 設定 > 表示 を開く。表示サブメニューの中身は hover で出る。 */
async function openDisplayMenu(page: Page) {
  const settings = page.locator(".editor-menubar").getByRole("button", { name: "設定", exact: true });
  if ((await settings.getAttribute("aria-expanded")) !== "true") await settings.click();
  const trigger = page.getByRole("menuitem", { name: "表示", exact: true });
  await trigger.hover();
  return {
    problem: page.getByRole("menuitemcheckbox", { name: "問題", exact: true }),
    solution: page.getByRole("menuitemcheckbox", { name: "解答", exact: true }),
    hints: page.getByRole("menuitemcheckbox", { name: "コメント", exact: true }),
  };
}

async function closeMenu(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "設定" })).toHaveCount(0);
}

const editorBlock = (page: Page, id: string) => page.locator(`.text-flow-editor [data-sigma-doc-id="${id}"]`).first();
const shape = (page: Page, id: string) => page.locator(`.page-mode [data-overlay-shape-id="${id}"]`).first();
const chip = (page: Page) => page.locator("[data-problem-display-chip] [role=status]");

/** 紙面の段落の末尾に打鍵する (macOS の合成キーで行末へ動かすのは当てにならないので、選択を直接置く)。 */
async function typeAtParagraphEnd(page: Page, blockId: string, value: string) {
  await page.evaluate((targetBlockId) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>(`.text-flow-editor [data-sigma-doc-id="${targetBlockId}"]`))
      .find((element) => element.getClientRects().length > 0);
    const walker = target ? document.createTreeWalker(target, NodeFilter.SHOW_TEXT) : null;
    let last: Text | null = null;
    for (let node = walker?.nextNode(); node; node = walker?.nextNode()) last = node as Text;
    if (!target || !last) throw new Error(`caret target not found: ${targetBlockId}`);
    target.scrollIntoView({ block: "center" });
    target.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(last, last.data.length);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, blockId);
  await page.keyboard.insertText(value);
}

type SavedProblem = Extract<SigmaDocument["content"][number], { type: "problem" }>;

/** 検証用の空の profile で 2 つ目の Electron を起動する (ユーザーのセッションには触れない)。 */
async function launchApp(prefix: string) {
  const userData = mkdtempSync(path.join(tmpdir(), prefix));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = userData;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${userData}`], cwd: APP_ROOT, env });
  return {
    app,
    async close() {
      await app.close().catch(() => undefined);
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function skipWithoutApp() {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
}

function textOf(document: SigmaDocument | null | undefined, problemId: string, area: "lead" | "prompt" | "hints" | "solution"): string {
  const problem = document?.content.find((item): item is SavedProblem => item.type === "problem" && item.id === problemId);
  return JSON.stringify(problem?.[area] ?? null);
}

test("設定 > 表示 で絞ったまま、見えている領域を編集でき、隠した領域と図形は保存で変わらない (実機)", async ({}, testInfo) => {
  skipWithoutApp();
  const { app, close } = await launchApp("sigma-problem-display-");
  try {
    const page = await app.firstWindow();
    await prepare(page);
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), sourceDocument());
    await page.reload();
    await expect(editorBlock(page, "q1_solution")).toBeVisible();
    const fileId = created.file.fileId;
    const saved = () => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
    const before = await saved();

    // ふだんの表示: 3つともチェックが付いている。
    let menu = await openDisplayMenu(page);
    await expect(menu.problem).toHaveAttribute("aria-checked", "true");
    await expect(menu.solution).toHaveAttribute("aria-checked", "true");
    await expect(menu.hints).toHaveAttribute("aria-checked", "true");

    // 解答・コメントを外す = 問題だけ。読み取り専用の面に差し替えず、編集面のまま隠した領域だけが消える。
    await menu.solution.click();
    await menu.hints.click();
    await expect(menu.problem).toBeDisabled();
    await closeMenu(page);
    await expect(chip(page)).toContainText("問題だけを表示中");
    await expect(page.locator("[data-problem-display-view]")).toHaveCount(0);
    await expect(page.locator(".document-title-row")).not.toHaveAttribute("inert", /.*/);
    await expect(editorBlock(page, "q1_prompt")).toBeVisible();
    await expect(editorBlock(page, "body_intro")).toBeVisible();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="q1_solution"]')).toHaveCount(0);
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="q1_hint"]')).toHaveCount(0);
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="q2_solution"]')).toHaveCount(0);
    // 箱の中の問題も、解答は畳まれて問題文だけが見える。
    await expect(editorBlock(page, "boxed_prompt")).toBeVisible();
    await expect(editorBlock(page, "boxed_solution")).toBeHidden();
    // 解答に錨を下ろした図は解答と一緒に隠れ、問題文の図は残る。
    await expect(shape(page, "shape_in_prompt")).toBeVisible();
    await expect(shape(page, "shape_in_solution")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("01-problem-only-editable.png") });

    // 見えている問題文・箱の問題文・本文を、そのまま打って直せる。
    await typeAtParagraphEnd(page, "q1_prompt", "追記");
    await typeAtParagraphEnd(page, "boxed_prompt", "箱追記");
    await typeAtParagraphEnd(page, "body_intro", "本文追記");
    await expect(editorBlock(page, "q1_prompt")).toContainText("問題文BRAVO追記");
    await expect.poll(async () => textOf(await saved(), "q1", "prompt"), { timeout: 20_000 }).toContain("問題文BRAVO追記");
    await expect.poll(async () => JSON.stringify((await saved())?.content), { timeout: 20_000 }).toContain("箱の問題文HOTEL箱追記");
    await expect.poll(async () => JSON.stringify((await saved())?.content), { timeout: 20_000 }).toContain("本文GOLF本文追記");
    // 見えている図を動かすと、図形の保存で錨の付け替えが走る。隠した図はその付け替えで錨を移されない。
    const savedShape = (document: SigmaDocument | null | undefined, id: string) => document?.pageLayout?.overlay?.overlaySnapshot?.shapes.find((item) => item.id === id);
    const promptShapeBefore = savedShape(await saved(), "shape_in_prompt");
    await grabShapeFromBody(page, shape(page, "shape_in_prompt"));
    await expect(page.locator('.overlay-shape.selected[data-overlay-shape-id="shape_in_prompt"]')).toHaveCount(1);
    const promptShapeBox = (await page.locator('.overlay-shape.selected[data-overlay-shape-id="shape_in_prompt"]').boundingBox())!;
    await page.mouse.move(promptShapeBox.x + promptShapeBox.width / 2, promptShapeBox.y + promptShapeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(promptShapeBox.x + promptShapeBox.width / 2 + 160, promptShapeBox.y + promptShapeBox.height / 2 + 4, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await expect.poll(async () => savedShape(await saved(), "shape_in_prompt")?.x, { timeout: 20_000 }).not.toBe(promptShapeBefore?.x);
    // 隠した領域の中身と、そこに錨を下ろした図は、保存しても前のまま。
    let current = await saved();
    expect(textOf(current, "q1", "solution")).toBe(textOf(before, "q1", "solution"));
    expect(textOf(current, "q1", "hints")).toBe(textOf(before, "q1", "hints"));
    expect(textOf(current, "q2", "solution")).toBe(textOf(before, "q2", "solution"));
    expect(JSON.stringify(current?.content)).toContain("箱の解答INDIA");
    expect(savedShape(current, "shape_in_solution")?.anchor).toEqual(savedShape(before, "shape_in_solution")?.anchor);
    expect(savedShape(current, "shape_in_prompt")?.anchor).toMatchObject({ type: "block", blockId: "q1_prompt" });
    await page.screenshot({ path: testInfo.outputPath("02-problem-only-edited.png") });

    // 解答だけ: 解答を直せる。番号は先頭の領域 (解答) に付く。問題文の図は隠れる。
    menu = await openDisplayMenu(page);
    await menu.solution.click();
    await menu.problem.click();
    await closeMenu(page);
    await expect(chip(page)).toContainText("解答だけを表示中");
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="q1_prompt"]')).toHaveCount(0);
    await expect(editorBlock(page, "q1_solution")).toBeVisible();
    await expect(editorBlock(page, "boxed_solution")).toBeVisible();
    await expect(editorBlock(page, "boxed_prompt")).toBeHidden();
    await expect(page.locator(".page-flow .problem-number-marker")).toHaveCount(2);
    await expect(shape(page, "shape_in_solution")).toBeVisible();
    await expect(shape(page, "shape_in_prompt")).toBeHidden();
    await typeAtParagraphEnd(page, "q1_solution", "解答追記");
    await expect.poll(async () => textOf(await saved(), "q1", "solution"), { timeout: 20_000 }).toContain("解答DELTA解答追記");
    current = await saved();
    expect(textOf(current, "q1", "prompt")).toContain("問題文BRAVO追記");
    expect(textOf(current, "q1", "lead")).toBe(textOf(before, "q1", "lead"));
    expect(savedShape(current, "shape_in_prompt")?.anchor).toMatchObject({ type: "block", blockId: "q1_prompt" });
    await page.screenshot({ path: testInfo.outputPath("03-solution-only-edited.png") });

    // チップのボタンで元に戻す。直した内容も隠していた内容も、すべてそろって見える。
    await page.locator("[data-problem-display-chip]").getByRole("button", { name: "すべて表示に戻す" }).click();
    await expect(page.locator("[data-problem-display-chip]")).toHaveCount(0);
    await expect(editorBlock(page, "q1_prompt")).toContainText("問題文BRAVO追記");
    await expect(editorBlock(page, "q1_solution")).toContainText("解答DELTA解答追記");
    await expect(editorBlock(page, "q1_hint")).toContainText("コメントCHARLIE");
    await expect(editorBlock(page, "boxed_solution")).toBeVisible();
    await expect(shape(page, "shape_in_prompt")).toBeVisible();
    await expect(shape(page, "shape_in_solution")).toBeVisible();
    menu = await openDisplayMenu(page);
    await expect(menu.problem).toHaveAttribute("aria-checked", "true");
    await expect(menu.solution).toHaveAttribute("aria-checked", "true");
    await expect(menu.hints).toHaveAttribute("aria-checked", "true");
    await closeMenu(page);
    await page.screenshot({ path: testInfo.outputPath("04-back-to-all.png") });

    // 絞り込みは教材 (タブ) ごと: 新しい教材はふつうの表示で、元の教材へ戻ると絞ったまま。
    menu = await openDisplayMenu(page);
    await menu.problem.click();
    await closeMenu(page);
    await expect(chip(page)).toContainText("解答・コメントだけを表示中");
    await page.getByRole("button", { name: "新規教材", exact: true }).click();
    await expect(page.locator(".document-tab")).toHaveCount(2);
    await expect(page.locator("[data-problem-display-chip]")).toHaveCount(0);
    await page.locator(".document-tab-main").first().click();
    await expect(chip(page)).toContainText("解答・コメントだけを表示中");
    // 再読み込みするとふつうの表示に戻る (絞り込みは保存しない)。保存された中身は直したとおり。
    await page.reload();
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await expect(page.locator("[data-problem-display-chip]")).toHaveCount(0);
    current = await saved();
    expect(textOf(current, "q1", "prompt")).toContain("問題文BRAVO追記");
    expect(textOf(current, "q1", "solution")).toContain("解答DELTA解答追記");
    expect(textOf(current, "q1", "hints")).toBe(textOf(before, "q1", "hints"));
    expect(savedShape(current, "shape_in_solution")?.anchor).toEqual(savedShape(before, "shape_in_solution")?.anchor);
  } finally {
    await close();
  }
});

/**
 * 解答を隠している間に問題文が伸びたら、解答を戻したとき解答とその図が伸びた分だけ下がる、の検証用の教材。
 * 図は解答に付いたもの (錨・ラベルのような図に付いた図・グループ) と、後ろの解答・箱の中の解答・後ろの本文に付いたもの。
 */
function shiftDocument(): SigmaDocument {
  const geo = (id: string, x: number, extra: Partial<OverlayShape>): OverlayShape => ({
    id,
    type: "geo",
    x,
    y: 200,
    rotation: 0,
    props: { w: 60, h: 36, geo: "rectangle", fill: "solid", color: "#1133cc", labelColor: "#111111", dash: "solid", size: "m" },
    ...extra,
  } as OverlayShape);
  const onBlock = (blockId: string, dy: number) => ({ anchor: { type: "block" as const, blockId, dy } });
  const source = ensurePageLayout({
    ...sampleDocument,
    version: "2.0",
    docId: "electron_problem_display_shift",
    metadata: { title: "表示の絞り込み ずれの追従" },
    content: [
      paragraph("body_intro", "本文GOLF"),
      { type: "problem", id: "q1", tags: [], lead: [], prompt: [paragraph("q1_prompt", "問題文BRAVO")], hints: [], solution: [paragraph("q1_solution", "解答DELTA")] },
      { type: "problem", id: "q2", tags: [], lead: [], prompt: [paragraph("q2_prompt", "問題文ECHO")], hints: [], solution: [paragraph("q2_solution", "解答FOXTROT")] },
      {
        type: "boxBlock", id: "box", styleId: "cornerbox",
        blocks: [{ type: "problem", id: "boxed", tags: [], lead: [], prompt: [paragraph("boxed_prompt", "箱の問題文HOTEL")], hints: [], solution: [paragraph("boxed_solution", "箱の解答INDIA")] }],
      },
      paragraph("body_after", "後ろの本文"),
    ],
  });
  source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [
    geo("fig_solution", 300, onBlock("q1_solution", 6)),
    // 図に付いた図 (ラベルなど)。親の図と一緒に動く。
    geo("fig_solution_label", 380, { anchor: { type: "shape", shapeId: "fig_solution", dx: 80, dy: 0 } }),
    { id: "fig_group", type: "group", x: 470, y: 200, props: { w: 60, h: 80 }, ...onBlock("q1_solution", 6) } as OverlayShape,
    geo("fig_group_top", 470, { parentId: "fig_group", ...onBlock("q1_solution", 6) }),
    geo("fig_group_bottom", 470, { parentId: "fig_group", ...onBlock("q1_solution", 46) }),
    geo("fig_q2_prompt", 450, onBlock("q2_prompt", 6)),
    geo("fig_q2_solution", 300, onBlock("q2_solution", 6)),
    geo("fig_boxed_solution", 300, onBlock("boxed_solution", 6)),
    geo("fig_after", 300, onBlock("body_after", 6)),
  ] } };
  return source;
}

/** 動かさない図と、その図が付いている段落。図の上端 − 段落の上端 が変わらなければ、図は段落と一緒に動いている。 */
const FOLLOWING_FIGURES: ReadonlyArray<readonly [figureId: string, blockId: string]> = [
  ["fig_solution", "q1_solution"],
  ["fig_solution_label", "q1_solution"],
  ["fig_group_top", "q1_solution"],
  ["fig_group_bottom", "q1_solution"],
  ["fig_q2_solution", "q2_solution"],
  ["fig_boxed_solution", "boxed_solution"],
  ["fig_after", "body_after"],
];

/** 描かれている要素の上端 (画面の px)。見えない (畳んだ・描いていない) ものは null。 */
async function topOf(page: Page, selector: string): Promise<number | null> {
  return page.evaluate((target) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>(target))
      .find((candidate) => candidate.getClientRects().length > 0 && getComputedStyle(candidate).visibility !== "hidden");
    return element ? element.getBoundingClientRect().top : null;
  }, selector);
}

async function figureOffsets(page: Page, scope: string, figures = FOLLOWING_FIGURES): Promise<Record<string, number | null>> {
  const entries: Array<[string, number | null]> = [];
  for (const [figureId, blockId] of figures) {
    const figureTop = await topOf(page, `${scope} [data-overlay-shape-id="${figureId}"]`);
    const blockTop = await topOf(page, `${scope} [data-sigma-doc-id="${blockId}"]`);
    entries.push([figureId, figureTop === null || blockTop === null ? null : Math.round((figureTop - blockTop) * 10) / 10]);
  }
  return Object.fromEntries(entries);
}

/** 要素の上端が何枚目の紙 (`.a4-page-sheet`) に載っているか (0 始まり)。 */
async function pageIndexOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((target) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>(target)).find((candidate) => candidate.getClientRects().length > 0);
    if (!element) return -1;
    const top = element.getBoundingClientRect().top;
    return Array.from(document.querySelectorAll<HTMLElement>(".page-mode .a4-page-sheet"))
      .findIndex((sheet) => {
        const rect = sheet.getBoundingClientRect();
        return top >= rect.top && top < rect.bottom;
      });
  }, selector);
}

/** 段落の末尾で改行して行を足す (問題文を縦に伸ばす)。 */
async function addLinesAfter(page: Page, blockId: string, count: number, prefix: string) {
  await typeAtParagraphEnd(page, blockId, "");
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press("Enter");
    await page.keyboard.insertText(`${prefix}${index + 1}`);
  }
}

async function toggleSolution(page: Page) {
  const menu = await openDisplayMenu(page);
  await menu.solution.click();
  await closeMenu(page);
}

test("解答を隠している間に問題文が伸びたら、解答を戻したとき解答と図はその分だけ下がる (実機)", async ({}, testInfo) => {
  skipWithoutApp();
  test.setTimeout(180_000);
  const { app, close } = await launchApp("sigma-problem-display-shift-");
  try {
    const page = await app.firstWindow();
    await prepare(page);
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), shiftDocument());
    await page.reload();
    await expect(editorBlock(page, "q1_solution")).toBeVisible();
    const saved = () => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), created.file.fileId);
    const anchorsOf = (document: SigmaDocument | null | undefined) => Object.fromEntries(
      (document?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? []).map((item) => [item.id, item.anchor]),
    );
    const scroller = page.locator(".editor-canvas");
    // 位置は紙面の座標で比べる (スクロールしても変わらない値にする)。
    const pageTop = async (blockId: string) => (await topOf(page, `.text-flow-editor [data-sigma-doc-id="${blockId}"]`))! + await scroller.evaluate((element) => element.scrollTop);
    await expect.poll(async () => Object.values(await figureOffsets(page, ".page-mode")).every((offset) => offset !== null)).toBe(true);
    const offsetsBefore = await figureOffsets(page, ".page-mode");
    const solutionTopBefore = await pageTop("q1_solution");
    const initialAnchors = anchorsOf(await saved());

    // 解答を隠して、問題文を 8 行伸ばす。箱の中の問題文も伸ばす。
    await toggleSolution(page);
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="q1_solution"]')).toHaveCount(0);
    const q2PromptTopHidden = await pageTop("q2_prompt");
    await addLinesAfter(page, "q1_prompt", 8, "伸ばした行");
    await addLinesAfter(page, "boxed_prompt", 3, "箱の伸ばした行");
    await expect.poll(async () => (await pageTop("q2_prompt")) - q2PromptTopHidden).toBeGreaterThan(150);
    const growth = (await pageTop("q2_prompt")) - q2PromptTopHidden;
    // 隠したまま見えている図を動かす: 図形の保存 (保存時の付け替え) が隠れた図の上でも走る。
    await grabShapeFromBody(page, shape(page, "fig_q2_prompt"));
    const grabbed = (await page.locator('.overlay-shape.selected[data-overlay-shape-id="fig_q2_prompt"]').boundingBox())!;
    await page.mouse.move(grabbed.x + grabbed.width / 2, grabbed.y + grabbed.height / 2);
    await page.mouse.down();
    await page.mouse.move(grabbed.x + grabbed.width / 2 + 80, grabbed.y + grabbed.height / 2 + 2, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: testInfo.outputPath("shift-01-hidden-and-grown.png") });

    // 解答を戻す: 解答は問題文が伸びた分だけ下がり、解答の図・ラベル・グループも同じだけ下がる (段落からの位置は同じ)。
    await toggleSolution(page);
    await expect(editorBlock(page, "q1_solution")).toBeVisible();
    await expect.poll(async () => Math.abs((await pageTop("q1_solution")) - solutionTopBefore - growth)).toBeLessThanOrEqual(1);
    await expect.poll(async () => figureOffsets(page, ".page-mode")).toEqual(offsetsBefore);
    await editorBlock(page, "q1_solution").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("shift-02-shown-again.png") });

    // 保存されたもの: 伸ばした問題文は入り、隠していた図の錨 (段落と、そこからの位置) は変わらない。
    await expect.poll(async () => JSON.stringify((await saved())?.content), { timeout: 20_000 }).toContain("伸ばした行8");
    await expect.poll(async () => JSON.stringify((await saved())?.content), { timeout: 20_000 }).toContain("箱の伸ばした行3");
    const anchorsAfter = anchorsOf(await saved());
    for (const id of ["fig_solution", "fig_solution_label", "fig_group", "fig_group_top", "fig_group_bottom", "fig_q2_solution", "fig_boxed_solution"]) {
      expect(anchorsAfter[id], id).toEqual(initialAnchors[id]);
    }

    // ページをまたぐほど伸ばしても同じ: 解答が次のページへ送られ、図もそのページへ一緒に行く。
    await toggleSolution(page);
    await addLinesAfter(page, "q1_prompt", 30, "さらに伸ばした行");
    await toggleSolution(page);
    await expect(editorBlock(page, "q1_solution")).toBeVisible();
    await expect.poll(async () => pageIndexOf(page, '.text-flow-editor [data-sigma-doc-id="q1_solution"]')).toBeGreaterThan(0);
    await expect.poll(async () => figureOffsets(page, ".page-mode")).toEqual(offsetsBefore);
    expect(await pageIndexOf(page, '.page-mode [data-overlay-shape-id="fig_solution"]'))
      .toBe(await pageIndexOf(page, '.text-flow-editor [data-sigma-doc-id="q1_solution"]'));
    await editorBlock(page, "q1_solution").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("shift-03-next-page.png") });

    // 開き直しても同じ位置に描かれる。
    await expect.poll(async () => JSON.stringify((await saved())?.content), { timeout: 20_000 }).toContain("さらに伸ばした行30");
    await page.reload();
    await expect(editorBlock(page, "q1_solution")).toBeVisible();
    await expect.poll(async () => figureOffsets(page, ".page-mode")).toEqual(offsetsBefore);

    // PDF プレビューでも、解答の図は解答の横に付いたまま。
    // (箱の中の問題に錨を下ろした図は、PDF では絞り込みと関係なく描かれない既存の制約があるので外す。)
    await page.locator(".editor-menubar").getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "エクスポート", exact: true }).hover();
    await page.getByRole("menuitem", { name: "PDFを書き出し", exact: true }).click();
    const pdfFigures = FOLLOWING_FIGURES.filter(([figureId]) => figureId !== "fig_boxed_solution");
    const pdfOffsetsBefore = Object.fromEntries(pdfFigures.map(([figureId]) => [figureId, offsetsBefore[figureId]]));
    await expect.poll(async () => figureOffsets(page, ".preview-drawer .paged-surface-pages", pdfFigures), { timeout: 30_000 })
      .toEqual(pdfOffsetsBefore);
    await page.screenshot({ path: testInfo.outputPath("shift-04-pdf.png") });
  } finally {
    await close();
  }
});
