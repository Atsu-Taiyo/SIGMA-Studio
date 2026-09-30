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
  await expect(promptArea).toHaveClass(/problem-frame--bracket/);
  await expect(page.getByTestId("problem-frame-style-cornerbox")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => problemFrameRenderMetrics(page)).toMatchObject({
    hasBracketClass: true,
    bracketArm: "18px",
    topBracketDrawn: true,
    bottomBracketDrawn: true,
  });
  await expect.poll(() => savedFrame(page)).toEqual({ enabled: true, styleId: "cornerbox" });

  // A frame the user drew: pick an example, and the same problem is drawn with it, saved with it,
  // and kept in the user's own list of borders.
  const tiles = page.locator('[data-testid^="problem-frame-library-"]');
  await expect(tiles).toHaveCount(0);
  await page.getByTestId("problem-frame-new").click();
  await expect(page.getByTestId("problem-custom-frame-editor")).toBeVisible();
  await page.getByTestId("problem-frame-preset-soft-round").click();
  await expect(promptArea).toHaveClass(/problem-frame--custom/);
  await expect(promptArea).toHaveAttribute("data-problem-frame-style", "custom");
  await expect.poll(() => customFrameRenderMetrics(page)).toMatchObject({
    borderImageDrawn: true,
    borderLeft: 16,
    borderTop: 16,
    paddingLeft: 12,
  });
  await expect.poll(async () => (await savedFrame(page))?.styleId).toBe("custom");
  await expect.poll(async () => (await savedFrame(page))?.custom?.svg ?? "").toContain("<svg");
  await expect(tiles).toHaveCount(1);
  const firstSvg = (await savedFrame(page))?.custom?.svg;

  // Thickness is a live control: the frame on the page follows it, and so does the saved border.
  await page.getByTestId("problem-custom-frame-thickness").fill("24");
  await expect.poll(() => customFrameRenderMetrics(page)).toMatchObject({ borderLeft: 24, borderTop: 24 });
  await expect.poll(async () => (await libraryEntries(page))[0]?.custom.borderPx).toBe(24);

  // Borders can be added one after another; each is its own entry.
  await page.getByTestId("problem-frame-new").click();
  await expect(page.getByTestId("problem-custom-frame-preview")).toHaveCount(0);
  await page.getByTestId("problem-frame-preset-double-diamond").click();
  await expect(tiles).toHaveCount(2);
  await expect.poll(async () => (await savedFrame(page))?.custom?.svg).not.toBe(firstSvg);
  await expect.poll(async () => (await libraryEntries(page)).map((entry) => entry.custom.svg === firstSvg)).toEqual([false, true]);

  // Picking an earlier one from the list puts it on this problem.
  const [, firstEntry] = await libraryEntries(page);
  await page.getByTestId(`problem-frame-library-${firstEntry.id}`).click();
  await expect.poll(async () => (await savedFrame(page))?.custom?.svg).toBe(firstSvg);
  await expect(page.getByTestId(`problem-frame-library-${firstEntry.id}`)).toHaveAttribute("aria-pressed", "true");

  // Choosing a built-in style and coming back keeps the drawing.
  await page.getByTestId("problem-frame-style-doublebox").click();
  await expect(promptArea).not.toHaveClass(/problem-frame--custom/);
  await page.getByTestId(`problem-frame-library-${firstEntry.id}`).click();
  await expect(promptArea).toHaveClass(/problem-frame--custom/);
  await expect.poll(() => customFrameRenderMetrics(page)).toMatchObject({ borderLeft: 24 });

  // It can be named.
  await page.getByTestId("problem-custom-frame-name").fill("桜の枠");
  await expect(page.getByTestId(`problem-frame-library-${firstEntry.id}`)).toContainText("桜の枠");

  // A drawing pasted as SVG replaces this entry's drawing; broken markup is reported and changes nothing.
  const svgField = page.getByTestId("problem-custom-frame-svg");
  await svgField.fill("<p>not a drawing</p>");
  await expect(page.getByRole("alert")).toContainText("SVG");
  await expect.poll(async () => (await savedFrame(page))?.custom?.svg).toBe(firstSvg);
  await svgField.fill('<svg viewBox="0 0 100 60"><rect x="2" y="2" width="96" height="56" fill="none" stroke="#c2410c" stroke-width="4"/></svg>');
  await expect.poll(async () => (await savedFrame(page))?.custom?.width).toBe(100);
  await expect.poll(async () => (await libraryEntries(page)).find((entry) => entry.id === firstEntry.id)?.custom.width).toBe(100);
  await expect(tiles).toHaveCount(2);

  // Deleting it from the list leaves the frame on the problem that uses it.
  await page.getByTestId("problem-custom-frame-delete").click();
  await expect(tiles).toHaveCount(1);
  await expect(promptArea).toHaveClass(/problem-frame--custom/);
  await expect(page.getByTestId("problem-custom-frame-save")).toBeVisible();
});

async function libraryEntries(page: Page): Promise<Array<{ id: string; name: string; custom: { svg: string; width: number; borderPx: number } }>> {
  return page.evaluate(() => JSON.parse(window.localStorage.getItem("sigma-studio:problem-frame-library") ?? "[]"));
}

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
  hasBracketClass: boolean;
  bracketArm: string;
  topBracketDrawn: boolean;
  bottomBracketDrawn: boolean;
}> {
  return page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('[data-problem-area="prompt"][data-problem-id="problem_frame_e2e"]');
    if (!area) {
      throw new Error("problem prompt area not found");
    }

    return {
      hasBracketClass: area.classList.contains("problem-frame--bracket"),
      bracketArm: getComputedStyle(area).getPropertyValue("--problem-bracket-arm").trim(),
      topBracketDrawn: getComputedStyle(area, "::before").backgroundImage.includes("linear-gradient"),
      bottomBracketDrawn: getComputedStyle(area, "::after").backgroundImage.includes("linear-gradient"),
    };
  });
}

async function customFrameRenderMetrics(page: Page): Promise<{
  borderImageDrawn: boolean;
  borderLeft: number;
  borderTop: number;
  paddingLeft: number;
}> {
  return page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('[data-problem-area="prompt"][data-problem-id="problem_frame_e2e"]');
    if (!area) {
      throw new Error("problem prompt area not found");
    }

    const style = getComputedStyle(area);
    return {
      borderImageDrawn: style.borderImageSource.startsWith("url("),
      borderLeft: Number.parseFloat(style.borderLeftWidth),
      borderTop: Number.parseFloat(style.borderTopWidth),
      paddingLeft: Number.parseFloat(style.paddingLeft),
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
