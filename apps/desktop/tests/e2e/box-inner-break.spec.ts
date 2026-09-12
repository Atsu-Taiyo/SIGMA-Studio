import { expect, test, type Page } from "@playwright/test";

import { createBoxBlock } from "@/lib/box-blocks";
import type { SigmaDocument } from "@/types/sigma-doc";

import { countFocusIn, readCaretSurface } from "./caret-surface";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

function boxDocument(
  columnCount: number,
  withInnerColumns = false,
  childCount = 3,
): SigmaDocument {
  const box = createBoxBlock("fancybox", "", { id: "inner_break_box", bodyId: "inner_break_1" });
  const children = Array.from({ length: childCount }, (_, index) => ({
    type: "paragraph" as const,
    id: `inner_break_${index + 1}`,
    children: [{ type: "text" as const, text: `箱の${index + 1}行目` }],
  })) satisfies typeof box.blocks;
  box.blocks = withInnerColumns
    ? [{
        type: "layoutSection",
        id: "inner_break_columns",
        layout: { columnCount: 2, columnGapMm: 8 },
        children,
      }]
    : children;
  return {
    version: "2.0",
    docId: "doc_box_inner_break",
    metadata: { title: "箱の中の改ページ" },
    content: [
      { type: "paragraph", id: "before_box", children: [{ type: "text", text: "箱の前の本文" }] },
      box,
      { type: "paragraph", id: "after_box", children: [{ type: "text", text: "箱の後の本文" }] },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "custom",
      orientation: "portrait",
      pageSize: { widthMm: 120, heightMm: 160 },
      marginsMm: { top: 12, right: 12, bottom: 12, left: 12 },
      flow: { type: "columns", columnCount, columnGapMm: 8 },
    },
  };
}

function boxColumnBreakHeightDocument(afterBreakBlockCount: number): SigmaDocument {
  const box = createBoxBlock("fancybox", "", {
    id: "height_break_box",
    bodyId: "height_break_unused",
  });
  const before = Array.from({ length: 5 }, (_, index) => ({
    type: "paragraph" as const,
    id: `height_break_before_${index + 1}`,
    children: [{ type: "text" as const, text: `改段前 ${index + 1}` }],
  }));
  const after = Array.from({ length: afterBreakBlockCount }, (_, index) => ({
    type: "paragraph" as const,
    id: index === 0 ? "height_break_target" : `height_break_after_${index + 1}`,
    ...(index === 0 ? { pagination: { break: true as const } } : {}),
    children: [{ type: "text" as const, text: `改段後 ${index + 1}` }],
  }));
  box.blocks = [{
    type: "layoutSection",
    id: "height_break_columns",
    layout: { columnCount: 2, columnGapMm: 8 },
    children: [...before, ...after],
  }];
  return {
    ...boxDocument(1),
    docId: `doc_box_break_height_${afterBreakBlockCount}`,
    content: [box],
  };
}

function boxDocumentAtManualColumnBreakLimit(): SigmaDocument {
  const document = boxDocument(1, true);
  const box = document.content.find((block) => block.id === "inner_break_box");
  if (!box || box.type !== "boxBlock") {
    throw new Error("box fixture was not created");
  }
  const section = box.blocks[0];
  if (!section || section.type !== "layoutSection") {
    throw new Error("box-local layout section fixture was not created");
  }
  section.children[1] = {
    ...section.children[1],
    pagination: { break: true },
  };
  return document;
}

function boxLocalColumnsInSecondOuterColumnDocument(): SigmaDocument {
  const document = boxDocument(2, true);
  const box = document.content.find((block) => block.id === "inner_break_box");
  if (!box || box.type !== "boxBlock") {
    throw new Error("box fixture was not created");
  }
  document.content = [
    document.content[0],
    {
      type: "paragraph",
      id: "second_outer_column_start",
      pagination: { break: true },
      children: [{ type: "text", text: "右段の先頭" }],
    },
    box,
    document.content[2],
  ];
  return document;
}

test("a direct child of a box can be wrapped in columns but cannot insert a page/outer-column break", async ({ page }) => {
  await installDesktopRuntimeMock(page, boxDocument(2));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const target = page.locator('.page-flow [data-sigma-doc-id="inner_break_2"]').first();
  await target.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "本文操作" });

  await expect(menu.getByRole("menuitem", { name: "ここを段組にする", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "boxの設定…", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "boxをコピー", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "boxを削除", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "改段を挿入", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "改ページを挿入", exact: true })).toHaveCount(0);
});

for (const nestedKind of ["code", "quote", "nestedBox"] as const) {
  test(`hides unavailable layout commands in a box descendant: ${nestedKind}`, async ({ page }) => {
    const doc = boxDocument(1);
    const box = doc.content[1];
    if (box.type !== "boxBlock") throw new Error("missing box");
    const body = { type: "paragraph" as const, id: "nested_target", children: [{ type: "text" as const, text: "入れ子の本文" }] };
    box.blocks = nestedKind === "code"
      ? [{ ...body, type: "codeBlock" }]
      : nestedKind === "quote"
        ? [{ type: "quote", id: "nested_quote", blocks: [body] }]
        : [{ ...createBoxBlock("codebox", "", { id: "nested_box" }), blocks: [body] }];
    await installDesktopRuntimeMock(page, doc);
    await page.goto("/");
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.locator('.page-flow [data-sigma-doc-id="nested_target"]').first().click({ button: "right" });
    const menu = page.getByRole("menu", { name: "本文操作" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "改ページを挿入", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "改段を挿入", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "ここを段組にする", exact: true })).toHaveCount(nestedKind === "nestedBox" ? 1 : 0);
    await page.keyboard.press("Escape");
    await page.locator('.page-flow [data-sigma-doc-id="before_box"]').first().click({ button: "right" });
    await expect(menu.getByRole("menuitem", { name: "改ページを挿入", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "ここを段組にする", exact: true })).toBeVisible();
  });
}

test("can delete the containing box from its inner context menu", async ({ page }) => {
  await installDesktopRuntimeMock(page, boxDocument(1));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const target = page.locator('.page-flow [data-sigma-doc-id="inner_break_2"]').first();
  await target.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "本文操作" });
  await menu.getByRole("menuitem", { name: "boxを削除", exact: true }).click();

  await expect(page.locator('.sigma-doc-box-block[data-sigma-doc-id="inner_break_box"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) as SigmaDocument : null;
    return document?.content.some((block) => block.id === "inner_break_box") ?? false;
  })).toBe(false);
});

test("hides box-local column breaks and preserves columns after editing and reopening", async ({ page }) => {
  await installDesktopRuntimeMock(page, boxDocument(1, true));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const target = page.locator('.page-flow [data-sigma-doc-id="inner_break_1"]').first();
  await target.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "本文操作" });
  await expect(menu.getByRole("menuitem", { name: "改ページを挿入", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "改段を挿入", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await target.click();
  await page.keyboard.insertText("列を維持");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sigma-studio:e2e-document"))).toContain("列を維持");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!));
  const section = saved.content.find((block: { id: string }) => block.id === "inner_break_box").blocks[0];
  expect(section.layout.columnCount).toBe(2);
  expect(section.children.some((block: { pagination?: { break?: boolean } }) => block.pagination?.break)).toBe(false);
  await installDesktopRuntimeMock(page, saved);
  await page.reload();
  await expect(target).toContainText("列を維持");
  await expect(page.locator('[data-page-break-marker]')).toHaveCount(0);
});

test("allows removing an existing box-local column break", async ({ page }) => {
  await installDesktopRuntimeMock(page, boxDocumentAtManualColumnBreakLimit());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const marker = page.locator('[data-page-break-marker][data-page-break-block-id="inner_break_2"]');
  await expect(marker).toHaveCount(1);
  await marker.click({ button: "right", force: true });

  const menu = page.getByRole("menu", { name: "本文操作" });
  await expect(menu.getByRole("menuitem", { name: "改段を挿入", exact: true })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "改段を解除", exact: true }).click();
  await expect(marker).toHaveCount(0);
  await installDesktopRuntimeMock(page, await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!)));
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(marker).toHaveCount(0);
});

for (const afterBreakBlockCount of [1, 6]) {
  test(`a box-local break starts the second column with ${afterBreakBlockCount === 1 ? "short" : "long"} following content`, async ({ page }) => {
    await installDesktopRuntimeMock(page, boxColumnBreakHeightDocument(afterBreakBlockCount));
    await page.goto("/");
    await expect(page.locator(".startup-splash")).toBeHidden();

    const geometry = await page.evaluate(() => {
      const columns = document.querySelector<HTMLElement>(
        '[data-sigma-doc-id="height_break_columns"] .sigma-doc-layout-section-body',
      );
      const target = document.querySelector<HTMLElement>('[data-sigma-doc-id="height_break_target"]');
      const before = Array.from(
        document.querySelectorAll<HTMLElement>('[data-sigma-doc-id^="height_break_before_"]'),
      );
      if (!columns || !target || before.length === 0) {
        throw new Error("box-local break geometry was not rendered");
      }
      const columnsRect = columns.getBoundingClientRect();
      const gap = Number.parseFloat(getComputedStyle(columns).columnGap);
      const secondColumnLeft = columnsRect.left + (columnsRect.width - gap) / 2 + gap;
      return {
        columnsRight: columnsRect.right,
        secondColumnLeft,
        targetLeft: target.getBoundingClientRect().left,
        beforeLefts: before.map((element) => element.getBoundingClientRect().left),
      };
    });

    expect(geometry.beforeLefts.every((left) => left < geometry.secondColumnLeft - 1)).toBe(true);
    expect(geometry.targetLeft).toBeGreaterThanOrEqual(geometry.secondColumnLeft - 1);
    expect(geometry.targetLeft).toBeLessThan(geometry.columnsRight - 1);
  });
}

test("a long box automatically continues onto the next page", async ({ page }) => {
  test.setTimeout(120_000);
  await installDesktopRuntimeMock(page, boxDocument(1, false, 24));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.waitForTimeout(1500);

  // A box that outgrows the page is clipped and continued automatically, independently
  // from the manual inner-column break command.
  await expect(page.locator('.page-flow [data-sigma-doc-id="inner_break_box"].text-flow-box-fragment-source'))
    .toHaveCount(1);
  const continuation = page.locator('.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]').first();
  await expect(continuation).toHaveCount(1);

  const geometry = await page.evaluate(() => {
    const sheets = Array.from(document.querySelectorAll<HTMLElement>(".page-backdrop .a4-page-sheet"))
      .map((sheet) => sheet.getBoundingClientRect());
    const fragment = document.querySelector<HTMLElement>(".editor-box-fragment-viewport")?.getBoundingClientRect();
    return {
      sheetCount: sheets.length,
      // The continuation must start on a later sheet than the first one.
      fragmentSheetIndex: fragment
        ? sheets.findIndex((sheet) => fragment.top >= sheet.top && fragment.top <= sheet.bottom)
        : -1,
    };
  });
  expect(geometry.sheetCount).toBeGreaterThan(1);
  expect(geometry.fragmentSheetIndex).toBeGreaterThan(0);
});

test("a text selection can cross every page of a continued box", async ({ page }) => {
  test.setTimeout(120_000);
  await installDesktopRuntimeMock(page, boxDocument(1, false, 24));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const sourceLine = page.locator(
    '.page-flow [data-box-fragment-source-id="inner_break_box"] [data-sigma-doc-id="inner_break_2"]',
  ).first();
  const sourceBounds = await sourceLine.boundingBox();
  const target = await page.locator(
    '.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]',
  ).last().evaluate((viewport) => {
    const viewportRect = viewport.getBoundingClientRect();
    const visible = Array.from(viewport.querySelectorAll<HTMLElement>("[data-sigma-doc-id]"))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > viewportRect.top + 2 && rect.top < viewportRect.bottom - 2)
      .at(-1);
    if (!visible) {
      throw new Error("continued box has no visible text row");
    }
    return {
      x: visible.rect.left + Math.min(visible.rect.width - 2, 40),
      y: Math.min(visible.rect.bottom - 2, viewportRect.bottom - 2),
    };
  });
  if (!sourceBounds) {
    throw new Error("box source line was not rendered");
  }

  await page.mouse.move(sourceBounds.x + 8, sourceBounds.y + sourceBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();

  await expect.poll(() => page.locator(".text-flow-editor[data-box-fragment-span]").count())
    .toBeGreaterThan(1);
  await expect.poll(() => page.evaluate(() =>
    CSS.highlights.get("text-run-span")?.size ?? 0,
  )).toBeGreaterThan(1);

  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await savedBoxLineTexts(page)).length).toBeLessThan(24);
});

test("box-local and body-local columns share column spacing and menu layout", async ({ page }) => {
  await installDesktopRuntimeMock(page, columnParityDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator('[data-sigma-doc-id="box_local_1"]').first()).toBeVisible();

  const presentation = await page.evaluate(() => {
    const bodyColumns = document.querySelector<HTMLElement>('[data-layout-section-id="body_local_columns"] .layout-section-independent-columns')!;
    const boxColumns = document.querySelector<HTMLElement>('[data-sigma-doc-id="box_local_columns"] .sigma-doc-layout-section-body')!;
    const read = (element: HTMLElement, ids: string[]) => {
      const rects = ids.map(id => document.querySelector<HTMLElement>(`[data-sigma-doc-id="${id}"]`)!.getBoundingClientRect());
      return {
        gap: getComputedStyle(element).columnGap,
        lineHeight: getComputedStyle(document.querySelector(`[data-sigma-doc-id="${ids[0]}"]`)!).lineHeight,
        topDelta: Math.abs(rects[1].top - rects[0].top),
        widthDelta: Math.abs(rects[1].width - rects[0].width),
      };
    };
    return { body: read(bodyColumns, ["body_local_1", "body_local_3"]), box: read(boxColumns, ["box_local_1", "box_local_3"]) };
  });
  expect(presentation.box.gap).toEqual(presentation.body.gap);
  expect(presentation.box.lineHeight).toEqual(presentation.body.lineHeight);
  for (const metrics of [presentation.body, presentation.box]) {
    expect(metrics.topDelta).toBeLessThanOrEqual(2);
    expect(metrics.widthDelta).toBeLessThan(2);
  }
  const rowMetrics = [];
  for (const id of ["body_local_1", "box_local_1"]) {
    await page.locator(`[data-sigma-doc-id="${id}"]`).first().click({ button: "right" });
    const menu = page.getByRole("menu", { name: "本文操作" });
    const row = menu.getByRole("menuitem", { name: "段組を変更", exact: true });
    await expect(row).toBeVisible();
    rowMetrics.push(await row.evaluate(element => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, padding: style.padding, gap: style.gap, fontSize: style.fontSize };
    }));
    await page.keyboard.press("Escape");
  }
  expect(rowMetrics[1]).toEqual(rowMetrics[0]);

  await expect(page.locator(".sigma-doc-layout-section-side-note")).toHaveCount(0);
  const bodySideNote = page.locator('[data-layout-section-id="body_local_columns"] > .layout-section-side-note');
  const boxSideNote = page.locator(
    '[data-box-layout-section-side-note="box_local_columns"] .layout-section-side-note',
  );
  await expect(bodySideNote).toContainText("2段組");
  await expect(boxSideNote).toContainText("2段組");

  const sideNoteGeometry = await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>(".page-backdrop .a4-page-sheet")?.getBoundingClientRect();
    const section = document.querySelector<HTMLElement>(
      '[data-sigma-doc-id="box_local_columns"].sigma-doc-layout-section-block',
    )?.getBoundingClientRect();
    const note = document.querySelector<HTMLElement>(
      '[data-box-layout-section-side-note="box_local_columns"] .layout-section-side-note',
    )?.getBoundingClientRect();
    if (!sheet || !section || !note) {
      throw new Error("box-local section side-note geometry was not rendered");
    }
    return {
      noteRight: note.right,
      noteTop: note.top,
      noteHeight: note.height,
      sectionTop: section.top,
      sectionHeight: section.height,
      sheetLeft: sheet.left,
    };
  });
  expect(sideNoteGeometry.noteRight).toBeLessThan(sideNoteGeometry.sheetLeft);
  expect(sideNoteGeometry.noteTop).toBeCloseTo(sideNoteGeometry.sectionTop, 0);
  expect(sideNoteGeometry.noteHeight).toBeCloseTo(sideNoteGeometry.sectionHeight, 0);
});

test("a box-local column guide appears immediately before its containing outer page column", async ({ page }) => {
  await installDesktopRuntimeMock(page, boxLocalColumnsInSecondOuterColumnDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const geometry = await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>(".page-backdrop .a4-page-sheet")?.getBoundingClientRect();
    const outerColumnBoundary = document.querySelector<HTMLElement>(
      ".page-backdrop .a4-page-sheet .page-column-guides span",
    )?.getBoundingClientRect();
    const section = document.querySelector<HTMLElement>(
      '[data-sigma-doc-id="inner_break_columns"].sigma-doc-layout-section-block',
    )?.getBoundingClientRect();
    const note = document.querySelector<HTMLElement>(
      '[data-box-layout-section-side-note="inner_break_columns"] .layout-section-side-note',
    )?.getBoundingClientRect();
    if (!sheet || !outerColumnBoundary || !section || !note) {
      throw new Error("outer-column side-note geometry was not rendered");
    }
    return {
      boundaryLeft: outerColumnBoundary.left,
      noteRight: note.right,
      sectionLeft: section.left,
      sheetLeft: sheet.left,
    };
  });

  expect(geometry.sectionLeft).toBeGreaterThan(geometry.boundaryLeft);
  expect(geometry.noteRight).toBeGreaterThan(geometry.sheetLeft);
  expect(geometry.noteRight).toBeLessThan(geometry.sectionLeft);
  expect(Math.abs(geometry.noteRight - (geometry.boundaryLeft - 10))).toBeLessThan(2);
});

test("Enter keeps inserting lines while editing a box continuation fragment", async ({ page }) => {
  test.setTimeout(120_000);
  // Keep enough complete rows after the first page boundary. With line-safe
  // fragmentation, 18 rows can leave only the closing frame in a continuation.
  const initialLineCount = 24;
  await installDesktopRuntimeMock(page, boxDocument(1, false, initialLineCount));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const continuation = page.locator(
    '.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]',
  );
  await expect(continuation.first()).toBeVisible();
  const lastContentFragment = continuation.filter({ has: page.locator("[data-sigma-doc-id]") }).last();
  await lastContentFragment.scrollIntoViewIfNeeded();
  const lastContentPoint = await continuation.evaluateAll((viewports) => {
    const contentFragments = viewports
      .map((viewport) => viewport.getBoundingClientRect())
      .filter((rect) => rect.height > 24);
    const rect = contentFragments.at(-1);
    if (!rect) {
      throw new Error("box continuation has no complete text row");
    }
    return { x: rect.left + 40, y: rect.bottom - 8 };
  });
  await page.mouse.click(lastContentPoint.x, lastContentPoint.y);
  await page.keyboard.press("End");
  await expect.poll(() => readCaretSurface(page)).toMatchObject({
    caretVisible: true,
    selectionSurface: { kind: "replica" },
    text: `箱の${initialLineCount}行目`,
  });

  const insertedLineCount = 6;
  for (let index = 1; index <= insertedLineCount; index += 1) {
    await page.keyboard.press("Enter");
    await expect.poll(() => savedBoxLineTexts(page)).toHaveLength(initialLineCount + index);
    await page.keyboard.insertText(`追加行 ${index}`);
    await expect.poll(async () => (await savedBoxLineTexts(page)).at(-1))
      .toBe(`追加行 ${index}`);
    await expect.poll(() => readCaretSurface(page)).toMatchObject({
      caretVisible: true,
      selectionSurface: { kind: "replica" },
      text: `追加行 ${index}`,
    });
  }

  await expect(page.locator('.page-flow [data-sigma-doc-id="inner_break_box"].text-flow-box-fragment-source'))
    .toHaveCount(1);
  await expect.poll(async () => page.locator(
    '.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]',
  ).count()).toBeGreaterThan(0);
  await expect.poll(async () => {
    const texts = await savedBoxLineTexts(page);
    return texts.at(-1);
  }).toBe(`追加行 ${insertedLineCount}`);
  await expect.poll(() => readCaretSurface(page)).toMatchObject({
    caretVisible: true,
    selectionSurface: { kind: "replica" },
    text: `追加行 ${insertedLineCount}`,
  });
});

test("断片が何個あっても復元でのフォーカス移動は 1 回", async ({ page }) => {
  test.setTimeout(120_000);
  await installDesktopRuntimeMock(page, boxDocument(1, false, 40));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const fragments = page.locator('.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]');
  await expect(fragments.first()).toBeVisible();
  // 正本 + 複製で 3 面以上 = ブロードキャストなら全部がフォーカスを奪い合う状況。
  expect(await fragments.count()).toBeGreaterThanOrEqual(2);

  const point = await visibleSourceLinePoint(page);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press("End");
  await expect.poll(() => readCaretSurface(page)).toMatchObject({ caretVisible: true });

  const focusCount = await countFocusIn(page, async () => {
    await page.keyboard.press("Enter");
    await expect.poll(() => savedBoxLineTexts(page)).toHaveLength(41);
    await expect.poll(() => readCaretSurface(page)).toMatchObject({ caretVisible: true });
  });

  expect(focusCount).toBeLessThanOrEqual(1);
});

test("跨ぎ選択の帯が二重に塗られない", async ({ page }) => {
  test.setTimeout(120_000);
  await installDesktopRuntimeMock(page, boxDocument(1, false, 24));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const sourceLine = page.locator(
    '.page-flow [data-box-fragment-source-id="inner_break_box"] [data-sigma-doc-id="inner_break_2"]',
  ).first();
  const sourceBounds = await sourceLine.boundingBox();
  const target = await page.locator(
    '.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]',
  ).last().evaluate((viewport) => {
    const viewportRect = viewport.getBoundingClientRect();
    const visible = Array.from(viewport.querySelectorAll<HTMLElement>("[data-sigma-doc-id]"))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > viewportRect.top + 2 && rect.top < viewportRect.bottom - 2)
      .at(-1);
    if (!visible) {
      throw new Error("continued box has no visible text row");
    }
    return {
      x: visible.rect.left + Math.min(visible.rect.width - 2, 40),
      y: Math.min(visible.rect.bottom - 2, viewportRect.bottom - 2),
    };
  });
  if (!sourceBounds) {
    throw new Error("box source line was not rendered");
  }

  await page.mouse.move(sourceBounds.x + 8, sourceBounds.y + sourceBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();

  // 帯を描く面の数と Range の数が一致すること。ルーターが `data-box-fragment-span` の
  // 付け外しまで奪うと、同じ面に 2 本の Range が積まれて帯が濃く二重に出る。
  await expect.poll(async () => {
    const state = await readCaretSurface(page);
    const highlightSize = await page.evaluate(() => CSS.highlights.get("text-run-span")?.size ?? 0);
    // 帯を描く面の数と Range の数が一致すること。面ごとに 1 本を超えると帯が濃く二重に出る。
    return { crossesFragments: state.spanSurfaceCount > 1, matches: highlightSize === state.spanSurfaceCount };
  }).toEqual({ crossesFragments: true, matches: true });
});

test("caret-surface ヘルパは意図的に取り違えた面を検出する", async ({ page }) => {
  test.setTimeout(120_000);
  await installDesktopRuntimeMock(page, boxDocument(1, false, 24));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(
    '.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]',
  ).first()).toBeVisible();

  const point = await visibleSourceLinePoint(page);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press("End");
  await expect.poll(() => readCaretSurface(page)).toMatchObject({
    caretVisible: true,
    selectionSurface: { fragmentIndex: 0, kind: "source" },
  });
  const placed = await readCaretSurface(page);
  expect(placed.activeSurface).toEqual(placed.selectionSurface);

  // わざと「最後の断片複製の 1 行目」へ DOM 選択を移す。複製はブロック全体の doc を持つので
  // blockId も textContent も正しく見えるが、その行は translateY で viewport の外にある。
  // 旧ヘルパ (blockId / textContent だけ) はこの状態を緑と判定していた。
  await page.evaluate(() => {
    const viewport = Array.from(document.querySelectorAll<HTMLElement>(
      '.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]',
    )).filter((candidate) => candidate.querySelector('[data-sigma-doc-id="inner_break_1"]')).at(-1);
    const target = viewport?.querySelector<HTMLElement>('[data-sigma-doc-id="inner_break_1"]');
    const text = target?.firstChild;
    if (!viewport || !target || !(text instanceof Text)) {
      throw new Error("misdirection target was not rendered");
    }
    viewport.querySelector<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(text, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  const misdirected = await readCaretSurface(page);
  expect(misdirected.blockId).toBe("inner_break_1");
  expect(misdirected.text).toBe("箱の1行目");
  expect(misdirected.selectionSurface?.kind).toBe("replica");
  expect(misdirected.caretVisible).toBe(false);
});

test("1 断片目の末尾で改行してもキャレットが見えている面に残る", async ({ page }) => {
  test.setTimeout(120_000);
  const initialLineCount = 24;
  await installDesktopRuntimeMock(page, boxDocument(1, false, initialLineCount));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(
    '.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]',
  ).first()).toBeVisible();

  const point = await visibleSourceLinePoint(page);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press("End");
  await expect.poll(() => readCaretSurface(page)).toMatchObject({
    caretVisible: true,
    selectionSurface: { fragmentIndex: 0, kind: "source" },
  });

  const focusCount = await countFocusIn(page, async () => {
    await page.keyboard.press("Enter");
    await expect.poll(() => savedBoxLineTexts(page)).toHaveLength(initialLineCount + 1);
    await expect.poll(() => readCaretSurface(page)).toMatchObject({
      caretVisible: true,
      collapsed: true,
    });
  });

  // 断片が何個あっても、復元でキャレットの所有権が移る回数は高々 1 回。
  expect(focusCount).toBeLessThanOrEqual(1);
  const settled = await readCaretSurface(page);
  expect(settled.activeSurface).toEqual(settled.selectionSurface);
  expect(settled.caretVisible).toBe(true);
  expect(settled.collapsed).toBe(true);

  // 紙面そのものが可視域に入っていること (「何も描かれていないページ」へ飛んでいない)。
  const geometry = await caretCanvasGeometry(page);
  expect(geometry.caretTop).toBeGreaterThanOrEqual(geometry.canvasTop - 1);
  expect(geometry.caretBottom).toBeLessThanOrEqual(geometry.canvasBottom + 1);
  expect(geometry.maxFragmentScrollTop).toBe(0);
});

test("タイピング中も断片 viewport の scrollTop が 0 のまま", async ({ page }) => {
  test.setTimeout(120_000);
  await installDesktopRuntimeMock(page, boxDocument(1, false, 24));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(
    '.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]',
  ).first()).toBeVisible();

  const point = await fragmentFirstLinePoint(page, 1);
  expect(point).not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
  await page.keyboard.press("End");

  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.insertText("あ");
    // `overflow: clip` は**スクロールコンテナ自体を作らない**ので、ブラウザ自身の
    // caret-into-view も ProseMirror の `scrollTop += moveY` もここを動かせない
    // (この assertion は CSS を戻したときだけ落ちる)。
    expect((await readCaretSurface(page)).maxFragmentScrollTop).toBe(0);
    // こちらは `handleScrollToSelection` 側の担保: 打つたびに紙面が飛んでいないこと。
    const geometry = await caretCanvasGeometry(page);
    expect(geometry.caretTop).toBeGreaterThanOrEqual(geometry.canvasTop - 1);
    expect(geometry.caretBottom).toBeLessThanOrEqual(geometry.canvasBottom + 1);
  }
});

test("ズームを変えても改行直後のキャレットが可視領域にある", async ({ page }) => {
  test.setTimeout(120_000);
  await installDesktopRuntimeMock(page, boxDocument(1, false, 24));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(
    '.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]',
  ).first()).toBeVisible();

  const zoomIn = page.locator('button[aria-label="拡大"]');
  for (let index = 0; index < 3; index += 1) {
    await zoomIn.click({ timeout: 5000 });
  }
  await expect.poll(() => page.evaluate(() => Number.parseFloat(
    getComputedStyle(document.querySelector(".page-stack")!).getPropertyValue("--editor-zoom"),
  ))).toBeGreaterThan(1);

  const point = await visibleSourceLinePoint(page);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect.poll(() => savedBoxLineTexts(page)).toHaveLength(25);

  await expect.poll(() => readCaretSurface(page)).toMatchObject({ caretVisible: true });
  const geometry = await caretCanvasGeometry(page);
  expect(geometry.caretTop).toBeGreaterThanOrEqual(geometry.canvasTop - 1);
  expect(geometry.caretBottom).toBeLessThanOrEqual(geometry.canvasBottom + 1);
  expect(geometry.maxFragmentScrollTop).toBe(0);
});

/** キャレット矩形と紙面スクローラーの矩形 (どちらも client 座標)。 */
async function caretCanvasGeometry(page: Page): Promise<{
  canvasBottom: number;
  canvasTop: number;
  caretBottom: number;
  caretTop: number;
  maxFragmentScrollTop: number;
}> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const canvas = document.querySelector(".editor-canvas");
    if (!selection || selection.rangeCount === 0 || !canvas) {
      throw new Error("caret or canvas was not rendered");
    }
    const caret = selection.getRangeAt(0).getBoundingClientRect();
    const view = canvas.getBoundingClientRect();
    return {
      canvasBottom: view.bottom,
      canvasTop: view.top,
      caretBottom: caret.bottom,
      caretTop: caret.top,
      maxFragmentScrollTop: Array.from(
        document.querySelectorAll<HTMLElement>(".editor-box-fragment-viewport"),
      ).reduce((largest, viewport) => Math.max(largest, viewport.scrollTop), 0),
    };
  });
}

/**
 * 正本 (source) の可視帯に完全に収まっている最後の行の中心座標。ここが「1 断片目の末尾」で、
 * 改行するとブロックが伸びて再ページ割りが走る。
 */
async function visibleSourceLinePoint(page: Page): Promise<{ blockId: string; x: number; y: number }> {
  return page.evaluate(() => {
    const source = document.querySelector<HTMLElement>(
      '.page-flow [data-box-fragment-source-id="inner_break_box"]',
    );
    if (!source) {
      throw new Error("fragment source was not rendered");
    }
    const sourceRect = source.getBoundingClientRect();
    const visibleHeight = Number.parseFloat(
      getComputedStyle(source).getPropertyValue("--text-flow-box-fragment-visible-height"),
    );
    // 可視高さはズーム前の紙面 px、矩形は client px。実寸との比で倍率を掛ける。
    const scale = source.offsetHeight > 0 ? sourceRect.height / source.offsetHeight : 1;
    const bottom = Number.isFinite(visibleHeight)
      ? sourceRect.top + visibleHeight * (Number.isFinite(scale) && scale > 0 ? scale : 1)
      : sourceRect.bottom;
    const visibleLine = Array.from(source.querySelectorAll<HTMLElement>("[data-sigma-doc-id]"))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((entry) => entry.rect.height > 0
        && entry.rect.bottom <= bottom + 0.5
        && Boolean(entry.element.textContent))
      .at(-1);
    if (!visibleLine) {
      throw new Error("fragment source has no fully visible line");
    }
    visibleLine.element.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = visibleLine.element.getBoundingClientRect();
    return {
      blockId: visibleLine.element.dataset.sigmaDocId ?? "",
      x: rect.left + 8,
      y: rect.top + rect.height / 2,
    };
  });
}

test("断片境界を上下に往復してもキャレットが対称に戻る", async ({ page }) => {
  test.setTimeout(120_000);
  await installDesktopRuntimeMock(page, boxDocument(1, false, 30));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(
    '.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]',
  ).first()).toBeVisible();

  // 断片の先頭行に置く。ここで ↑ を押すと、複製はブロック全体の doc を持つのでネイティブ
  // 移動が「成功」してしまい、見えない行へ入ったままになるのが症状 (2) の主因だった。
  let checked = 0;
  for (const fragmentIndex of [1, 2]) {
    const point = await fragmentFirstLinePoint(page, fragmentIndex);
    if (!point) {
      continue;
    }
    checked += 1;
    await page.mouse.click(point.x, point.y);
    await expect.poll(() => readCaretSurface(page)).toMatchObject({ caretVisible: true });
    const before = await readCaretSurface(page);

    await page.keyboard.press("ArrowUp");
    await expect.poll(() => readCaretSurface(page)).toMatchObject({ caretVisible: true });
    const up = await readCaretSurface(page);
    expect(up.activeSurface).toEqual(up.selectionSurface);
    // 断片の先頭行から ↑ なので、必ず 1 つ前の面へ出ていること。
    expect(up.selectionSurface).not.toEqual(before.selectionSurface);

    await page.keyboard.press("ArrowDown");
    await expect.poll(() => readCaretSurface(page)).toMatchObject({ caretVisible: true });
    const back = await readCaretSurface(page);
    expect(back.selectionSurface).toEqual(before.selectionSurface);
    expect(back.blockId).toBe(before.blockId);
    expect(back.offset).toBe(before.offset);
  }
  // 断片が 1 つも無いと assertion 0 件のまま緑になってしまう。
  expect(checked).toBeGreaterThan(0);
});

test("preferredX が断片を跨いでも保たれる", async ({ page }) => {
  test.setTimeout(120_000);
  await installDesktopRuntimeMock(page, boxDocument(1, false, 30));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(
    '.editor-box-fragment-viewport[data-box-source-id="inner_break_box"]',
  ).first()).toBeVisible();

  const point = await fragmentFirstLinePoint(page, 1);
  if (!point) {
    test.skip(true, "断片が 1 つも作られなかった");
    return;
  }
  // 行の右寄りに置く。preferredX を捨てると、面を跨いだ後に行頭へ寄ってしまう。
  await page.mouse.click(point.rightX, point.y);
  await expect.poll(() => readCaretSurface(page)).toMatchObject({ caretVisible: true });
  const before = await readCaretSurface(page);
  expect(before.offset).toBeGreaterThan(0);

  await page.keyboard.press("ArrowUp");
  await expect.poll(() => readCaretSurface(page)).toMatchObject({ caretVisible: true });
  const up = await readCaretSurface(page);
  expect(up.offset).toBeGreaterThan(0);

  await page.keyboard.press("ArrowDown");
  await expect.poll(() => readCaretSurface(page)).toMatchObject({ caretVisible: true });
  expect((await readCaretSurface(page)).offset).toBe(before.offset);
});

/** 指定した断片の複製の、最初の**見えている**行の座標。 */
async function fragmentFirstLinePoint(
  page: Page,
  fragmentIndex: number,
): Promise<{ rightX: number; x: number; y: number } | null> {
  return page.evaluate((index) => {
    const viewport = document.querySelector<HTMLElement>(
      `.editor-box-fragment-viewport[data-box-source-id="inner_break_box"][data-box-fragment-index="${index}"]`,
    );
    if (!viewport) {
      return null;
    }
    const viewportRect = viewport.getBoundingClientRect();
    const line = Array.from(viewport.querySelectorAll<HTMLElement>("[data-sigma-doc-id]"))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .find((entry) => (
        entry.rect.height > 0
        && entry.rect.top >= viewportRect.top - 1
        && entry.rect.bottom <= viewportRect.bottom + 1
        && Boolean(entry.element.textContent)
      ));
    if (!line) {
      return null;
    }
    viewport.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = line.element.getBoundingClientRect();
    return {
      rightX: rect.left + Math.max(8, rect.width - 6),
      x: rect.left + 8,
      // ブロックの**最初の行**を狙う (垂直中央だと複数行ブロックで 1 行目にならない)。
      y: rect.top + Math.min(6, rect.height / 2),
    };
  }, fragmentIndex);
}

async function savedBoxLineTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const parsed = raw ? JSON.parse(raw) : null;
    const box = parsed?.content?.find((block: { id?: string }) => block.id === "inner_break_box");
    return (box?.blocks ?? []).map(
      (block: { children?: Array<{ text?: string }> }) =>
        block.children?.map((child) => child.text ?? "").join("") ?? "",
    );
  });
}

function columnParityDocument(): SigmaDocument {
  const box = createBoxBlock("itembox", "", {
    id: "column_parity_box",
    bodyId: "box_local_1",
  });
  box.blocks = [{
    type: "layoutSection",
    id: "box_local_columns",
    layout: { columnCount: 2, columnGapMm: 7 },
    children: Array.from({ length: 4 }, (_, index) => ({
      type: "paragraph" as const,
      id: `box_local_${index + 1}`,
      children: [{ type: "text" as const, text: `箱内段組 ${index + 1}` }],
    })),
  }];

  return {
    version: "2.0",
    docId: "doc_local_column_presentation_parity",
    metadata: { title: "局所段組エンジンの統一" },
    content: [{
      type: "layoutSection",
      id: "body_local_columns",
      layout: { columnCount: 2, columnGapMm: 7, columnStartIds: ["body_local_1", "body_local_3"] },
      children: Array.from({ length: 4 }, (_, index) => ({
        type: "paragraph" as const,
        id: `body_local_${index + 1}`,
        children: [{ type: "text" as const, text: `本文段組 ${index + 1}` }],
      })),
    }, box],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    },
  };
}
