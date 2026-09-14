import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;

test("font sizes use the real Electron bridge and survive an app restart", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const userData = mkdtempSync(path.join(tmpdir(), "sigma-font-size-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = userData;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const launch = () => electron.launch({ args: [APP_ROOT, `--user-data-dir=${userData}`], cwd: APP_ROOT, env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    await page.reload();
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const source = ensurePageLayout({
      ...sampleDocument,
      version: "2.0", docId: "electron_font_size", metadata: { title: "フォントサイズ 実機検証", styleUnits: { fontSize: "pt" } },
      content: [
        { type: "heading", id: "heading_size", level: 2, children: [{ type: "text", text: "継承見出し" }] },
        { type: "paragraph", id: "body_size", children: [{ type: "text", text: "前 注記 後" }] },
      ],
    });
    source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
      id: "shape_size", type: "text", x: 100, y: 220, rotation: 0,
      props: { w: 200, h: 32, color: "#111111", size: "m", blocks: [{
        type: "paragraph", id: "shape_text", children: [{ type: "text", text: "図中文字" }],
      }] },
    }] } };
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), source);
    await page.reload();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="body_size"]')).toBeVisible();
    const sizeButton = () => page.getByRole("button", { name: "フォントサイズ", exact: true });
    const up = () => page.getByRole("button", { name: "フォントサイズを1pt大きく", exact: true });
    await selectBody(page, "heading_size", 1, 1);
    await expect(sizeButton()).toHaveText("17.04pt");
    await selectBody(page, "body_size", 2, 4);
    await expect(sizeButton()).toHaveText("12pt");
    await up().click();
    await expect(sizeButton()).toHaveText("13pt");
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("注記");
    await sizeButton().click();
    await page.getByRole("spinbutton", { name: "サイズ (pt)" }).fill("7.5");
    await page.getByRole("spinbutton", { name: "サイズ (pt)" }).press("Enter");
    await expect.poll(() => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), created.file.fileId))
      .toMatchObject({ content: [source.content[0], { ...source.content[1], children: [
        { type: "text", text: "前 " }, { type: "text", text: "注記", fontSize: 7.5 }, { type: "text", text: " 後" },
      ] }] });

    // Double-click the actual shape to enter its text session, then use the same toolbar.
    const shape = page.locator('.overlay-shape-text[data-overlay-shape-id="shape_size"]');
    await grabShapeFromBody(page, shape);
    await shape.click();
    const shapeEditor = shape.locator(".ProseMirror");
    await expect(shapeEditor).toBeVisible();
    await shapeEditor.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await expect(sizeButton()).toHaveText("12pt");
    await up().click();
    await expect(sizeButton()).toHaveText("13pt");
    await expect(shapeEditor.locator("span[style*='font-size']")).toHaveCSS("font-size", "17.3333px");
    await page.keyboard.press("Escape");
    await expect(sizeButton()).toHaveText("13pt");
    await up().click();
    await expect(sizeButton()).toHaveText("14pt");
    const savedShape = async () => page.evaluate(async (id) => {
      const document = await window.desktopAPI!.storage.loadDocument(id);
      return document?.pageLayout?.overlay?.overlaySnapshot?.shapes.find((shape) => shape.id === "shape_size");
    }, created.file.fileId);
    await expect.poll(savedShape).toMatchObject({ props: { blocks: [{ children: [{ type: "text", text: "図中文字", fontSize: 14 }] }] } });
    await page.screenshot({ path: testInfo.outputPath("font-size-electron.png") });
    await app.close();

    app = await launch();
    page = await app.firstWindow();
    const body = page.locator('.text-flow-editor [data-sigma-doc-id="body_size"]');
    await expect(body).toBeVisible();
    await expect(body.locator("[style*='font-size']")).toHaveText("注記");
    await expect(body.locator("[style*='font-size']")).toHaveCSS("font-size", "10px");
    await selectBody(page, "heading_size", 1, 1);
    await expect(sizeButton()).toHaveText("17.04pt");
    await expect.poll(savedShape).toMatchObject({ props: { blocks: [{ children: [{ fontSize: 14 }] }] } });
    const files = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
    const file = files.find((file) => file.fileId === created.file.fileId)!;
    const documentPath = path.resolve(userData, "data", file.documentPath!);
    expect(documentPath.startsWith(`${userData}${path.sep}`)).toBe(true);
    const onDisk = JSON.parse(readFileSync(documentPath, "utf8")) as SigmaDocument;
    expect(onDisk.content[0]).toEqual(source.content[0]);
    expect(onDisk.content[1]).toMatchObject({ children: [{ text: "前 " }, { text: "注記", fontSize: 7.5 }, { text: " 後" }] });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

async function selectBody(page: Page, id: string, from: number, to: number) {
  await page.evaluate(({ id, from, to }) => {
    const block = document.querySelector(`[data-sigma-doc-id="${id}"]`)!;
    const editor = block.closest<HTMLElement>(".ProseMirror")!;
    editor.focus();
    const text = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(text, from);
    range.setEnd(text, to);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, { id, from, to });
}
