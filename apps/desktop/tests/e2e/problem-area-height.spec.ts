import { expect, test } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const PROBLEM_HEIGHT_DOCUMENT = {
  version: "2.0",
  docId: "doc_e2e_problem_area_height",
  metadata: { title: "問題の縦幅 e2e" },
  content: [
    {
      type: "problem",
      id: "problem_height_1",
      tags: [],
      lead: [],
      prompt: [
        {
          type: "paragraph",
          id: "p_problem_height_prompt",
          children: [{ type: "text", text: "ここだけが問題文の入力行" }],
        },
      ],
      solution: [],
      hints: [],
      areaLayout: {
        prompt: { minHeightMm: 55 },
      },
      numbering: {
        enabled: true,
        value: 1,
      },
    },
  ],
  outputProfiles: {
    student: {},
    teacher: { showSolutions: true, showHints: true },
    answerBook: { includeAnswers: true, onlySolutions: true },
  },
};

test.beforeEach(async ({ page }) => {
  await installDesktopRuntimeMock(page, PROBLEM_HEIGHT_DOCUMENT as SigmaDocument);
});

test("reserved problem height does not become an editable text area", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  const promptArea = page.locator('[data-problem-area="prompt"][data-problem-id="problem_height_1"]');
  const editorShell = promptArea.locator(".text-flow-shell").first();
  await expect(promptArea).toBeVisible();
  await expect(editorShell).toBeVisible();

  const areaBox = await promptArea.boundingBox();
  const shellBox = await editorShell.boundingBox();
  expect(areaBox).not.toBeNull();
  expect(shellBox).not.toBeNull();
  expect(areaBox!.height).toBeGreaterThan(shellBox!.height + 120);

  await editorShell.click();
  await page.keyboard.insertText(" 編集可能");
  await expect(promptArea).toContainText("編集可能");

  const refreshedAreaBox = await promptArea.boundingBox();
  const refreshedShellBox = await editorShell.boundingBox();
  expect(refreshedAreaBox).not.toBeNull();
  expect(refreshedShellBox).not.toBeNull();

  const reservedTop = refreshedShellBox!.y + refreshedShellBox!.height;
  const reservedBottom = refreshedAreaBox!.y + refreshedAreaBox!.height;
  expect(reservedBottom).toBeGreaterThan(reservedTop + 80);

  await page.mouse.click(
    refreshedAreaBox!.x + refreshedAreaBox!.width * 0.72,
    reservedTop + (reservedBottom - reservedTop) / 2,
  );
  await expect
    .poll(async () => page.evaluate(() => Boolean(document.activeElement?.closest(".text-flow-editor"))))
    .toBe(false);

  await page.keyboard.insertText(" SHOULD_NOT_APPEAR");
  await expect(promptArea).not.toContainText("SHOULD_NOT_APPEAR");

  const saved = await page.evaluate(() => window.localStorage.getItem("sigma-studio:e2e-document") ?? "");
  expect(saved).not.toContain("SHOULD_NOT_APPEAR");
});
