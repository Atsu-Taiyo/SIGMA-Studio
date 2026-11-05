import { handleSessionPrompts } from "./session-prompts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import type { OverlayShape, SigmaDocument } from "@/features/document";

const root = path.resolve(__dirname, "../..");
const rect = (id: string, x: number, y: number, anchor?: OverlayShape["anchor"]): OverlayShape => ({
  id, type: "geo", x, y, ...(anchor ? { anchor } : {}),
  props: { w: 80, h: 50, geo: "rectangle", fill: "solid", color: "black", labelColor: "black", dash: "solid", size: "m" },
});
const text = (value: string) => [{ type: "text" as const, text: value }];

async function openDocument(page: Page, document: SigmaDocument): Promise<string> {
  const fileId = await page.evaluate(async (source) => {
    const created = await window.desktopAPI!.storage.createFileFromDocument({ document: source });
    await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
    return created.file.fileId;
  }, document);
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator('.page-flow [data-sigma-doc-id="p2"]').first()).toBeVisible();
  return fileId;
}

/** 紙面 (`.page-canvas`) の左上から測った位置。既定の 100% 表示では紙面のモデル座標と同じ。 */
async function offset(page: Page, selector: string) {
  return page.evaluate((target) => {
    const canvas = document.querySelector(".page-canvas")!.getBoundingClientRect();
    const rect = document.querySelector(target)!.getBoundingClientRect();
    return { x: rect.x - canvas.x, y: rect.y - canvas.y };
  }, selector);
}

test("opening a material connects figures fixed to the page to the body text at their height", async ({}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-connect-on-open-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await handleSessionPrompts(page);
    await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1400, 900));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    });

    const body = structuredClone(sampleDocument);
    body.metadata = { title: "開いたときの本文への接続" };
    body.content = [
      { type: "paragraph", id: "p1", children: text("図の上にある本文。ここに行が増えると、下の本文と図が一緒に下がる。") },
      { type: "paragraph", id: "p2", children: text("図はこの段落の高さに置いてある。ページに固定されたまま開くと、この段落に繋がる。") },
      { type: "paragraph", id: "p3", children: text("最後の段落。") },
    ];
    // 同じ本文の教材で段落の位置を測ってから、その高さに図を置いた教材を作る。
    const measuring = structuredClone(body);
    measuring.docId = "connect_on_open_measure";
    await openDocument(page, measuring);
    const p2 = await offset(page, '.page-flow [data-sigma-doc-id="p2"]');

    const source = structuredClone(body);
    source.docId = "connect_on_open";
    const beside = { x: Math.round(p2.x + 420), y: Math.round(p2.y + 4) };
    source.pageLayout = { ...source.pageLayout!, overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: [
      rect("beside", beside.x, beside.y, { type: "page" }),
      // 上の余白 (ヘッダーの帯) だけにある飾りは、ページに固定したまま。
      rect("header", 120, 4, { type: "page" }),
    ] } } };
    const fileId = await openDocument(page, source);
    const load = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
    const shapes = async () => (await load())!.pageLayout!.overlay!.overlaySnapshot!.shapes;

    await expect.poll(async () => (await shapes()).find(item => item.id === "beside")!.anchor?.type).toBe("block");
    const saved = await shapes();
    expect(saved.find(item => item.id === "beside")!.anchor).toMatchObject({ type: "block", blockId: "p2", line: { index: 0 } });
    expect(saved.find(item => item.id === "header")!.anchor).toEqual({ type: "page" });
    // 繋いでも 1 px も動かない。
    const figure = '.page-stack .overlay-shape[data-overlay-shape-id="beside"]';
    const opened = await offset(page, figure);
    expect(Math.abs(opened.x - beside.x)).toBeLessThan(0.1);
    expect(Math.abs(opened.y - beside.y)).toBeLessThan(0.1);

    // 上の本文に行を足すと、図は横の段落と同じだけ下がる。
    await page.evaluate(() => {
      const paragraph = document.querySelector('.page-flow .ProseMirror [data-sigma-doc-id="p1"]')!;
      (paragraph.closest(".ProseMirror") as HTMLElement).focus();
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text;
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.collapse(last!, last!.length);
    });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await offset(page, '.page-flow [data-sigma-doc-id="p2"]')).y).toBeGreaterThan(p2.y + 10);
    const movedParagraph = await offset(page, '.page-flow [data-sigma-doc-id="p2"]');
    await expect.poll(async () => (await offset(page, figure)).y - beside.y).toBeCloseTo(movedParagraph.y - p2.y, 0);
    await page.screenshot({ path: testInfo.outputPath("connected-figure-follows-text.png") });

    // 保存して開き直しても繋がったまま、同じ位置。
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(async () => (await load())!.content.length).toBe(5);
    const followed = await offset(page, figure);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(figure)).toBeVisible();
    await expect.poll(async () => Math.abs((await offset(page, figure)).y - followed.y)).toBeLessThan(0.5);
    const reopened = await shapes();
    expect(reopened.find(item => item.id === "beside")!.anchor).toMatchObject({ type: "block", blockId: "p2" });
    expect(reopened.find(item => item.id === "header")!.anchor).toEqual({ type: "page" });
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
