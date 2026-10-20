import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout, type ParagraphNode, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;
const paragraph = (id: string, text: string): ParagraphNode => ({ type: "paragraph", id, children: [{ type: "text", text, fontSize: 12 }] });

function fixture(fragmented: boolean): SigmaDocument {
  const document = ensurePageLayout({
    ...structuredClone(sampleDocument), version: "2.0", docId: `selection_retention_${fragmented}`,
    metadata: { title: "選択バーの連続書式変更", styleUnits: { fontSize: "pt" } },
    content: Array.from({ length: 40 }, (_, i) => paragraph(`p${i + 1}`, `${i + 1}. これは選択範囲の確認用の本文です。同じ範囲へ続けて書式を適用し、問題枠を越えても選択範囲全体が同じ文字サイズになることを確かめます。`)),
  });
  document.content.splice(6, 0, {
    type: "problem", id: "problem", tags: [], lead: [], hints: [], solution: [],
    prompt: [paragraph("prompt", "問題文も選択範囲のすべてに書式が適用されます。")],
  });
  // A larger font creates pages/running-region editors while the range is active.
  document.pageLayout!.header = { enabled: true, heightMm: 10, offsetMm: 5, showOnFirstPage: true, blocks: [paragraph("header", "選択保持の検証")] };
  if (fragmented) document.content = [
    paragraph("filler", "先行する行\n".repeat(28)),
    paragraph("split", Array.from({ length: 70 }, (_, i) => `行${String(i).padStart(2, "0")} 分割された段落の一部だけを選択して書式を続けて変更します。`).join(" ")),
  ];
  return document;
}

async function openFixture(document: SigmaDocument) {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const userData = mkdtempSync(path.join(tmpdir(), "sigma-selection-retention-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = userData;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${userData}`], cwd: APP_ROOT, env }).catch(error => {
    rmSync(userData, { recursive: true, force: true }); throw error;
  });
  const close = async () => { try { await app.close(); } finally { rmSync(userData, { recursive: true, force: true }); } };
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 1200 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const created = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const result = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [result.file.fileId], activeFileId: result.file.fileId });
      return result;
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(`.page-flow [data-sigma-doc-id="${document.content[0].id}"]`).first()).toBeVisible();
    return { page, fileId: created.file.fileId, close };
  } catch (error) { await close(); throw error; }
}

async function textPoint(block: Locator, offset: number) {
  return block.evaluate((element, offset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (remaining <= node.textContent!.length) {
        const range = document.createRange();
        range.setStart(node, remaining); range.collapse(true);
        const rect = range.getClientRects()[0];
        if (!rect) throw new Error(`No caret rectangle at ${offset}`);
        return { x: rect.x + 0.5, y: rect.y + rect.height / 2 };
      }
      remaining -= node.textContent!.length;
    }
    throw new Error(`Missing text offset ${offset}`);
  }, offset);
}

async function drag(page: Page, start: Locator, from: number, end: Locator, to: number) {
  const a = await textPoint(start, from);
  const b = await textPoint(end, to);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 20 }); await page.mouse.up();
}

/** Inspect the actual Highlight ranges painted by TextRunSelectionOverlay, including every glyph. */
async function paintedSelection(page: Page, ids: string[], scope = ".page-flow") {
  return page.evaluate(({ ids, scope }) => {
    const highlights = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
    const ranges = Array.from(highlights.get("text-run-span") ?? []);
    return ids.map(id => {
      const block = document.querySelector(`${scope} [data-sigma-doc-id="${id}"]`)!;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const selected: { offset: number; size: number; char: string }[] = [];
      let offset = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let i = 0; i < node.textContent!.length; i++, offset++) {
          if (ranges.some(range => range.comparePoint(node, i) === 0 && range.comparePoint(node, i + 1) === 0)) {
            selected.push({ offset, char: node.textContent![i], size: Number.parseFloat(getComputedStyle(node.parentElement!).fontSize) * 3 / 4 });
          }
        }
      }
      return { id, offsets: selected.map(glyph => glyph.offset), text: selected.map(glyph => glyph.char).join(""), sizes: [...new Set(selected.map(glyph => Math.round(glyph.size * 1000) / 1000))] };
    });
  }, { ids, scope });
}

async function savedSizes(page: Page, fileId: string, id: string) {
  return page.evaluate(async ({ fileId, id }) => {
    const doc = await window.desktopAPI!.storage.loadDocument(fileId);
    const find = (value: unknown): { children?: { text?: string; fontSize?: number }[] } | null => {
      if (!value || typeof value !== "object") return null;
      if ((value as { id?: string }).id === id) return value;
      for (const child of Object.values(value)) { const result = find(child); if (result) return result; }
      return null;
    };
    return find(doc)?.children?.flatMap(node => Array.from(node.text ?? "", () => node.fontSize ?? 12)) ?? [];
  }, { fileId, id });
}

async function assertSavedRange(page: Page, fileId: string, id: string, offsets: number[], size: number, length: number) {
  const selected = new Set(offsets);
  await expect.poll(() => savedSizes(page, fileId, id)).toEqual(Array.from({ length }, (_, index) => selected.has(index) ? size : 12));
}

const toolbar = (page: Page) => page.locator(".selection-action-popover").filter({ has: page.getByRole("button", { name: "フォントサイズを大きく", exact: true }) });

test("a real drag across p5, a problem prompt and p7 stays selected through three size increments", async () => {
  const source = fixture(false);
  const { page, fileId, close } = await openFixture(source);
  try {
    const block = (id: string) => page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
    await block("p5").scrollIntoViewIfNeeded();
    await drag(page, block("p5"), 5, block("p7"), 12);
    const ids = ["p5", "p6", "prompt", "p7"];
    await expect.poll(async () => (await paintedSelection(page, ids)).every(range => range.offsets.length > 0)).toBe(true);
    const initial = await paintedSelection(page, ids);
    const spanUnits = page.locator(".ProseMirror[data-text-run-span]");
    const assertSelectedUnits = async () => {
      // The empty problem lead may also have a surface in the cross-editor span.
      await expect.poll(() => spanUnits.count()).toBeGreaterThanOrEqual(3);
      for (const id of ids) {
        await expect(spanUnits.locator(`[data-sigma-doc-id="${id}"]`)).toHaveCount(1);
      }
    };
    await assertSelectedUnits();
    for (const size of [13, 14, 15]) {
      await toolbar(page).getByRole("button", { name: "フォントサイズを大きく", exact: true }).click();
      await expect.poll(() => paintedSelection(page, ids)).toEqual(initial.map(range => ({ ...range, sizes: [size] })));
      await assertSelectedUnits();
      for (const range of initial) {
        const length = (await block(range.id).textContent())!.length;
        await assertSavedRange(page, fileId, range.id, range.offsets, size, length);
      }
    }
    // The bar's size menu, bold and default palette color use this same retained range.
    // Lead also checks these, the ribbon +/- and undo/redo/file-switch dismissal manually.
  } finally { await close(); }
});

test("a partial selection inside a continued paragraph survives two increments without formatting the whole paragraph", async () => {
  const source = fixture(true);
  const { page, fileId, close } = await openFixture(source);
  try {
    const continuation = page.locator('.editor-box-fragment-viewport[data-box-source-id="split"]').first();
    await continuation.scrollIntoViewIfNeeded();
    await expect(continuation.locator(".editor-box-fragment-editor")).toBeVisible();
    const block = continuation.locator('[data-sigma-doc-id="split"]').first();
    const offsets = await block.evaluate(element => {
      const clip = element.closest(".editor-box-fragment-viewport")!.getBoundingClientRect();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const visible: number[] = [];
      let offset = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let i = 0; i < node.textContent!.length; i++, offset++) {
          const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 && rect.top >= Math.max(clip.top, 0) && rect.bottom <= Math.min(clip.bottom, innerHeight)) visible.push(offset);
        }
      }
      if (visible.length < 18) throw new Error("Continuation has too few visible glyphs");
      return { from: visible[3], to: visible[15] };
    });
    await drag(page, block, offsets.from, block, offsets.to);
    await expect.poll(async () => (await paintedSelection(page, ["split"]))[0].offsets.length).toBeGreaterThan(0);
    const initial = await paintedSelection(page, ["split"]);
    expect(initial[0].offsets).toEqual(Array.from({ length: offsets.to - offsets.from }, (_, i) => offsets.from + i));
    for (const size of [13, 14]) {
      await toolbar(page).getByRole("button", { name: "フォントサイズを大きく", exact: true }).click();
      await expect.poll(() => paintedSelection(page, ["split"])).toEqual(initial.map(range => ({ ...range, sizes: [size] })));
      await expect.poll(() => paintedSelection(page, ["split"], ".editor-box-fragment-viewport")).toEqual(initial.map(range => ({ ...range, sizes: [size] })));
      await expect.poll(() => page.locator(".ProseMirror[data-box-fragment-span]").count()).toBeGreaterThan(1);
      const length = (source.content[1] as ParagraphNode).children.map(node => node.type === "text" ? node.text : "").join("").length;
      await assertSavedRange(page, fileId, "split", initial[0].offsets, size, length);
    }
  } finally { await close(); }
});
