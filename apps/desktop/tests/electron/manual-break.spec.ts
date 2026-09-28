import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");

async function placeCaretAtStart(page: Page, blockId: string) {
  await page.evaluate((id) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>(`.text-flow-editor [data-sigma-doc-id="${id}"]`))
      .find((element) => element.getClientRects().length > 0 && !element.closest(".editor-box-fragment-editor"));
    const text = target?.firstChild;
    if (!target || !(text instanceof Text)) throw new Error(`caret target not found: ${id}`);
    target.closest<HTMLElement>('[contenteditable="true"]')?.focus();
    window.getSelection()?.collapse(text, 0);
  }, blockId);
}

async function caretBlock(page: Page) {
  return page.evaluate(() => {
    const node = window.getSelection()?.focusNode;
    const element = node instanceof Element ? node : node?.parentElement;
    return {
      blockId: element?.closest("[data-sigma-doc-id]")?.getAttribute("data-sigma-doc-id") ?? null,
      replica: !!element?.closest(".editor-box-fragment-editor"),
      offset: window.getSelection()?.focusOffset ?? -1,
    };
  });
}

test("a page break typed inside a quote is saved, survives reopening, and Backspace only crosses it", async () => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!process.env.SIGMA_STUDIO_E2E_BASE_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-manual-break-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) {
    env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  }
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    const source: SigmaDocument = {
      version: "2.0",
      docId: "manual_break_quote",
      metadata: { title: "引用の中の改ページ" },
      content: [
        { type: "paragraph", id: "before", children: [{ type: "text", text: "引用の前" }] },
        {
          type: "quote",
          id: "quote",
          blocks: [
            { type: "paragraph", id: "q1", children: [{ type: "text", text: "引用の一行目" }] },
            { type: "paragraph", id: "q2", children: [{ type: "text", text: "引用の二行目" }] },
          ],
        },
      ],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    };
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, source);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator('.page-flow [data-sigma-doc-id="q2"]').first()).toBeVisible();

    await placeCaretAtStart(page, "q2");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
    const savedQuote = async () => {
      const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
      return saved?.content.find((block) => block.id === "quote");
    };
    await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
    await expect.poll(async () => JSON.stringify(await savedQuote())).toContain('"id":"q2","pagination":{"break":true}');

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".startup-splash")).toBeHidden();
    // 区切りの後ろは引用の続き (次のページの断片) に描かれる。
    const continued = page.locator('.editor-box-fragment-viewport [data-sigma-doc-id="q2"]');
    await expect(continued).toHaveCount(1);
    const firstTop = (await page.locator('.page-flow [data-sigma-doc-id="q1"]').first().boundingBox())!.y;
    expect((await continued.boundingBox())!.y).toBeGreaterThan(firstTop + 300);

    await page.evaluate(() => {
      const text = document.querySelector('.editor-box-fragment-viewport [data-sigma-doc-id="q2"]')?.firstChild;
      if (!(text instanceof Text)) throw new Error("continuation text not found");
      (text.parentElement!.closest('[contenteditable="true"]') as HTMLElement).focus();
      window.getSelection()?.collapse(text, 0);
    });
    await page.keyboard.press("Backspace");
    await expect.poll(() => caretBlock(page)).toEqual({ blockId: "q1", replica: false, offset: "引用の一行目".length });
    expect(JSON.stringify(await savedQuote())).toContain('"id":"q2","pagination":{"break":true}');
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
