import { expect, test, type Page } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";
import { createBoxBlock } from "@/lib/box-blocks";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { selectUiOptionInPage } from "./ui-select";

function boxColumnDocument(columnCount: number, nested: boolean): SigmaDocument {
  const box = createBoxBlock("fancybox", "", { id: "audit_box", bodyId: "audit_unused" });
  box.pagination = { break: true };
  box.blocks = [{
    type: "layoutSection", id: "audit_columns", layout: { columnCount: 2, columnGapMm: 5 },
    children: Array.from({ length: 6 }, (_, index) => ({
      type: "paragraph" as const,
      id: `audit_p${index}`,
      children: [{ type: "text" as const, text: `本文${index}` }],
      ...(index === 5 ? { pagination: { break: true } } : {}),
    })),
  }];
  return {
    version: "2.0", docId: "doc_box_column_audit", metadata: { title: "Boxと改段" },
    content: [
      { type: "paragraph", id: "audit_before", children: [{ type: "text", text: "前の本文" }] },
      nested ? {
        type: "layoutSection", id: "audit_outer_section", pagination: { break: true },
        layout: { columnCount: 2, columnStartIds: [box.id, "audit_neighbor"] },
        children: [{ ...box, pagination: undefined }, {
          type: "paragraph", id: "audit_neighbor", children: [{ type: "text", text: "隣の段" }],
        }],
      } : box,
      { type: "paragraph", id: "audit_after", children: [{ type: "text", text: "後の本文" }] },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "custom", orientation: "portrait", pageSize: { widthMm: 210, heightMm: 180 },
      marginsMm: { top: 12, right: 12, bottom: 12, left: 12 },
      flow: { type: "columns", columnCount, columnGapMm: 8 },
    },
  };
}

async function readGeometry(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".page-canvas")!;
    const scale = new DOMMatrixReadOnly(getComputedStyle(canvas.closest(".page-stack")!).transform).a;
    const box = canvas.querySelector<HTMLElement>('.page-flow [data-sigma-doc-id="audit_box"]')!;
    const columns = box.querySelector<HTMLElement>(".sigma-doc-layout-section-body")!;
    const rect = box.getBoundingClientRect();
    const columnsRect = columns.getBoundingClientRect();
    const block = (index: number) => box.querySelector(`[data-sigma-doc-id="audit_p${index}"]`)!.getBoundingClientRect();
    return {
      height: rect.height / scale,
      tops: [0, 1, 2, 3, 4, 5].map(index => (block(index).top - columnsRect.top) / scale),
      lefts: [0, 1, 2, 3, 4, 5].map(index => (block(index).left - columnsRect.left) / scale),
      columnHeight: columnsRect.height / scale,
      pageCount: Number(canvas.dataset.pageCount),
    };
  });
}

for (const columnCount of [1, 2]) {
  for (const nested of [false, true]) {
    test(`editing box-local manual columns after zoom preserves layout (${columnCount} page columns, nested=${nested})`, async ({ page }) => {
      await installDesktopRuntimeMock(page, boxColumnDocument(columnCount, nested));
      await page.goto("/");
      await expect(page.locator(".startup-splash")).toBeHidden();
      await expect(page.locator('.page-flow [data-sigma-doc-id="audit_p5"]')).toHaveClass(/manual-column-break-before/);
      let before = await readGeometry(page);
      await expect.poll(async () => {
        const next = await readGeometry(page);
        const stable = Math.abs(next.height - before.height) < 1;
        before = next;
        return stable;
      }).toBe(true);
      for (const zoom of ["50", "150", "100"]) {
        await selectUiOptionInPage(page, "ズーム", zoom);
        const target = page.locator('.page-flow [data-sigma-doc-id="audit_p0"]').first();
        await target.click({ force: true });
        // End stops at the visual line end in narrow nested columns. Select
        // the paragraph's actual end so each edit replaces the final digit.
        await target.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(false);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
        });
        await page.keyboard.press("Backspace");
        await page.keyboard.insertText(zoom[0]);
        await expect(target).toHaveText(`本文${zoom[0]}`);
        await expect.poll(async () => Math.abs((await readGeometry(page)).height - before.height)).toBeLessThan(2);
        const current = await readGeometry(page);
        expect(current.pageCount).toBe(before.pageCount);
        for (let index = 0; index < 6; index += 1) {
          expect(Math.abs(current.lefts[index] - before.lefts[index])).toBeLessThan(2);
          expect(Math.abs(current.tops[index] - before.tops[index])).toBeLessThan(2);
        }
      }
    });
  }
}
