import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";
import { normalizePageLayout, type ParagraphNode } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;

// Synthetic comparison rows: no customer documents or email attachments belong in the repository.
function comparisonDocument(preset: "A4" | "B5", pages: number) {
  const document = createBlankDocument(`${preset} comparison`);
  document.docId = `comparison_${preset}`;
  document.pageLayout = normalizePageLayout({ ...document.pageLayout, preset, pageSize: undefined });
  const families = [undefined,
    '"Yu Mincho", YuMincho, "Hiragino Mincho ProN", "BIZ UDPMincho", serif',
    '"MS PMincho", "Yu Mincho", "Hiragino Mincho ProN", serif'];
  const rows: ParagraphNode[] = families.map((fontFamily, index) => ({
    type: "paragraph", id: `${preset}_row_${index}`,
    ...(index === 0 ? { pagination: { break: true } } : {}),
    children: [
      { type: "text", text: "12pt PQあいうえお　", ...(fontFamily ? { fontFamily } : {}), ...(index === 2 ? { fontSize: 12 } : {}) },
      { type: "text", text: "11pt PQあいうえお", fontSize: 11, ...(fontFamily ? { fontFamily } : {}) },
    ],
  }));
  document.content = [
    ...Array.from({ length: pages - 1 }, (_, index): ParagraphNode => ({
      type: "paragraph", id: `${preset}_page_${index}`,
      children: [{ type: "text", text: `Page ${index + 1}` }],
      ...(index > 0 ? { pagination: { break: true } } : {}),
    })),
    ...rows,
    { type: "paragraph", id: `${preset}_paste`, children: [] },
  ];
  return { document, rows };
}

test("B5 page 14 and A4 page 2 keep 11/12pt typography through native cross-file copy and reload", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-font-copy-pages-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await expect(page.locator("[data-startup-splash]")).toBeHidden();
    const fixtures = [comparisonDocument("B5", 14), comparisonDocument("A4", 2)];
    const ids = await page.evaluate(async (documents) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const storage = window.desktopAPI!.storage;
      const ids = [];
      for (const document of documents) ids.push((await storage.createFileFromDocument({ document })).file.fileId);
      await storage.saveWorkspace({ openFileIds: ids, activeFileId: ids[0] });
      return ids;
    }, fixtures.map(({ document }) => document));
    await page.reload();
    await expect(page.locator("[data-startup-splash]")).toBeHidden();
    const measurements: unknown[] = [];
    const platformFonts: unknown[] = [];
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    for (const [index, { rows }] of fixtures.entries()) {
      await page.locator(`[data-tab-id="document:${ids[index]}"]`).getByRole("tab").click();
      await expect(page.locator("[data-page-count]").first()).toHaveAttribute("data-page-count", index === 0 ? "14" : "2");
      await page.locator(`[data-sigma-doc-id="${rows[0].id}"]`).first().scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      const sizes = await page.evaluate((ids) => ids.map(id => {
        const block = document.querySelector(`.page-flow [data-sigma-doc-id="${id}"]`)!;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        const runs = [];
        let node;
        while ((node = walker.nextNode())) {
          if (!node.textContent?.trim()) continue;
          const style = getComputedStyle(node.parentElement!);
          runs.push({ size: Number.parseFloat(style.fontSize), family: style.fontFamily });
        }
        return runs;
      }), rows.map(row => row.id));
      for (const runs of sizes) {
        expect(runs[0].size).toBeCloseTo(16, 3);
        expect(runs[1].size).toBeCloseTo(44 / 3, 3);
      }
      measurements.push(sizes);
      const { root } = await cdp.send("DOM.getDocument");
      const fonts = [];
      for (const row of rows) {
        const { nodeId } = await cdp.send("DOM.querySelector", {
          nodeId: root.nodeId, selector: `.page-flow [data-sigma-doc-id="${row.id}"]`,
        });
        fonts.push(await cdp.send("CSS.getPlatformFontsForNode", { nodeId }));
      }
      if (process.env.SIGMA_STUDIO_E2E_REQUIRE_JAPANESE_FONTS === "1") {
        expect(fonts[1].fonts.map(font => font.familyName)).toContain("Yu Mincho");
        expect(fonts[2].fonts.map(font => font.familyName)).toContain("MS PMincho");
      }
      platformFonts.push(fonts);
    }
    expect(measurements[0]).toEqual(measurements[1]);
    await testInfo.attach("rendered-fonts.json", {
      body: JSON.stringify({ platform: process.platform, measurements, platformFonts }, null, 2),
      contentType: "application/json",
    });
    await cdp.detach();

    await page.locator(`[data-tab-id="document:${ids[0]}"]`).getByRole("tab").click();
    const rows = fixtures[0].rows;
    await page.locator(`[data-sigma-doc-id="${rows[0].id}"]`).first().scrollIntoViewIfNeeded();
    const points = await page.evaluate((ids) => {
      const first = document.querySelector(`.page-flow [data-sigma-doc-id="${ids[0]}"]`)!;
      const last = document.querySelector(`.page-flow [data-sigma-doc-id="${ids[2]}"]`)!;
      const start = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()!;
      const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT);
      let end = start;
      let node;
      while ((node = walker.nextNode())) if (node.textContent?.trim()) end = node;
      const range = document.createRange();
      range.setStart(start, 0); range.setEnd(start, 1);
      const from = range.getBoundingClientRect();
      range.setStart(end, end.textContent!.length - 1); range.setEnd(end, end.textContent!.length);
      const to = range.getBoundingClientRect();
      return { from: { x: from.left + 0.1, y: from.top + from.height / 2 }, to: { x: to.right + 1, y: to.top + to.height / 2 } };
    }, rows.map(row => row.id));
    await page.mouse.move(points.from.x, points.from.y);
    await page.mouse.down();
    await page.mouse.move(points.to.x, points.to.y, { steps: 20 });
    await page.mouse.up();
    await page.keyboard.press("ControlOrMeta+c");
    const expectedText = rows.map(row => row.children.map(child => child.type === "text" ? child.text : "").join("")).join("\n");
    await expect.poll(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, "\n")).toBe(expectedText);
    await page.locator(`[data-tab-id="document:${ids[1]}"]`).getByRole("tab").click();
    await page.locator('[data-sigma-doc-id="A4_paste"]').first().click();
    await page.keyboard.press("ControlOrMeta+v");
    const readPastedRows = () => page.evaluate(async (id) => {
      const saved = await window.desktopAPI!.storage.loadDocument(id);
      return saved?.content.slice(-3).map(block => block.type === "paragraph" ? block.children : null);
    }, ids[1]);
    await expect.poll(readPastedRows).toEqual(rows.map(row => row.children));
    await page.reload();
    await expect(page.locator("[data-startup-splash]")).toBeHidden();
    expect(await readPastedRows()).toEqual(rows.map(row => row.children));
    await page.locator(".editor-canvas").first().evaluate(element => { element.scrollTop = element.scrollHeight; });
    const pastedIds = await page.evaluate(async (id) => {
      const saved = await window.desktopAPI!.storage.loadDocument(id);
      return saved!.content.slice(-3).map(block => block.id);
    }, ids[1]);
    await expect(page.locator(`.page-flow [data-sigma-doc-id="${pastedIds[0]}"]`).first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const reloadedSizes = await page.evaluate((ids) => ids.map(id => {
      const block = document.querySelector(`.page-flow [data-sigma-doc-id="${id}"]`)!;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const runs = [];
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.trim()) continue;
        const style = getComputedStyle(node.parentElement!);
        runs.push({ size: Number.parseFloat(style.fontSize), family: style.fontFamily });
      }
      return runs;
    }), pastedIds);
    expect(reloadedSizes).toEqual(measurements[0]);
    await page.locator(`.page-flow [data-sigma-doc-id="${pastedIds[0]}"]`).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("font-size-copy-reloaded.png") });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
