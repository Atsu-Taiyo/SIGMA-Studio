import { expect, test } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { normalizePageLayout } from "@/lib/page-layout";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test("deleting the first empty line keeps the editing surface mounted", async ({ page }) => {
  await installDesktopRuntimeMock(page, {
    ...sampleDocument,
    content: [
      { id: "empty", type: "paragraph", children: [] },
      { id: "body", type: "paragraph", children: [{ type: "text", text: "朝" }] },
    ],
    pageLayout: normalizePageLayout({}),
  });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.locator('.page-flow [data-sigma-doc-id="empty"]').click();
  await page.locator(".page-flow .tiptap").evaluate((element) => element.setAttribute("data-original-surface", "true"));
  await page.keyboard.press("Delete");
  await expect(page.locator(".page-flow")).toContainText("朝");
  await expect(page.locator('.page-flow .tiptap[data-original-surface="true"]')).toHaveCount(1);
});

test("manual break after empty paragraphs remains on the next sheet after deletion", async ({ page }) => {
  await installDesktopRuntimeMock(page, {
    ...sampleDocument,
    content: [
      { id: "first", type: "paragraph", children: [{ type: "text", text: "朝" }] },
      { id: "second", type: "paragraph", children: [{ type: "text", text: "朝" }] },
      { id: "empty1", type: "paragraph", children: [] },
      { id: "empty2", type: "paragraph", children: [] },
      { id: "after", type: "paragraph", children: [{ type: "text", text: "朝" }], pagination: { break: true } },
    ],
    pageLayout: normalizePageLayout({}),
  });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const after = page.locator('.page-flow [data-sigma-doc-id="after"]').first();
  await expect(page.locator(".page-backdrop .a4-page-sheet")).toHaveCount(2);
  const nextPage = page.locator(".page-backdrop .a4-page-sheet").nth(1);
  await expect.poll(async () => (await after.boundingBox())!.y - (await nextPage.boundingBox())!.y).toBeGreaterThan(0);
  await page.locator('.page-flow [data-sigma-doc-id="empty2"]').click();
  await page.evaluate(() => {
    const samples: number[] = [];
    (window as unknown as { deletionFrames: number[] }).deletionFrames = samples;
    const read = () => {
      const block = document.querySelector('.page-flow [data-sigma-doc-id="after"]');
      const sheet = document.querySelectorAll(".page-backdrop .a4-page-sheet")[1];
      if (block && sheet) samples.push(block.getBoundingClientRect().top - sheet.getBoundingClientRect().top);
      if (samples.length < 30) requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
  });
  await page.keyboard.press("Backspace");
  await expect(page.locator(".page-backdrop .a4-page-sheet")).toHaveCount(2);
  await expect.poll(async () => (await after.boundingBox())!.y - (await nextPage.boundingBox())!.y).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { deletionFrames: number[] }).deletionFrames.length)).toBe(30);
  const samples = await page.evaluate(() => (window as unknown as { deletionFrames: number[] }).deletionFrames);
  expect(Math.max(...samples) - Math.min(...samples)).toBeLessThan(2);
});
