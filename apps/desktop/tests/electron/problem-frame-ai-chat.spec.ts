import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { ensurePageLayout } from "@/features/document";
import type { ParagraphNode, ProblemNode, SigmaDocument } from "@/types/sigma-doc";

const APP_ROOT = path.resolve(__dirname, "../..");
const FRAME_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect x="3" y="3" width="154" height="94" fill="none" stroke="#c2185b" stroke-width="4"/></svg>';

/**
 * Only the AI itself is replaced (a main-process handler that streams thinking and a reply on a
 * timer, so the run is long enough to close the dialog in the middle of it, and reports whether
 * anything was asked of it). The connection state, the bridge, the dialog, the store, the document
 * and the file it is saved to are the real ones. `_invokeHandlers` is Electron's own handler table.
 */
async function replaceAi(app: ElectronApplication, svg: string) {
  await app.evaluate(({ ipcMain }, drawing) => {
    ipcMain.removeHandler("claude:get-status");
    ipcMain.handle("claude:get-status", () => ({
      available: true, running: false, loggedIn: true, claudeBin: "claude", configuredClaudeBin: null,
      account: { apiKeySource: "none" }, error: null,
    }));
    const calls: unknown[] = [];
    (globalThis as { __frameAiCalls?: unknown[] }).__frameAiCalls = calls;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    ipcMain.removeHandler("ai-skill-draft:generate");
    ipcMain.handle("ai-skill-draft:generate", async (event, runId: string, payload: unknown) => {
      calls.push(payload);
      const channel = `ai-skill-draft:event:${runId}`;
      event.sender.send(channel, { kind: "reasoning", text: "四隅に小さな花びらを置き、" });
      await sleep(700);
      event.sender.send(channel, { kind: "reasoning", text: "辺は単純な直線にします。" });
      await sleep(700);
      event.sender.send(channel, { kind: "delta", text: "赤紫の細い枠にしました。\n<svg" });
      await sleep(1200);
      return { ok: true, text: drawing, message: "赤紫の細い枠にしました。" };
    });
  }, svg);
}

test("the AI frame chat keeps drawing after the dialog is closed, tells when it is done, and saves the frame it is given", async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-problem-frame-ai-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    // After the window exists: the real handlers are registered by then, and can be swapped out.
    await replaceAi(app, FRAME_SVG);
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    const created = await page.evaluate(
      (document) => window.desktopAPI!.storage.createFileFromDocument({ document }),
      createDocument(),
    );
    await page.reload();
    const prompt = page.locator('[data-problem-area="prompt"][data-problem-id="problem_ai_frame"]').first();
    await expect(prompt).toBeVisible();

    const openProblemSettings = async () => {
      await prompt.hover();
      await prompt.getByRole("button", { name: "問題操作" }).click();
      await page.getByRole("menu", { name: "問題操作" }).getByRole("menuitem", { name: "問題の設定…" }).click();
    };
    const settings = page.getByRole("dialog", { name: "問題設定" });

    // 1. The chat already has the AI's first question in it.
    await openProblemSettings();
    await page.getByTestId("problem-frame-new").click();
    await settings.getByRole("tab", { name: "AIで描く" }).click();
    await expect(settings.getByTestId("problem-custom-frame-ai-greeting")).toContainText("どんな枠線にしますか？");

    // 2. Answering in the chat input sends it; the thinking and the reply stream in.
    await settings.getByTestId("problem-custom-frame-ai-prompt").fill("赤紫の細い枠");
    await settings.getByTestId("problem-custom-frame-ai-prompt").press("Enter");
    await expect(settings.getByTestId("problem-custom-frame-ai-log")).toContainText("赤紫の細い枠");
    await expect(settings.getByTestId("problem-custom-frame-ai-reasoning")).toContainText("四隅に小さな花びらを置き、");
    await expect(settings.getByTestId("problem-custom-frame-ai-reasoning")).toContainText("辺は単純な直線にします。");
    await expect(settings.getByTestId("problem-custom-frame-ai-log")).toContainText("赤紫の細い枠にしました。");
    await expect(settings.getByTestId("problem-custom-frame-ai-stop")).toBeVisible();

    // 3. Closing the dialog does not stop it.
    await settings.getByRole("button", { name: "閉じる" }).click();
    await expect(settings).toBeHidden();
    await expect.poll(() => app.evaluate(() => (globalThis as { __frameAiCalls?: unknown[] }).__frameAiCalls?.length)).toBe(1);
    // Work in progress stays visible, with a way to stop it, while nobody has the conversation open.
    const busy = page.getByTestId("problem-custom-frame-ai-busy");
    await expect(busy).toBeVisible();

    // 4. When it is done, a dialog says so, with the frame on show. The problem is not touched yet.
    const notice = page.getByRole("dialog", { name: "枠を描き終えました" });
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(busy).toBeHidden();
    await expect(notice).toContainText("赤紫の細い枠にしました。");
    await expect(notice.locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml/);
    await expect(prompt).not.toHaveClass(/problem-frame--custom/);

    // 5. Using it puts it on the problem, and the real bridge saves it with the file.
    await notice.getByTestId("problem-custom-frame-ai-notice-use").click();
    await expect(notice).toBeHidden();
    await expect(prompt).toHaveClass(/problem-frame--custom/);
    await expect.poll(async () => {
      const saved = await page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId), created.file.fileId);
      const problem = saved?.content.find((block): block is ProblemNode => block.type === "problem");
      return { styleId: problem?.frame?.styleId, width: problem?.frame?.custom?.width, hasSvg: Boolean(problem?.frame?.custom?.svg) };
    }, { timeout: 15_000 }).toEqual({ styleId: "custom", width: 160, hasSvg: true });

    // 6. The conversation is still there when the dialog is opened again, and says which frame is in use.
    await openProblemSettings();
    await settings.getByRole("tab", { name: "AIで描く" }).click();
    await expect(settings.getByTestId("problem-custom-frame-ai-log")).toContainText("赤紫の細い枠");
    await expect(settings.getByTestId("problem-custom-frame-ai-in-use")).toBeVisible();

    // 7. A follow-up reworks that drawing and sends the earlier request along.
    await settings.getByTestId("problem-custom-frame-ai-prompt").fill("もっと細く");
    await settings.getByTestId("problem-custom-frame-ai-generate").click();
    await expect.poll(() => app.evaluate(() => (globalThis as { __frameAiCalls?: unknown[] }).__frameAiCalls?.length)).toBe(2);
    const calls = await app.evaluate(() => (globalThis as { __frameAiCalls?: Array<{ prompt: string; purpose: string; context: { currentContent: string; history: string[] } }> }).__frameAiCalls);
    expect(calls?.[1]).toMatchObject({ prompt: "もっと細く", purpose: "problemFrame", context: { history: ["赤紫の細い枠"] } });
    expect(calls?.[1].context.currentContent).toContain("<svg");
    // ...and while the dialog is open, the new drawing lands on the problem without a notice:
    // the latest one is the frame in use, the earlier one can be taken again.
    await expect(settings.getByTestId("problem-custom-frame-ai-drawing")).toHaveCount(2, { timeout: 15_000 });
    await expect(settings.getByTestId("problem-custom-frame-ai-in-use")).toHaveCount(1);
    await expect(settings.getByTestId("problem-custom-frame-ai-use")).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: "枠を描き終えました" })).toBeHidden();
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

function createDocument(): SigmaDocument {
  return ensurePageLayout({
    version: "2.0",
    docId: "problem_ai_frame_doc",
    metadata: { title: "AIで描く問題枠" },
    content: [{
      type: "problem",
      id: "problem_ai_frame",
      tags: [],
      lead: [],
      prompt: [paragraph("problem_ai_frame_prompt", "方程式 x² + 2x + 1 = 0 を解きなさい。")],
      solution: [],
      hints: [],
      frame: { enabled: true, styleId: "fancybox" },
    }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  });
}

function paragraph(id: string, text: string): ParagraphNode {
  return { id, type: "paragraph", children: [{ type: "text", text }] };
}
