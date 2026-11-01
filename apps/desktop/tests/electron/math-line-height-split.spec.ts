import type { Editor } from "@tiptap/core";
import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SigmaDocument } from "@/features/document";

test("an Enter consumed by another handler cannot change a later split's saved line height", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-math-line-height-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const source: SigmaDocument = {
      version: "2.0", docId: "math_line_height",
      metadata: { title: "数式行の改行" },
      content: [{ type: "paragraph", id: "math_line", lineHeight: "3", children: [
        { type: "mathInline", id: "m1", tex: "\\frac{1}{2}", display: "inline" },
        { type: "text", text: "本文" },
      ] }],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    };
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, source);
    await page.reload();
    const paragraph = page.locator('.page-flow [data-sigma-doc-id="math_line"]').first();
    await expect(paragraph).toBeVisible();
    await paragraph.evaluate(el => {
      const editor = (el.closest(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
      editor.commands.focus();
      editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize - 1);
      // Menus and other key handlers can consume Enter without changing the document.
      editor.setOptions({ editorProps: { ...editor.options.editorProps, handleKeyDown: () => true } });
    });
    await page.keyboard.press("Enter");
    await paragraph.evaluate(el => {
      const editor = (el.closest(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
      editor.commands.splitBlock();
      editor.commands.insertContent("次の行");
    });
    const savedHeights = () => page.evaluate(async id => {
      const doc = await window.desktopAPI!.storage.loadDocument(id);
      return doc?.content.map(block => block.type === "paragraph" ? block.lineHeight ?? null : block.type);
    }, fileId);
    await expect.poll(savedHeights).toEqual(["3", "3"]);
    await page.reload();
    await expect(paragraph).toBeVisible();
    await expect(page.locator(".page-flow")).toContainText("次の行");
    expect(await savedHeights()).toEqual(["3", "3"]);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
