import { expect, test, type Page } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";
import { normalizePageLayout } from "@/lib/page-layout";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { selectUiOptionInPage } from "./ui-select";

// The reported document: short Japanese paragraphs, an empty paragraph, and a
// manual break before the fourth paragraph. PDF already paginated this input.
function seedDocument(manualBreak = true): SigmaDocument {
  return {
    ...sampleDocument,
    content: [
      { type: "paragraph", id: "first", children: [{ type: "text", text: "あ" }] },
      { type: "paragraph", id: "empty", children: [] },
      { type: "paragraph", id: "before", children: [{ type: "text", text: "あ" }] },
      { type: "paragraph", id: "after", children: [{ type: "text", text: "あ" }], ...(manualBreak ? { pagination: { break: true } } : {}) },
      { type: "paragraph", id: "last", children: [{ type: "text", text: "￥" }] },
    ],
    pageLayout: normalizePageLayout({}),
  };
}

async function openDocument(page: Page, manualBreak = true) {
  await installDesktopRuntimeMock(page, seedDocument(manualBreak));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
}

async function expectNextPageStart(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".page-canvas")!;
    const scale = new DOMMatrixReadOnly(getComputedStyle(canvas.closest(".page-stack")!).transform).a;
    const first = canvas.querySelector('[data-sigma-doc-id="first"]')!.getBoundingClientRect();
    const after = canvas.querySelector('[data-sigma-doc-id="after"]')!.getBoundingClientRect();
    const last = canvas.querySelector('[data-sigma-doc-id="last"]')!.getBoundingClientRect();
    const offset = (after.top - first.top) / scale - Number(canvas.dataset.pageStride);
    return {
      pages: Number(canvas.dataset.pageCount),
      // Normal flow margins and integer spacer rounding differ by up to 3px.
      aligned: Math.abs(offset) < 3,
      following: last.top >= after.bottom && (last.top - after.bottom) / scale < 4,
      oscillations: window.__SIGMA_STUDIO_PERFORMANCE__?.counters["PageCanvasEditor.paginationOscillation"] ?? 0,
    };
  })).toEqual({ pages: 2, aligned: true, following: true, oscillations: 0 });
}

test("saved manual break stays at the next page body start through zoom changes", async ({ page }) => {
  await openDocument(page);
  for (const zoom of ["100", "75", "150", "50", "125", "100"]) {
    await selectUiOptionInPage(page, "ズーム", zoom);
    await expectNextPageStart(page);
  }
});

for (const zoom of ["50", "150"]) {
  for (const changeMetrics of [false, true]) {
    test(`queued layout keeps manual break stable at ${zoom}% (metric change: ${changeMetrics})`, async ({ page }) => {
      await openDocument(page);
      await expectNextPageStart(page);
      const trigger = page.getByRole("combobox", { name: "ズーム", exact: true });
      await trigger.click();
      const listboxId = await trigger.getAttribute("aria-controls");
      const frames = await page.locator(`#${listboxId} [data-value="${zoom}"]`).evaluate((option, changeMetrics) => {
        // Reproduce font completion queuing a layout pass immediately before the
        // zoom commit. The optional line metrics change also replaces the spacer
        // before ResizeObserver delivers the corresponding size notification.
        if (changeMetrics) {
          document.querySelector<HTMLElement>(".page-flow .tiptap")!.style.lineHeight = "3";
        }
        const face = new FontFace("Pagination event ordering", 'local("Arial")');
        document.fonts.add(face);
        document.fonts.dispatchEvent(new Event("loadingdone"));
        (option as HTMLElement).click();
        return new Promise<Array<{ offset: number; pages: number }>>(resolve => {
          const samples: Array<{ offset: number; pages: number }> = [];
          const sample = () => {
            const canvas = document.querySelector<HTMLElement>(".page-canvas")!;
            const scale = new DOMMatrixReadOnly(getComputedStyle(canvas.closest(".page-stack")!).transform).a;
            const first = canvas.querySelector('[data-sigma-doc-id="first"]')!.getBoundingClientRect();
            const after = canvas.querySelector('[data-sigma-doc-id="after"]')!.getBoundingClientRect();
            samples.push({
              offset: (after.top - first.top) / scale - Number(canvas.dataset.pageStride),
              pages: Number(canvas.dataset.pageCount),
            });
            if (samples.length < 20) requestAnimationFrame(sample);
            else {
              document.fonts.delete(face);
              resolve(samples);
            }
          };
          requestAnimationFrame(sample);
        });
      }, changeMetrics);
      expect(frames.every(frame => frame.pages === 2)).toBe(true);
      expect(Math.max(...frames.map(frame => Math.abs(frame.offset)))).toBeLessThan(3);
      await expectNextPageStart(page);
    });
  }
}

test("inserting a manual break and zooming immediately keeps the following body on page two", async ({ page }) => {
  await openDocument(page, false);
  const before = page.locator('.page-flow [data-sigma-doc-id="before"]').first();
  await before.click({ button: "right" });
  await page.getByRole("menuitem", { name: "改ページを挿入", exact: true }).click();
  for (const zoom of ["50", "150", "75", "100"]) {
    await selectUiOptionInPage(page, "ズーム", zoom);
    await expectNextPageStart(page);
  }
});
