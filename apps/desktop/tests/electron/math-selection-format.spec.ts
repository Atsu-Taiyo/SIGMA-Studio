import { _electron as electron, expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePageLayout } from "../../src/lib/page-layout";
import type { SigmaDocument } from "../../src/types/sigma-doc";

interface DelayedMathFocusProbe {
  originalSetTimeout: typeof window.setTimeout;
  originalClearTimeout: typeof window.clearTimeout;
  callbacks: Map<number, () => void>;
}

test("math-only selection has text tools and mixed formatting toggles together after reload", async () => {
  test.setTimeout(60_000);
  const root = process.cwd();
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-math-selection-"));
  const settingsDir = path.join(profile, "data");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    expect(await page.evaluate(() => window.desktopAPI!.settings!.get())).toMatchObject({ uiLocale: "ja" });
    const document = ensurePageLayout({
      version: "2.0", docId: "math-selection", metadata: { title: "数式の選択と書式" },
      content: [
        { type: "paragraph", id: "mixed", children: [
          { type: "text", text: "本文" },
          { type: "mathInline", id: "mixed-math", tex: "x^2", display: "inline" },
          { type: "text", text: "後文" },
        ] },
        { type: "paragraph", id: "math-only", children: [{ type: "mathInline", id: "only-math", tex: "y^2", display: "inline" }] },
        { type: "paragraph", id: "comment-target", children: [
          { type: "text", text: "前" },
          { type: "mathInline", id: "comment-math", tex: String.raw`\boldsymbol{\mathit{z}}`, display: "inline" },
          { type: "text", text: "対象末尾" },
        ] },
        { type: "paragraph", id: "paste-target", children: [{ type: "text", text: "貼り付け先" }] },
      ],
      comments: [{
        id: "range-after-math", createdAt: "2026-10-21T00:00:00Z",
        anchor: { type: "textRange", start: { blockId: "comment-target", offset: 1 + String.raw`\boldsymbol{\mathit{z}}`.length + 2 }, end: { blockId: "comment-target", offset: 3 + String.raw`\boldsymbol{\mathit{z}}`.length + 2 }, quote: "対象" },
        messages: [{ id: "comment-message", authorName: "検証", createdAt: "2026-10-21T00:00:00Z", body: [{ type: "text", text: "保存した範囲" }] }],
      }],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    } as SigmaDocument);
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:inline-math-input-mode", "tex");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      const storage = window.desktopAPI!.storage;
      const created = await storage.createFileFromDocument({ document });
      await storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, document);
    await page.reload();
    const mixed = page.locator('.page-flow [data-sigma-doc-id="mixed"]').first();
    await expect(mixed).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "太字", exact: true })).toBeVisible();
    const commentTarget = page.locator('.page-flow [data-sigma-doc-id="comment-target"]').first();
    expect(await commentTarget.evaluate((element) => Boolean(element.closest(".ProseMirror")))).toBe(true);
    await expect(commentTarget.locator('.comment-text-highlight[data-comment-thread-id="range-after-math"]')).toHaveText("対象");
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
    // A restored text-range anchor counts the canonical formatted TeX, not attrs.tex.
    await page.reload();
    await expect(mixed).toBeVisible();
    await page.evaluate((from) => window.dispatchEvent(new CustomEvent("sigma-studio:ai-reference-text-range", { detail: { anchors: [{
      type: "textRange", start: { blockId: "mixed", offset: from }, end: { blockId: "mixed", offset: from + 2 }, quote: "後文",
    }] } })), "本文".length + String.raw`\boldsymbol{x^2}`.length + 2);
    await expect(mixed.locator(".external-text-range-highlight")).toHaveText("後文");
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
    expect(await mixed.locator(".inline-math-node").evaluate((element) => {
      const clipboardData = new DataTransfer();
      element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
      return clipboardData.getData("text/plain");
    })).toBe(String.raw`$\boldsymbol{x^2}$`);
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
    // The real pointer gesture must preserve the input and apply the new mark.
    await mixed.locator(".inline-math-node").dblclick();
    const draft = page.getByRole("textbox", { name: "TeX", exact: true });
    await draft.fill("x^3+1");
    await mixed.evaluate((element) => {
      // Textarea autofocus can scroll an outer viewport underneath the fixed menu.
      for (let parent = element.parentElement; parent; parent = parent.parentElement) parent.scrollTop = 0;
    });
    await tools.getByRole("button", { name: /太字/ }).click();
    await expect.poll(savedRuns).toEqual([["bold"], "x^3+1", ["bold"]]);
    await page.reload();
    await expect(mixed.locator(".inline-math-node")).toHaveAttribute("data-tex", "x^3+1");
    await mixed.locator(".inline-math-node").dblclick();
    await draft.fill("x^4+2");
    await mixed.evaluate((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) parent.scrollTop = 0;
    });
    await tools.getByRole("button", { name: /斜体/ }).click();
    await expect.poll(savedRuns).toEqual([["bold"], String.raw`\mathit{x^4+2}`, ["bold"]]);
    await page.reload();
    await expect(mixed.locator(".inline-math-node")).toHaveAttribute("data-tex", String.raw`\mathit{x^4+2}`);
    // Hold the field's delayed initial focus while select-all runs. Without this
    // explicit ordering the focus/fill race only appears intermittently in CI.
    await page.evaluate(() => {
      const originalSetTimeout = window.setTimeout.bind(window);
      const originalClearTimeout = window.clearTimeout.bind(window);
      const callbacks = new Map<number, () => void>();
      (window as typeof window & { mathSelectionFocusProbe?: DelayedMathFocusProbe })
        .mathSelectionFocusProbe = { originalSetTimeout, originalClearTimeout, callbacks };
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 50 && typeof handler === "function" && handler.toString().includes("preventScroll")) {
          const id = originalSetTimeout(() => {}, 0);
          callbacks.set(id, () => handler(...args));
          return id;
        }
        return originalSetTimeout(handler, timeout, ...args);
      }) as typeof window.setTimeout;
      window.clearTimeout = (id) => {
        if (typeof id === "number") callbacks.delete(id);
        originalClearTimeout(id);
      };
    });
    await mixed.locator(".inline-math-node").dblclick();
    const focusProbe = await draft.evaluate(input => {
      const textarea = input as HTMLTextAreaElement;
      const probeWindow = window as typeof window & { mathSelectionFocusProbe?: DelayedMathFocusProbe };
      const probe = probeWindow.mathSelectionFocusProbe!;
      textarea.select();
      window.setTimeout = probe.originalSetTimeout;
      window.clearTimeout = probe.originalClearTimeout;
      for (const callback of probe.callbacks.values()) callback();
      delete probeWindow.mathSelectionFocusProbe;
      return { callbacks: probe.callbacks.size, start: textarea.selectionStart, end: textarea.selectionEnd, length: textarea.value.length };
    });
    expect(focusProbe.callbacks).toBeGreaterThan(0);
    expect(focusProbe.start).toBe(0);
    expect(focusProbe.end).toBe(focusProbe.length);
    await draft.fill("x^5+3");
    await expect(mixed.locator(".inline-math-node > .math-preview .ML__it").first()).toBeAttached();
    await mixed.evaluate((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) parent.scrollTop = 0;
    });
    const band = page.locator(".selection-action-popover");
    await band.getByRole("button", { name: "コメントを追加", exact: true }).click();
    const composer = page.locator("[data-floating-comment-composer]");
    await composer.getByRole("textbox", { name: "コメントを追加", exact: true }).fill("数式の下書きを確認");
    await composer.getByRole("button", { name: "追加", exact: true }).click();
    const savedAnchor = () => page.evaluate(async (id) => (await window.desktopAPI!.storage.loadDocument(id))?.comments?.find((thread) => thread.anchor.type === "inlineMath")?.anchor, fileId);
    await expect.poll(savedAnchor).toMatchObject({ type: "inlineMath", mathInlineId: "mixed-math", tex: String.raw`\mathit{x^5+3}`, quote: String.raw`$\mathit{x^5+3}$` });
    await page.reload();
    await expect.poll(savedAnchor).toMatchObject({ type: "inlineMath", tex: String.raw`\mathit{x^5+3}` });
    await expect(commentTarget.locator('.comment-text-highlight[data-comment-thread-id="range-after-math"]')).toHaveText("対象");
    await selectParagraph("paste-target");
    await page.locator('.page-flow [data-sigma-doc-id="paste-target"]').first().evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/html", String.raw`<p>前<span data-sigma-doc-math-inline="true" data-id="viewer-copy" data-tex="\boldsymbol{\mathit{w}}"></span>後</p>`);
      clipboardData.setData("text/plain", String.raw`前$\boldsymbol{\mathit{w}}$後`);
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    const pastedMath = page.locator('.page-flow [data-sigma-doc-id="paste-target"] .inline-math-node').first();
    await expect(pastedMath).toHaveAttribute("data-tex", String.raw`\boldsymbol{\mathit{w}}`);
    await pastedMath.evaluate((element) => {
      element.closest<HTMLElement>(".ProseMirror")!.focus();
      const range = window.document.createRange();
      range.selectNode(element);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      window.document.dispatchEvent(new Event("selectionchange"));
    });
    await tools.getByRole("button", { name: /太字/ }).click();
    await tools.getByRole("button", { name: /斜体/ }).click();
    const savedPaste = () => page.evaluate(async (id) => {
      const block = (await window.desktopAPI!.storage.loadDocument(id))?.content.find((block) => block.id === "paste-target");
      return block?.type === "paragraph" ? block.children.find((child) => child.type === "mathInline")?.tex : null;
    }, fileId);
    await expect.poll(savedPaste).toBe("w");
    await page.reload();
    await expect(pastedMath).toHaveAttribute("data-tex", "w");
    const paletteMath = page.locator('.page-flow [data-sigma-doc-id="math-only"] .inline-math-node').first();
    await paletteMath.dblclick();
    await page.getByRole("button", { name: "数式", exact: true }).first().hover();
    await page.getByRole("button", { name: "to", exact: true }).click();
    const savedPalette = () => page.evaluate(async (id) => {
      const block = (await window.desktopAPI!.storage.loadDocument(id))?.content.find((block) => block.id === "math-only");
      return block?.type === "paragraph" ? block.children.find((child) => child.type === "mathInline")?.tex : null;
    }, fileId);
    await expect.poll(savedPalette).toBe(String.raw`\boldsymbol{y^2\to}`);
    await page.reload();
    await expect(paletteMath).toHaveAttribute("data-tex", String.raw`\boldsymbol{y^2\to}`);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
