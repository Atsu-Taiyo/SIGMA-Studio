import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { ensurePageLayout, type InlineNode, type SigmaBlock, type SigmaDocument } from "@/features/document";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";

const APP_ROOT = path.resolve(__dirname, "../..");
const DEV_URL = process.env.SIGMA_STUDIO_DEV_SERVER_URL ?? process.env.SIGMA_STUDIO_E2E_BASE_URL;
const SHAPE_ID = "shape_rounded";

/**
 * 囲み文字の角 (#209)。細線・太線・二重の角は尖らせ、角丸は「角の丸み」で丸め具合を決められる。
 * 決めた丸みは紙面・保存・再読み込み・印刷 (PageCanvas の出力) まで同じ形で残る。図形を丸ごと
 * 選んでいるときは、メニューの丸みは図形自身の文字から読み、囲みを外すと丸みも一緒に消える (#210)。
 */
test("boxed text has square corners and an adjustable rounding for the oval style", async ({}, testInfo) => {
  test.setTimeout(180_000);
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!DEV_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-boxed-corners-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (DEV_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = DEV_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    if (DEV_URL) expect(new URL(page.url()).origin).toBe(new URL(DEV_URL).origin);
    const content: SigmaBlock[] = [
      {
        type: "paragraph", id: "p_square", children: [
          { type: "text", text: "細線", marks: ["boxed"] },
          { type: "text", text: " と " },
          { type: "text", text: "太線", marks: ["boxed"], boxedVariant: "thick" },
          { type: "text", text: " と " },
          { type: "text", text: "二重", marks: ["boxed"], boxedVariant: "double" },
        ],
      },
      { type: "paragraph", id: "p_round", children: [{ type: "text", text: "角丸にする文字" }] },
    ] as SigmaBlock[];
    const document = ensurePageLayout({
      version: "2.0", docId: "boxed-text-corners", metadata: { title: "囲み文字の角" }, content,
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    } as SigmaDocument);
    document.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
      id: SHAPE_ID, type: "text", x: 100, y: 320, rotation: 0,
      props: { w: 260, h: 48, color: "#111111", size: "m", blocks: [{
        type: "paragraph", id: "shape_rounded_text", children: [
          { type: "text", text: "図形の角丸", marks: ["boxed"], boxedVariant: "oval", boxedRoundness: 30 },
        ],
      }] },
    }] } };
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const created = await api.createFileFromDocument({ document });
      await api.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const square = page.locator('.page-flow [data-sigma-doc-id="p_square"]').first();
    await expect(square).toBeVisible();
    await page.evaluate(async () => { await window.document.fonts.ready; });

    // 細線・太線・二重の角は尖っている (以前は 2px 丸まっていた)。
    await expect.poll(() => paintedRadii(page, "p_square")).toEqual(["0px", "0px", "0px"]);
    await zoomShot(page, "p_square", testInfo.outputPath("square-corners-x4.png"));

    // 角丸を選ぶと「角の丸み」が出て、既定 (100%) から 10% ずつ角を立てられる。
    await page.locator('.page-flow [data-sigma-doc-id="p_round"]').first().click({ clickCount: 3 });
    await page.locator(".editor-menubar .boxed-text-menu-trigger").click();
    const menu = page.locator(".boxed-text-menu").first();
    await menu.getByRole("button", { name: "角丸", exact: true }).click();
    const stepper = menu.locator('[data-boxed-text-stepper="roundness"]');
    await expect(stepper.locator("output")).toHaveText("100%");
    // 角丸に替わった枠が描かれるまで待ってから既定の丸みを測る (選んだ直後は前の四角い枠が残る)。
    await expect.poll(() => radiusPx(page, "p_round")).toBeGreaterThan(1);
    const fullRadius = await radiusPx(page, "p_round");
    await zoomShot(page, "p_round", testInfo.outputPath("oval-100-x4.png"));
    for (let index = 0; index < 6; index += 1) {
      await stepper.getByRole("button", { name: "角の丸みを10%減らす" }).click();
    }
    await expect(stepper.locator("output")).toHaveText("40%");
    await page.screenshot({ path: testInfo.outputPath("menu-roundness.png") });
    await expect.poll(() => radiusPx(page, "p_round")).toBeCloseTo(fullRadius * 0.4, 1);
    await page.keyboard.press("Escape");
    await zoomShot(page, "p_round", testInfo.outputPath("oval-40-x4.png"));

    // 図形を丸ごと選ぶ (文字の編集には入らない)。メニューの丸みは図形自身の文字から読む。
    const shape = page.locator(`.overlay-shape-text[data-overlay-shape-id="${SHAPE_ID}"]`);
    const shapeRuns = () => page.evaluate(async (id) => {
      const saved = await window.desktopAPI!.storage.loadDocument(id);
      const found = saved?.pageLayout?.overlay?.overlaySnapshot?.shapes.find((item) => item.id === "shape_rounded");
      const block = found?.type === "text" ? found.props.blocks[0] : undefined;
      return block?.type === "paragraph" ? block.children : null;
    }, fileId);
    const shapeRadius = () => shape.locator(".boxed-run-frame, .boxed-text").evaluateAll((elements) => {
      const frames = elements.filter((element) => element.classList.contains("boxed-run-frame"));
      return Number.parseFloat(getComputedStyle((frames[0] ?? elements[0]) as Element).borderTopLeftRadius);
    });
    await grabShapeFromBody(page, shape);
    await expect(shape).toHaveClass(/selected/);
    await expect(shape.locator(".ProseMirror")).toHaveCount(0);
    // 本文で最後に選んだ 40% とは違う値 (30%) を持たせ、図形の文字から読んでいることを確かめる。
    await expect.poll(shapeRadius).toBeGreaterThan(1);
    const shapeFullRadius = (await shapeRadius()) / 0.3;
    await page.locator(".editor-menubar .boxed-text-menu-trigger").click();
    await expect(menu.getByRole("button", { name: "角丸", exact: true })).toHaveClass(/applied/);
    await expect(stepper.locator("output")).toHaveText("30%");
    await stepper.getByRole("button", { name: "角の丸みを10%増やす" }).click();
    await expect(stepper.locator("output")).toHaveText("40%");
    await expect.poll(shapeRuns).toEqual([
      { type: "text", text: "図形の角丸", marks: ["boxed"], boxedVariant: "oval", boxedRoundness: 40 },
    ] satisfies InlineNode[]);
    await expect.poll(shapeRadius).toBeCloseTo(shapeFullRadius * 0.4, 0);
    await page.screenshot({ path: testInfo.outputPath("shape-roundness-40.png") });
    await page.keyboard.press("Escape");

    // 囲みを外すと丸みも一緒に消え、付け直すと最後に使った種類と丸みで戻る (上下余白と同じ規則)。
    const boxButton = (state: "apply" | "remove") => page.locator(".editor-menubar")
      .getByRole("button", { name: state === "apply" ? "囲み文字を適用" : "囲み文字を解除", exact: true });
    await boxButton("remove").click();
    await expect.poll(shapeRuns).toEqual([{ type: "text", text: "図形の角丸" }] satisfies InlineNode[]);
    await expect(shape.locator(".boxed-text")).toHaveCount(0);
    await boxButton("apply").click();
    await expect.poll(shapeRuns).toEqual([
      { type: "text", text: "図形の角丸", marks: ["boxed"], boxedVariant: "oval", boxedRoundness: 40, boxedPaddingY: 0 },
    ] satisfies InlineNode[]);
    await expect.poll(shapeRadius).toBeCloseTo(shapeFullRadius * 0.4, 0);

    await expect.poll(async () => {
      const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
      const block = saved?.content.find((entry) => entry.id === "p_round");
      return block?.type === "paragraph" ? block.children.map((child) => child.type === "text" ? [child.boxedVariant, child.boxedRoundness] : null) : null;
    }).toEqual([["oval", 40]]);

    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('.page-flow [data-sigma-doc-id="p_round"]').first()).toBeVisible();
    await expect.poll(() => radiusPx(page, "p_round")).toBeCloseTo(fullRadius * 0.4, 1);
    await expect.poll(() => paintedRadii(page, "p_square")).toEqual(["0px", "0px", "0px"]);
    await expect.poll(shapeRadius).toBeCloseTo(shapeFullRadius * 0.4, 0);

    // 印刷 (保存した文書を PageCanvas の出力セッションで描く) でも同じ角。
    const printUrl = new URL(page.url());
    printUrl.pathname = printUrl.protocol === "file:" ? printUrl.pathname.replace(/index\.html$/, "print.html") : "/print";
    printUrl.search = new URLSearchParams({ fileId, profile: "teacher" }).toString();
    await page.goto(printUrl.href);
    await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1);
    const printed = page.locator('.paged-surface-page [data-sigma-doc-id="p_round"] .boxed-text').first();
    await expect(printed).toHaveAttribute("data-sigma-doc-boxed-roundness", "40");
    await expect.poll(async () => Number.parseFloat((await paintedRadii(page, "p_round", ".paged-surface-page"))[0] ?? "NaN"))
      .toBeCloseTo(fullRadius * 0.4, 1);
    await expect.poll(() => paintedRadii(page, "p_square", ".paged-surface-page")).toEqual(["0px", "0px", "0px"]);
    writeFileSync(testInfo.outputPath("print.png"), await page.locator(".paged-surface-page").first().screenshot());
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** The radius each boxed run is painted with: its run frame when one is drawn, else the run itself. */
function paintedRadii(page: Page, blockId: string, surface = ".page-flow"): Promise<string[]> {
  return page.evaluate(([id, root]) => {
    const block = window.document.querySelector(`${root} [data-sigma-doc-id="${id}"]`);
    const frames = Array.from(block?.querySelectorAll<HTMLElement>(".boxed-run-frame") ?? []);
    const painted = frames.length > 0 ? frames : Array.from(block?.querySelectorAll<HTMLElement>(".boxed-text") ?? []);
    return painted.map((element) => getComputedStyle(element).borderTopLeftRadius);
  }, [blockId, surface] as const);
}

async function radiusPx(page: Page, blockId: string): Promise<number> {
  const [radius] = await paintedRadii(page, blockId);
  return Number.parseFloat(radius ?? "NaN");
}

async function zoomShot(page: Page, blockId: string, file: string) {
  const block = page.locator(`.page-flow [data-sigma-doc-id="${blockId}"]`).first();
  await block.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.mouse.move(1400, 80);
  const bounds = (await block.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: bounds.x, y: bounds.y - 4, width: Math.min(320, bounds.width), height: bounds.height + 8, scale: 4 },
  });
  writeFileSync(file, Buffer.from(data, "base64"));
  await cdp.detach();
}
