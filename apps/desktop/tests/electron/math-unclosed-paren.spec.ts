import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

import type { InlineNode, SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const TEX = String.raw`\sin(x)`;
const OPEN = String.raw`\sin(x`;
const MATH_IDS = ["m_inline", "m_display", "m_problem", "m_shape", "m_table"] as const;
type MathId = typeof MATH_IDS[number];

const math = (id: MathId): InlineNode => ({ type: "mathInline", id, tex: TEX, display: "inline", semanticRole: "expression" });
const text = (value: string): InlineNode => ({ type: "text", text: value });

function fixture(): SigmaDocument {
  return {
    version: "2.0", docId: "math_unclosed_paren",
    metadata: { title: "閉じ括弧を消した数式", styleUnits: { fontSize: "pt" } },
    content: [
      { type: "paragraph", id: "p_inline", children: [text("式 "), math("m_inline"), text(" です")] },
      { type: "paragraph", id: "p_display", align: "center", children: [math("m_display")] },
      { type: "problem", id: "q1", tags: [], lead: [], hints: [], solution: [], prompt: [
        { type: "paragraph", id: "p_problem", children: [text("問 "), math("m_problem")] },
      ] },
      { type: "paragraph", id: "p_after", children: [text("後")] },
    ],
    pageLayout: {
      overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: [
        { id: "shape_text", type: "text", x: 120, y: 420, rotation: 0, props: { w: 240, h: 48, color: "#111111", size: "m", blocks: [
          { type: "paragraph", id: "p_shape", children: [math("m_shape"), text(" 図中")] },
        ] } },
        { id: "shape_table", type: "tableShape", x: 120, y: 520, rotation: 0, props: { w: 240, h: 60, table: {
          version: 1, kind: "plain",
          columns: [{ id: "c1", width: { mode: "auto" } }, { id: "c2", width: { mode: "auto" } }],
          rows: [{ id: "r1", height: { mode: "auto" } }],
          cells: [
            { id: "cell_label", rowId: "r1", columnId: "c1", content: [{ type: "paragraph", id: "cp_label", children: [text("値")] }] },
            { id: "cell_math", rowId: "r1", columnId: "c2", content: [{ type: "paragraph", id: "cp_math", children: [math("m_table")] }] },
          ],
          grid: { borderColor: "#111827", borderWidth: 1 }, defaultCellStyle: {},
        } } },
      ] } },
    },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  } as SigmaDocument;
}

async function savedTex(page: Page, fileId: string): Promise<Record<string, string | null>> {
  return page.evaluate(async ({ id, mathIds }) => {
    window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    const document = await window.desktopAPI!.storage.loadDocument(id);
    const found: Record<string, string | null> = Object.fromEntries(mathIds.map((mathId) => [mathId, null]));
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const node = value as { type?: unknown; id?: unknown; tex?: unknown };
      if (node.type === "mathInline" && typeof node.id === "string" && node.id in found) found[node.id] = String(node.tex);
      Object.values(value).forEach(visit);
    };
    visit(document);
    return found;
  }, { id: fileId, mathIds: [...MATH_IDS] });
}

const editingField = (page: Page) => page.locator(".inline-math-node.editing math-field");

/** 本文の数式は 1 回のクリックで開く。図形・表の中は、掴んでから押し直して入る。 */
async function openMath(page: Page, mathId: MathId, expectedTex = TEX): Promise<void> {
  const node = page.locator(`.inline-math-node[data-id="${mathId}"]`).first();
  await node.scrollIntoViewIfNeeded();
  const center = async () => {
    const box = (await node.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  if (mathId === "m_shape" || mathId === "m_table") {
    const point = await center();
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("ControlOrMeta");
    for (const action of ["click", "click", "dblclick", "click"] as const) {
      if (await editingField(page).count()) break;
      await page.waitForTimeout(300);
      const next = await center();
      if (action === "dblclick") await page.mouse.dblclick(next.x, next.y);
      else await page.mouse.click(next.x, next.y);
    }
  } else {
    const point = await center();
    await page.mouse.click(point.x, point.y);
  }
  await expect(editingField(page)).toHaveCount(1);
  await expect.poll(() => editingField(page).evaluate((field) => (field as HTMLElement & { value: string }).value)).toBe(expectedTex);
  // MathLive は focus() の少し後に焦点を移す。キーを押すのは焦点が入ってから。
  // MathLive の hasFocus() は DOM の焦点より先に true になるので、DOM の焦点も見る。
  await expect.poll(() => editingField(page).evaluate((field) => document.activeElement === field && (field as HTMLElement & { hasFocus: () => boolean }).hasFocus())).toBe(true);
}

async function deleteClosingParenAndCommit(page: Page, mathId: MathId): Promise<string> {
  await openMath(page, mathId);
  const field = editingField(page);
  await field.evaluate((element) => (element as HTMLElement & { executeCommand: (command: string) => void }).executeCommand("moveToMathfieldEnd"));
  await page.keyboard.press("Backspace");
  await expect.poll(() => field.evaluate((element) => (element as HTMLElement & { value: string }).value)).not.toBe(TEX);
  const value = await field.evaluate((element) => (element as HTMLElement & { value: string }).value);
  // 本文の別の段落をクリックして確定する。
  const after = (await page.locator('.page-flow [data-sigma-doc-id="p_after"]').first().boundingBox())!;
  await page.mouse.click(after.x + 4, after.y + after.height / 2);
  await expect(page.locator(".inline-math-node.editing")).toHaveCount(0);
  return value;
}

async function renderedMathText(page: Page, mathId: MathId): Promise<string> {
  const node: Locator = page.locator(`.inline-math-node[data-id="${mathId}"]`).first();
  return (await node.textContent() ?? "").replace(/\s+/g, "");
}

/**
 * MathLive は、閉じ括弧を Backspace で消した `\sin(x)` を `\sin(x.` と書き出していた (入力欄には
 * `sin(x` と出る)。本文・問題・文字図形・表のどの数式でも `.` 付きで保存され、読み直すと `sin(x.` と
 * 点が残った。TeX 表示で同じ操作をしたときと同じ `\sin(x` で保存されることを確かめる。
 */
test("deleting a closing parenthesis in realtime math saves the formula without a stray dot, everywhere math is edited", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!process.env.SIGMA_STUDIO_E2E_BASE_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-math-unclosed-paren-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1200, 900));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    // 起動直後の空の教材の保存が終わってから差し替える (先に書くと、作業状態を上書きされて空の教材が開く)。
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      // 数式入力モード「リアルタイム表示」(MathLive)。
      localStorage.setItem("sigma-studio:inline-math-input-mode", "mathlive");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, fixture());
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator('.page-flow [data-sigma-doc-id="p_inline"]').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    for (const mathId of MATH_IDS) {
      expect(await deleteClosingParenAndCommit(page, mathId), mathId).toBe(OPEN);
      await expect.poll(async () => (await savedTex(page, fileId))[mathId], mathId).toBe(OPEN);
    }
    await page.screenshot({ path: testInfo.outputPath("math-unclosed-paren-edited.png") });

    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator('.page-flow [data-sigma-doc-id="p_inline"]').first()).toBeVisible();
    expect(await savedTex(page, fileId)).toEqual(Object.fromEntries(MATH_IDS.map((mathId) => [mathId, OPEN])));
    for (const mathId of MATH_IDS) {
      await expect.poll(() => renderedMathText(page, mathId), mathId).toBe("sin(x");
    }
    await page.screenshot({ path: testInfo.outputPath("math-unclosed-paren-reloaded.png") });

    // 開き直しても `.` が文字として現れず、閉じ括弧を打ち直せば元の式に戻る。
    await openMath(page, "m_inline", OPEN);
    await editingField(page).evaluate((element) => (element as HTMLElement & { executeCommand: (command: string) => void }).executeCommand("moveToMathfieldEnd"));
    await page.keyboard.type(")");
    await expect.poll(() => editingField(page).evaluate((field) => (field as HTMLElement & { value: string }).value)).toBe(TEX);
    const after = (await page.locator('.page-flow [data-sigma-doc-id="p_after"]').first().boundingBox())!;
    await page.mouse.click(after.x + 4, after.y + after.height / 2);
    await expect.poll(async () => (await savedTex(page, fileId)).m_inline).toBe(TEX);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect(existsSync(profile)).toBe(false);
  }
});
