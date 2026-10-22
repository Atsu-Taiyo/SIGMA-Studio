import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";
import type { MathfieldElement } from "mathlive";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const BLANK = String.raw`\placeholder{}`;

// MathLive は IME 変換の開始時に選んでいる範囲を deleteRange で消す。分子・根号の中・上付きなどの
// 中身を丸ごと選んでいると親ごと消すので、空欄を選んだまま (分数を入れた直後・空欄をクリックした
// ところで) 日本語を変換すると、分数・根号・上付きごと消えて `\text{漢}` だけが残っていた。
const cases = [
  { id: "numerator", tex: String.raw`\frac{${BLANK}}{${BLANK}}`, blank: 0, expected: String.raw`\frac{\text{漢}}{${BLANK}}` },
  { id: "denominator", tex: String.raw`\frac{${BLANK}}{${BLANK}}`, blank: 1, expected: String.raw`\frac{${BLANK}}{\text{漢}}` },
  { id: "radical", tex: String.raw`\sqrt{${BLANK}}`, blank: 0, expected: String.raw`\sqrt{\text{漢}}` },
  { id: "superscript", tex: String.raw`x^{${BLANK}}`, blank: 0, expected: String.raw`x^{\text{漢}}` },
  { id: "subscript", tex: String.raw`x_{${BLANK}}`, blank: 0, expected: String.raw`x_{\text{漢}}` },
] as const;

test("IME composition into a selected blank stays in the blank and keeps its fraction, radical or script", async () => {
  const paragraph = (id: string, tex?: string) => ({
    type: "paragraph" as const, id, children: [
      { type: "text" as const, text: `${id}: ` },
      ...tex === undefined ? [] : [{ type: "mathInline" as const, id: `m_${id}`, tex, display: "inline" as const }],
    ],
  });
  const { page, fileId, close } = await launch({
    version: "2.0", docId: "math_ime_placeholder",
    metadata: { title: "空欄への日本語入力", styleUnits: { fontSize: "pt" } },
    content: [
      paragraph("inserted"),
      ...cases.map(({ id, tex }) => paragraph(id, tex)),
      paragraph("cancelled", String.raw`\frac{${BLANK}}{${BLANK}}`),
      paragraph("whole-numerator", String.raw`\frac{ab}{c}`),
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  });
  try {
    const ime = await page.context().newCDPSession(page);
    const compose = async (field: Locator, template: RegExp) => {
      for (const composing of ["k", "か", "かん"]) {
        await ime.send("Input.imeSetComposition", { text: composing, selectionStart: composing.length, selectionEnd: composing.length });
        // 変換中も分数・根号・上付きは残っている。
        await expect.poll(() => valueOf(field)).toMatch(template);
      }
    };

    // 本文で分数を入れると、分母の空欄が選ばれた状態で開く (分数は分母から入れる)。そのまま変換する。
    const inserted = page.locator('.page-flow [data-sigma-doc-id="inserted"]').first();
    await inserted.click();
    await inserted.evaluate(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let last: Node | null = null;
      while (walker.nextNode()) last = walker.currentNode;
      getSelection()!.collapse(last, last!.textContent!.length);
    });
    await page.keyboard.press("Control+/");
    const insertedField = inserted.locator("math-field");
    await expect(insertedField).toBeFocused();
    await expect.poll(() => valueOf(insertedField)).toBe(String.raw`\frac{${BLANK}}{${BLANK}}`);
    await compose(insertedField, /^\\frac\{/);
    await ime.send("Input.insertText", { text: "漢" });
    await expect.poll(() => valueOf(insertedField)).toBe(String.raw`\frac{${BLANK}}{\text{漢}}`);
    await page.keyboard.press("Enter");
    await expect(insertedField).toHaveCount(0);

    // 既存の数式の空欄をクリックすると、その空欄が選ばれた状態で開く。
    for (const { id, blank, expected } of cases) {
      const field = await openAtBlank(page, id, blank);
      await compose(field, new RegExp(`^${escapeRegExp(expected.split(String.raw`\text{漢}`)[0])}`));
      await ime.send("Input.insertText", { text: "漢" });
      await expect.poll(() => valueOf(field), id).toBe(expected);
      await page.keyboard.press("Enter");
      await expect(field).toHaveCount(0);
    }

    // 変換を取り消したら空欄に戻り、選ばれたまま (続けて打つと空欄に入る)。
    const cancelled = await openAtBlank(page, "cancelled", 0);
    await compose(cancelled, /^\\frac\{/);
    await ime.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    await expect.poll(() => valueOf(cancelled)).toBe(String.raw`\frac{${BLANK}}{${BLANK}}`);
    await page.keyboard.type("a");
    await expect.poll(() => valueOf(cancelled)).toBe(String.raw`\frac{a}{${BLANK}}`);
    await page.keyboard.press("Enter");
    await expect(cancelled).toHaveCount(0);

    // 空欄でなくても、分子の中身を丸ごと選んで変換すると分数ごと消えていた。
    const whole = page.locator('.page-flow [data-sigma-doc-id="whole-numerator"]').first();
    await whole.locator(".inline-math-node").click();
    const wholeField = whole.locator("math-field");
    await expect(wholeField).toBeFocused();
    for (const key of ["Home", "ArrowRight", "ArrowRight", "ArrowRight", "Shift+ArrowLeft", "Shift+ArrowLeft"]) await page.keyboard.press(key);
    await expect.poll(() => wholeField.evaluate(el => {
      const field = el as MathfieldElement;
      return field.getValue(field.selection, "latex");
    })).toBe("ab");
    await compose(wholeField, /^\\frac\{/);
    await ime.send("Input.insertText", { text: "漢" });
    await expect.poll(() => valueOf(wholeField)).toBe(String.raw`\frac{\text{漢}}{c}`);
    await page.keyboard.press("Enter");
    await expect(wholeField).toHaveCount(0);

    const expectedSaved = {
      inserted: String.raw`\frac{${BLANK}}{\text{漢}}`,
      ...Object.fromEntries(cases.map(({ id, expected }) => [id, expected])),
      cancelled: String.raw`\frac{a}{${BLANK}}`,
      "whole-numerator": String.raw`\frac{\text{漢}}{c}`,
    };
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => savedMath(page, fileId)).toEqual(expectedSaved);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    for (const [id, tex] of Object.entries(expectedSaved)) {
      await expect(page.locator(`.page-flow [data-sigma-doc-id="${id}"] .inline-math-node`).first()).toHaveAttribute("data-tex", tex);
    }
  } finally {
    await close();
  }
});

async function launch(source: SigmaDocument) {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-math-ime-placeholder-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const close = async () => {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  };
  try {
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1200, 850));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:inline-math-input-mode", "mathlive");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, source);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.evaluate(() => document.fonts.ready);
    return { page, fileId, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** 静的な数式の n 番目の空欄をクリックして開く (その空欄が選ばれた状態になる)。 */
async function openAtBlank(page: Page, id: string, blank: number) {
  const paragraph = page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
  const square = (await paragraph.locator(".inline-math-node .ML__prompt-atom").nth(blank).boundingBox())!;
  await page.mouse.click(square.x + square.width / 2, square.y + square.height / 2);
  const field = paragraph.locator("math-field");
  await expect(field).toBeFocused();
  await expect.poll(() => field.evaluate(el => {
    const mathField = el as MathfieldElement;
    return mathField.selectionIsCollapsed ? "" : mathField.getValue(mathField.selection, "latex");
  })).toBe(BLANK);
  return field;
}

function valueOf(field: Locator) {
  return field.evaluate(el => (el as MathfieldElement).value);
}

async function savedMath(page: Page, fileId: string) {
  const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
  return Object.fromEntries((saved?.content ?? []).flatMap(block => {
    const math = block.type === "paragraph" ? block.children.find(run => run.type === "mathInline") : undefined;
    return math?.type === "mathInline" ? [[block.id, math.tex]] : [];
  }));
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
