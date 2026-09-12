import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { SigmaDocument, ParagraphNode, ProblemNode } from "@/types/sigma-doc";

test("inserts native boxes in problem text and solution independently from the problem frame", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument());

  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  const promptBlock = page.locator('[data-problem-area="prompt"][data-problem-id="problem_frame_e2e"] [data-sigma-doc-id="problem_prompt_frame_e2e"]').first();
  const promptArea = page.locator('[data-problem-area="prompt"][data-problem-id="problem_frame_e2e"]').first();

  await expect(promptBlock).toBeVisible();
  await promptBlock.click();
  await page.keyboard.type("/doublebox");
  await expect(page.locator(".slash-command-popover")).toContainText("doublebox");
  await page.keyboard.press("Enter");

  await expect(promptArea.locator('.sigma-doc-box-block[data-box-style="doublebox"]')).toHaveCount(1);
  await expect(promptArea).not.toHaveClass(/with-frame/);
  await expect.poll(() => savedProblemState(page)).toMatchObject({
    frame: null,
    promptTypes: ["boxBlock"],
    promptBoxStyleIds: ["doublebox"],
    solutionTypes: ["paragraph"],
  });

  const solutionBlock = page.locator(
    '[data-problem-area="solution"][data-problem-id="problem_frame_e2e"] [data-sigma-doc-id="problem_solution_frame_e2e"]',
  ).first();
  const solutionArea = page.locator(
    '[data-problem-area="solution"][data-problem-id="problem_frame_e2e"]',
  ).first();
  await solutionBlock.click();
  await page.keyboard.type("/cornerbox");
  await expect(page.locator(".slash-command-popover")).toContainText("cornerbox");
  await page.keyboard.press("Enter");

  await expect(solutionArea.locator('.sigma-doc-box-block[data-box-style="cornerbox"]')).toHaveCount(1);
  await expect.poll(() => savedProblemState(page)).toMatchObject({
    frame: null,
    promptTypes: ["boxBlock"],
    promptBoxStyleIds: ["doublebox"],
    solutionTypes: ["boxBlock"],
    solutionBoxStyleIds: ["cornerbox"],
  });

  await promptArea.hover();
  const problemAction = promptArea.getByRole("button", { name: "問題操作" });
  await expect(problemAction).toBeVisible();
  await problemAction.click();
  const problemMenu = page.getByRole("menu", { name: "問題操作" });
  await expect(problemMenu).toBeVisible();
  await problemMenu.getByRole("menuitem", { name: "問題の設定…" }).click();
  await expect(page.getByRole("dialog", { name: "問題設定" })).toBeVisible();
  await expect(page.getByTestId("problem-frame-style-cornerbox")).toBeVisible();
  await page.getByTestId("problem-frame-style-cornerbox").click();

  await expect(promptArea).toHaveAttribute("data-problem-frame-style", "cornerbox");
  await expect(promptArea).toHaveClass(/box-frame--corner/);
  await expect(promptArea).toHaveClass(/corner-frame/);
  await expect(page.getByTestId("problem-frame-style-cornerbox")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => problemFrameRenderMetrics(page)).toMatchObject({
    hasBoxFrameCornerClass: true,
    hasCornerFrameClass: true,
    guideInsetToken: "clamp(12px, 6cqi, 24px)",
  });
  await expect.poll(() => savedFrame(page)).toEqual({ enabled: true, styleId: "cornerbox" });
});

async function savedProblemState(page: Page): Promise<{
  frame: ProblemNode["frame"] | null;
  promptTypes: string[];
  promptBoxStyleIds: string[];
  solutionTypes: string[];
  solutionBoxStyleIds: string[];
}> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) as SigmaDocument : null;
    const problem = document?.content.find(
      (block): block is ProblemNode => block.type === "problem" && block.id === "problem_frame_e2e",
    );
    const prompt = problem?.prompt ?? [];
    const solution = problem?.solution ?? [];
    return {
      frame: problem?.frame ?? null,
      promptTypes: prompt.map((block) => block.type),
      promptBoxStyleIds: prompt.flatMap((block) => block.type === "boxBlock" ? [block.styleId] : []),
      solutionTypes: solution.map((block) => block.type),
      solutionBoxStyleIds: solution.flatMap((block) => block.type === "boxBlock" ? [block.styleId] : []),
    };
  });
}

async function savedFrame(page: Page): Promise<ProblemNode["frame"] | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return null;
    }

    const document = JSON.parse(raw) as SigmaDocument;
    const problem = document.content.find((block): block is ProblemNode => block.type === "problem" && block.id === "problem_frame_e2e");
    return problem?.frame ?? null;
  });
}

async function problemFrameRenderMetrics(page: Page): Promise<{
  beforeBackgroundImage: string;
  guideInsetToken: string;
  hasBoxFrameCornerClass: boolean;
  hasCornerFrameClass: boolean;
}> {
  return page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('[data-problem-area="prompt"][data-problem-id="problem_frame_e2e"]');
    if (!area) {
      throw new Error("problem prompt area not found");
    }

    const beforeStyle = getComputedStyle(area, "::before");
    return {
      beforeBackgroundImage: beforeStyle.backgroundImage,
      guideInsetToken: beforeStyle.getPropertyValue("--corner-frame-guide-inset-x").trim(),
      hasBoxFrameCornerClass: area.classList.contains("box-frame--corner"),
      hasCornerFrameClass: area.classList.contains("corner-frame"),
    };
  });
}

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "problem_frame_style_e2e_doc",
    metadata: { title: "問題枠スタイル E2E" },
    content: [{
      type: "problem",
      id: "problem_frame_e2e",
      tags: [],
      lead: [],
      prompt: [paragraph("problem_prompt_frame_e2e", "")],
      solution: [paragraph("problem_solution_frame_e2e", "")],
      hints: [],
    }],
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}
