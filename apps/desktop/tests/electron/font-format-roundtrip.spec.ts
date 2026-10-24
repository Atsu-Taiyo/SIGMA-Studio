import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";
import { DEFAULT_SERIF_BODY_FONT_FAMILY, type ParagraphNode } from "@/features/document";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";

const APP_ROOT = path.resolve(__dirname, "../..");

// Use synthetic materials, the native clipboard, and the actual desktop storage bridge.
test("bold math keeps its face and copied body/figure fonts survive paste and reload", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-font-format-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    await app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const state = globalThis as typeof globalThis & { sigmaFontTestClipboard?: Awaited<ReturnType<typeof clipboard.read>> };
      state.sigmaFontTestClipboard = await Promise.all((await clipboard.read()).filter(item => item.types.length > 0).map(async item =>
        new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))),
      ));
    });
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1400, 1000));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const source = createBlankDocument("書体のコピペ確認");
    const row: ParagraphNode = { type: "paragraph", id: "font_source", children: [
      { type: "text", text: "積分計算のPoint!", fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY, marks: ["underline", "bold"] },
      { type: "text", text: " 置換積分", fontFamily: '"Hiragino Maru Gothic ProN", sans-serif', marks: ["bold"], fontSize: 16 },
    ] };
    source.content = [row, { type: "paragraph", id: "math_body", children: [
      { type: "mathInline", id: "body_f", tex: "f", display: "inline" },
    ] }, { type: "paragraph", id: "same_doc_target", children: [] }];
    source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
      id: "font_figure", type: "text", x: 120, y: 250, rotation: 0,
      props: { w: 350, h: 90, color: "#111111", size: "m", blocks: [
        { ...row, id: "figure_label" },
        { type: "paragraph", id: "figure_math", children: [{ type: "mathInline", id: "figure_f", tex: "f", display: "inline" }] },
      ] },
    }] } };
    const target = createBlankDocument("貼り付け先");
    target.content = [{ type: "paragraph", id: "other_doc_target", children: [] }];
    const ids = await page.evaluate(async documents => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:inline-math-input-mode", "mathlive");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const storage = window.desktopAPI!.storage;
      const ids = [];
      for (const document of documents) ids.push((await storage.createFileFromDocument({ document })).file.fileId);
      await storage.saveWorkspace({ openFileIds: ids, activeFileId: ids[0] });
      return ids;
    }, [source, target]);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator('[data-sigma-doc-id="font_source"]').first()).toBeVisible();
    const selectContents = async (locator: Locator) => {
      await locator.evaluate(element => {
        element.closest<HTMLElement>(".ProseMirror")!.focus();
        const range = document.createRange();
        range.selectNodeContents(element);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
    };
    const fontRuns = (locator: Locator) => locator.evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const result = [];
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.trim()) continue;
        const style = getComputedStyle(node.parentElement!);
        result.push({ text: node.textContent, family: style.fontFamily, weight: style.fontWeight, size: style.fontSize });
      }
      return result;
    });
    const sourceRow = page.locator('.page-flow [data-sigma-doc-id="font_source"]').first();
    const originalFonts = await fontRuns(sourceRow);
    await selectContents(sourceRow);
    await page.keyboard.press("ControlOrMeta+c");
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("積分計算のPoint! 置換積分");
    // Same-document paste and cross-document paste must carry canonical marks as well as font names.
    for (const [index, blockId] of ["same_doc_target", "other_doc_target"].entries()) {
      if (index === 1) await page.locator(`[data-tab-id="document:${ids[1]}"]`).getByRole("tab").click();
      await page.locator(`[data-sigma-doc-id="${blockId}"]`).first().click();
      await page.keyboard.press("ControlOrMeta+v");
      const readPasted = () => page.evaluate(async id => {
        const document = await window.desktopAPI!.storage.loadDocument(id);
        return document?.content.filter(block => block.type === "paragraph" && block.children.some(child => child.type === "text" && child.text === "積分計算のPoint!"));
      }, ids[index]);
      await expect.poll(async () => (await readPasted())?.length).toBe(index === 0 ? 2 : 1);
      const pasted = (await readPasted())!.at(-1)! as ParagraphNode;
      expect(pasted.children).toEqual(row.children);
      await page.reload();
      const pastedRow = page.locator(`.page-flow [data-sigma-doc-id="${pasted.id}"]`).first();
      await expect(pastedRow).toBeVisible();
      expect(await fontRuns(pastedRow)).toEqual(originalFonts);
    }
    await page.locator(`[data-tab-id="document:${ids[0]}"]`).getByRole("tab").click();
    const figure = page.locator('.overlay-shape-text[data-overlay-shape-id="font_figure"]');
    await grabShapeFromBody(page, figure);
    await figure.click();
    await expect(figure.locator(".ProseMirror")).toBeVisible();
    const mathRow = figure.locator(".ProseMirror p").nth(1);
    await selectContents(mathRow);
    await page.locator(".editor-menubar").getByRole("button", { name: "太字", exact: true }).click();
    const savedMath = () => page.evaluate(async id => {
      const document = await window.desktopAPI!.storage.loadDocument(id);
      const shape = document?.pageLayout?.overlay?.overlaySnapshot?.shapes.find(item => item.id === "font_figure");
      const mathBlock = shape?.type === "text" ? shape.props.blocks[1] : undefined;
      return mathBlock?.type === "paragraph"
        ? mathBlock.children.find(child => child.type === "mathInline")?.tex ?? null
        : null;
    }, ids[0]);
    await expect.poll(savedMath).toBe(String.raw`\boldsymbol{f}`);
    const glyph = figure.locator(".ML__mathit").filter({ hasText: "f" }).first();
    await expect(glyph).toHaveCSS("font-family", "KaTeX_Math");
    await expect(glyph).toHaveCSS("font-style", "italic");
    await expect(glyph).toHaveCSS("font-weight", "700");
    await mathRow.locator(".inline-math-node").dblclick();
    const liveGlyph = figure.locator("math-field .ML__mathit").filter({ hasText: "f" }).first();
    await expect(liveGlyph).toHaveCSS("font-family", "KaTeX_Math");
    await expect(liveGlyph).toHaveCSS("font-style", "italic");
    await expect(liveGlyph).toHaveCSS("font-weight", "700");
    await page.keyboard.press("End");
    await page.keyboard.type("+x");
    await expect(figure.locator("math-field")).toHaveJSProperty("value", "f+x");
    await page.keyboard.press("Escape");
    await expect.poll(savedMath).toBe(String.raw`\boldsymbol{f+x}`);
    await mathRow.locator(".inline-math-node").dblclick();
    await expect(figure.locator("math-field")).toHaveJSProperty("value", "f+x");
    await expect(figure.locator("math-field")).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Escape");
    await expect.poll(savedMath).toBe(String.raw`\boldsymbol{f}`);
    await page.reload();
    await expect(glyph).toHaveCSS("font-family", "KaTeX_Math");
    await expect(glyph).toHaveCSS("font-style", "italic");
    await expect(glyph).toHaveCSS("font-weight", "700");
    // Also copy the whole figure, which takes a different clipboard path from its text.
    await grabShapeFromBody(page, figure);
    await page.keyboard.press("ControlOrMeta+c");
    await page.locator(`[data-tab-id="document:${ids[1]}"]`).getByRole("tab").click();
    await page.keyboard.press("ControlOrMeta+v");
    const pastedFigure = () => page.evaluate(async id => {
      const document = await window.desktopAPI!.storage.loadDocument(id);
      const shape = document?.pageLayout?.overlay?.overlaySnapshot?.shapes[0];
      return shape?.type === "text" ? shape.props.blocks : null;
    }, ids[1]);
    await expect.poll(pastedFigure).toMatchObject([
      { children: row.children }, { children: [{ tex: String.raw`\boldsymbol{f}` }] },
    ]);
    await page.reload();
    await expect(page.locator(".overlay-shape-text")).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.evaluate(() => document.fonts.ready);
    expect(await fontRuns(page.locator(".overlay-shape-text p").first())).toEqual(originalFonts);
    await page.screenshot({ path: testInfo.outputPath("font-format-reloaded.png") });

    // A previous copy of the same words must not override the current native cut's HTML.
    // Figure text uses the native ProseMirror cut, which does not update Sigma's copy cache.
    const pastedShape = page.locator(".overlay-shape-text");
    await grabShapeFromBody(page, pastedShape);
    await pastedShape.click();
    const label = pastedShape.locator(".ProseMirror p").first();
    await selectContents(label);
    await page.keyboard.press("ControlOrMeta+c");
    await page.locator('.editor-menubar button[aria-label^="フォント:"]').click();
    await page.getByRole("menu", { name: "フォント", exact: true })
      .getByRole("menuitemradio", { name: "M PLUS 1p", exact: true }).click();
    await page.locator(".editor-menubar").getByRole("button", { name: "太字", exact: true }).click();
    // The default body font is represented by an omitted fontFamily in SigmaDoc.
    const changedChildren = [
      { type: "text", text: "積分計算のPoint!", marks: ["underline"] },
      { type: "text", text: " 置換積分", fontSize: 16 },
    ];
    await expect.poll(pastedFigure).toMatchObject([{ children: changedChildren }, {}]);
    const changedFonts = await fontRuns(label);
    expect(changedFonts.every(run => run.family.includes("M PLUS 1p") && run.weight === "400")).toBe(true);
    await selectContents(label);
    await page.keyboard.press("ControlOrMeta+x");
    await expect(label).toHaveText("");
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(pastedFigure).toMatchObject([{ children: changedChildren }, {}]);
    expect(await fontRuns(label)).toEqual(changedFonts);
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect.poll(pastedFigure).toMatchObject([{ children: changedChildren }, {}]);
    expect(await fontRuns(page.locator(".overlay-shape-text p").first())).toEqual(changedFonts);
    await page.screenshot({ path: testInfo.outputPath("overlay-cut-font-reloaded.png") });
  } finally {
    try {
      await app.evaluate(async ({ clipboard }) => {
        const state = globalThis as typeof globalThis & { sigmaFontTestClipboard?: Awaited<ReturnType<typeof clipboard.read>> };
        if (state.sigmaFontTestClipboard) await clipboard.write(state.sigmaFontTestClipboard);
        delete state.sigmaFontTestClipboard;
      });
    } finally {
      await app.close();
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});
