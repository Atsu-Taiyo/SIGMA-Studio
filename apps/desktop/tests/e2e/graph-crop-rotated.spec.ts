import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 回した図でも、切り取り・拡大で「残した部分」が紙面の同じ場所に残る。
 *
 * 回転は図形の中心を軸に描かれる。切り取りで幅と高さが変わると軸も動くので、位置の補正が左上を
 * 軸にした式のままだと、角度が 0 以外のときだけ図が別の場所へずれた。ドラッグの移動量も、画面の
 * 座標をそのまま図の座標として使っていたため、回した図では動かした向きと違う辺が動いた。
 *
 * 図の原点に置いた点を目印にし、描かれた円の画面上の中心が、確定の前後で動かないことで確かめる。
 * (単位テストの式ではなく、実際に描かれた位置を見るので、描画側の軸の取り方が変わっても気づける。)
 */

const GRAPH_ID = "graph_rotated_crop";

function documentWithRotatedGraph(rotation: number): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_rotated_graph_crop";
  document.metadata = { ...document.metadata, title: "回した図の切り取り E2E" };
  document.content = [{ type: "paragraph", id: "p_rotated_crop", children: [{ type: "text", text: "本文" }] }];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: GRAPH_ID,
            type: "graph2dShape",
            x: 280,
            y: 330,
            rotation,
            props: {
              boundsMode: "plot",
              w: 400,
              h: 220,
              spec: {
                kind: "cartesian",
                title: "",
                width: 464,
                height: 272,
                viewBox: { xMin: "-5", xMax: "5", yMin: "-2.75", yMax: "2.75" },
                axes: { grid: false, showX: true, showY: true, showTicks: false, xLabel: "", yLabel: "", originLabel: "" },
                curves: [],
                points: [{ id: "origin_marker", x: "0", y: "0", color: "#dc2626" }],
                showFormulaLabels: false,
              },
            },
          },
        ],
        assets: {},
      },
    },
  } as SigmaDocument["pageLayout"];
  return document;
}

async function open(page: Page, rotation: number) {
  await page.addInitScript(() => window.localStorage.clear());
  await page.setViewportSize({ width: 1600, height: 1100 });
  await installDesktopRuntimeMock(page, documentWithRotatedGraph(rotation));
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  await expect(page.locator(".graph-shape .graph2d-point").first()).toBeVisible();
  // 図形の位置はアンカー解決とブリード適用が終わるまで動く。
  await page.waitForTimeout(500);
}

async function center(page: Page, selector: string) {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const markerCenter = (page: Page) => center(page, ".graph-shape .graph2d-point");

async function enterCrop(page: Page) {
  const middle = await center(page, ".graph-shape .graph2d-plot-bg");
  await page.mouse.click(middle.x, middle.y);
  // 本文モードでは最初の押下で編集面が組み立てられる。選択が出るのを待ってから 2 回目を押す。
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  await page.waitForTimeout(300);
  await page.mouse.dblclick(middle.x, middle.y);
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(1);
}

/** 図の x・y 軸に沿って (localDx, localDy) だけ、ハンドルを画面上で動かす。 */
async function dragAlongGraphAxes(
  page: Page,
  handle: "l" | "r" | "t" | "b",
  rotation: number,
  localDx: number,
  localDy: number,
  options: { alt?: boolean } = {},
) {
  const order = ["tl", "tr", "bl", "br", "t", "b", "l", "r"];
  const grip = (await page
    .locator(".graph2d-container.cropping circle[fill='transparent']")
    .nth(order.indexOf(handle))
    .boundingBox())!;
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const screenDx = localDx * cos - localDy * sin;
  const screenDy = localDx * sin + localDy * cos;
  if (options.alt) await page.keyboard.down("Alt");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + screenDx, y + screenDy, { steps: 10 });
  await page.mouse.up();
  if (options.alt) await page.keyboard.up("Alt");
}

async function finish(page: Page) {
  // 用紙の内側の空白 (図から離れた本文の下)。用紙の外を押しても、本文モードでは何も起きない。
  await page.mouse.click(520, 1000);
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
}

async function savedGraph(page: Page) {
  return page.evaluate(async (id) => {
    const doc = await window.desktopAPI!.storage.loadDocument("file_e2e_document");
    const shapes = (doc?.pageLayout?.overlay?.overlaySnapshot as { shapes: Array<{ id: string; x: number; y: number; props: { w: number; h: number } }> }).shapes;
    return shapes.find((shape) => shape.id === id)!;
  }, GRAPH_ID);
}

const ROTATIONS = [
  { name: "0°", radians: 0 },
  { name: "30°", radians: Math.PI / 6 },
  { name: "90°", radians: Math.PI / 2 },
  // 逆向きに回した図。ほかの角度の候補 (例: -120°) は、右辺のハンドルが選択時の浮動ツールバーの真下に
  // 来て押下が吸われるので、ハンドルがツールバーと重ならない角度を選んでいる。
  { name: "150°", radians: (5 * Math.PI) / 6 },
];

for (const { name, radians } of ROTATIONS) {
  test.describe(`graph turned ${name}`, () => {
    test("keeps the part that stays on the same spot of the page after cutting", async ({ page }) => {
      await open(page, radians);
      const before = await markerCenter(page);
      await enterCrop(page);

      // 図の座標で: 右を 100、左を 50、下を 40 切る。
      await dragAlongGraphAxes(page, "r", radians, -100, 0);
      await dragAlongGraphAxes(page, "l", radians, 50, 0);
      await dragAlongGraphAxes(page, "b", radians, 0, -40);
      await finish(page);

      const after = await markerCenter(page);
      expect(Math.abs(after.x - before.x)).toBeLessThan(0.75);
      expect(Math.abs(after.y - before.y)).toBeLessThan(0.75);
      // ドラッグが図の軸に沿って効いている: 幅は 400-150、高さは 220-40。
      await expect.poll(async () => (await savedGraph(page)).props.w).toBeCloseTo(250, 0);
      expect((await savedGraph(page)).props.h).toBeCloseTo(180, 0);
    });

    test("keeps the part that stays on the same spot of the page after widening with the modifier key", async ({ page }) => {
      await open(page, radians);
      const before = await markerCenter(page);
      await enterCrop(page);

      await dragAlongGraphAxes(page, "l", radians, -60, 0, { alt: true });
      await dragAlongGraphAxes(page, "t", radians, 0, -30, { alt: true });
      await dragAlongGraphAxes(page, "r", radians, 90, 0, { alt: true });
      await finish(page);

      const after = await markerCenter(page);
      expect(Math.abs(after.x - before.x)).toBeLessThan(0.75);
      expect(Math.abs(after.y - before.y)).toBeLessThan(0.75);
      await expect.poll(async () => (await savedGraph(page)).props.w).toBeCloseTo(550, 0);
      expect((await savedGraph(page)).props.h).toBeCloseTo(250, 0);
    });
  });
}
