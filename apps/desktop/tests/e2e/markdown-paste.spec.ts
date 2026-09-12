import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/features/document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
});

test("automatically applies pasted Markdown structure to the paper", async ({ page }) => {
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });

  const target = page.locator('[data-sigma-doc-id="markdown_paste_target"]').first();
  await expect(target).toBeVisible();
  await target.click();
  await dispatchPlainTextPaste(page, [
    "md形式の文章",
    "",
    "## aaa",
    "- wagvw",
    "- **太字** と *斜体*",
  ].join("\n"));

  const editor = page.locator(".page-flow .text-flow-editor").first();
  await expect(editor.locator("h2").filter({ hasText: "aaa" })).toBeVisible();
  await expect(editor.locator("ul > li")).toHaveCount(2);
  await expect(editor.locator("ul > li").first()).toHaveText("wagvw");
  await expect(editor.locator("ul > li").nth(1).locator("strong")).toHaveText("太字");
  await expect(editor.locator("ul > li").nth(1).locator("em")).toHaveText("斜体");

  await expect.poll(async () => savedMarkdownSummary(page)).toEqual([
    { type: "paragraph", text: "md形式の文章" },
    { type: "heading", level: 2, text: "aaa" },
    { type: "list", listType: "bullet", items: ["wagvw", "太字 と 斜体"] },
  ]);
});

test("turns every $...$ range in pasted prose into editable inline math", async ({ page }) => {
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });

  const target = page.locator('[data-sigma-doc-id="markdown_paste_target"]').first();
  await expect(target).toBeVisible();
  await target.click();
  await dispatchPlainTextPaste(page, [
    String.raw`$z=0$ の面内で点 $\mathrm{O}$ を中心とする半径 $a\,(\leqq R)$ の円を貫く磁束 $\Phi_a$ は，`,
    "",
    String.raw`$\Phi_a=\pi B_0a^2\left(1-\frac{2a}{3R}\right)$`,
    "",
    "であることを示せ。",
  ].join("\n"));

  const formulas = page.locator(".page-flow .text-flow-editor .inline-math-node");
  await expect(formulas).toHaveCount(5);
  expect(await formulas.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-tex")))).toEqual([
    "z=0",
    String.raw`\mathrm{O}`,
    String.raw`a\,(\leqq R)`,
    String.raw`\Phi_a`,
    String.raw`\Phi_a=\pi B_0a^2\left(1-\frac{2a}{3R}\right)`,
  ]);

  await expect.poll(async () => savedMarkdownSummary(page)).toEqual([
    {
      type: "paragraph",
      text: String.raw`$z=0$ の面内で点 $\mathrm{O}$ を中心とする半径 $a\,(\leqq R)$ の円を貫く磁束 $\Phi_a$ は，`,
    },
    {
      type: "paragraph",
      text: String.raw`$\Phi_a=\pi B_0a^2\left(1-\frac{2a}{3R}\right)$`,
    },
    { type: "paragraph", text: "であることを示せ。" },
  ]);
  await page.keyboard.type("!");
  await expect.poll(async () => (await savedMarkdownSummary(page)).at(-1)).toEqual({
    type: "paragraph", text: "であることを示せ。!",
  });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!) as SigmaDocument);
  expect(saved.content).toHaveLength(3);
  await installDesktopRuntimeMock(page, saved);
  await page.reload();
  await expect(formulas).toHaveCount(5);
  await expect(page.locator(".page-flow .text-flow-editor")).toContainText("であることを示せ。!");
});

test("pastes Markdown markers as literal text with Command-Shift-V", async ({ page }) => {
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });

  const target = page.locator('[data-sigma-doc-id="markdown_paste_target"]').first();
  await expect(target).toBeVisible();
  await target.click();
  await dispatchPlainTextPaste(page, "## aaa\n- wagvw", true);

  const editor = page.locator(".page-flow .text-flow-editor").first();
  await expect(editor.locator("h2")).toHaveCount(0);
  await expect(editor.locator("ul")).toHaveCount(0);
  await expect(editor).toContainText("## aaa");
  await expect(editor).toContainText("- wagvw");
  await expect.poll(async () => savedMarkdownSummary(page)).toEqual([
    { type: "paragraph", text: "## aaa" },
    { type: "paragraph", text: "- wagvw" },
  ]);
});

async function dispatchPlainTextPaste(page: Page, text: string, literal = false): Promise<void> {
  await page.evaluate(({ literalPaste, pastedText }) => {
    const target = document.activeElement?.closest(".text-flow-editor");
    if (!target) {
      throw new Error("Text flow editor is not focused");
    }
    if (literalPaste) {
      target.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "v",
        metaKey: true,
        shiftKey: true,
      }));
    }
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pastedText);
    target.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }));
  }, { literalPaste: literal, pastedText: text });
}

async function savedMarkdownSummary(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return [];
    }
    const saved = JSON.parse(raw) as {
      content: Array<{
        type: string;
        level?: number;
        listType?: string;
        children?: Array<{ type: string; text?: string; tex?: string }>;
        items?: Array<{ children: Array<{ type: string; text?: string; tex?: string }> }>;
      }>;
    };
    const inlineText = (children: Array<{ type: string; text?: string; tex?: string }> = []) => (
      children.map((child) => child.type === "text" ? child.text ?? "" : `$${child.tex ?? ""}$`).join("")
    );
    const summary: Array<Record<string, unknown>> = [];
    for (const block of saved.content) {
      if (block.type === "paragraph") {
        const text = inlineText(block.children);
        if (text) {
          summary.push({ type: "paragraph", text });
        }
        continue;
      }
      if (block.type === "heading") {
        summary.push({ type: "heading", level: block.level, text: inlineText(block.children) });
        continue;
      }
      if (block.type === "list") {
        summary.push({
          type: "list",
          listType: block.listType,
          items: (block.items ?? []).map((item) => inlineText(item.children)),
        });
      }
    }
    return summary;
  });
}

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_markdown_paste",
    metadata: { title: "Markdown paste test" },
    content: [{
      type: "paragraph",
      id: "markdown_paste_target",
      children: [],
    }],
    outputProfiles: {
      student: { showSolutions: false, showHints: false, includeAnswers: false },
      teacher: { showSolutions: true, showHints: true, includeAnswers: true, includeComments: true },
      answerBook: { showSolutions: true, showHints: false, includeAnswers: true, onlySolutions: true },
    },
  };
}
