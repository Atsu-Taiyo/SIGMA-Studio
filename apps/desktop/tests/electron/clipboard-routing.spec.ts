import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";
import type { ParagraphNode } from "@/features/document";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";
import { placeClipboardCaret } from "../e2e/clipboard-caret";

const APP_ROOT = path.resolve(__dirname, "../..");

test("copying inside an itembox pastes only its contents and survives undo and restart", async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-box-clipboard-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  let app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const originalClipboard = await app.evaluateHandle(async ({ clipboard, ClipboardItem }) => Promise.all((await clipboard.read()).filter(item => item.types.length > 0).map(async item =>
    new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))),
  )));
  let restoreClipboard = true;
  try {
    let page = await app.firstWindow();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const document = createBlankDocument("箱の中身をコピー");
    document.content = [
      { type: "boxBlock", id: "clipboard_box", styleId: "itembox", title: [{ type: "text", text: "箱の題名" }], blocks: [
        { type: "paragraph", id: "clipboard_inside", children: [{ type: "text", text: "選んだ本文", marks: ["bold"] }] },
        { type: "paragraph", id: "clipboard_inside_target", children: [{ type: "text", text: "箱内:" }] },
      ] },
      { type: "paragraph", id: "clipboard_outside", children: [{ type: "text", text: "箱外:" }] },
    ];
    const fileId = await page.evaluate(async document => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const storage = window.desktopAPI!.storage;
      const { file } = await storage.createFileFromDocument({ document });
      await storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const body = (id: string) => page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
    await expect(body("clipboard_inside")).toBeVisible();
    await body("clipboard_inside").evaluate(element => {
      element.closest<HTMLElement>(".ProseMirror")!.focus();
      const range = window.document.createRange();
      range.selectNodeContents(element);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      window.document.dispatchEvent(new Event("selectionchange"));
    });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("選んだ本文");
    // Observe after React's delegated copy handler, before the overlay's window listener.
    await page.evaluate(() => window.document.addEventListener("copy", event => {
      window.document.body.dataset.e2eCopiedSlice = event.clipboardData!.getData("application/x-sigma-studio-text-slice");
    }, { once: true }));
    await page.keyboard.press("ControlOrMeta+c");
    await expect.poll(() => page.evaluate(() => JSON.parse(window.document.body.dataset.e2eCopiedSlice || "null"))).toMatchObject({
      slice: { openStart: 1, openEnd: 1, content: [{ type: "paragraph" }] },
    });
    await page.evaluate(() => delete window.document.body.dataset.e2eCopiedSlice);
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain("選んだ本文");
    const load = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
    await placeClipboardCaret(page, body("clipboard_outside"));
    await page.keyboard.press("ControlOrMeta+v");
    await expect(body("clipboard_outside")).toHaveText("箱外:選んだ本文");
    await expect.poll(async () => (await load())?.content.filter(block => block.type === "boxBlock").length).toBe(1);
    await expect.poll(async () => (await load())?.content.find(block => block.id === "clipboard_outside")).toMatchObject({
      type: "paragraph", children: [{ type: "text", text: "箱外:" }, { type: "text", text: "選んだ本文", marks: ["bold"] }],
    });
    await page.keyboard.press("ControlOrMeta+z");
    await expect(body("clipboard_outside")).toHaveText("箱外:");
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(body("clipboard_outside")).toHaveText("箱外:選んだ本文");
    await placeClipboardCaret(page, body("clipboard_inside_target"));
    await page.keyboard.press("ControlOrMeta+v");
    await expect(body("clipboard_inside_target")).toHaveText("箱内:選んだ本文");
    await expect.poll(load).toMatchObject({ content: [
      { type: "boxBlock", id: "clipboard_box", title: [{ type: "text", text: "箱の題名" }], blocks: [
        { id: "clipboard_inside", children: [{ type: "text", text: "選んだ本文", marks: ["bold"] }] },
        { id: "clipboard_inside_target", children: [{ type: "text", text: "箱内:" }, { type: "text", text: "選んだ本文", marks: ["bold"] }] },
      ] },
      { id: "clipboard_outside" },
    ] });
    const savedContent = (await load())!.content;
    await app.evaluate(({ clipboard }, original) => clipboard.write(original), originalClipboard);
    await originalClipboard.dispose();
    restoreClipboard = false;
    await app.close();
    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    page = await app.firstWindow();
    await expect(body("clipboard_inside_target")).toHaveText("箱内:選んだ本文");
    expect((await load())!.content).toEqual(savedContent);
  } finally {
    try {
      if (restoreClipboard) {
        await app.evaluate(({ clipboard }, original) => clipboard.write(original), originalClipboard);
        await originalClipboard.dispose();
      }
    } finally {
      await app.close();
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});

function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "id").map(([key, child]) => [key, withoutIds(child)]));
}

test("native cut/paste preserves its destination, formatting, undo and saved content across documents", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-clipboard-routing-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const originalClipboard = await app.evaluateHandle(async ({ clipboard, ClipboardItem }) => Promise.all((await clipboard.read()).filter(item => item.types.length > 0).map(async item =>
    new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))),
  )));
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1400, 1000));
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const source = createBlankDocument("切り取り元");
    const row: ParagraphNode = { type: "paragraph", id: "cut_source", children: [
      { type: "text", text: "移動する文章 ", fontFamily: '"Noto Serif JP", serif', fontSize: 16, marks: ["underline", "bold"] },
      { type: "mathInline", id: "cut_math", tex: String.raw`\frac{x}{y}`, display: "inline", semanticRole: "expression", marks: ["boxed"] },
    ] };
    source.content = [row,
      { type: "problem", id: "copy_problem", tags: [], lead: [], hints: [], solution: [], prompt: [
        { type: "paragraph", id: "problem_prompt", children: [{ type: "text", text: "コピーする問題文" }] },
      ] },
      { type: "paragraph", id: "external_target", children: [] },
      { type: "paragraph", id: "literal_target", children: [] },
    ];
    source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
      id: "cut_figure", type: "text", x: 120, y: 400, rotation: 0,
      props: { w: 350, h: 65, color: "#111111", size: "m", blocks: [{
        ...row, id: "figure_row", children: [
          { type: "text", text: "図中から移動 ", fontFamily: '"Noto Serif JP", serif', marks: ["bold"] },
          { type: "mathInline", id: "figure_math", tex: "a^2+b^2", display: "inline", semanticRole: "expression", marks: ["boxed"] },
        ],
      }] },
    }] } };
    const target = createBlankDocument("貼り付け先");
    target.content = ["problem_target", "cut_target", "repeat_target", "figure_target"].map(id => ({ type: "paragraph", id, children: [] }));
    const ids = await page.evaluate(async documents => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const storage = window.desktopAPI!.storage;
      const ids = [];
      for (const document of documents) ids.push((await storage.createFileFromDocument({ document })).file.fileId);
      await storage.saveWorkspace({ openFileIds: ids, activeFileId: ids[0] });
      return ids;
    }, [source, target]);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const saved = (index: number) => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), ids[index]);
    const problems = async (index: number) => (await saved(index))?.content.filter(block => block.type === "problem") ?? [];
    const children = async (index: number, blockId: string) => {
      const block = (await saved(index))?.content.find(block => block.id === blockId);
      return block?.type === "paragraph" ? block.children : null;
    };
    const body = (id: string) => page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
    const selectContents = async (locator: Locator) => locator.evaluate(element => {
      element.closest<HTMLElement>(".ProseMirror")!.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const switchTo = async (index: number) => page.locator(`[data-tab-id="document:${ids[index]}"]`).getByRole("tab").click();
    const copyProblem = async () => {
      await body("problem_prompt").click({ button: "right" });
      await page.locator(".problem-context-menu").getByRole("menuitem", { name: "問題をコピー", exact: true }).click();
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain("コピーする問題文");
    };

    // A copied problem must paste as text into the title, without inserting behind it.
    await copyProblem();
    const problemText = await app.evaluate(({ clipboard }) => clipboard.readText());
    await page.locator(".document-title-input").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+v");
    await expect(page.locator(".document-title-input")).toHaveValue(problemText.replace(/[\r\n]/g, ""));
    expect(await problems(0)).toHaveLength(1);

    // The real clipboard now belongs to another application; the old problem cache is stale.
    await app.evaluate(({ clipboard }) => clipboard.writeText("外部からコピーした文章"));
    await body("external_target").click();
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(() => children(0, "external_target")).toEqual([{ type: "text", text: "外部からコピーした文章" }]);
    expect(await problems(0)).toHaveLength(1);

    await copyProblem();
    await body("literal_target").click();
    // CDP key injection does not invoke Electron menu key equivalents.
    await (await app.browserWindow(page)).evaluate(window => window.webContents.pasteAndMatchStyle());
    await expect(body("literal_target")).toContainText("コピーする問題文");
    expect(await problems(0)).toHaveLength(1);
    await switchTo(1);
    await body("problem_target").click();
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(() => problems(1)).toHaveLength(1);
    expect((await problems(1))[0].id).not.toBe("copy_problem");

    // Cut real body text with a boxed formula; undo/redo must not change its clipboard.
    await switchTo(0);
    const sourceChildren = await children(0, "cut_source");
    expect(sourceChildren).toHaveLength(2);
    await selectContents(body("cut_source"));
    await page.keyboard.press("ControlOrMeta+x");
    await expect.poll(async () => (await children(0, "cut_source")) ?? []).toEqual([]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => children(0, "cut_source")).toEqual(sourceChildren);
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect.poll(async () => (await children(0, "cut_source")) ?? []).toEqual([]);
    await switchTo(1);
    await body("cut_target").click();
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(async () => withoutIds(await children(1, "cut_target"))).toEqual(withoutIds(sourceChildren));
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => children(1, "cut_target")).toEqual([]);
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect.poll(async () => withoutIds(await children(1, "cut_target"))).toEqual(withoutIds(sourceChildren));
    await body("repeat_target").click();
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(async () => withoutIds(await children(1, "repeat_target"))).toEqual(withoutIds(sourceChildren));
    const firstMath = (await children(1, "cut_target"))!.find(child => child.type === "mathInline");
    const secondMath = (await children(1, "repeat_target"))!.find(child => child.type === "mathInline");
    expect(firstMath?.id).not.toBe(secondMath?.id);

    // The native cut from figure text takes the HTML path into the other document.
    await switchTo(0);
    const figure = page.locator('.overlay-shape-text[data-overlay-shape-id="cut_figure"]');
    await grabShapeFromBody(page, figure);
    await figure.click();
    const figureChildren = async () => {
      const shape = (await saved(0))?.pageLayout?.overlay?.overlaySnapshot?.shapes[0];
      return shape?.type === "text" && shape.props.blocks[0].type === "paragraph" ? shape.props.blocks[0].children : null;
    };
    const originalFigure = await figureChildren();
    await selectContents(figure.locator(".ProseMirror p").first());
    await page.keyboard.press("ControlOrMeta+x");
    await expect.poll(figureChildren).toEqual([]);
    await switchTo(1);
    await body("figure_target").click();
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(async () => withoutIds(await children(1, "figure_target"))).toEqual(withoutIds(originalFigure));
    const expectedContent = (await saved(1))!.content;
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    expect((await saved(1))!.content).toEqual(expectedContent);
    expect((await children(0, "cut_source")) ?? []).toEqual([]);
    expect(await figureChildren()).toEqual([]);
    await expect(body("figure_target").locator(".inline-math-node")).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("cut-paste-reloaded.png") });
    // Reopening the empty source must not insert a placeholder on the next blur either.
    await switchTo(0);
    await grabShapeFromBody(page, figure);
    await figure.click();
    await expect(figure.locator(".ProseMirror")).toBeVisible();
    await placeClipboardCaret(page, body("external_target"));
    await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
    expect(await figureChildren()).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    try {
      await app.evaluate(({ clipboard }, original) => clipboard.write(original), originalClipboard);
      await originalClipboard.dispose();
    } finally {
      await app.close();
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});
