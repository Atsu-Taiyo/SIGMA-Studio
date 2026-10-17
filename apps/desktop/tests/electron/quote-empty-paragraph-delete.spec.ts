import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";

test("Backspace removes the empty paragraph after a quote without extending it, including after reload", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-quote-delete-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".workspace-tab-group")).toHaveCount(1);
    const source: SigmaDocument = {
      version: "2.0", docId: "code_quote_insert", metadata: { title: "コードと引用の下に追加" },
      content: [
        { type: "quote", id: "quote", blocks: [{ type: "paragraph", id: "quoted", children: [{ type: "text", text: "引用本文" }] }] },
        { type: "paragraph", id: "after", children: [] },
      ],
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
    const read = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
    const blank = page.locator('.page-flow [data-sigma-doc-id="after"]').first();
    await expect(blank).toBeVisible();
    await blank.click();
    await page.keyboard.press("Backspace");
    await expect.poll(async () => (await read())?.content.map(block => block.type)).toEqual(["quote"]);
    expect((await read())!.content[0]).toMatchObject({ ...source.content[0] });
    await page.keyboard.press("ControlOrMeta+Z");
    await expect.poll(async () => (await read())?.content.map(block => block.type)).toEqual(["quote", "paragraph"]);
    await blank.click();
    await page.keyboard.press("Backspace");
    await expect.poll(async () => (await read())?.content.map(block => block.type)).toEqual(["quote"]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".startup-splash")).toBeHidden();
    const saved = (await read())!;
    expect(saved.content).toHaveLength(1);
    expect(saved.content[0]).toMatchObject({ ...source.content[0] });
    await expect(page.locator('.page-flow [data-sigma-doc-id="quoted"]').first()).toHaveText("引用本文");
    await expect(page.locator('.page-flow [data-sigma-doc-id="after"]')).toHaveCount(0);
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
