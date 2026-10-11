import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { SigmaBlock, SigmaDocument } from "@/features/document";

/**
 * ツールバーの文字サイズ欄にフォーカスを移したときの本文の扱い。
 *
 * 1. 欄に入って何も変えずに出るだけで、選択中の文字・数式に文字サイズが書き込まれていた
 *    (まちまちの範囲は表示中の値にそろった)。文書が変わり、数式の選択色が消える原因にもなった。
 * 2. 欄にフォーカスがある間、本文の選択の色が全部消えていた (何に効くのか見えない)。
 */

const APP_ROOT = path.resolve(__dirname, "../..");

async function launch(content: SigmaBlock[]): Promise<{ app: ElectronApplication; page: Page; fileId: string; profile: string }> {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-toolbar-focus-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const page = await app.firstWindow();
  await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1400, 900));
  await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
  const source: SigmaDocument = {
    version: "2.0", docId: "toolbar_focus_selection",
    metadata: { title: "ツールバーと選択", styleUnits: { fontSize: "pt" } },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
  const fileId = await page.evaluate(async document => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    await window.desktopAPI!.settings!.setUiLocale!("ja");
    const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
    await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
    return file.fileId;
  }, source);
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
  return { app, page, fileId, profile };
}

const CONTENT: SigmaBlock[] = [
  { type: "paragraph", id: "p0", children: [
    { type: "text", text: "大きい", fontSize: 16 },
    { type: "text", text: "前の文字と分数 " },
    { type: "mathInline", id: "m0", tex: "\\frac{1}{2}", display: "inline" },
    { type: "text", text: " の後の文字" },
  ] },
  { type: "paragraph", id: "p1", children: [{ type: "text", text: "クリックで焦点を戻す段落" }] },
];

/** 段落の中の文字 `from` の左端から `to` の右端までドラッグする (数式の文字は数えない)。 */
async function dragText(page: Page, blockId: string, from: number, to: number): Promise<void> {
  const points = await page.locator(`.page-flow [data-sigma-doc-id="${blockId}"]`).first().evaluate((el, [start, end]) => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest(".inline-math-node") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const rectAt = (index: number) => {
      let rest = index;
      for (const node of nodes) {
        if (rest < node.data.length) {
          const range = document.createRange();
          range.setStart(node, rest);
          range.setEnd(node, rest + 1);
          return range.getBoundingClientRect();
        }
        rest -= node.data.length;
      }
      throw new Error(`no character ${index}`);
    };
    const a = rectAt(start);
    const b = rectAt(end);
    return { x0: a.left + 1, y0: a.top + a.height / 2, x1: b.right - 1, y1: b.top + b.height / 2 };
  }, [from, to] as const);
  await page.mouse.move(points.x0, points.y0);
  await page.mouse.down();
  await page.mouse.move(points.x1, points.y1, { steps: 8 });
  await page.mouse.up();
}

function fontSizeInput(page: Page): Locator {
  return page.locator(".editor-menubar input.toolbar-font-size-input");
}

async function savedSizes(page: Page, fileId: string): Promise<string[]> {
  await page.keyboard.press("ControlOrMeta+s");
  const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
  const paragraph = saved?.content.find(block => block.id === "p0");
  return paragraph?.type === "paragraph"
    ? paragraph.children.map(run => `${run.type === "text" ? run.text : run.tex}@${run.fontSize ?? "-"}`)
    : [];
}

async function returnFocusToBody(page: Page): Promise<void> {
  await page.locator('.page-flow [data-sigma-doc-id="p1"]').first().click({ position: { x: 4, y: 6 } });
  await expect(page.locator(".page-flow .ProseMirror-focused")).toHaveCount(1);
}

test("leaving the font size box unchanged does not write a size into the document", async () => {
  const { app, page, fileId, profile } = await launch(CONTENT);
  try {
    // Tab で欄を抜ける: 本文の選択はそのまま、欄だけからフォーカスが外れる (以前はここで書き込んだ)。
    // 引き継いだ文字サイズの範囲 (数式を含む) と、指定のある文字にまたがる範囲の両方。
    for (const [from, to] of [[3, 12], [0, 12]] as const) {
      await dragText(page, "p0", from, to);
      await fontSizeInput(page).click();
      await page.keyboard.press("Tab");
      await expect(fontSizeInput(page)).not.toBeFocused();
      await returnFocusToBody(page);
    }

    // 打ち変えた値は今までどおり書き込む。これが保存に届くのを待ってから、上の範囲を確かめる
    // (書き込まなかったことは待っても観測できないので、後の変更と同じ保存で見る)。
    await dragText(page, "p0", 13, 14);
    await fontSizeInput(page).click();
    await fontSizeInput(page).fill("20");
    await page.keyboard.press("Tab");
    await expect.poll(() => savedSizes(page, fileId)).toContain("後の@20");
    const saved = await savedSizes(page, fileId);
    expect(saved[0]).toBe("大きい@16");
    expect(saved.filter(run => run !== "大きい@16" && run !== "後の@20").every(run => run.endsWith("@-"))).toBe(true);
    await returnFocusToBody(page);

    // まちまちの範囲で Enter を押すのは明示の確定: 表示中の値にそろえる。
    await dragText(page, "p0", 0, 12);
    const shown = await fontSizeInput(page).inputValue();
    await fontSizeInput(page).click();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await savedSizes(page, fileId)).slice(0, 3).every(run => run.endsWith(`@${shown}`))).toBe(true);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the body selection stays painted while the font size box has focus", async () => {
  const { app, page, profile } = await launch(CONTENT);
  try {
    await dragText(page, "p0", 3, 12);
    const formula = page.locator('.page-flow [data-sigma-doc-id="p0"] .inline-math-node');
    // 指定のある文字と同じ段落なので、選択の印は数式を包む span に載る。色は数式に出る。
    await expect.poll(() => formula.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");

    await fontSizeInput(page).click();
    await fontSizeInput(page).fill("18");
    // 入力欄がブラウザの選択を持っていっても、本文の選択はエディタの状態選択から描き直す。
    const editor = page.locator('.page-flow .text-flow-editor:has([data-sigma-doc-id="p0"])');
    await expect(editor).toHaveAttribute("data-held-body-selection", "");
    await expect.poll(() => page.evaluate(() => {
      const ranges = CSS.highlights?.get("held-body-selection");
      return ranges ? [...ranges].map(range => range.toString().replace(/​/g, "")).join("") : "";
    })).toContain("前の文字と分数");
    await expect.poll(() => formula.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");

    // 本文へ戻ればネイティブの選択に任せて外す。
    await returnFocusToBody(page);
    await expect(page.locator("[data-held-body-selection]")).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});
