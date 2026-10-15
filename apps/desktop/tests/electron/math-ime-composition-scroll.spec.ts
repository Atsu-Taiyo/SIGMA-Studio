import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import type { MathfieldElement } from "mathlive";
import type { SigmaDocument } from "@/features/document";
import { selectUiOptionInPage } from "../e2e/ui-select";

const APP_ROOT = path.resolve(__dirname, "../..");

// 紙面の .page-stack はズームの transform を持つので、MathLive が IME 変換の開始時に
// 画面座標で置く隠し入力欄 (position: fixed) が紙面基準にずれる。改ページの後の数式では
// 画面の上の外へ出て、変換中に編集面が上へ飛んでいた。
test("IME composition in math after a page break keeps the viewport and anchors the input at the caret", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-math-ime-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1200, 850));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const text = (id: string) => ({ type: "paragraph" as const, id, children: [{ type: "text" as const, text: `${id} 改ページ後の数式の確認` }] });
    const source: SigmaDocument = {
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
    };
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
      const before = await scroller.evaluate(el => el.scrollTop);
      expect(before).toBeGreaterThan(400);
      // 同じ数式で2回変換する (2回目は前回置いた位置から始まる)。
      for (const [steps, committed] of [[["k", "か", "かん", "かんじ"], "漢字"], [["s", "す", "すう"], "数"]] as const) {
        for (const composing of steps) {
          await ime.send("Input.imeSetComposition", { text: composing, selectionStart: composing.length, selectionEnd: composing.length });
          await expect.poll(() => sinkOffsetFromField(field)).toBeLessThanOrEqual(2);
          expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - before), `${zoom}% ${composing}`).toBeLessThan(2);
        }
        await ime.send("Input.insertText", { text: committed });
        typed += committed;
        await expect.poll(async () => kanji(await field.evaluate(el => (el as MathfieldElement).value))).toBe(typed);
        await page.waitForTimeout(100);
        expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - before), `${zoom}% ${committed}`).toBeLessThan(2);
      }
      await field.screenshot({ path: testInfo.outputPath(`composed-${zoom}.png`) });
      await page.keyboard.press("Enter");
      await expect(field).toHaveCount(0);
    }
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(async () => {
      const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
      const body = saved?.content.find(block => block.id === "answer");
      const tex = body?.type === "paragraph" ? body.children.find(run => run.type === "mathInline")?.tex : undefined;
      return tex === undefined ? undefined : kanji(tex);
    }).toBe(typed);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});

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
