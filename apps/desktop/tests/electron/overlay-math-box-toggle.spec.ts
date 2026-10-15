import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { ensurePageLayout, type InlineNode, type SigmaDocument } from "@/features/document";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";

const APP_ROOT = path.resolve(__dirname, "../..");
const SHAPE_ID = "shape_formula";
const FORMULA = String.raw`\frac{1}{x}`;

// Issue #210: 図形を丸ごと選んで図中数式に付けた囲み文字が、もう一度押しても外れなかった。
// 図形の選択ではキャレットが書式の状態を知らせないので、ボタンが「付いていない」と見続け、
// 押すたびに「付ける」側だけが走っていた。太字・斜体はそのつど反転するので外せていた。
test("a box put on a figure formula comes off again, undoes, and survives a restart either way", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-overlay-math-box-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const launch = async () => {
    const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1300, 900));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    return { app, page };
  };
  let { app, page } = await launch();
  try {
    const source = ensurePageLayout({
      version: "2.0", docId: "overlay_math_box",
      metadata: { title: "図中数式の囲み", styleUnits: { fontSize: "pt" } },
      content: [{ type: "paragraph", id: "body", children: [{ type: "text", text: "本文" }] }],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    } as SigmaDocument);
    source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
      id: SHAPE_ID, type: "text", x: 100, y: 220, rotation: 0,
      props: { w: 260, h: 64, color: "#111111", size: "m", blocks: [{
        type: "paragraph", id: "shape_formula_text", children: [
          { type: "text", text: "答 ", marks: ["bold"] },
          { type: "mathInline", id: "shape_formula_math", tex: FORMULA, display: "inline", semanticRole: "expression" },
        ],
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

    const savedRuns = () => page.evaluate(async id => {
      const document = await window.desktopAPI!.storage.loadDocument(id);
      const shape = document?.pageLayout?.overlay?.overlaySnapshot?.shapes.find(item => item.id === "shape_formula");
      const block = shape?.type === "text" ? shape.props.blocks[0] : undefined;
      return block?.type === "paragraph" ? block.children : null;
    }, fileId);
    const boxed: InlineNode[] = [
      { type: "text", text: "答 ", marks: ["bold", "boxed"], boxedPaddingY: 0 },
      { type: "mathInline", id: "shape_formula_math", tex: FORMULA, display: "inline", semanticRole: "expression", marks: ["boxed"], boxedPaddingY: 0 },
    ];
    const unboxed: InlineNode[] = [
      { type: "text", text: "答 ", marks: ["bold"] },
      { type: "mathInline", id: "shape_formula_math", tex: FORMULA, display: "inline", semanticRole: "expression" },
    ];

    await selectWholeShape(page);
    await expect(boxButton(page, "apply")).toHaveAttribute("aria-pressed", "false");
    await boxButton(page, "apply").click();
    await expect.poll(savedRuns).toEqual(boxed);
    await expect(shape(page).locator(".boxed-text.boxed-inline-math")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("01-boxed.png") });

    // The button now shows the box it is about to take off, and pressing it does.
    await expect(boxButton(page, "remove")).toHaveAttribute("aria-pressed", "true");
    await boxButton(page, "remove").click();
    await expect.poll(savedRuns).toEqual(unboxed);
    await expect(shape(page).locator(".boxed-text")).toHaveCount(0);
    await expect(shape(page).locator("[data-sigma-doc-math-inline]")).toBeVisible();
    await expect(boxButton(page, "apply")).toHaveAttribute("aria-pressed", "false");
    await page.screenshot({ path: testInfo.outputPath("02-unboxed.png") });

    await page.locator(".editor-menubar").getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect.poll(savedRuns).toEqual(boxed);
    await expect(boxButton(page, "remove")).toBeVisible();
    await page.locator(".editor-menubar").getByRole("button", { name: "やり直す", exact: true }).click();
    await expect.poll(savedRuns).toEqual(unboxed);
    await expect(boxButton(page, "apply")).toBeVisible();

    // Leave it boxed and restart: the reopened shape shows its box and can drop it.
    await boxButton(page, "apply").click();
    await expect.poll(savedRuns).toEqual(boxed);
    await expectSavedAsShown(page, fileId);
    ({ app, page } = await relaunch(app, launch));
    await expect(shape(page).locator(".boxed-text.boxed-inline-math")).toBeVisible();
    await selectWholeShape(page);
    await expect(boxButton(page, "remove")).toHaveAttribute("aria-pressed", "true");
    await boxButton(page, "remove").click();
    await expect.poll(savedRuns).toEqual(unboxed);
    await expectSavedAsShown(page, fileId);

    ({ app, page } = await relaunch(app, launch));
    await expect(shape(page).locator("[data-sigma-doc-math-inline]")).toBeVisible();
    await expect(shape(page).locator(".boxed-text")).toHaveCount(0);
    await selectWholeShape(page);
    await expect(boxButton(page, "apply")).toHaveAttribute("aria-pressed", "false");
    await page.screenshot({ path: testInfo.outputPath("03-after-restart.png") });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function shape(page: Page) {
  return page.locator(`.overlay-shape-text[data-overlay-shape-id="${SHAPE_ID}"]`);
}

function boxButton(page: Page, state: "apply" | "remove") {
  return page.locator(".editor-menubar").getByRole("button", { name: state === "apply" ? "囲み文字を適用" : "囲み文字を解除", exact: true });
}

/**
 * Waits until the shape on disk has the size shown on screen. A text shape measures its height
 * again after its content changes and saves that as a change of its own, about half a second after
 * the content; closing the app before it lands meets the close-time save dialog, not a restart.
 */
async function expectSavedAsShown(page: Page, fileId: string): Promise<void> {
  await expect.poll(async () => {
    const shown = await page.locator(".overlay-shape-dimension-label").first().textContent();
    const saved = await page.evaluate(async id => {
      const document = await window.desktopAPI!.storage.loadDocument(id);
      const found = document?.pageLayout?.overlay?.overlaySnapshot?.shapes.find(item => item.id === "shape_formula");
      const size = found?.props as { w: number; h: number } | undefined;
      return size ? `${Math.max(1, Math.round(size.w))} x ${Math.max(1, Math.round(size.h))}` : null;
    }, fileId);
    const saveDot = await page.locator(".document-tab-save-dot").first().getAttribute("class");
    return saved === shown && /\bsaved\b/.test(saveDot ?? "");
  }).toBe(true);
}

/** Selects the shape as a whole — not its text session, where the caret reports its own marks. */
async function selectWholeShape(page: Page): Promise<void> {
  await grabShapeFromBody(page, shape(page));
  await expect(shape(page)).toHaveClass(/selected/);
  await expect(shape(page).locator(".ProseMirror")).toHaveCount(0);
}

async function relaunch(
  app: ElectronApplication,
  launch: () => Promise<{ app: ElectronApplication; page: Page }>,
): Promise<{ app: ElectronApplication; page: Page }> {
  await app.close();
  const next = await launch();
  await expect(next.page.locator(".startup-splash")).toBeHidden();
  return next;
}
