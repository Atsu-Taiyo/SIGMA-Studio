import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePageLayout } from "../../src/lib/page-layout";
import type { SigmaDocument } from "../../src/types/sigma-doc";

test("math-only selection has text tools and mixed formatting toggles together after reload", async () => {
  test.setTimeout(60_000);
  const root = process.cwd();
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-math-selection-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    const document = ensurePageLayout({
      version: "2.0", docId: "math-selection", metadata: { title: "数式の選択と書式" },
      content: [
        { type: "paragraph", id: "mixed", children: [
          { type: "text", text: "本文" },
          { type: "mathInline", id: "mixed-math", tex: "x^2", display: "inline" },
          { type: "text", text: "後文" },
        ] },
        { type: "paragraph", id: "math-only", children: [{ type: "mathInline", id: "only-math", tex: "y^2", display: "inline" }] },
      ], outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    } as SigmaDocument);
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const storage = window.desktopAPI!.storage;
      const created = await storage.createFileFromDocument({ document });
      await storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, document);
    await page.reload();
    const mixed = page.locator('.page-flow [data-sigma-doc-id="mixed"]').first();
    await expect(mixed).toBeVisible({ timeout: 60_000 });
    const selectParagraph = async (id: string) => {
      await page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first().evaluate((element) => {
        const editor = element.closest<HTMLElement>(".ProseMirror")!;
        editor.focus();
        const range = window.document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        window.document.dispatchEvent(new Event("selectionchange"));
      });
    };
    const tools = page.locator(".selection-action-popover").filter({ has: page.getByRole("button", { name: /太字/ }) });
    const savedRuns = () => page.evaluate(async (id) => {
      const saved = await window.desktopAPI!.storage.loadDocument(id);
      const paragraph = saved?.content.find((block) => block.id === "mixed");
      return paragraph?.type === "paragraph" ? paragraph.children.map((child) => child.type === "text" ? child.marks ?? [] : child.tex) : null;
    }, fileId);
    await selectParagraph("mixed");
    await expect(tools).toBeVisible();
    await tools.getByRole("button", { name: /太字/ }).click();
    await expect.poll(savedRuns).toEqual([["bold"], String.raw`\boldsymbol{x^2}`, ["bold"]]);
    // A formula selected inside a mixed line exposes the same tools.
    await mixed.locator(".inline-math-node").evaluate((element) => {
      element.closest<HTMLElement>(".ProseMirror")!.focus();
      const range = window.document.createRange();
      range.selectNode(element);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      window.document.dispatchEvent(new Event("selectionchange"));
    });
    await expect(tools).toBeVisible();
    await tools.getByRole("button", { name: /太字/ }).click();
    await expect.poll(savedRuns).toEqual([["bold"], "x^2", ["bold"]]);
    await selectParagraph("mixed");
    await tools.getByRole("button", { name: /太字/ }).click();
    await expect.poll(savedRuns).toEqual([["bold"], String.raw`\boldsymbol{x^2}`, ["bold"]]);
    await tools.getByRole("button", { name: /斜体/ }).click();
    await expect.poll(savedRuns).toEqual([["bold", "italic"], String.raw`\boldsymbol{\mathit{x^2}}`, ["bold", "italic"]]);
    await tools.getByRole("button", { name: /斜体/ }).click();
    await expect.poll(savedRuns).toEqual([["bold"], String.raw`\boldsymbol{x^2}`, ["bold"]]);
    await expect(mixed.locator("strong .inline-math-node")).toHaveCount(1);
    await tools.getByRole("button", { name: /太字/ }).click();
    await expect.poll(savedRuns).toEqual([[], "x^2", []]);
    await selectParagraph("math-only");
    await expect(tools).toBeVisible();
    await tools.getByRole("button", { name: /太字/ }).click();
    await expect(page.locator('.page-flow [data-sigma-doc-id="math-only"] strong .inline-math-node').first()).toBeVisible();
    await expect.poll(() => page.evaluate(async (id) => {
      const saved = await window.desktopAPI!.storage.loadDocument(id);
      const paragraph = saved?.content.find((block) => block.id === "math-only");
      const child = paragraph?.type === "paragraph" ? paragraph.children[0] : null;
      return child?.type === "mathInline" ? child.tex : null;
    }, fileId)).toBe(String.raw`\boldsymbol{y^2}`);
    await page.reload();
    await expect(page.locator('.page-flow [data-sigma-doc-id="math-only"] strong .inline-math-node').first()).toBeVisible();
    await selectParagraph("mixed");
    await tools.getByRole("button", { name: /太字/ }).click();
    await expect.poll(savedRuns).toEqual([["bold"], String.raw`\boldsymbol{x^2}`, ["bold"]]);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
