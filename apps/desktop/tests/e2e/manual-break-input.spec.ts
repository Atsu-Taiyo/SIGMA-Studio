import { expect, test, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { normalizePageLayout } from "@/lib/page-layout";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

async function typeReportedDocument(page: Page) {
  await installDesktopRuntimeMock(page, {
    ...sampleDocument,
    metadata: { title: "無題の教材 2" },
    content: [{ type: "paragraph", id: "typed_first", children: [] }],
    pageLayout: normalizePageLayout({
      marginsMm: { top: 18, right: 17, bottom: 18, left: 17 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    }),
  });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const paragraphs = page.locator('.page-flow p[data-sigma-doc-type="paragraph"]');
  await paragraphs.first().click();
  await page.keyboard.insertText("s");
  await page.keyboard.press("Enter");
  await expect(paragraphs).toHaveCount(2);
  await paragraphs.last().click({ button: "right" });
  await startFrameRecording(page);
  await page.getByRole("menuitem", { name: "改ページを挿入", exact: true }).click();
  // Type when the command's caret reaches the newly created editing surface.
  // Do not click the paragraph: the command itself must make it ready for input.
  await expect.poll(() => paragraphs.last().evaluate(element => {
    const selection = window.getSelection();
    return element.closest("[contenteditable=true]") === document.activeElement
      && !!selection?.focusNode && element.contains(selection.focusNode);
  })).toBe(true);
  await page.keyboard.insertText("s");
  await expect(paragraphs).toHaveCount(3);
  await expect(paragraphs.last()).toHaveText("s");
  return paragraphs;
}

async function startFrameRecording(page: Page) {
  await page.evaluate(() => {
    const samples: Array<{ pages: number; offset: number; count: number }> = [];
    (window as unknown as { manualInputFrames: typeof samples }).manualInputFrames = samples;
    const sample = () => {
      const canvas = document.querySelector<HTMLElement>(".page-canvas")!;
      const scale = new DOMMatrixReadOnly(getComputedStyle(canvas.closest(".page-stack")!).transform).a;
      const paragraphs = canvas.querySelectorAll('.page-flow p[data-sigma-doc-type="paragraph"]');
      samples.push({
        pages: Number(canvas.dataset.pageCount), count: paragraphs.length,
        offset: paragraphs.length >= 3
          ? (paragraphs[2].getBoundingClientRect().top - paragraphs[0].getBoundingClientRect().top) / scale - Number(canvas.dataset.pageStride)
          : 0,
      });
      if (samples.length < 60) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function expectStableFrames(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { manualInputFrames: unknown[] }).manualInputFrames.length)).toBe(60);
  const frames = await page.evaluate(() => (window as unknown as {
    manualInputFrames: Array<{ pages: number; offset: number; count: number }>;
  }).manualInputFrames);
  const afterBreak = frames.slice(frames.findIndex(frame => frame.pages === 2));
  expect(afterBreak.length).toBeGreaterThan(5);
  expect(afterBreak.every(frame => frame.pages === 2), JSON.stringify(afterBreak)).toBe(true);
  expect(Math.max(...afterBreak.filter(frame => frame.count >= 3).map(frame => Math.abs(frame.offset)))).toBeLessThan(3);
}

async function savedBreakCount(page: Page) {
  return page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "{}");
    return doc.content?.filter((block: { pagination?: { break?: boolean } }) => block.pagination?.break === true).length ?? -1;
  });
}

test("deleting all body above a break removes the leading boundary and keeps typing on page one", async ({ page }) => {
  const paragraphs = await typeReportedDocument(page);
  await expectStableFrames(page);
  await paragraphs.nth(1).click();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect.poll(() => savedBreakCount(page)).toBe(0);
  await expect(page.locator(".page-canvas")).toHaveAttribute("data-page-count", "1");
  await paragraphs.last().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("あ");
  await expect(paragraphs.last()).toHaveText("sあ");
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect.poll(() => savedBreakCount(page)).toBe(0);
  await expect(page.locator(".page-canvas")).toHaveAttribute("data-page-count", "1");
});

test("paragraph and hard break marks are visible without changing saved text or line height", async ({ page }, testInfo) => {
  await typeReportedDocument(page);
  const marks = page.locator('.page-flow [data-formatting-mark="paragraph"]');
  await expect(marks).toHaveCount(3);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.insertText("次");
  await expect(page.locator('.page-flow [data-formatting-mark="line"]')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("formatting-marks.png") });
  const metrics = await marks.first().evaluate(element => {
    const before = element.parentElement!.getBoundingClientRect().height;
    const glyph = getComputedStyle(element, "::after").content;
    (element as HTMLElement).style.display = "none";
    const after = element.parentElement!.getBoundingClientRect().height;
    return { before, after, glyph };
  });
  expect(metrics.before).toBe(metrics.after);
  expect(metrics.glyph).toBe('"↵"');
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sigma-studio:e2e-document"))).not.toBeNull();
  const saved = await page.evaluate(() => localStorage.getItem("sigma-studio:e2e-document")!);
  expect(saved).not.toContain("¶");
  expect(saved).not.toContain("↵");
  await page.emulateMedia({ media: "print" });
  await expect(marks.last()).toBeHidden();
});

test("typing from an empty document and inserting a page break keeps its first paint stable", async ({ page }) => {
  await typeReportedDocument(page);
  await expectStableFrames(page);
  await expect.poll(() => savedBreakCount(page)).toBe(1);
});

for (const position of ["start", "middle", "end", "empty"] as const) {
  test(`Enter at the ${position} of the freshly inserted page break keeps one boundary`, async ({ page }) => {
    const paragraphs = await typeReportedDocument(page);
    await expectStableFrames(page);
    if (position === "middle") await page.keyboard.insertText("s");
    if (position === "start" || position === "middle") await page.keyboard.press("ArrowLeft");
    if (position === "empty") await page.keyboard.press("Backspace");
    await startFrameRecording(page);
    await page.keyboard.press("Enter");
    await expect(paragraphs).toHaveCount(4);
    await expect.poll(() => savedBreakCount(page)).toBe(1);
    await expectStableFrames(page);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(paragraphs).toHaveCount(6);
    await expect.poll(() => savedBreakCount(page)).toBe(1);
    await expect(page.locator(".page-canvas")).toHaveAttribute("data-page-count", "2");
  });
}

for (const operation of ["delete-line", "insert-line", "delete-text"] as const) {
  test(`editing immediately above a freshly typed break keeps the next page fixed: ${operation}`, async ({ page }) => {
    const paragraphs = await typeReportedDocument(page);
    await expectStableFrames(page);
    const afterId = await paragraphs.last().getAttribute("data-sigma-doc-id");
    await paragraphs.nth(1).click();
    if (operation === "delete-text") await page.keyboard.insertText("s");
    await page.evaluate((afterId) => {
      const samples: number[] = [];
      (window as unknown as { boundaryFrames: number[] }).boundaryFrames = samples;
      const read = () => {
        const canvas = document.querySelector<HTMLElement>(".page-canvas")!;
        const scale = new DOMMatrixReadOnly(getComputedStyle(canvas.closest(".page-stack")!).transform).a;
        const after = canvas.querySelector(`[data-sigma-doc-id="${afterId}"]`)!;
        return (after.getBoundingClientRect().top - canvas.getBoundingClientRect().top) / scale;
      };
      samples.push(read());
      const sample = () => {
        samples.push(read());
        if (samples.length < 40) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, afterId);
    await page.keyboard.press(operation === "insert-line" ? "Enter" : "Backspace");
    await expect.poll(() => page.evaluate(() => (window as unknown as { boundaryFrames: number[] }).boundaryFrames.length)).toBe(40);
    const frames = await page.evaluate(() => (window as unknown as { boundaryFrames: number[] }).boundaryFrames);
    expect(Math.max(...frames) - Math.min(...frames), JSON.stringify(frames)).toBeLessThan(2);
    await expect.poll(() => savedBreakCount(page)).toBe(1);
  });
}

test("an empty first line cannot insert a manual page break", async ({ page }) => {
  await installDesktopRuntimeMock(page, {
    ...sampleDocument,
    content: [{ type: "paragraph", id: "empty_first", children: [] }],
    pageLayout: normalizePageLayout({}),
  });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.locator('.page-flow [data-sigma-doc-id="empty_first"]').click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "改ページを挿入", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator('.page-flow [data-sigma-doc-id="empty_first"]').click();
  await page.keyboard.insertText("s");
  await page.locator('.page-flow [data-sigma-doc-id="empty_first"]').click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "改ページを挿入", exact: true })).toBeVisible();
});

test("an empty page after a manual break cannot insert another break", async ({ page }) => {
  const paragraphs = await typeReportedDocument(page);
  await expectStableFrames(page);
  await page.keyboard.press("Backspace");
  await expect(paragraphs.last()).toHaveText("");
  await paragraphs.last().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "改ページを挿入", exact: true })).toHaveCount(0);
  await expect.poll(() => savedBreakCount(page)).toBe(1);
  await page.getByRole("menuitem", { name: "改ページを解除", exact: true }).click();
  await expect.poll(() => savedBreakCount(page)).toBe(0);
});
