import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { SigmaDocument } from "@/features/document";

for (const fontSize of [10, 18]) {
  test(`Enter draws the empty caret line at ${fontSize}pt before typing`, async () => {
    const root = path.resolve(__dirname, "../..");
    const profile = await mkdtemp(path.join(tmpdir(), "sigma-empty-line-size-"));
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      SIGMA_STUDIO_USER_DATA_DIR: profile,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
    const app = await electron.launch({ args: [root], cwd: root, env });
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => Boolean(window.desktopAPI));
      await expect(page.locator(".startup-splash")).toBeHidden();
      await expect(page.locator(".workspace-tab-group")).toHaveCount(1);
      const source: SigmaDocument = {
        version: "2.0", docId: `empty_line_size_${fontSize}`, metadata: { title: "改行後のキャレット", styleUnits: { fontSize: "pt" } },
        content: [{ type: "paragraph", id: "body", children: [
          { type: "text", text: "先頭", fontSize: 24 },
          { type: "text", text: "本文", fontSize },
        ] }],
        outputProfiles: { student: {}, teacher: {}, answerBook: {} },
      };
      const fileId = await page.evaluate(async document => {
        localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
        await window.desktopAPI!.settings!.setUiLocale!("ja");
        const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
        await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
        return created.file.fileId;
      }, source);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator(".startup-splash")).toBeHidden();
      const body = page.locator('.page-flow [data-sigma-doc-id="body"]').first();
      await expect(body).toBeVisible();
      await body.evaluate(element => {
        const host = element.closest(".ProseMirror") as HTMLElement & { editor: Editor };
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let last: Node | null = null;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent?.length) last = node;
        }
        if (!last) throw new Error("Missing final text run");
        host.editor.commands.setTextSelection(host.editor.view.posAtDOM(last, last.textContent!.length));
        host.editor.view.focus();
      });
      await page.keyboard.press("Enter");
      const caretGeometry = () => page.evaluate(() => {
        const host = document.activeElement as HTMLElement & { editor?: Editor };
        const editor = host.editor;
        if (!editor) return null;
        const { $from, empty } = editor.state.selection;
        const block = editor.view.nodeDOM($from.before()) as HTMLElement;
        // coordsAtPos can read the zero-height formatting widget before the trailing BR.
        // The BR's glyph box uses the same inherited font as the native empty-line caret.
        const rect = block.querySelector("br.ProseMirror-trailingBreak")?.getBoundingClientRect();
        return {
          empty: empty && $from.parent.content.size === 0,
          fontSize: Number.parseFloat(getComputedStyle(block).fontSize) * 3 / 4,
          emptyLineGlyphHeight: rect?.height ?? 0,
          lineHeight: Number.parseFloat(getComputedStyle(block).lineHeight),
          pendingSize: editor.getAttributes("styledText").fontSize,
        };
      });
      await expect.poll(async () => (await caretGeometry())?.fontSize).toBeCloseTo(fontSize, 2);
      const first = (await caretGeometry())!;
      await page.screenshot({ path: test.info().outputPath("empty-caret.png"), caret: "initial" });
      expect(first.empty).toBe(true);
      expect(first.pendingSize).toBe(fontSize);
      expect(first.emptyLineGlyphHeight).toBeGreaterThan(0);
      expect(first.lineHeight / (fontSize * 4 / 3)).toBeLessThan(2);
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await caretGeometry())?.fontSize).toBeCloseTo(fontSize, 2);
      expect((await caretGeometry())!.emptyLineGlyphHeight).toBeCloseTo(first.emptyLineGlyphHeight, 1);
      await page.keyboard.type("continued");
      const read = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
      await expect.poll(async () => (await read())?.content.at(-1)).toMatchObject({
        type: "paragraph", children: [{ type: "text", text: "continued", fontSize }],
      });
      const saved = (await read())!;
      expect(saved.content[0]).toEqual(source.content[0]);
      expect(saved.content[1]).toMatchObject({ type: "paragraph", children: [] });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator(".startup-splash")).toBeHidden();
      await expect(page.locator(`.page-flow [data-sigma-doc-id="${saved.content.at(-1)!.id}"]`).first()).toHaveText("continued");
      expect((await read())!.content).toEqual(saved.content);
    } finally {
      try { await app.close(); }
      finally { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    }
  });
}
