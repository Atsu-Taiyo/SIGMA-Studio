import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { ensurePageLayout, type SigmaDocument } from "@/features/document";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";

const APP_ROOT = path.resolve(__dirname, "../..");
const DEV_URL = process.env.SIGMA_STUDIO_DEV_SERVER_URL ?? process.env.SIGMA_STUDIO_E2E_BASE_URL;
const SHAPE_ID = "shape_boxed_typing";

/**
 * 図中テキストの囲み枠の入力まわり。
 *
 * 1. 囲みを Off にして続きを打つと、その次の 1 文字が枠の中に入り、もう 1 文字打つと外へ出た。
 *    囲みの区間の装飾範囲 (枠を読む DOM) が、端に打った「囲みなしの文字」まで巻き込んでいた。
 * 2. 囲みを付けた瞬間、行が 16 → 30 → 23.5px と伸び縮みし、編集中だけ静的な描画 (22px) より
 *    高く残った。囲みの外側の印が自前の行高を持ち、行そのものを決めていた。
 */
test("a character typed beside a box stays outside its frame, and boxing a line does not make it jump", async ({}, testInfo) => {
  test.setTimeout(240_000);
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!DEV_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-overlay-boxed-typing-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (DEV_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = DEV_URL;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1300, 900));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    // 起動の初期化が終わる前に教材を作ると、その後の初期化が作業状態を上書きして教材が開かない。
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const source = ensurePageLayout({
      version: "2.0", docId: "overlay_boxed_typing",
      metadata: { title: "図中テキストの囲み", styleUnits: { fontSize: "pt" } },
      content: [{ type: "paragraph", id: "body", children: [{ type: "text", text: "本文" }] }],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    } as SigmaDocument);
    source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
      id: SHAPE_ID, type: "text", x: 100, y: 220, rotation: 0,
      props: { w: 400, h: 64, color: "#111111", size: "m", blocks: [{
        type: "paragraph", id: "shape_boxed_typing_text", children: [{ type: "text", text: "あいう" }],
      }] },
    }] } };
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, source);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();

    const shape = page.locator(`.overlay-shape-text[data-overlay-shape-id="${SHAPE_ID}"]`);
    const bar = page.locator(".editor-menubar");
    const applyBox = bar.getByRole("button", { name: "囲み文字を適用", exact: true });
    const removeBox = bar.getByRole("button", { name: "囲み文字を解除", exact: true });
    await expect(shape).toBeVisible();
    await installLineReader(page);
    const plain = await lineMetrics(page);

    await grabShapeFromBody(page, shape);
    await shape.dblclick();
    await expect(shape.locator(".ProseMirror")).toHaveCount(1);
    await expect.poll(async () => lineGap(await lineMetrics(page), plain)).toBeLessThanOrEqual(LINE_TOLERANCE_PX);

    // --- 囲みを付けた瞬間に、行が一度伸びてから縮むことがない。編集中の高さは静的な描画と同じ。 ---
    // 「い」だけを選んで囲む。
    await placeCaret(page, 1, 2);
    await trackLine(page);
    await applyBox.click();
    await page.waitForTimeout(1500);
    const track = await untrackLine(page);
    const settled = track.at(-1)!;
    expect(settled.line, "the boxed line is taller than a plain one").toBeGreaterThan(plain.line + 2);
    expect(Math.max(...track.map(row => row.line)), "the line never overshoots its settled height").toBeLessThanOrEqual(settled.line + 0.5);
    expect(Math.max(...track.map(row => row.shape)), "the shape never overshoots its settled height").toBeLessThanOrEqual(settled.shape + 0.5);
    await expectFramesMatchText(page);
    const editing = await lineMetrics(page);
    await page.screenshot({ path: testInfo.outputPath("01-boxed-editing.png") });

    // 編集を抜けた静的な描画と、行の高さも文字の位置も同じ (フォーカスの出入りで上下に動かない)。
    await page.keyboard.press("Escape");
    await page.mouse.click(900, 700);
    await expect(shape.locator(".ProseMirror")).toHaveCount(0);
    await expect.poll(async () => lineGap(await lineMetrics(page), editing)).toBeLessThanOrEqual(LINE_TOLERANCE_PX);
    await page.screenshot({ path: testInfo.outputPath("02-boxed-static.png") });

    // --- 囲みを外して続きを打つと、その文字は枠の外。 ---
    await grabShapeFromBody(page, shape);
    await shape.dblclick();
    await expect(shape.locator(".ProseMirror")).toHaveCount(1);
    await placeCaretAtEnd(page);
    await applyBox.click(); // 末尾からの囲みを始める (「う」の後ろ)
    await page.keyboard.type("XY");
    await expectFramesMatchText(page);
    await removeBox.click();
    await page.keyboard.type("Z");
    await page.waitForTimeout(700);
    // 以前は 700ms 待っても枠が「Z」まで太いままで、次の 1 文字を打つまで直らなかった。
    expect(await frameProblems(page)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("03-after-off-Z.png") });
    await page.keyboard.type("W");
    await expectFramesMatchText(page);

    // 囲みの直前に打つ文字も同じ (「あ」の後ろの囲みの手前)。
    await placeCaret(page, 1); // 「あ」の後ろ = 囲み「い」の手前
    await page.keyboard.type("P");
    await page.waitForTimeout(700);
    expect(await frameProblems(page)).toEqual([]);

    // 囲みの端の 1 文字だけ囲みを外すと、枠もその分だけ縮む。位置は動かないので、写像だけでは
    // 気づけず、枠が外した文字まで太いまま次の測り直しまで残った。「あPいうXYZW」の「Y」を外す。
    await placeCaret(page, 5, 6);
    await removeBox.click();
    await page.waitForTimeout(700);
    expect(await frameProblems(page)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("04-end-char-unboxed.png") });

    // 保存された文書でも、打った文字・外した文字は囲みの外。
    await expect.poll(() => savedRuns(page, fileId)).toEqual([
      { text: "あP", boxed: false },
      { text: "い", boxed: true },
      { text: "う", boxed: false },
      { text: "X", boxed: true },
      { text: "YZW", boxed: false },
    ]);
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/** 図形の高さ・最初の行の高さ・先頭の文字の上端 (図形の上端から)。 */
interface Line { line: number; shape: number; textTop: number }

/** フォントによる端数の違いは許すが、以前の食い違い (編集中 +1.5px、先頭の文字 +0.5px) は拾う幅。 */
const LINE_TOLERANCE_PX = 0.75;

function lineGap(a: Line, b: Line): number {
  return Math.max(Math.abs(a.line - b.line), Math.abs(a.shape - b.shape), Math.abs(a.textTop - b.textTop));
}

/**
 * 読み取りはページ側に 1 度だけ置く。毎フレームの追跡も同じ関数を使うので、1 点の読みと
 * 追跡の読みが食い違わない (配布版の CSP は eval を許さないので、文字列から作ることはしない)。
 */
async function installLineReader(page: Page): Promise<void> {
  await page.evaluate(() => {
    const holder = window as unknown as { __readLine?: (id: string) => { line: number; shape: number; textTop: number } };
    holder.__readLine = (id) => {
      const root = document.querySelector(`.overlay-shape-text[data-overlay-shape-id="${id}"]`)!;
      const paragraph = root.querySelector("p")!;
      const base = root.getBoundingClientRect().top;
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      let textTop = Number.NaN;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node.textContent ?? "").length || node.parentElement?.closest(".boxed-run-frame-layer")) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        textTop = range.getBoundingClientRect().top - base;
        break;
      }
      const round = (value: number) => Math.round(value * 2) / 2;
      return { line: round(paragraph.getBoundingClientRect().height), shape: round(root.getBoundingClientRect().height), textTop: round(textTop) };
    };
  });
}

async function lineMetrics(page: Page): Promise<Line> {
  return page.evaluate((id) => (window as unknown as { __readLine: (id: string) => Line }).__readLine(id), SHAPE_ID);
}

async function trackLine(page: Page): Promise<void> {
  await page.evaluate((id) => {
    const holder = window as unknown as { __readLine: (id: string) => Line; __lineTrack?: { stop: boolean; rows: Line[] } };
    if (holder.__lineTrack) holder.__lineTrack.stop = true;
    const track = { stop: false, rows: [] as Line[] };
    holder.__lineTrack = track;
    const tick = () => {
      if (track.stop) return;
      track.rows.push(holder.__readLine(id));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, SHAPE_ID);
}

async function untrackLine(page: Page): Promise<Line[]> {
  return page.evaluate(() => {
    const holder = window as unknown as { __lineTrack?: { stop: boolean; rows: Line[] } };
    holder.__lineTrack!.stop = true;
    return holder.__lineTrack!.rows;
  });
}

/** 先頭の段落の中の文字を [from, to) 文字目で選ぶ (to を省くとキャレットだけ)。 */
async function placeCaret(page: Page, from: number, to?: number): Promise<void> {
  await page.evaluate(([id, start, end]) => {
    const paragraph = document.querySelector(`.overlay-shape-text[data-overlay-shape-id="${id}"] .ProseMirror p`)!;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node.textContent ?? "").length && !(node.parentElement?.closest(".boxed-run-frame-layer"))) nodes.push(node as Text);
    }
    const locate = (offset: number) => {
      let left = offset;
      for (const node of nodes) {
        const length = node.textContent!.length;
        if (left <= length) return { node, offset: left };
        left -= length;
      }
      return { node: nodes.at(-1)!, offset: nodes.at(-1)!.textContent!.length };
    };
    const selection = window.getSelection()!;
    const a = locate(start);
    const b = end === undefined ? a : locate(end);
    selection.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
  }, [SHAPE_ID, from, to] as const);
  await page.waitForTimeout(250);
}

async function placeCaretAtEnd(page: Page): Promise<void> {
  const length = await page.evaluate((id) => (document.querySelector(`.overlay-shape-text[data-overlay-shape-id="${id}"] .ProseMirror p`)!.textContent ?? "").length, SHAPE_ID);
  await placeCaret(page, length);
}

/**
 * 囲みの中の文字は枠の中、囲みの外の文字は枠の外にあるか。違う文字の一覧 (空なら正しい)。
 * 枠はセグメントの border ではなく別レイヤの矩形 1 枚なので、文字の中心がその矩形に入るかで見る。
 */
async function frameProblems(page: Page): Promise<string[]> {
  return page.evaluate((id) => {
    const content = document.querySelector(`.overlay-shape-text[data-overlay-shape-id="${id}"] .ProseMirror`)!;
    const frames = Array.from(content.querySelectorAll(".boxed-run-frame")).map(frame => frame.getBoundingClientRect());
    const problems: string[] = [];
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (!text || node.parentElement?.closest(".boxed-run-frame-layer")) continue;
      const boxed = node.parentElement?.closest(".boxed-text") !== null;
      for (let index = 0; index < text.length; index++) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getClientRects()[0];
        if (!rect) continue;
        const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
        const inside = frames.some(frame => x >= frame.left && x <= frame.right && y >= frame.top && y <= frame.bottom);
        if (boxed && !inside) problems.push(`boxed '${text[index]}' is outside the frame`);
        if (!boxed && inside) problems.push(`unboxed '${text[index]}' is inside the frame`);
      }
    }
    return problems;
  }, SHAPE_ID);
}

/** 枠が描かれ終えるのを待ってから、文字と枠が食い違っていないことを見る。 */
async function expectFramesMatchText(page: Page): Promise<void> {
  await expect.poll(async () => (await frameProblems(page)).length === 0
    && await page.locator(`.overlay-shape-text[data-overlay-shape-id="${SHAPE_ID}"] .boxed-run-frame`).count() > 0, { timeout: 5000 }).toBe(true);
}

/** 保存された図形の 1 段落目を (文字, 囲みか) の連なりにして返す。隣り合う同じ囲み状態は 1 つにまとめる。 */
async function savedRuns(page: Page, fileId: string): Promise<{ text: string; boxed: boolean }[]> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  return page.evaluate(async (id) => {
    const document = await window.desktopAPI!.storage.loadDocument(id);
    const found = document?.pageLayout?.overlay?.overlaySnapshot?.shapes.find(item => item.id === "shape_boxed_typing");
    const block = found?.type === "text" ? found.props.blocks[0] : undefined;
    if (block?.type !== "paragraph") return [];
    const runs: { text: string; boxed: boolean }[] = [];
    for (const child of block.children) {
      if (child.type !== "text") continue;
      const boxed = Array.isArray(child.marks) && child.marks.includes("boxed");
      const last = runs.at(-1);
      if (last && last.boxed === boxed) last.text += child.text;
      else runs.push({ text: child.text, boxed });
    }
    return runs;
  }, fileId);
}
