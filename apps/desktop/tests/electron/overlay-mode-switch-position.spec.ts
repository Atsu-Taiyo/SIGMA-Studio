import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { createGraph2DSpecPreset } from "@/lib/graph2d";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

/**
 * #207: 図形の編集 (図形選択) へ切り替えた瞬間に、本文に付いた図形が上下にずれた。
 *
 * 本文に付いた図形の保存座標 (`y`) は、最後に図形を保存したときの位置のまま。本文を打って図形が
 * 下へ動いても書き換わらない (表示は錨と本文の実測から解く)。編集面を開くと、開いた直後の
 * グラフのラベル整合がその保存座標から図形を組み直し、解いた位置を上書きしていた。本文が動く
 * (Enter) までアンカーは解き直されないので、改行すると戻って見えた。ラベル整合が保存も起こすと、
 * ずれた位置が錨に焼き込まれて再読み込み後も残った。
 *
 * ここでは保存座標をわざと古くした (y = 0) 教材と、開くとラベルを作るグラフを置き、
 * 切り替えの前後と、保存して起動し直した後で、図形の画面上の位置を数値で比べる。
 */
const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_DEV_SERVER_URL ?? process.env.SIGMA_STUDIO_E2E_BASE_URL;
const ANCHORED_IDS = ["fig_top", "fig_line", "fig_lower"] as const;
const TRACKED_IDS = [...ANCHORED_IDS, "fig_page", "graph"] as const;

function rectangle(id: string, x: number, y: number, anchor: unknown) {
  return {
    id,
    type: "geo",
    x,
    y,
    anchor,
    props: { w: 120, h: 50, geo: "rectangle", fill: "none", color: "#1133cc", labelColor: "#111111", dash: "solid", size: "m" },
  };
}

function sourceDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_overlay_mode_switch_position";
  document.metadata = { ...document.metadata, title: "図形切り替えの位置" };
  const long = "折り返しのある長い段落です。".repeat(14);
  document.content = Array.from({ length: 32 }, (_, index) => ({
    type: "paragraph" as const,
    id: `p_${index}`,
    lineHeight: "1.35" as const,
    children: [{ type: "text" as const, text: index % 4 === 3 ? `${index}: ${long}` : `段落 ${index} の本文。` }],
  })) as SigmaDocument["content"];
  const spec = createGraph2DSpecPreset("blank");
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [
          // 保存座標 y = 0 は、図形を保存した後に本文を打ち足した教材と同じ状態 (表示は錨から解く)。
          rectangle("fig_top", 420, 0, { type: "block", blockId: "p_2", dy: 4 }),
          rectangle("fig_line", 420, 0, { type: "block", blockId: "p_7", dy: 0, dx: 300, line: { index: 1, dy: 2 } }),
          rectangle("fig_lower", 420, 0, { type: "block", blockId: "p_27", dy: 6 }),
          rectangle("fig_page", 120, 760, { type: "page" }),
          // 軸ラベルの文字を持つのに、ラベルの文字図形がまだ無いグラフ。編集面を開くとラベルが作られる。
          {
            id: "graph",
            type: "graph2dShape",
            x: 120,
            y: 860,
            anchor: { type: "page" },
            props: { boundsMode: "plot", w: spec.width, h: spec.height, spec: { ...spec, axes: { ...spec.axes, xLabel: "x", yLabel: "y" } } },
          },
        ],
        assets: {},
      },
    },
  } as SigmaDocument["pageLayout"];
  return document;
}

type Positions = Record<string, { x: number; y: number }>;

/** 図形の左上を、紙面 (`.page-canvas`) の左上からの画面座標で測る。プレビュー面でも編集面でも同じ物差し。 */
async function measureShapes(page: Page): Promise<Positions> {
  return page.evaluate((ids) => {
    const canvas = document.querySelector(".page-canvas")!.getBoundingClientRect();
    const out: Record<string, { x: number; y: number }> = {};
    for (const id of ids) {
      const element = document.querySelector(`.page-stack [data-overlay-shape-id="${CSS.escape(id)}"]`);
      const rect = element?.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) {
        out[id] = { x: rect.left - canvas.left, y: rect.top - canvas.top };
      }
    }
    return out;
  }, [...TRACKED_IDS]);
}

function expectSamePositions(actual: Positions, expected: Positions, label: string) {
  expect(Object.keys(actual).sort(), `${label}: 測れた図形`).toEqual(Object.keys(expected).sort());
  for (const [id, position] of Object.entries(expected)) {
    expect(Math.abs(actual[id].x - position.x), `${label}: ${id} の横のずれ`).toBeLessThan(0.75);
    expect(Math.abs(actual[id].y - position.y), `${label}: ${id} の縦のずれ`).toBeLessThan(0.75);
  }
}

async function launch(profile: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  const page = await app.firstWindow();
  if (devUrl) {
    await expect.poll(() => new URL(page.url()).origin).toBe(new URL(devUrl).origin);
  }
  await (await app.browserWindow(page)).evaluate((win) => win.setContentSize(1400, 900));
  await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
  return { app, page };
}

/** 本文の表示 (プレビュー面) で、追う図形がすべて描かれ、位置が落ち着くまで待つ。 */
async function settledPreviewPositions(page: Page): Promise<Positions> {
  await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
  await expect(page.locator('[data-overlay-editing="false"]')).toHaveCount(1);
  let previous = "";
  await expect.poll(async () => {
    const current = JSON.stringify(await measureShapes(page));
    const settled = current === previous && Object.keys(JSON.parse(current)).length === TRACKED_IDS.length;
    previous = current;
    return settled;
  }, { intervals: [250] }).toBe(true);
  return JSON.parse(previous) as Positions;
}

test("図形の編集へ切り替えても本文に付いた図形は動かず、保存して起動し直しても同じ位置にある (#207)", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-overlay-mode-switch-"));
  let { app, page } = await launch(profile);
  try {
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, sourceDocument());
    await page.reload();
    await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue(/^図形切り替えの位置/);
    const before = await settledPreviewPositions(page);
    // 前提: 保存座標 (y = 0) ではなく、錨から解いた位置に描かれている。
    for (const id of ANCHORED_IDS) {
      expect(before[id].y, `${id} は本文の位置に描かれる`).toBeGreaterThan(100);
    }
    await page.screenshot({ path: testInfo.outputPath("01-body-mode.png") });

    // 紙の左余白を ⌘/Ctrl クリックして、図形の編集 (図形選択) へ切り替える。
    const canvas = (await page.locator(".page-canvas").boundingBox())!;
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.click(canvas.x + 20, canvas.y + 420);
    await page.keyboard.up("ControlOrMeta");
    await expect(page.locator('[data-overlay-editing="true"]')).toHaveCount(1);
    await expect(page.locator(".overlay-canvas-editor")).toBeVisible();
    expectSamePositions(await measureShapes(page), before, "切り替えた直後");

    // 開いた編集面はグラフのラベルを作って保存する。ずれていた頃は、この保存がずれを錨へ焼き込んでいた。
    const saved = () => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
    await expect.poll(async () => (await saved())?.pageLayout?.overlay?.overlaySnapshot?.shapes
      .filter((shape) => shape.anchor?.type === "shape" && shape.anchor.shapeId === "graph").length ?? 0).toBeGreaterThanOrEqual(2);
    expectSamePositions(await measureShapes(page), before, "ラベルが保存された後");
    await page.screenshot({ path: testInfo.outputPath("02-shape-mode.png") });

    // 錨の本文と組は変わらない (保存座標だけが今の位置へ揃う)。
    const anchors = Object.fromEntries(((await saved())?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [])
      .filter((shape) => (ANCHORED_IDS as readonly string[]).includes(shape.id))
      .map((shape) => [shape.id, shape.anchor?.type === "block" ? shape.anchor.blockId : null]));
    expect(anchors).toEqual({ fig_top: "p_2", fig_line: "p_7", fig_lower: "p_27" });

    // 保存して起動し直しても、本文の表示で同じ位置に描かれる。
    await app.close();
    ({ app, page } = await launch(profile));
    expectSamePositions(await settledPreviewPositions(page), before, "起動し直した後");
    await page.screenshot({ path: testInfo.outputPath("03-after-relaunch.png") });
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
