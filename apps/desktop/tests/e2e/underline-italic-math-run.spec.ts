import { expect, test } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { SigmaDocument } from "@/types/sigma-doc";

// Regression: italic on surrounding 和文 used to nest *outside* underline, so
// ProseMirror closed the underline span at every em boundary. Text runs kept
// baseline text-decoration while math runs (sa^2, ∑) used the bottom border —
// stepped underlines. ∑ looked fine in isolation; ^2 next to italic text did not.
test("italic CJK + sa^2 + sum share one continuous underline run", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await installDesktopRuntimeMock(page, createUserUnderlineDoc());
  await page.goto("/");
  await expect(page.getByText("準備完了")).toBeVisible();

  const paragraph = page.locator('[data-sigma-doc-id="p_ul_user"]');
  await expect(paragraph).toBeVisible();

  const info = await page.evaluate(() => {
    const p = document.querySelector<HTMLElement>('[data-sigma-doc-id="p_ul_user"]');
    if (!p) {
      throw new Error("missing paragraph");
    }
    const runs = Array.from(p.querySelectorAll<HTMLElement>(".sigma-underline-run"));
    const maths = Array.from(p.querySelectorAll<HTMLElement>(".inline-math-node"));
    return {
      runCount: runs.length,
      emInsideRun: runs[0]?.querySelectorAll("em").length ?? 0,
      emWrappingRun: p.querySelectorAll("em > .sigma-underline-run").length,
      run: runs.map((r) => {
        const s = getComputedStyle(r);
        const rect = r.getBoundingClientRect();
        return {
          text: r.textContent?.replace(/\s+/g, "").slice(0, 40),
          hasMath: !!r.querySelector(".math-preview"),
          display: s.display,
          decoration: s.textDecorationLine,
          borderBottomWidth: parseFloat(s.borderBottomWidth) || 0,
          lineY: rect.bottom - (parseFloat(s.borderBottomWidth) || 0) / 2,
        };
      }),
      mathBottoms: maths.map((m) => m.getBoundingClientRect().bottom),
    };
  });

  expect(info.runCount).toBe(1);
  expect(info.emWrappingRun).toBe(0);
  expect(info.emInsideRun).toBe(2);
  expect(info.run[0]?.hasMath).toBe(true);
  expect(info.run[0]?.display).toBe("inline-block");
  expect(info.run[0]?.decoration).toBe("none");
  expect(info.run[0]?.borderBottomWidth).toBeGreaterThanOrEqual(1);
  const maxMathBottom = Math.max(...info.mathBottoms);
  expect(info.run[0]!.lineY).toBeGreaterThanOrEqual(maxMathBottom - 1);
});

function createUserUnderlineDoc(): SigmaDocument {
  return {
    version: "2.0",
    docId: "user_ul_sup_doc",
    metadata: { title: "下線と上付き" },
    content: [
      {
        type: "paragraph",
        id: "p_ul_user",
        children: [
          { type: "text", text: "あさ", marks: ["italic", "underline"] },
          {
            type: "mathInline",
            id: "m1",
            tex: "a\\log\\pi sa^2",
            display: "inline",
            marks: ["underline"],
          },
          { type: "text", text: "ああささ", marks: ["italic", "underline"] },
          {
            type: "mathInline",
            id: "m2",
            tex: "a\\log\\pi sa^2",
            display: "inline",
            marks: ["underline"],
          },
          {
            type: "mathInline",
            id: "m3",
            tex: "\\sum",
            display: "inline",
            marks: ["underline"],
          },
        ],
      },
    ],
    outputProfiles: {
      student: {},
      teacher: { showSolutions: true, showHints: true },
      answerBook: { includeAnswers: true, onlySolutions: true },
    },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    },
  };
}