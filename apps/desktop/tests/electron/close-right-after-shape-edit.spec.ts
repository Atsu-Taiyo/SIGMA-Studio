import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { ensurePageLayout, type SigmaDocument } from "@/features/document";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";

const APP_ROOT = path.resolve(__dirname, "../..");
const SHAPE_ID = "shape_note";

// 図形の編集 (ドラッグ・測り直した高さ) は短い遅延 (250ms) の後に文書へ入る。終了時の保存が
// それを取り込まずに走ると、保存の途中で入った変更が「保存後も未保存」になり、閉じるたびに
// 「保存できませんでした」が出ていた (ドラッグ直後の終了では4回に3回)。
test("quitting right after a shape edit saves the edit and closes without the save-failure dialog", async () => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-close-after-edit-"));
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
      version: "2.0", docId: "close_after_shape_edit",
      metadata: { title: "終了直前の図形編集", styleUnits: { fontSize: "pt" } },
      content: [{ type: "paragraph", id: "body", children: [{ type: "text", text: "本文" }] }],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    } as SigmaDocument);
    source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
      id: SHAPE_ID, type: "text", x: 100, y: 220, rotation: 0,
      props: { w: 260, h: 64, color: "#111111", size: "m", blocks: [{
        type: "paragraph", id: "shape_note_text", children: [
          { type: "text", text: "答 " },
          { type: "mathInline", id: "shape_note_math", tex: String.raw`\frac{1}{x}`, display: "inline", semanticRole: "expression" },
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
    const savedShape = () => page.evaluate(async ({ id, shapeId }) => {
      const document = await window.desktopAPI!.storage.loadDocument(id);
      const found = document?.pageLayout?.overlay?.overlaySnapshot?.shapes.find(item => item.id === shapeId);
      return found as { x: number; y: number; props: { h: number; blocks: unknown } } | undefined;
    }, { id: fileId, shapeId: SHAPE_ID });

    // 1. Drag the shape and quit at once: the move is still on the debounce when closing starts.
    await selectWholeShape(page);
    await expectSavedAsShown(page, savedShape);
    const box = (await shape(page).boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + box.height / 2 + 40, { steps: 6 });
    await page.mouse.up();
    await quitWithoutSaveFailure(app, page);
    ({ app, page } = await launch());
    await expect(page.locator(".startup-splash")).toBeHidden();
    const moved = await savedShape();
    expect(moved?.x).toBeCloseTo(160, 0);
    expect(moved?.y).toBeCloseTo(260, 0);

    // 2. Box the text and quit at once: the height it measures afterwards is also still held back.
    await selectWholeShape(page);
    await expectSavedAsShown(page, savedShape);
    const heightBefore = (await savedShape())!.props.h;
    await page.locator(".editor-menubar").getByRole("button", { name: "囲み文字を適用", exact: true }).click();
    await expect(page.locator(".overlay-shape-dimension-label").first()).not.toHaveText(new RegExp(` x ${Math.round(heightBefore)}$`));
    const shownSize = await page.locator(".overlay-shape-dimension-label").first().textContent();
    await quitWithoutSaveFailure(app, page);
    ({ app, page } = await launch());
    await expect(page.locator(".startup-splash")).toBeHidden();
    const boxed = await savedShape();
    expect(JSON.stringify(boxed?.props.blocks)).toContain("boxed");
    expect(Math.round(boxed!.props.h)).toBe(Number(shownSize?.split(" x ")[1]));
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function shape(page: Page) {
  return page.locator(`.overlay-shape-text[data-overlay-shape-id="${SHAPE_ID}"]`);
}

async function selectWholeShape(page: Page): Promise<void> {
  await grabShapeFromBody(page, shape(page));
  await expect(shape(page)).toHaveClass(/selected/);
  await expect(shape(page).locator(".ProseMirror")).toHaveCount(0);
}

/** Opening re-measures the shape and saves that; start each edit from a document that is at rest. */
async function expectSavedAsShown(
  page: Page,
  savedShape: () => Promise<{ props: { h: number } } | undefined>,
): Promise<void> {
  await expect.poll(async () => {
    const shown = await page.locator(".overlay-shape-dimension-label").first().textContent();
    const saved = await savedShape();
    const saveDot = await page.locator(".document-tab-save-dot").first().getAttribute("class");
    return Boolean(saved) && shown?.endsWith(` x ${Math.round(saved!.props.h)}`) === true && /\bsaved\b/.test(saveDot ?? "");
  }).toBe(true);
}

/** Closes the app the way the window's close button does and fails if the save-failure dialog shows. */
async function quitWithoutSaveFailure(app: ElectronApplication, page: Page): Promise<void> {
  const closing = app.close();
  const dialog = page.getByRole("dialog", { name: "保存できませんでした" });
  const outcome = await Promise.race([
    closing.then(() => "closed" as const),
    dialog.waitFor({ state: "visible", timeout: 30_000 }).then(() => "dialog" as const, () => "closed" as const),
  ]);
  if (outcome === "dialog") {
    const message = await dialog.textContent().catch(() => "");
    await dialog.getByRole("button", { name: "保存せずに閉じる" }).click().catch(() => undefined);
    await closing;
    throw new Error(`終了時に保存失敗のダイアログが出た: ${message}`);
  }
  await closing;
}
