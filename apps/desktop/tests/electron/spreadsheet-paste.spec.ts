import { _electron as electron, expect, test } from "@playwright/test";
import { createCanvas } from "@napi-rs/canvas";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SigmaDocument } from "@/features/document";

const HTML = '<html><head><style>.xl65{font-weight:700;color:#ffffff;background-color:#245ba3;font-size:12pt}</style></head><body><table><colgroup><col width="140"><col width="100"></colgroup><tr height="32"><td colspan="2" class="xl65" style="text-align:center">売上</td></tr><tr><td>4月</td><td style="text-align:right">¥1,234</td></tr><tr><td>5月<br>見込み</td><td style="background-color:#fff2cc">25%</td></tr></table></body></html>';

test("native spreadsheet/chart clipboard survives undo, redo and desktop reload", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-spreadsheet-paste-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  const originalClipboard = await app.evaluateHandle(async ({ clipboard, ClipboardItem }) => Promise.all((await clipboard.read()).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))));
  const importer = path.join(root, "src/lib/spreadsheet-clipboard.ts");
  let sourceBefore: string | undefined;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1400, 1000));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const document: SigmaDocument = { version: "2.0", docId: "spreadsheet-paste", metadata: { title: "表とグラフの貼り付け" }, content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "表とグラフ" }] }], outputProfiles: { student: {}, teacher: {}, answerBook: {} } };
    const id = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const saved = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), id);
    const shapes = async () => (await saved())?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const canvas = createCanvas(320, 180);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = "#245ba3"; ctx.fillRect(30, 80, 60, 80); ctx.fillRect(130, 35, 60, 125); ctx.fillRect(230, 60, 60, 100);
    const png = canvas.toDataURL("image/png");
    await page.locator('.page-flow [data-sigma-doc-id="p"]').first().click();
    if (process.env.SIGMA_STUDIO_E2E_VERIFY_HMR) {
      sourceBefore = await readFile(importer, "utf8");
      await writeFile(importer, sourceBefore.replace('borderColor: "#b7b7b7"', 'borderColor: "#a1b2c3"'));
      await page.waitForTimeout(2000);
    }
    await app.evaluate(({ clipboard, ClipboardItem }, { html, png }) => clipboard.write([new ClipboardItem({ "text/html": html, "text/plain": "売上\n4月\t¥1,234\n5月\t25%", "image/png": new Blob([Buffer.from(png.split(",")[1], "base64")], { type: "image/png" }) })]), { html: HTML, png });
    await page.keyboard.press(`${modifier}+v`);
    await expect.poll(async () => (await shapes()).map(shape => shape.type)).toEqual(["tableShape"]);
    const table = (await shapes())[0];
    if (table.type !== "tableShape") throw new Error("No table");
    expect(table.props.table.cells[0]).toMatchObject({ colSpan: 2, style: { backgroundColor: "rgb(36, 91, 163)" }, content: [{ children: [{ text: "売上", marks: ["bold"] }] }] });
    if (sourceBefore) {
      expect(table.props.table.grid.borderColor).toBe("#a1b2c3");
    }
    await page.keyboard.press(`${modifier}+z`);
    await expect.poll(shapes).toEqual([]);
    await page.keyboard.press(`${modifier}+Shift+z`);
    await expect.poll(async () => (await shapes()).map(shape => shape.type)).toEqual(["tableShape"]);
    await page.keyboard.press("Escape");
    await page.locator(".overlay-canvas-editor").click({ position: { x: 360, y: 300 } });
    await app.evaluate(({ clipboard, ClipboardItem }, png) => clipboard.write([new ClipboardItem({ "image/png": new Blob([Buffer.from(png.split(",")[1], "base64")], { type: "image/png" }) })]), png);
    await page.keyboard.press(`${modifier}+v`);
    await expect.poll(async () => (await shapes()).map(shape => shape.type).sort()).toEqual(["image", "tableShape"]);
    const beforeReload = (await saved())!;
    const asset = Object.values(beforeReload.pageLayout!.overlay!.overlaySnapshot!.assets)[0];
    expect(asset.props).toMatchObject({ w: 320, h: 180, mimeType: "image/png" });
    await page.screenshot({ path: testInfo.outputPath("spreadsheet-chart-pasted.png") });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    expect((await saved())?.pageLayout?.overlay?.overlaySnapshot).toEqual(beforeReload.pageLayout!.overlay!.overlaySnapshot);
    await expect(page.locator(".page-canvas").getByText("¥1,234", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".overlay-shape-image").first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("spreadsheet-chart-reloaded.png") });
    expect(errors).toEqual([]);
  } finally {
    if (sourceBefore) await writeFile(importer, sourceBefore);
    await app.evaluate(({ clipboard }, original) => clipboard.write(original), originalClipboard);
    await originalClipboard.dispose();
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
