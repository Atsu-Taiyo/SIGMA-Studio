import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { MathfieldElement } from "mathlive";
import type { SigmaDocument } from "@/features/document";
import { readCaretSurface } from "../e2e/caret-surface";

async function launch(mode: "mathlive" | "tex" = "mathlive") {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-caret-owner-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  const page = await app.firstWindow();
  await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1200, 900));
  await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
  const source: SigmaDocument = {
    version: "2.0", docId: "caret_owner", metadata: { title: "入力位置の検証" },
    content: [{ type: "quote", id: "q", blocks: Array.from({ length: 18 }, (_, i) => ({
      type: "paragraph", id: `p${i}`, children: [
        { type: "text", text: `本文${i} ` },
        { type: "mathInline", id: `a${i}`, tex: "x", display: "inline" },
        { type: "mathInline", id: `b${i}`, tex: "y", display: "inline" },
        { type: "text", text: " 続きの文章" },
      ],
    })) }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: { preset: "custom", orientation: "portrait", pageSize: { widthMm: 140, heightMm: 110 }, marginsMm: { top: 12, right: 12, bottom: 12, left: 12 }, flow: { type: "columns", columnCount: 1, columnGapMm: 8 } },
  };
  const fileId = await page.evaluate(async ({ source, mode }) => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    localStorage.setItem("sigma-studio:inline-math-input-mode", mode);
    await window.desktopAPI!.settings!.setUiLocale!("ja");
    const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document: source });
    await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
    return file.fileId;
  }, { source, mode });
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".editor-box-fragment-viewport")).toHaveCount(1);
  return {
    page, fileId,
    saved: () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId),
    close: async () => { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); },
  };
}

for (const mode of ["mathlive", "tex"] as const) {
  test(`${mode}: adjacent math opens one visible input in source and continuation and saves it`, async () => {
    const { page, saved, close } = await launch(mode);
    try {
      const field = page.locator(mode === "mathlive" ? "math-field" : ".inline-math-tex-field");
      const done = mode === "mathlive" ? "Enter" : "Control+Enter";
      for (const index of [0, 17]) {
        const surface = index === 0 ? page.locator(".page-flow").first() : page.locator(".editor-box-fragment-viewport").first();
        const first = surface.locator(`.inline-math-node[data-id="a${index}"]`);
        await first.click();
        await expect(field).toHaveCount(1);
        await expect(field).toBeFocused();
        await page.keyboard.press("End");
        await page.keyboard.press(done);
        await expect(field).toHaveCount(1);
        await expect(field).toBeFocused();
        if (mode === "mathlive") {
          await expect(surface.locator(`.inline-math-node[data-id="b${index}"] math-field`)).toBeFocused();
          await expect.poll(() => field.evaluate(element => {
            const box = element.getBoundingClientRect();
            const viewport = element.closest(".editor-box-fragment-viewport")?.getBoundingClientRect();
            return !viewport || (box.bottom > viewport.top && box.top < viewport.bottom);
          })).toBe(true);
        }
        await page.keyboard.type("z");
        await expect.poll(() => field.evaluate(element => (element as MathfieldElement | HTMLTextAreaElement).value)).toBe("zy");
        await page.keyboard.press(done);
        // Type immediately after the handoff: no old offset may be restored next frame.
        await page.keyboard.type("ABC");
        await expect(field).toHaveCount(0);
        await expect.poll(async () => (await readCaretSurface(page)).caretVisible).toBe(true);
      }
      await page.keyboard.press("ControlOrMeta+s");
      for (const index of [0, 17]) {
        await expect.poll(async () => {
          const document = await saved();
          const quote = document!.content[0];
          if (quote.type !== "quote") return null;
          const paragraph = quote.blocks[index];
          return paragraph.type === "paragraph" ? paragraph.children.map(run => run.type === "text" ? run.text : run.type === "mathInline" ? `$${run.tex}$` : "").join("") : null;
        }).toBe(`本文${index} $x$$zy$ABC 続きの文章`);
      }
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden();
      await expect(page.locator('.page-flow [data-sigma-doc-id="p0"]').first()).toContainText("ABC");
      await expect(page.locator('.inline-math-node[data-id="b17"]').first()).toHaveAttribute("data-tex", "zy");
    } finally { await close(); }
  });
}

test("body input and Japanese composition follow the caret across a page and survive reload", async () => {
  const { page, saved, close } = await launch();
  try {
    const paragraph = page.locator('.page-flow [data-sigma-doc-id="p8"]').first();
    await paragraph.click({ position: { x: 220, y: 12 } });
    await paragraph.evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement!.closest(".inline-math-node") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      let last: Node | null = null;
      while (walker.nextNode()) last = walker.currentNode;
      getSelection()!.collapse(last, last!.textContent!.length);
    });
    const ime = await page.context().newCDPSession(page);
    const surfaces = new Set<string>();
    let inserted = "";
    for (let i = 0; i < 35; i++) {
      const text = `v${i} `;
      await page.keyboard.type(text);
      inserted += text;
      if (i % 7 === 6) {
        await ime.send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 });
        await ime.send("Input.insertText", { text: "仮名" });
        inserted += "仮名";
      }
      await expect.poll(async () => (await readCaretSurface(page)).caretVisible).toBe(true);
      surfaces.add((await readCaretSurface(page)).selectionSurface!.kind);
      expect(await page.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest("[data-sigma-doc-id]")?.getAttribute("data-sigma-doc-id"))).toBe("p8");
    }
    expect(surfaces).toEqual(new Set(["source", "replica"]));
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(async () => JSON.stringify((await saved())?.content)).toContain(inserted);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(paragraph).toContainText(inserted);
  } finally { await close(); }
});
