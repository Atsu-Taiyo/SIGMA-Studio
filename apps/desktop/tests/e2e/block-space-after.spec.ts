import { expect, test } from "@playwright/test";

import { normalizePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const SPACE_AFTER_PX = 40;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

/**
 * 実紙面は zoom の CSS transform 越しに描かれるので、`getBoundingClientRect` は
 * 拡大率ぶん伸びている。レイアウト px へ戻すために、同じ要素の `offsetWidth` (レイアウト px) と
 * rect の幅から実効倍率を測ってから比べる。
 */
async function readFlowGeometry(page: import("@playwright/test").Page, ids: string[]) {
  return page.evaluate((blockIds) => {
    const read = (id: string) => {
      const element = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${id}"]`);
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      const scale = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
      return {
        top: rect.top / scale,
        bottom: rect.bottom / scale,
        left: rect.left / scale,
        paddingBottom: Number.parseFloat(getComputedStyle(element).paddingBottom || "0"),
      };
    };
    return Object.fromEntries(blockIds.map((id) => [id, read(id)]));
  }, ids);
}

test("a paragraph's space below pushes the next block down, not itself", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createSpaceAfterDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  await expect(page.locator('.page-flow [data-sigma-doc-id="p_after"]')).toBeVisible();

  const geometry = await readFlowGeometry(page, ["p_before", "p_spaced", "p_after"]);
  const before = geometry.p_before!;
  const spaced = geometry.p_spaced!;
  const after = geometry.p_after!;

  // 余白は本人の padding として描かれている。
  expect(spaced.paddingBottom).toBeCloseTo(SPACE_AFTER_PX, 0);
  // 未指定のブロックは従来どおり (相続で余白が降りていない)。
  expect(before.paddingBottom).toBeCloseTo(0, 0);
  expect(after.paddingBottom).toBeCloseTo(0, 0);

  // 次のブロックだけが余白ぶん下がる。前のブロックとの間隔は変わらない。
  const gapBefore = spaced.top - before.bottom;
  const gapAfter = after.top - spaced.bottom;
  expect(Math.abs(gapAfter - gapBefore)).toBeLessThan(1.5);
  expect(after.top - spaced.top).toBeGreaterThan(SPACE_AFTER_PX);
});

test("the space below is drawn in a two-column flow too", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createTwoColumnSpaceAfterDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);
  await expect(page.locator('.page-flow [data-sigma-doc-id="p_col_after"]')).toBeVisible();

  const geometry = await readFlowGeometry(page, ["p_col_before", "p_col_spaced", "p_col_after"]);
  const before = geometry.p_col_before!;
  const spaced = geometry.p_col_spaced!;
  const after = geometry.p_col_after!;

  // 3 つが同じ段に載っていることを確かめてから縦位置を比べる。
  expect(Math.abs(spaced.left - before.left)).toBeLessThan(2);
  expect(Math.abs(after.left - before.left)).toBeLessThan(2);

  expect(spaced.paddingBottom).toBeCloseTo(SPACE_AFTER_PX, 0);
  const gapBefore = spaced.top - before.bottom;
  const gapAfter = after.top - spaced.bottom;
  expect(Math.abs(gapAfter - gapBefore)).toBeLessThan(1.5);
});

test("a list's space below does not leak into its own items", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createListSpaceAfterDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  await expect(page.locator('.page-flow [data-sigma-doc-id="p_list_after"]')).toBeVisible();

  const leak = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.page-flow [data-sigma-doc-id="list_spaced"]');
    const items = Array.from(list?.querySelectorAll<HTMLElement>("li > p") ?? []);
    return {
      listPaddingBottom: list ? Number.parseFloat(getComputedStyle(list).paddingBottom || "0") : -1,
      itemPaddings: items.map((item) => Number.parseFloat(getComputedStyle(item).paddingBottom || "0")),
      itemCount: items.length,
    };
  });

  expect(leak.listPaddingBottom).toBeCloseTo(SPACE_AFTER_PX, 0);
  expect(leak.itemCount).toBeGreaterThan(1);
  // custom property は相続するので、断ち切りが無いと項目ごとに 40px が付いて紙面が壊れる。
  expect(leak.itemPaddings.every((padding) => padding < 0.5)).toBe(true);
});

function baseDocument(docId: string): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = docId;
  document.metadata = { title: "ブロック下余白 e2e" };
  document.comments = [];
  return document;
}

function createSpaceAfterDocument(): SigmaDocument {
  const document = baseDocument("doc_e2e_block_space_after");
  document.content = [
    { type: "paragraph", id: "p_before", children: [{ type: "text", text: "余白の前の段落" }] },
    {
      type: "paragraph",
      id: "p_spaced",
      children: [{ type: "text", text: "下に余白を持つ段落" }],
      spaceAfterPx: SPACE_AFTER_PX,
    },
    { type: "paragraph", id: "p_after", children: [{ type: "text", text: "余白の後の段落" }] },
  ];
  return document;
}

function createTwoColumnSpaceAfterDocument(): SigmaDocument {
  const document = baseDocument("doc_e2e_block_space_after_columns");
  document.content = [
    { type: "paragraph", id: "p_col_before", children: [{ type: "text", text: "段組の前" }] },
    {
      type: "paragraph",
      id: "p_col_spaced",
      children: [{ type: "text", text: "段組で余白を持つ段落" }],
      spaceAfterPx: SPACE_AFTER_PX,
    },
    { type: "paragraph", id: "p_col_after", children: [{ type: "text", text: "段組の後" }] },
  ];
  document.pageLayout = normalizePageLayout({
    ...document.pageLayout,
    flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
  });
  return document;
}

function createListSpaceAfterDocument(): SigmaDocument {
  const document = baseDocument("doc_e2e_block_space_after_list");
  document.content = [
    {
      type: "list",
      id: "list_spaced",
      listType: "bullet",
      spaceAfterPx: SPACE_AFTER_PX,
      items: [
        { type: "listItem", id: "li_one", children: [{ type: "text", text: "ひとつ" }] },
        { type: "listItem", id: "li_two", children: [{ type: "text", text: "ふたつ" }] },
      ],
    },
    { type: "paragraph", id: "p_list_after", children: [{ type: "text", text: "リストの後" }] },
  ];
  return document;
}
