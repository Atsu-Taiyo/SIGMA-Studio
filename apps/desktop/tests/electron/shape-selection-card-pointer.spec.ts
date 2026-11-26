import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import type { OverlayShape } from "@/features/document";

const root = path.resolve(__dirname, "../..");

// 図形の選択のカードは、図形の上下ではなく選んだときのマウスの近くに出す。図形が画面より大きい
// (拡大している) と、図形の上下は画面の外にあり、カードが見えなくなるため。
// カードは段を決め打ちせずに折り返し、「…」は右上に置く。
test("shape selection card opens next to the pointer with the more button at the top right", async ({}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-shape-card-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1400, 900));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const tall: OverlayShape = {
      id: "tall", type: "geo", x: 120, y: 40, anchor: { type: "page" },
      props: { w: 420, h: 1000, geo: "rectangle", fill: "solid", color: "black", labelColor: "black", dash: "solid", size: "m" },
    };
    const source = structuredClone(sampleDocument);
    source.docId = "shape_selection_card_pointer";
    source.metadata = { title: "図形カードの位置" };
    source.content = [{ type: "paragraph", id: "p", children: [{ type: "text", text: "大きな図形を選ぶ。" }] }];
    source.pageLayout = { ...source.pageLayout!, overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: [tall] } } };
    await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
    }, source);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const shape = page.locator('.page-stack .overlay-shape[data-overlay-shape-id="tall"]');
    await expect(shape).toBeVisible();

    const box = (await shape.boundingBox())!;
    const click = { x: box.x + 200, y: Math.min(box.y + 420, 600) };
    await page.mouse.click(click.x, click.y);
    const card = page.locator(".selection-action-popover--card");
    await expect(card).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("shape-card.png") });
    const cardBox = (await card.boundingBox())!;
    expect(Math.abs(cardBox.x - (click.x + 12))).toBeLessThan(2);
    expect(Math.abs(cardBox.y - (click.y + 16))).toBeLessThan(2);

    // 「…」はカードの右上。
    const more = card.getByRole("button", { name: "その他", exact: true });
    const moreBox = (await more.boundingBox())!;
    expect(cardBox.x + cardBox.width - (moreBox.x + moreBox.width)).toBeLessThan(10);
    expect(moreBox.y - cardBox.y).toBeLessThan(10);

    // 別の場所で押し直すと、カードもそこへ移る。
    const second = { x: box.x + 120, y: click.y + 150 };
    await page.mouse.click(second.x, second.y);
    await expect.poll(async () => Math.round((await card.boundingBox())!.y)).toBe(Math.round(second.y + 16));
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
