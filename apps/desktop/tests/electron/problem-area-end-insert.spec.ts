import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";

/**
 * 問題のコメントの末尾 (最後が箱) の ＋ で足した段落が、保存・再読み込みの後もコメントの中に残る
 * (Issue #203)。問題の外や解答には入らない。
 */
test("plus at the end of a comment adds a paragraph that stays in the comment after reload", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-problem-area-end-insert-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    const source: SigmaDocument = {
      version: "2.0", docId: "problem_area_end_insert", metadata: { title: "コメントの末尾に追加" },
      content: [
        {
          type: "problem", id: "prob", tags: [], lead: [],
          prompt: [{ type: "paragraph", id: "prompt", children: [{ type: "text", text: "問題文" }] }],
          hints: [
            { type: "paragraph", id: "hint", children: [{ type: "text", text: "コメント" }] },
            { type: "boxBlock", id: "hint_box", styleId: "fancybox", title: [{ type: "text", text: "ポイント" }], blocks: [{ type: "paragraph", id: "in_box", children: [{ type: "text", text: "箱の中" }] }] },
          ],
          solution: [{ type: "paragraph", id: "solution", children: [{ type: "text", text: "解答" }] }],
        },
        { type: "paragraph", id: "after", children: [{ type: "text", text: "問題の後" }] },
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
    const hintsOf = (document: SigmaDocument | null | undefined) => {
      const problem = document?.content.find(block => block.id === "prob");
      return problem?.type === "problem" ? problem.hints : [];
    };

    const box = page.locator('.page-flow [data-sigma-doc-id="hint_box"]').first();
    await expect(box).toBeVisible();
    const rect = (await box.boundingBox())!;
    await page.mouse.move(rect.x + 60, rect.y + rect.height - 24);
    await page.mouse.move(rect.x + 60, rect.y + rect.height - 3);
    const plus = page.locator(".page-block-insert-button");
    await expect(plus).toBeVisible();
    await plus.click();
    await page.keyboard.type("追記");
    await expect.poll(async () => hintsOf(await read()).map(block => block.type)).toEqual(["paragraph", "boxBlock", "paragraph"]);
    await expect.poll(async () => {
      const last = hintsOf(await read()).at(-1);
      return last?.type === "paragraph" ? last.children.map(child => child.type === "text" ? child.text : "").join("") : null;
    }).toBe("追記");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".startup-splash")).toBeHidden();
    const saved = (await read())!;
    expect(saved.content.map(block => block.id)).toEqual(["prob", "after"]);
    const problem = saved.content[0];
    expect(problem.type === "problem" && problem.prompt.map(block => block.id)).toEqual(["prompt"]);
    expect(problem.type === "problem" && problem.solution.map(block => block.id)).toEqual(["solution"]);
    const added = hintsOf(saved).at(-1)!;
    await expect(page.locator(`[data-problem-id="prob"][data-problem-area="hints"] [data-sigma-doc-id="${added.id}"]`).first()).toContainText("追記");
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
