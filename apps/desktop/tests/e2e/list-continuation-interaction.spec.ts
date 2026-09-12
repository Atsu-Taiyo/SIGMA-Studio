import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { SigmaDocument } from '@/features/document';
import { installDesktopRuntimeMock } from './desktop-runtime-mock';
import { readCaretSurface } from './caret-surface';
import { selectUiOptionInPage } from './ui-select';

function fixture(): SigmaDocument {
  if (process.env.SIGMA_PAGINATION_DOCUMENT) {
    return JSON.parse(readFileSync(process.env.SIGMA_PAGINATION_DOCUMENT, 'utf8'));
  }
  return {
    version: '2.0', docId: 'list_continuation', metadata: { title: 'リストの続き' },
    content: [{
      type: 'problem', id: 'problem', lead: [],
      prompt: [{
        type: 'list', id: 'list', listType: 'ordered', markerStyle: 'paren',
        items: Array.from({ length: 8 }, (_, i) => ({
          type: 'listItem', id: `item_${i}`, children: [
            { type: 'text', text: `条件${i + 1}を満たす範囲について、次の式を使って体積を求めよ。` },
            { type: 'mathInline', display: 'inline', id: `math_${i}`, tex: '\\sin\\alpha=\\dfrac{1}{\\sqrt{3}}' },
            { type: 'text', text: 'を満たす実数を用いてよい。' },
          ],
        })),
      }, { type: 'paragraph', id: 'following', children: [{ type: 'text', text: 'リストの後の条件' }] }],
      solution: [], hints: [], tags: [],
    }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: 'custom', orientation: 'portrait', pageSize: { widthMm: 180, heightMm: 140 },
      marginsMm: { top: 18, right: 17, bottom: 18, left: 18.5 },
      flow: { type: 'columns', columnCount: 1, columnGapMm: 8 },
    },
  };
}

async function visibleLastRow(page: Page) {
  return page.evaluate(() => {
    const copies = Array.from(document.querySelectorAll<HTMLElement>('.editor-box-fragment-viewport'));
    for (const viewport of copies.reverse()) {
      const rows = Array.from(viewport.querySelectorAll<HTMLElement>('[data-sigma-doc-type="listItem"]'));
      const row = rows.at(-1);
      if (!row) continue;
      const r = row.getBoundingClientRect(), v = viewport.getBoundingClientRect();
      if (r.bottom < v.top) continue;
      // A long item may start on the previous page. Its visible part is the
      // interaction target; actual glyphs must still fall wholly within a page.
      const contentRects = Array.from(row.querySelectorAll<HTMLElement>('.inline-math-node'))
        .map((math) => math.getBoundingClientRect());
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        // Math glyph font boxes can exceed the actual expression ink. Its
        // rendered layout box is the shared editor/pagination boundary.
        if (node.parentElement?.closest('.inline-math-node')) continue;
        range.selectNodeContents(node);
        contentRects.push(...Array.from(range.getClientRects()));
      }
      const cutGlyphs = contentRects.filter((glyph) => glyph.width > 0 && glyph.height > 0
        && glyph.bottom > v.top + 1 && glyph.top < v.bottom - 1
        && (glyph.top < v.top - 1 || glyph.bottom > v.bottom + 1)).length;
      return {
        id: row.dataset.sigmaDocId!, top: Math.max(r.top, v.top), bottom: r.bottom, left: r.left, right: r.right,
        viewportTop: v.top, viewportBottom: v.bottom, sourceId: viewport.dataset.boxSourceId!,
        itemCount: rows.length, text: row.textContent, cutGlyphs,
      };
    }
    return null;
  });
}

async function assertRowVisible(page: Page) {
  await expect.poll(async () => {
    const row = await visibleLastRow(page);
    return row ? Math.max(row.bottom - row.viewportBottom, row.viewportTop - row.top, row.cutGlyphs ? 999 : 0) : 999;
  }).toBeLessThanOrEqual(1);
}

for (const zoom of ['100', '150']) {
  test(`continued list grows, stays selectable on its visible page, and survives reload at ${zoom}%`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1400, height: 1000 });
    await installDesktopRuntimeMock(page, fixture());
    await page.goto('/');
    await expect(page.locator('.startup-splash')).toBeHidden();
    if (zoom !== '100') await selectUiOptionInPage(page, 'ズーム', zoom);
    await expect(page.locator('.editor-box-fragment-viewport').first()).toBeVisible({ timeout: 30000 });
    await assertRowVisible(page);
    let row = (await visibleLastRow(page))!;
    await page.locator(`.editor-box-fragment-viewport[data-box-source-id="${row.sourceId}"]`).last().scrollIntoViewIfNeeded();
    await page.locator(`.editor-box-fragment-viewport [data-sigma-doc-id="${row.id}"]`).last().scrollIntoViewIfNeeded();
    row = (await visibleLastRow(page))!;
    await page.mouse.move(row.left + 30, (row.top + row.bottom) / 2);
    const grip = page.locator(`.page-block-handle[data-block-id="${row.id}"]`);
    await expect(grip).toBeVisible();
    const edge = page.locator(`.page-block-space-handle[data-block-id="${row.id}"]`);
    await expect(edge).toBeVisible();
    const edgeBox = (await edge.boundingBox())!;
    expect(Math.abs(edgeBox.y + edgeBox.height / 2 - row.bottom)).toBeLessThan(5);
    const gripBox = (await grip.boundingBox())!;
    expect(gripBox.y).toBeGreaterThanOrEqual(row.top - 20);
    expect(gripBox.y).toBeLessThan(row.bottom);
    // Approach through the gutter, not a jump directly onto the control.
    for (let step = 1; step <= 6; step += 1) {
      const startX = row.left + 30;
      const endX = gripBox.x + gripBox.width / 2;
      await page.mouse.move(startX + (endX - startX) * step / 6, gripBox.y + gripBox.height / 2);
      await expect(grip).toBeVisible();
    }
    await grip.click();
    const outlines = await page.locator('.page-block-selection-outline').evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().toJSON()),
    );
    const outline = outlines.find((box) => box.top <= (row.top + row.bottom) / 2
      && box.bottom >= (row.top + row.bottom) / 2);
    expect(outline).toBeDefined();
    expect(outline!.top).toBeGreaterThanOrEqual(row.top - 1);
    expect(outline!.bottom).toBeLessThanOrEqual(row.bottom + 1);
    const sheets = await page.locator('.page-backdrop .a4-page-sheet').evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().toJSON()),
    );
    for (const piece of outlines) {
      expect(sheets.some((sheet) => piece.top >= sheet.top - 1 && piece.bottom <= sheet.bottom + 1)).toBe(true);
    }
    // Dismiss the block menu, then place the caret at the final visible text node.
    await page.keyboard.press('Escape');
    const lastTextPoint = await page.evaluate((id) => {
      const element = Array.from(document.querySelectorAll<HTMLElement>(`.editor-box-fragment-viewport [data-sigma-doc-id="${id}"]`)).at(-1)!;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim() && !node.parentElement?.closest('[contenteditable="false"]')) last = node as Text;
      }
      const range = document.createRange();
      range.setStart(last!, Math.max(0, last!.length - 1)); range.setEnd(last!, last!.length);
      const r = range.getBoundingClientRect(); return { x: r.right - 1, y: (r.top + r.bottom) / 2 };
    }, row.id);
    // Edit the continuation through the actual browser caret, adding another numbered item.
    await page.mouse.click(lastTextPoint.x, lastTextPoint.y);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('追加した設問。条件を確認して計算する。'.repeat(8));
    await assertRowVisible(page);
    await expect.poll(async () => (await visibleLastRow(page))?.itemCount).toBe(row.itemCount + 1);
    await expect.poll(async () => (await visibleLastRow(page))?.text).toContain('追加した設問');
    await expect.poll(async () => (await readCaretSurface(page)).caretVisible).toBe(true);
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('sigma-studio:e2e-document'))).toContain('追加した設問');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('sigma-studio:e2e-document')!)) as SigmaDocument;
    await installDesktopRuntimeMock(page, saved);
    await page.reload();
    await expect(page.locator('.startup-splash')).toBeHidden();
    if (zoom !== '100') await selectUiOptionInPage(page, 'ズーム', zoom);
    await expect(page.locator('.editor-box-fragment-viewport').first()).toBeVisible();
    await assertRowVisible(page);
  });

}
