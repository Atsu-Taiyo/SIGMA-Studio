import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page, type ElectronApplication, type Locator } from "@playwright/test";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";
import { ensurePageLayout } from "@/features/document";
import type { SigmaDocument } from "@/features/document";
import { createBoxBlock } from "@/lib/box-blocks";

const ROOT = path.resolve(__dirname, "../..");
let app: ElectronApplication;
let page: Page;
let profile: string;
let fileId: string;
const fixture = (): SigmaDocument => ({ version: "2.0", docId: "editor_state", metadata: { title: "入力中の題名" },
  content: [
    { type: "paragraph", id: "first", children: [{ type: "text", text: "本文の最初の行" }] },
    { type: "paragraph", id: "fraction", children: [{ type: "text", text: "前後 " }, { type: "mathInline", id: "frac", tex: String.raw`\frac{1}{2}`, display: "inline" }, { type: "text", text: " 位置" }] },
    { type: "paragraph", id: "styled_fraction", children: [{ type: "text", text: "囲み " }, { type: "mathInline", id: "frac_styled", tex: String.raw`\frac{1}{2}`, display: "inline", fontSize: 24, marks: ["boxed", "underline"], boxedPaddingY: 4 }] },
    { type: "list", id: "list", listType: "bullet", items: [{ type: "listItem", id: "item", children: [{ type: "text", text: "箇条書き" }] }] },
    { type: "paragraph", id: "empty", children: [] },
    { type: "layoutSection", id: "columns", layout: { columnCount: 2, columnGapMm: 8, columnStartIds: ["box_left", "box_right"] }, children: [
      createBoxBlock("fancybox", "", { id: "box_left", bodyId: "left_body", bodyText: "左の囲み" }),
      createBoxBlock("fancybox", "", { id: "box_right", bodyId: "right_body", bodyText: "右の囲み" }),
    ] },
    { type: "paragraph", id: "tail", children: [] },
  ], outputProfiles: { student: {}, teacher: {}, answerBook: {} } });

test.beforeEach(async () => {
  profile = mkdtempSync(path.join(tmpdir(), "sigma-editor-state-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  page = await app.firstWindow();
  const native = await app.browserWindow(page);
  await native.evaluate(win => win.setContentSize(1280, 900));
  await page.waitForURL(process.env.SIGMA_STUDIO_E2E_BASE_URL ? /http:\/\/127\.0\.0\.1/ : /file:/);
  await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
  await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
  fileId = await page.evaluate(async document => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    await window.desktopAPI!.settings!.setUiLocale!("ja");
    const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
    await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
    return created.file.fileId;
  }, fixture());
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator('.page-flow [data-sigma-doc-id="first"]').first()).toBeVisible();
});

test.afterEach(async () => { await app?.close(); rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

test("a title can stay empty until blur, then derives from the first line", async () => {
  const title = page.getByRole("textbox", { name: "教材タイトル", exact: true });
  await title.fill("");
  await expect(title).toHaveValue("");
  await page.locator('.page-flow [data-sigma-doc-id="first"]').first().click();
  await expect(title).toHaveValue("本文の最初の行");
  await title.fill("新しい教材タイトル");
  await page.locator('.page-flow [data-sigma-doc-id="first"]').first().click();
  await expect.poll(() => page.evaluate(async id => (await window.desktopAPI!.storage.loadDocument(id))?.metadata.title, fileId)).toBe("新しい教材タイトル");
  await page.reload();
  await expect(title).toHaveValue("新しい教材タイトル");
});

function measureFractionGlyphs(locator: Locator) {
  return locator.evaluate(element => {
    const root = element.shadowRoot ?? element;
    return Array.from(root.querySelectorAll("span"))
      .filter(el => el.children.length === 0 && /^[\d▢]+$/.test(el.textContent ?? ""))
      .flatMap(el => Array.from(el.textContent ?? "").map((text, i) => {
        const range = el.ownerDocument.createRange();
        range.setStart(el.firstChild!, i); range.setEnd(el.firstChild!, i + 1);
        const r = range.getBoundingClientRect();
        return { text, x: r.x, y: r.y, w: r.width, h: r.height, font: getComputedStyle(el).fontSize };
      }));
  });
}

// Blink LayoutUnit uses 1/64 CSS px. Text/font identity remains exact; allow only
// one layout quantum when comparing independent MathLive and static DOM boxes.
type MathGeometry = { x: number; y: number; w: number; h: number; text?: string; font?: string };
function expectSameMathGeometry(actual: MathGeometry[], expected: MathGeometry[]) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((wanted, index) => {
    expect(actual[index].text).toBe(wanted.text);
    expect(actual[index].font).toBe(wanted.font);
    for (const axis of ["x", "y", "w", "h"] as const) {
      expect(Math.abs(actual[index][axis] - wanted[axis]), `${index}.${axis}`).toBeLessThanOrEqual(1 / 64 + 1e-7);
    }
  });
}

test("fraction glyphs keep their size and position while editing", async ({}, info) => {
  for (const id of ["frac", "frac_styled"]) {
  const math = page.locator(`.page-flow [data-id="${id}"]`).first();
  await page.evaluate(() => document.fonts.ready);

  const before = await measureFractionGlyphs(math);
  await math.click();
  const field = page.locator("math-field.inline-math-field");
  await expect(field).toBeVisible();
  await expect.poll(() => field.evaluate(el => el.shadowRoot?.querySelectorAll("span").length ?? 0)).toBeGreaterThan(0);
  const during = await measureFractionGlyphs(field);
  await info.attach("fraction-geometry", { body: JSON.stringify({ before, during }, null, 2), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("fraction-editing.png") });
  expect(before.length).toBe(2);
  expect(during.length).toBe(before.length);
  await field.evaluate(element => {
    const input = element as HTMLElement & { executeCommand(command: string): void; insert(value: string): void };
    input.executeCommand("selectAll");
    input.insert(String.raw`\frac{12}{34}`);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  const typed = await measureFractionGlyphs(field);
  await field.press("Enter");
  await expect(field).toHaveCount(0);
  const committed = await measureFractionGlyphs(math);
  expect(typed.length).toBeGreaterThan(0);
  expectSameMathGeometry(committed, typed);
  for (let i = 0; i < before.length; i++) {
    expect(Math.abs(before[i].w - during[i].w)).toBeLessThan(1);
    expect(Math.abs(before[i].h - during[i].h)).toBeLessThan(1);
    expect(Math.abs(before[i].x - during[i].x)).toBeLessThan(1.5);
    expect(Math.abs(before[i].y - during[i].y)).toBeLessThan(1.5);
  }
  }
});

async function settleMathRendering(field: Locator) {
  await field.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function measureFractionLayout(locator: Locator) {
  return locator.evaluate(element => {
    const root = element.shadowRoot ?? element;
    return Array.from(root.querySelectorAll(".ML__frac-line")).map(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
  });
}

test("incomplete fraction geometry matches for large and framed math", async () => {
  for (const id of ["frac", "frac_styled"]) {
    const math = page.locator(`.page-flow [data-id="${id}"]`).first();
    for (const tex of [String.raw`\frac{1}{\placeholder{}}`, String.raw`\frac{\placeholder{}}{2}`, String.raw`\frac{\placeholder{}}{\placeholder{}}`]) {
      await math.click();
      const field = math.locator("math-field.inline-math-field");
      await expect(field).toBeFocused();
      await field.evaluate((element, tex) => {
        const input = element as HTMLElement & { executeCommand(command: string): void; insert(value: string): void };
        input.executeCommand("selectAll"); input.insert(tex);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      }, tex);
      await settleMathRendering(field);
      const glyphs = await measureFractionGlyphs(field);
      const bar = await measureFractionLayout(field);
      expect(glyphs).toHaveLength(2);
      expectSameMathGeometry(await measureFractionGlyphs(math.locator(".math-preview")), glyphs);
      expectSameMathGeometry(await measureFractionLayout(math.locator(".math-preview")), bar);
      await field.press("Enter"); await expect(field).toHaveCount(0);
      expectSameMathGeometry(await measureFractionGlyphs(math), glyphs);
      expectSameMathGeometry(await measureFractionLayout(math), bar);
    }
  }
});

for (const entry of ["shortcut", "frac command"] as const) {
  test(`incomplete fractions from ${entry} keep their position through commit and reload`, async () => {
    const paragraph = page.locator('.page-flow [data-sigma-doc-id="tail"]').first();
    await paragraph.click();
    if (entry === "shortcut") await page.keyboard.press("Control+/");
    else await page.keyboard.type(String.raw`\frac`);
    const math = paragraph.locator(".inline-math-node");
    const field = math.locator("math-field.inline-math-field");
    const value = () => field.evaluate(el => (el as HTMLElement & { value: string }).value);
    const blank = String.raw`\placeholder{}`;
    await expect(field).toBeFocused();
    await expect.poll(value).toBe(String.raw`\frac{${blank}}{${blank}}`);
    const preview = math.locator(".math-preview");
    const assertSameLayout = async () => {
      await settleMathRendering(field);
      expectSameMathGeometry(await measureFractionGlyphs(preview), await measureFractionGlyphs(field));
      expectSameMathGeometry(await measureFractionLayout(preview), await measureFractionLayout(field));
    };
    await assertSameLayout();
    // Fraction insertion starts in the denominator; leave the numerator empty.
    await page.keyboard.type("34");
    await expect.poll(value).toBe(String.raw`\frac{${blank}}{34}`);
    await assertSameLayout();
    const typed = await measureFractionGlyphs(field);
    const bar = await measureFractionLayout(field);
    expect(typed.map(glyph => glyph.text).sort()).toEqual(["3", "4", "▢"]);
    await field.press("Enter"); await expect(field).toHaveCount(0);
    expectSameMathGeometry(await measureFractionGlyphs(math), typed);
    expectSameMathGeometry(await measureFractionLayout(math), bar);
    // The visible empty slot remains clickable and reopens the real placeholder.
    await math.locator(".ML__prompt-atom").click();
    await expect(field).toBeFocused(); await assertSameLayout();
    await field.press("Enter"); await expect(field).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+s");
    const tex = String.raw`\frac{${blank}}{34}`;
    await expect.poll(async () => {
      const doc = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
      const block = doc?.content.find(block => block.id === "tail");
      return block?.type === "paragraph" ? block.children.find(run => run.type === "mathInline")?.tex : undefined;
    }).toBe(tex);
    await page.reload(); await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(math).toHaveAttribute("data-tex", tex);
    await math.locator(".ML__prompt-atom").click();
    await expect(field).toBeFocused(); await assertSameLayout();
    await field.press("Enter");
  });
}

test("the blue plus adds a paragraph after a box inside the same column", async () => {
  const box = page.locator('.page-flow [data-sigma-doc-id="box_right"]').first();
  const rect = await box.boundingBox();
  if (!rect) throw new Error("Missing box bounds");
  await box.scrollIntoViewIfNeeded();
  const current = (await box.boundingBox())!;
  await page.mouse.move(current.x + current.width / 2, current.y + current.height - 1);

  const plus = page.getByRole("button", { name: "ここに本文を追加", exact: true });
  await expect(plus).toBeVisible();
  await plus.click();
  await page.keyboard.type("箱の後ろの本文");
  await expect.poll(async () => {
    const doc = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
    const section = doc?.content.find(block => block.id === "columns");
    return section?.type === "layoutSection" ? JSON.stringify(section.children) : "";
  }).toContain("箱の後ろの本文");
  await page.reload();
  await expect(page.locator('.page-flow [data-layout-section-id="columns"]').first()).toContainText("箱の後ろの本文");
});

test("font size follows typing out of lists and recent fonts lead the menu", async () => {
  const item = page.locator('.page-flow [data-sigma-doc-id="item"]').first();
  await item.click();
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+Shift+ArrowLeft");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("");
  const size = page.getByRole("textbox", { name: "フォントサイズ", exact: true });
  await size.click(); await size.fill("24"); await size.press("Tab");
  await expect(item.locator('span[style*="font-size"]').first()).toHaveCSS("font-size", "32px");
  await item.click();
  await page.keyboard.press("End");
  await page.keyboard.type("large");
  await page.locator('.page-flow [data-sigma-doc-id="empty"]').first().click();
  await page.keyboard.type("body24");
  await expect(page.locator('.page-flow [data-sigma-doc-id="empty"] span').first()).toHaveCSS("font-size", "32px");
  await page.locator('button[aria-label^="フォント:"]').first().click();
  const menu = page.getByRole("menu", { name: "フォント", exact: true });
  await menu.getByRole("menuitemradio", { name: "M PLUS 1p", exact: true }).first().click();
  await page.locator('button[aria-label^="フォント:"]').first().click();
  const recent = menu.getByRole("group", { name: "最近使ったフォント" });
  await expect(recent.getByRole("menuitemradio", { name: "M PLUS 1p", exact: true })).toBeVisible();
  expect(await menu.locator('[role="group"]').first().getAttribute("aria-label")).toBe("最近使ったフォント");
  await page.keyboard.press("Escape");
  await expect.poll(async () => JSON.stringify((await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId))?.content)).toContain("body24");
  await page.reload();
  await expect(page.locator('.page-flow [data-sigma-doc-id="empty"] span').first()).toHaveCSS("font-size", "32px");
});

test("a box keeps its declared body font after a different font was used outside it", async () => {
  const document = fixture();
  document.content = [document.content[0], {
    ...createBoxBlock("plain", "", { id: "font_box", bodyId: "font_box_body" }),
    frame: { bodyFontFamily: "monospace" },
  }];
  fileId = await page.evaluate(async document => {
    const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
    await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
    return created.file.fileId;
  }, document);
  await page.reload();
  const first = page.locator('.page-flow [data-sigma-doc-id="first"]').first();
  await first.click();
  await page.locator('button[aria-label^="フォント:"]').first().click();
  await page.getByRole("menu", { name: "フォント", exact: true })
    .getByRole("menuitemradio", { name: "Noto Serif JP", exact: true }).first().click();
  await page.keyboard.type("A");
  const body = page.locator('.page-flow [data-sigma-doc-id="font_box_body"]').first();
  await body.click();
  await page.keyboard.type("box-font");
  await expect(body).toHaveText("box-font");
  const readBox = () => page.evaluate(async id => {
    const saved = await window.desktopAPI!.storage.loadDocument(id);
    return saved?.content.find(block => block.id === "font_box");
  }, fileId);
  await expect.poll(readBox).toMatchObject({ frame: { bodyFontFamily: "monospace" }, blocks: [{ children: [{ text: "box-font" }] }] });
  const box = await readBox();
  expect(box?.type === "boxBlock" && box.blocks[0]?.type === "paragraph" ? box.blocks[0].children[0] : null)
    .not.toHaveProperty("fontFamily");
  await expect.poll(() => body.evaluate(el => getComputedStyle(el.querySelector("span") ?? el).fontFamily)).toBe("monospace");
  await page.reload();
  await expect(body).toHaveText("box-font");
  await expect.poll(() => body.evaluate(el => getComputedStyle(el.querySelector("span") ?? el).fontFamily)).toBe("monospace");
});

test("@ references persist and open their destination document", async () => {
  const targetId = await page.evaluate(async () => {
    const document = { version: "2.0" as const, docId: "reference_target", metadata: { title: "参照先教材" }, content: [{ type: "paragraph" as const, id: "target_p", children: [{ type: "text" as const, text: "移動先の本文" }] }], outputProfiles: { student: {}, teacher: {}, answerBook: {} } };
    return (await window.desktopAPI!.storage.createFileFromDocument({ document })).file.fileId;
  });
  await page.evaluate(id => window.desktopAPI!.storage.saveWorkspace({ openFileIds: [id], activeFileId: id }), fileId);
  // Reload obtains the current library ledger through the actual desktop bridge.
  await page.reload();
  await page.locator('.page-flow [data-sigma-doc-id="tail"]').first().click();
  await page.keyboard.type("@参照先");
  const suggestions = page.getByRole("listbox", { name: "教材・素材を参照" });
  await expect(suggestions.getByRole("option")).toContainText(["参照先教材"]);
  await page.keyboard.press("Escape");
  await expect(suggestions).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("先");
  await expect(suggestions.getByRole("option")).toContainText(["参照先教材"]);
  await page.keyboard.press("Enter");
  const reference = page.locator(`.page-flow [data-document-reference-id="${targetId}"]`).first();
  await expect(reference).toHaveText("@参照先教材");
  await expect.poll(async () => JSON.stringify((await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId))?.content)).toContain(targetId);
  await page.reload();
  await expect(reference).toBeVisible();
  await reference.click();
  await expect(page.locator('.page-flow [data-sigma-doc-id="target_p"]').first()).toHaveText("移動先の本文");
});

test("a newly inserted box focuses its title and can hide it without losing text", async () => {
  await page.locator('.page-flow [data-sigma-doc-id="tail"]').first().click();
  await page.keyboard.type("/fancybox");
  await expect(page.locator(".slash-command-popover")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => {
    const selection = window.getSelection();
    const element = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
    return Boolean(element?.closest("[data-box-title-region]"));
  })).toBe(true);
  await page.keyboard.type("作成直後のタイトル");
  const title = page.locator('.page-flow [data-box-title-region]').filter({ hasText: "作成直後のタイトル" }).first();
  await expect(title).toBeVisible();
  const box = title.locator('xpath=ancestor::section[@data-sigma-doc-type="boxBlock"]');
  await box.getByRole("button", { name: "box操作", exact: true }).click();
  await page.getByRole("button", { name: "boxの設定…", exact: true }).click();
  const show = page.getByRole("checkbox", { name: "タイトルを表示" });
  await show.uncheck();
  await page.getByRole("button", { name: "閉じる", exact: true }).last().click();
  await expect(title).toBeHidden();
  await page.keyboard.insertText("タイトルなしの本文");
  await expect(box.locator(".sigma-doc-box-body")).toContainText("タイトルなしの本文");
  await expect.poll(async () => JSON.stringify((await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId))?.content)).toContain('"titleVisible":false');
  await page.reload(); await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(title).toBeHidden();
  await box.hover();

  await box.getByRole("button", { name: "box操作", exact: true }).click();
  await page.getByRole("button", { name: "boxの設定…", exact: true }).click();
  await show.check();
  await page.getByRole("button", { name: "閉じる", exact: true }).last().click();
  await expect(title).toBeVisible();
  await expect(title).toHaveText("作成直後のタイトル");
});

test("a pasted shared link reaches the existing sharing confirmation", async () => {
  const link = "sigma-studio://share/document/00000000-0000-4000-8000-000000000001#invitation=" + "x".repeat(43);
  await page.locator('.page-flow [data-sigma-doc-id="tail"]').first().click();
  await page.keyboard.insertText(link);
  const url = page.locator('.page-flow .url-detected').first();
  await expect(url).toHaveAttribute("data-url", link);
  await url.click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByRole("textbox", { name: "招待リンク・コード", exact: true })).toHaveValue(link);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("@ can reference a saved material and open its library entry", async () => {
  const material = await page.evaluate(() => window.desktopAPI!.materials.createMaterial({ name: "参照用素材", content: {
    blocks: [{ type: "paragraph", id: "referenced_material_body", children: [{ type: "text", text: "素材のプレビュー" }] }],
    overlaySnapshot: { version: 1, assets: {}, shapes: [] },
  } }));
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.locator('.page-flow [data-sigma-doc-id="tail"]').first().click();
  await page.keyboard.type("@参照用素材");
  await expect(page.getByRole("listbox", { name: "教材・素材を参照" }).getByRole("option")).toContainText(["参照用素材"]);
  await page.keyboard.press("Enter");
  const reference = page.locator(`.page-flow [data-document-reference-id="${material.id}"]`).first();
  await expect(reference).toHaveAttribute("data-document-reference-kind", "material");
  await reference.click();
  await expect(page.getByRole("dialog", { name: "素材", exact: true })).toBeVisible();
  await expect(page.locator(".material-library-item")).toContainText(["参照用素材"]);
  await page.getByRole("dialog", { name: "素材", exact: true }).getByRole("button", { name: "閉じる", exact: true }).click();
});

test("undo restores visible overlay text while the editor stays focused, and persists it", async () => {
  const source = ensurePageLayout(fixture());
  source.docId = "overlay_undo";
  source.content = [{ type: "paragraph", id: "overlay_body", children: [{ type: "text", text: "本文" }] }];
  source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
    type: "text", id: "undo_shape", x: 100, y: 220, props: { w: 280, h: 64, size: "m", color: "#111111", blocks: [
      { type: "paragraph", id: "undo_shape_p", children: [{ type: "text", text: "変更前" }] },
    ] },
  }] } };
  fileId = await page.evaluate(async document => {
    const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
    await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
    return created.file.fileId;
  }, source);
  await page.reload(); await expect(page.locator(".startup-splash")).toBeHidden();
  const shape = page.locator('.overlay-shape-text[data-overlay-shape-id="undo_shape"]');
  await grabShapeFromBody(page, shape);
  await shape.dblclick();
  const input = shape.locator(".ProseMirror");
  await expect(input).toBeVisible();
  await input.press("ControlOrMeta+A"); await page.keyboard.insertText("変更後");
  await expect(input).toHaveText("変更後");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input).toHaveText("変更前");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveText("変更後");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input).toHaveText("変更前");
  await page.keyboard.press("Escape");
  await expect.poll(async () => {
    const doc = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
    return JSON.stringify(doc?.pageLayout?.overlay?.overlaySnapshot?.shapes);
  }).toContain("変更前");
  await page.reload(); await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(shape).toContainText("変更前");
});
