import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SigmaDocument } from "@/features/document";

const COMMENTED_TEX = String.raw`[2468+\dots % ]_0^1` + "\n" + String.raw`]_0^1`;

test("commented evaluation formulas survive native save, restart, preview and PDF", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-evaluation-brackets-"));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    NODE_ENV: "development", SIGMA_STUDIO_USER_DATA_DIR: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const launch = async () => {
    app = await electron.launch({ args: [root], cwd: root, env, chromiumSandbox: true });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    return page;
  };
  try {
    let page = await launch();
    const source: SigmaDocument = {
      version: "2.0", docId: "evaluation_brackets", metadata: { title: "コメント付き数式" },
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
      content: [
        { type: "paragraph", id: "comment_line", children: [
          { type: "mathInline", id: "commented_evaluation", tex: COMMENTED_TEX, display: "inline" },
        ] },
        { type: "paragraph", id: "control_line", children: [
          { type: "mathInline", id: "plain_evaluation", tex: "[x^3+x]_0^1", display: "inline" },
        ] },
      ],
    };
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, source);
    await page.reload();
    const assertFormula = async () => {
      const math = page.locator('.page-flow [data-id="commented_evaluation"]').first();
      await expect(math.locator(".katex")).toBeVisible();
      await expect(math.locator(".ML__error")).toHaveCount(0);
      const control = page.locator('.page-flow [data-id="plain_evaluation"]').first();
      await expect(control).toBeVisible();
      await expect(control.locator(".ML__error")).toHaveCount(0);
    };
    const savedTex = () => page.evaluate(async id => {
      const document = await window.desktopAPI!.storage.loadDocument(id);
      const block = document?.content.find(block => block.type === "paragraph" && block.id === "comment_line");
      return block?.type === "paragraph" ? block.children.find(node => node.type === "mathInline")?.tex : undefined;
    }, fileId);
    await assertFormula();
    await page.keyboard.press("ControlOrMeta+KeyS");
    await expect.poll(savedTex).toBe(COMMENTED_TEX);
    await app!.close(); app = undefined;
    page = await launch();
    await assertFormula();
    expect(await savedTex()).toBe(COMMENTED_TEX);

    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "エクスポート" }).hover();
    await page.getByRole("menuitem", { name: "PDFを書き出し" }).click();
    const preview = page.getByRole("dialog", { name: "PDFプレビュー", exact: true });
    await expect(preview.locator('.paged-surface[data-paged-surface-state="ready"]')).toBeVisible();
    await expect(preview.locator('[data-id="commented_evaluation"] .katex').first()).toBeVisible();
    const output = testInfo.outputPath("commented-evaluation.pdf");
    await app!.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
    await preview.getByRole("button", { name: "PDF保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "PDFを保存しました" })).toBeVisible({ timeout: 60_000 });
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: Uint8Array.from(await readFile(output)), verbosity: 0 });
    try {
      const pdf = await loading.promise;
      const items = (await (await pdf.getPage(1)).getTextContent()).items.filter(item => "str" in item);
      expect(items.map(item => item.str).join("")).toContain("2468");
    } finally { await loading.destroy(); }
    expect(await savedTex()).toBe(COMMENTED_TEX);
    await page.screenshot({ path: testInfo.outputPath("commented-evaluation.png") });
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
