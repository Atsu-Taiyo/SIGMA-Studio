import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { ensurePageLayout } from "@/features/document";
import type { ParagraphNode, ProblemNode, SigmaDocument } from "@/types/sigma-doc";

const APP_ROOT = path.resolve(__dirname, "../..");

/**
 * A problem frame the user drew has to survive what a unit test cannot exercise: the real
 * bridge saving the file, the file being read back, and the frame being drawn again after a reload.
 */
test("a hand-drawn problem frame is saved with the file and drawn again after reload", async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-problem-custom-frame-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    const created = await page.evaluate(
      (document) => window.desktopAPI!.storage.createFileFromDocument({ document }),
      createDocument(),
    );
    await page.reload();
    const prompt = page.locator('[data-problem-area="prompt"][data-problem-id="problem_custom_frame"]').first();
    await expect(prompt).toBeVisible();

    await prompt.hover();
    await prompt.getByRole("button", { name: "問題操作" }).click();
    await page.getByRole("menu", { name: "問題操作" }).getByRole("menuitem", { name: "問題の設定…" }).click();
    await page.getByTestId("problem-frame-new").click();
    await page.getByTestId("problem-frame-preset-double-diamond").click();
    await page.getByTestId("problem-custom-frame-thickness").fill("22");
    await expect(prompt).toHaveClass(/problem-frame--custom/);
    await expect.poll(() => frameMetrics(page)).toMatchObject({ imageDrawn: true, borderLeft: 22, borderTop: 22 });

    // Saved by the real bridge: the drawing is in the file, not only on screen.
    await expect.poll(async () => {
      const saved = await page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId), created.file.fileId);
      const problem = saved?.content.find((block): block is ProblemNode => block.type === "problem");
      return { styleId: problem?.frame?.styleId, borderPx: problem?.frame?.custom?.borderPx, hasSvg: Boolean(problem?.frame?.custom?.svg) };
    }, { timeout: 15_000 }).toEqual({ styleId: "custom", borderPx: 22, hasSvg: true });

    await page.reload();
    await expect(prompt).toBeVisible();
    await expect(prompt).toHaveClass(/problem-frame--custom/);
    await expect.poll(() => frameMetrics(page)).toMatchObject({ imageDrawn: true, borderLeft: 22, borderTop: 22 });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

async function frameMetrics(page: Page): Promise<{ imageDrawn: boolean; borderLeft: number; borderTop: number }> {
  return page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('[data-problem-area="prompt"][data-problem-id="problem_custom_frame"]');
    if (!area) throw new Error("problem prompt area not found");
    const style = getComputedStyle(area);
    return {
      imageDrawn: style.borderImageSource.startsWith("url("),
      borderLeft: Number.parseFloat(style.borderLeftWidth),
      borderTop: Number.parseFloat(style.borderTopWidth),
    };
  });
}

function createDocument(): SigmaDocument {
  return ensurePageLayout({
    version: "2.0",
    docId: "problem_custom_frame_doc",
    metadata: { title: "自作の問題枠" },
    content: [{
      type: "problem",
      id: "problem_custom_frame",
      tags: [],
      lead: [],
      prompt: [paragraph("problem_custom_frame_prompt", "方程式 x² + 2x + 1 = 0 を解きなさい。")],
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
