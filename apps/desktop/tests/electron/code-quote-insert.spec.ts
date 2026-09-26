import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";

test("plus inserts a normal paragraph outside code and quote blocks and persists it", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-code-quote-insert-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    const source: SigmaDocument = {
      version: "2.0", docId: "code_quote_insert", metadata: { title: "コードと引用の下に追加" },
      content: [
        { type: "codeBlock", id: "code", language: "javascript", children: [{ type: "text", text: "const answer = 42;" }] },
        { type: "quote", id: "quote", blocks: [{ type: "paragraph", id: "quoted", children: [{ type: "text", text: "引用本文" }] }] },
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
    for (const [index, id] of ["code", "quote"].entries()) {
      const block = page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
      await expect(block).toBeVisible();
      const box = (await block.boundingBox())!;
      await page.mouse.move(box.x + 40, box.y + box.height - 2);
      const plus = page.locator(".page-block-insert-button");
      await expect(plus).toBeVisible();
      await plus.click();
      await expect.poll(async () => (await read())?.content.map(block => block.type)).toEqual(
        index === 0 ? ["codeBlock", "paragraph", "quote"] : ["codeBlock", "paragraph", "quote", "paragraph"],
      );
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".startup-splash")).toBeHidden();
    const saved = (await read())!;
    expect(saved.content.map(block => block.type)).toEqual(["codeBlock", "paragraph", "quote", "paragraph"]);
    expect(saved.content[0]).toMatchObject({ ...source.content[0] });
    expect(saved.content[2]).toMatchObject({ ...source.content[1] });
    for (const block of saved.content) await expect(page.locator(`.page-flow [data-sigma-doc-id="${block.id}"]`).first()).toBeVisible();
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
