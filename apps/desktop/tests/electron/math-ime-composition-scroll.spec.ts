import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";
import type { MathfieldElement } from "mathlive";
import type { SigmaDocument } from "@/features/document";
import { selectUiOptionInPage } from "../e2e/ui-select";

const APP_ROOT = path.resolve(__dirname, "../..");

async function launch(source: SigmaDocument) {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-math-ime-"));
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

async function savedMath(page: Page, fileId: string, paragraphId: string) {
  const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
  const body = saved?.content.find(block => block.id === paragraphId);
  return body?.type === "paragraph" ? body.children.find(run => run.type === "mathInline")?.tex : undefined;
}

// 紙面の .page-stack はズームの transform を持つので、MathLive が IME 変換の開始時に
// 画面座標で置く隠し入力欄 (position: fixed) が紙面基準にずれる。改ページの後の数式では
// 画面の上の外へ出て、変換中に編集面が上へ飛んでいた。
test("IME composition in math after a page break keeps the viewport and anchors the input at the caret", async ({}, testInfo) => {
  const text = (id: string) => ({ type: "paragraph" as const, id, children: [{ type: "text" as const, text: `${id} 改ページ後の数式の確認` }] });
  const { page, fileId, close } = await launch({
    version: "2.0", docId: "math_ime_scroll",
    metadata: { title: "数式のIME入力", styleUnits: { fontSize: "pt" } },
    content: [
      ...Array.from({ length: 12 }, (_, index) => text(`before${index}`)),
      {
        type: "paragraph", id: "answer", pagination: { break: true },
        children: [
          { type: "text", text: "答 " },
          { type: "mathInline", id: "formula", tex: String.raw`\frac{1}{5}`, display: "inline" },
        ],
      },
      ...Array.from({ length: 30 }, (_, index) => text(`after${index}`)),
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  });
  try {
    const ime = await page.context().newCDPSession(page);
    const scroller = page.locator(".editor-canvas");
    const paragraph = page.locator('.page-flow [data-sigma-doc-id="answer"]').first();
    const node = paragraph.locator(".inline-math-node");
    const field = node.locator("math-field");
    let typed = "";
    for (const zoom of ["100", "150", "75"]) {
      await selectUiOptionInPage(page, "ズーム", zoom);
      await expect.poll(() => page.locator(".page-stack").evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a))
        .toBeCloseTo(Number(zoom) / 100, 2);
      await paragraph.scrollIntoViewIfNeeded();
      await paragraph.evaluate(el => {
        const canvas = el.closest(".editor-canvas")!;
        const viewport = canvas.getBoundingClientRect();
        const target = el.getBoundingClientRect();
        canvas.scrollTop += (target.top + target.bottom - viewport.top - viewport.bottom) / 2;
      });
      await node.click();
      await expect(field).toBeFocused();
      await page.keyboard.press("End");
      const before = await scrollOf(scroller);
      expect(before.top).toBeGreaterThan(400);
      // 同じ数式で2回変換する (2回目は前回置いた位置から始まる)。
      for (const [steps, committed] of [[["k", "か", "かん", "かんじ"], "漢字"], [["s", "す", "すう"], "数"]] as const) {
        for (const composing of steps) {
          await ime.send("Input.imeSetComposition", { text: composing, selectionStart: composing.length, selectionEnd: composing.length });
          await expect.poll(() => sinkOffsetFromField(field)).toBeLessThanOrEqual(2);
          await expectScrollUnchanged(scroller, before, `${zoom}% ${composing}`);
        }
        await ime.send("Input.insertText", { text: committed });
        typed += committed;
        await expect.poll(async () => kanji(await field.evaluate(el => (el as MathfieldElement).value))).toBe(typed);
        await page.waitForTimeout(100);
        await expectScrollUnchanged(scroller, before, `${zoom}% ${committed}`);
      }
      await field.screenshot({ path: testInfo.outputPath(`composed-${zoom}.png`) });
      await page.keyboard.press("Enter");
      await expect(field).toHaveCount(0);
    }
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(async () => {
      const tex = await savedMath(page, fileId, "answer");
      return tex === undefined ? undefined : kanji(tex);
    }).toBe(typed);
  } finally {
    await close();
  }
});

// 範囲を選んでいる間 (分数などを入れた直後の空欄・Shift+Home などで選んだ式)、MathLive は隠し入力欄を
// `left: -1000px` へ隠す。紙面基準ではそれが紙面の左の外になり、そこへ打つ・変換すると編集面が左端まで
// 横へ飛んでいた。範囲を置き換える変換では MathLive が置き直さないので、IME の候補窓も紙面の左の外に
// 出ていた (横にはみ出さない 100% でも)。
test("typing or composing over a selection in math keeps the editor still sideways and the IME input at the formula", async ({}, testInfo) => {
  // blank: 本文から分数を入れると、分子の空欄が選ばれた状態で開く。そこへ打つ。
  // range: 行末の式を開いて Shift+Home で全体を選び、IME で置き換える。
  const cases = [["150", "blank"], ["150", "range"], ["100", "range"]] as const;
  const line = (id: string) => ({
    type: "paragraph" as const, id, children: [
      { type: "text" as const, text: `${id} 1行目の終わり近くの数式に、選んだまま打ち込む` },
      ...id.startsWith("range") ? [{ type: "mathInline" as const, id: `m_${id}`, tex: "x+1", display: "inline" as const }] : [],
    ],
  });
  const { page, fileId, close } = await launch({
    version: "2.0", docId: "math_ime_sideways",
    metadata: { title: "数式の範囲選択への入力", styleUnits: { fontSize: "pt" } },
    content: [...cases.map(([zoom, input]) => line(`${input}${zoom}`)), ...Array.from({ length: 20 }, (_, index) => line(`rest${index}`))],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  });
  try {
    const ime = await page.context().newCDPSession(page);
    const scroller = page.locator(".editor-canvas");
    for (const [zoom, input] of cases) {
      const id = `${input}${zoom}`;
      await selectUiOptionInPage(page, "ズーム", zoom);
      await expect.poll(() => page.locator(".page-stack").evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a))
        .toBeCloseTo(Number(zoom) / 100, 2);
      const paragraph = page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
      await paragraph.click();
      // 行末にカーソルを置き、そこが編集面の真ん中に来るようにスクロールしておく (150% は横にも)。
      await paragraph.evaluate(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let last: Node | null = null;
        while (walker.nextNode()) last = walker.currentNode;
        getSelection()!.collapse(last, last!.textContent!.length);
        const caret = getSelection()!.getRangeAt(0).getBoundingClientRect();
        const canvas = el.closest(".editor-canvas")!;
        const viewport = canvas.getBoundingClientRect();
        canvas.scrollLeft += caret.left - (viewport.left + viewport.right) / 2;
        canvas.scrollTop += caret.top - (viewport.top + viewport.bottom) / 2;
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const before = await scrollOf(scroller);
      if (zoom === "150") expect(before.left, "紙面が横にはみ出し、横へスクロールした状態から始める").toBeGreaterThan(100);

      const field = paragraph.locator("math-field");
      const value = () => field.evaluate(el => (el as MathfieldElement).value);
      if (input === "blank") {
        await page.keyboard.press("Control+/");
        await expect(field).toBeFocused();
        await expect.poll(value).toBe(String.raw`\frac{\placeholder{}}{\placeholder{}}`);
        await expectScrollUnchanged(scroller, before, `${id} 分数を入れた`);
        await page.keyboard.type("a");
        // 分数は分母から入る。
        await expect.poll(value).toBe(String.raw`\frac{\placeholder{}}{a}`);
        await page.waitForTimeout(100);
        await expectScrollUnchanged(scroller, before, `${id} a`);
      } else {
        await paragraph.locator(".inline-math-node").click();
        await expect(field).toBeFocused();
        await page.keyboard.press("End");
        await page.keyboard.press("Shift+Home");
        await expect.poll(() => field.evaluate(el => (el as MathfieldElement).selectionIsCollapsed)).toBe(false);
        await page.waitForTimeout(100);
        await expectScrollUnchanged(scroller, before, `${id} 選んだ`);
        for (const composing of ["k", "か", "かん"]) {
          await ime.send("Input.imeSetComposition", { text: composing, selectionStart: composing.length, selectionEnd: composing.length });
          await expect.poll(() => sinkOffsetFromField(field)).toBeLessThanOrEqual(2);
          await expectScrollUnchanged(scroller, before, `${id} ${composing}`);
        }
        await ime.send("Input.insertText", { text: "漢" });
        await expect.poll(async () => kanji(await value())).toBe("漢");
        await page.waitForTimeout(100);
        await expectScrollUnchanged(scroller, before, `${id} 漢`);
      }
      await page.screenshot({ path: testInfo.outputPath(`selection-${id}.png`) });
      await page.keyboard.press("Enter");
      await expect(field).toHaveCount(0);
    }
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => savedMath(page, fileId, "blank150")).toMatch(/^\\frac\{\\placeholder\{\}\}\{a\}/);
    for (const id of ["range150", "range100"]) {
      // 選んでいた x+1 は変換した文字で置き換わる。
      await expect.poll(async () => {
        const tex = await savedMath(page, fileId, id);
        return tex === undefined ? undefined : { kanji: kanji(tex), replaced: !tex.includes("+1") };
      }).toEqual({ kanji: "漢", replaced: true });
    }
    await page.reload();
    await expect(page.locator('.page-flow [data-sigma-doc-id="range150"] .inline-math-node').first()).toHaveAttribute("data-tex", /漢/);
    await expect(page.locator('.page-flow [data-sigma-doc-id="blank150"] .inline-math-node').first()).toHaveAttribute("data-tex", /^\\frac\{\\placeholder\{\}\}\{a\}/);
  } finally {
    await close();
  }
});

function scrollOf(scroller: Locator) {
  return scroller.evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }));
}

/** 編集面が縦にも横にも動いていない。 */
async function expectScrollUnchanged(scroller: Locator, before: { left: number; top: number }, step: string) {
  const now = await scrollOf(scroller);
  expect(Math.abs(now.left - before.left), `${step}: 横`).toBeLessThan(2);
  expect(Math.abs(now.top - before.top), `${step}: 縦`).toBeLessThan(2);
}

/** `\text{漢字}\text{数}` のように分かれても、確定した文字だけを順に比べる。 */
const kanji = (tex: string) => tex.replace(/[^\p{Script=Han}]/gu, "");

/** IME の入力を受ける隠し要素 (候補窓の位置もここで決まる) の左上が、数式の枠から外れている距離。 */
function sinkOffsetFromField(field: Locator) {
  return field.evaluate(el => {
    const sink = el.shadowRoot!.querySelector(".ML__keyboard-sink")!.getBoundingClientRect();
    // MathLive は変換開始時のキャレットの左上に置く (変換中はキャレットだけ右へ進む)。
    const box = el.getBoundingClientRect();
    return Math.max(box.left - sink.left, sink.left - box.right, box.top - sink.top, sink.top - box.bottom, 0);
  });
}
