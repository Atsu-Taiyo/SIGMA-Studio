import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { normalizePageLayout } from "@/lib/page-layout";

for (const columns of [2, 3]) test(`${columns} local columns split separator and resize guides across pages and preserve immediate settings`, async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-column-rule-"));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SIGMA_STUDIO_USER_DATA_DIR: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    const mainWindow = await app.browserWindow(page);
    await mainWindow.evaluate(nativeWindow => nativeWindow.setContentSize(1280, 800));
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".workspace-tab-group")).toHaveCount(1);
    const source = structuredClone(sampleDocument);
    source.docId = "column_rule_pagination";
    source.metadata = { title: "段間の線の改ページ確認" };
    source.comments = [];
    source.pageLayout = normalizePageLayout(source.pageLayout);
    source.pageLayout.flow = { type: "columns", columnCount: 1, columnGapMm: 8 };
    source.pageLayout.overlay = undefined;
    source.content = [{
      type: "layoutSection", id: "columns",
      layout: { columnCount: columns, columnGapMm: 8,
        columnStartIds: Array.from({ length: columns }, (_, i) => `c${i}_p0`),
        columnRule: { style: "solid", widthPx: 2, color: "#123456" } },
      children: Array.from({ length: columns }, (_, col) => Array.from({ length: 55 - col * 8 }, (_, row) => ({
        type: "paragraph" as const, id: `c${col}_p${row}`,
        children: [{ type: "text" as const, text: `${col + 1}段目 ${row + 1}行` }],
      }))).flat(),
    }];
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, source);
    for (let reopen = 0; reopen < 2; reopen++) {
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden();
      const grid = page.locator('.page-flow [data-layout-section-id="columns"] .layout-section-independent-columns').first();
      await expect(grid).toBeVisible();
      await expect.poll(() => grid.locator(':scope > .column-rule-separator').count()).toBeGreaterThan(columns - 1);
      const geometry = await grid.evaluate(element => {
        const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, height: r.height }; };
        return {
          rules: Array.from(element.querySelectorAll(':scope > .column-rule-separator')).map(rect),
          handles: Array.from(element.querySelectorAll(':scope > .layout-section-column-resize-handle')).map(rect),
          paragraphs: Array.from(element.querySelectorAll('[data-sigma-doc-id]')).filter(e => /^c\d+_p\d+$/.test(e.getAttribute('data-sigma-doc-id') ?? '')).map(rect),
        };
      });
      expect(geometry.handles.length).toBe(geometry.rules.length);
      for (const rule of geometry.rules) {
        expect(rule.height).toBeGreaterThan(0);
        expect(geometry.handles.some(handle => Math.abs(handle.top - rule.top) < 1 && Math.abs(handle.bottom - rule.bottom) < 1)).toBe(true);
      }
      const segments = geometry.rules.slice(0, geometry.rules.length / (columns - 1));
      for (let i = 1; i < segments.length; i++) expect(segments[i].top - segments[i - 1].bottom).toBeGreaterThan(35);
      const bodyBottom = Math.max(...geometry.paragraphs.map(p => p.bottom));
      expect(Math.abs(Math.max(...geometry.rules.map(p => p.bottom)) - bodyBottom)).toBeLessThan(20);
      if (!reopen) {
        await grid.locator('[data-sigma-doc-id="c0_p0"]').click({ button: "right" });
        await page.getByRole("menuitem", { name: "段間の線", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "段間の線", exact: true });
        await expect(dialog.getByRole("button", { name: /^(キャンセル|適用)$/ })).toHaveCount(0);
        await dialog.getByRole("button", { name: /^線種/ }).click();
        await page.getByRole("menuitemradio", { name: "破線", exact: true }).click();
        await expect(grid.locator(':scope > .column-rule-separator').first()).toHaveCSS("border-left-style", "dashed");
        await expect.poll(() => page.evaluate(async id => {
          const doc = await window.desktopAPI!.storage.loadDocument(id);
          const section = doc?.content[0];
          return section?.type === "layoutSection" ? section.layout.columnRule?.style : null;
        }, fileId)).toBe("dashed");
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        // The continuation-page guide remains an actual resize handle.
        const continuation = grid.locator(':scope > .layout-section-column-resize-handle[data-divider-index="0"]').nth(1);
        await continuation.hover();
        const handleRect = await continuation.boundingBox();
        if (!handleRect) throw new Error("missing continuation handle");
        const x = handleRect.x + handleRect.width / 2;
        const y = Math.max(150, Math.min(handleRect.y + handleRect.height - 20, 600));
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 35, y, { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => page.evaluate(async id => {
          const doc = await window.desktopAPI!.storage.loadDocument(id);
          const section = doc?.content[0];
          return section?.type === "layoutSection" ? section.layout.columnWidths?.[0] ?? 0 : 0;
        }, fileId)).toBeGreaterThan(10000 / columns);
      } else {
        await expect(grid.locator(':scope > .column-rule-separator').first()).toHaveCSS("border-left-style", "dashed");
      }
    }
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
