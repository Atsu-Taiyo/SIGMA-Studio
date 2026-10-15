import { _electron as electron, expect, test, type JSHandle } from "@playwright/test";
import type { ClipboardItem } from "electron";
import { createCanvas } from "@napi-rs/canvas";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDefaultPageLayout, type OverlaySnapshot, type SigmaDocument, type InlineNode } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><g stroke="#111111" stroke-width="2" fill="none"><rect x="20" y="20" width="80" height="50" fill="#dddddd"/><polygon points="150,20 190,70 110,70" fill="#cccccc"/><line x1="20" y1="100" x2="180" y2="100" stroke-dasharray="8 6"/><line x1="20" y1="130" x2="180" y2="130" stroke-dasharray="1 6"/><path d="M30 160 C60 190 120 190 160 160"/></g><text x="200" y="40">装置図</text><text x="200" y="80"><tspan font-style="italic">V</tspan>(<tspan font-style="italic">z</tspan>)</text></svg>';
const SNAPSHOT: OverlaySnapshot = {
  version: 1,
  shapes: [{ id: "svg-image", type: "image", x: 100, y: 120, anchor: { type: "page" }, props: { assetId: "svg-asset", w: 300, h: 200 } }],
  assets: { "svg-asset": { id: "svg-asset", type: "image", props: { w: 300, h: 200, name: "装置図", mimeType: "image/svg+xml",
    isAnimated: false, fileSize: SVG.length, src: `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}` } } },
};
const DOCUMENT: SigmaDocument = { version: "2.0", docId: "svg-conversion", metadata: { title: "SVG変換確認" },
  content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "SVGを右クリックして変換" }] }],
  pageLayout: { ...getDefaultPageLayout(), overlay: { overlaySnapshot: SNAPSHOT } }, outputProfiles: { student: {}, teacher: {}, answerBook: {} } };

for (const format of ["inline", "base64", "percent"] as const) {
  test(`native SVG clipboard (${format}) stays vector through conversion, undo and desktop reload`, async ({}, testInfo) => {
    test.setTimeout(180_000);
    const profile = await mkdtemp(path.join(tmpdir(), "sigma-svg-paste-"));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SIGMA_STUDIO_DEV_SERVER_URL;
    env.SIGMA_STUDIO_USER_DATA_DIR = profile;
    if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
    const executablePath = process.env.SIGMA_STUDIO_E2E_EXECUTABLE;
    const app = await electron.launch({ executablePath, args: executablePath ? [] : [APP_ROOT], cwd: APP_ROOT, env });
    let originalClipboard: JSHandle<ClipboardItem[]> | undefined;
    try {
      // X11 can report an empty item; ClipboardItem requires at least one readable MIME type.
      originalClipboard = await app.evaluateHandle(async ({ clipboard, ClipboardItem }) => Promise.all((await clipboard.read()).filter(item => item.types.length > 0).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))));
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1400, 1050));
      await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
      await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
      const fileId = await page.evaluate(async document => {
        localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
        localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
        await window.desktopAPI!.settings!.setUiLocale!("ja");
        const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
        await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
        return created.file.fileId;
      }, { ...DOCUMENT, pageLayout: getDefaultPageLayout() });
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
      await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("SVG変換確認");
      const saved = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
      const snapshot = async () => (await saved())!.pageLayout?.overlay?.overlaySnapshot;
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      const src = format === "base64" ? `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}` : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`;
      const html = format === "inline" ? `<html><body><!--StartFragment--><div>${SVG}</div><!--EndFragment--></body></html>` : `<img src="${src}">`;
      const png = format === "inline" ? undefined : createCanvas(300, 200).toDataURL("image/png");
      await app.evaluate(({ clipboard, ClipboardItem }, { html, png }) => clipboard.write([new ClipboardItem({
        "text/html": html,
        "text/plain": "装置図",
        ...(png ? { "image/png": new Blob([Buffer.from(png.split(",")[1], "base64")], { type: "image/png" }) } : {}),
      })]), { html, png });
      await page.locator('.page-flow [data-sigma-doc-id="p"]').first().click();
      await page.keyboard.press(`${modifier}+v`);
      await expect.poll(async () => (await snapshot())?.shapes.map(shape => shape.type)).toEqual(["image"]);
      const pasted = (await snapshot())!;
      expect(Object.values(pasted.assets)).toHaveLength(1);
      expect(Object.values(pasted.assets)[0].props).toMatchObject({ mimeType: "image/svg+xml", w: 300, h: 200 });
      expect((await saved())!.content).toEqual(DOCUMENT.content);
      const normalize = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value, (_key, child) => typeof child === "number" ? Math.round(child * 100) / 100 : child));
      await page.keyboard.press(`${modifier}+z`);
      await expect.poll(async () => (await snapshot())?.shapes ?? []).toEqual([]);
      await expect.poll(async () => Object.keys((await snapshot())?.assets ?? {})).toEqual([]);
      await page.keyboard.press(`${modifier}+Shift+z`);
      await expect.poll(async () => normalize(await snapshot())).toEqual(normalize(pasted));
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
      await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("SVG変換確認");
      expect(normalize(await snapshot())).toEqual(normalize(pasted));
      const image = page.locator(".overlay-shape-image").first();
      await image.scrollIntoViewIfNeeded();
      const box = (await image.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
      await page.getByRole("menuitem", { name: "図形に変換", exact: true }).click();
      await expect(page.getByTestId("svg-conversion-message")).toContainText("個の図形に変換しました");
      await expect.poll(async () => (await snapshot())?.shapes.filter(shape => shape.type === "geo" || shape.type === "line").length).toBe(4);
      const converted = (await snapshot())!;
      const text = converted.shapes.filter(shape => shape.type === "text");
      expect(text).toHaveLength(2);
      expect(text.flatMap(shape => shape.props.blocks.flatMap(block => block.type === "paragraph" ? block.children : [])).filter(node => node.type === "mathInline")).toMatchObject([{ tex: "V(z)" }]);
      expect(converted.shapes.filter(shape => shape.type === "image")).toHaveLength(1);
      await page.keyboard.press(`${modifier}+z`);
      await expect.poll(async () => normalize(await snapshot())).toEqual(normalize(pasted));
      await page.keyboard.press(`${modifier}+Shift+z`);
      await expect.poll(async () => normalize(await snapshot())).toEqual(normalize(converted));
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
      await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("SVG変換確認");
      expect(normalize(await snapshot())).toEqual(normalize(converted));
      await page.keyboard.press("Escape");
      await page.mouse.move(50, 150);
      await page.screenshot({ path: testInfo.outputPath(`svg-clipboard-${format}.png`) });
      expect(errors).toEqual([]);
    } finally {
      try {
        if (originalClipboard) await app.evaluate(async ({ clipboard }, original) => {
          clipboard.clear();
          if (original.length > 0) await clipboard.write(original);
        }, originalClipboard);
      } finally {
        await originalClipboard?.dispose();
        await app.close();
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  });
}

for (const reference of [false, true]) {
  test(reference ? "reference SVG converts on an isolated desktop copy" : "SVG context conversion, individual editing, undo and reload use the desktop bridge", async ({}, testInfo) => {
    test.skip(reference && !process.env.SIGMA_STUDIO_SVG_REFERENCE_DOCUMENT, "Optional local reference document");
    test.setTimeout(180_000);
    const profile = await mkdtemp(path.join(tmpdir(), "sigma-svg-conversion-"));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SIGMA_STUDIO_DEV_SERVER_URL;
    env.SIGMA_STUDIO_USER_DATA_DIR = profile;
    if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
    const executablePath = process.env.SIGMA_STUDIO_E2E_EXECUTABLE;
    const app = await electron.launch({ executablePath, args: executablePath ? [] : [APP_ROOT], cwd: APP_ROOT, env });
    const dictionary = path.join(APP_ROOT, "src/components/editor/overlay-canvas/context-menu.tsx");
    let dictionaryBefore: string | undefined;
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await (await app.browserWindow(page)).evaluate((win) => win.setContentSize(1400, 1050));
      await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
      await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
      const doc = reference ? JSON.parse(await readFile(process.env.SIGMA_STUDIO_SVG_REFERENCE_DOCUMENT!, "utf8")) as SigmaDocument : DOCUMENT;
      const fileId = await page.evaluate(async (document) => {
        localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
        localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
        await window.desktopAPI!.settings!.setUiLocale!("ja");
        const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
        await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
        return created.file.fileId;
      }, { ...doc, docId: `isolated-svg-${reference}`, metadata: { ...doc.metadata, title: "SVG変換確認" } });
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
      await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("SVG変換確認");
      if (process.env.SIGMA_STUDIO_E2E_BASE_URL) expect(new URL(page.url()).origin).toBe(new URL(process.env.SIGMA_STUDIO_E2E_BASE_URL).origin);
      const saved = () => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
      const snapshot = async () => (await saved())!.pageLayout!.overlay!.overlaySnapshot!;
      const before = await snapshot();
      const target = before.shapes.find((shape) => shape.type === "image")!;
      const rightClickImage = async () => {
        const image = page.locator(".overlay-shape-image").first();
        await image.scrollIntoViewIfNeeded();
        const box = await image.boundingBox();
        if (!box) throw new Error("SVG image is missing");
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
      };
      await rightClickImage();
      const convert = page.getByRole("menuitem", { name: "図形に変換", exact: true });
      await expect(convert).toBeVisible();
      if (!reference && process.env.SIGMA_STUDIO_E2E_VERIFY_HMR) {
        dictionaryBefore = await readFile(dictionary, "utf8");
        await writeFile(dictionary, dictionaryBefore.replace('{tShape("menu.svgConvert")}', '{tShape("menu.svgConvert") + "（HMR確認）"}'));
        await expect(page.getByRole("menuitem", { name: "図形に変換（HMR確認）", exact: true })).toBeVisible({ timeout: 60_000 });
        await writeFile(dictionary, dictionaryBefore);
        dictionaryBefore = undefined;
        await expect(convert).toBeVisible({ timeout: 60_000 });
      }
      await page.screenshot({ path: testInfo.outputPath("svg-before.png") });
      await convert.click();
      await expect(page.getByTestId("svg-conversion-message")).toContainText("個の図形に変換しました");
      await expect.poll(async () => (await snapshot()).shapes.find((shape) => shape.id === target.id)?.type).toBe("group");
      const converted = await snapshot();
      const nativeText = converted.shapes.filter((shape) => shape.type === "text");
      const nodes = (shape: OverlaySnapshot["shapes"][number] | undefined): InlineNode[] => shape?.type === "text" ? shape.props.blocks.flatMap(block => block.type === "paragraph" ? block.children : []) : [];
      const mathNodes = nativeText.flatMap(nodes).filter((node) => node.type === "mathInline");
      expect(nativeText).toHaveLength(reference ? 36 : 2);
      expect(mathNodes).toHaveLength(reference ? 13 : 1);
      expect(converted.shapes.filter(shape => shape.type === "image")).toHaveLength(reference ? 11 : 1);
      expect(mathNodes.map(node => node.tex)).toContain("V(z)");
      await expect(page.locator("body > .overlay-text-shape")).toHaveCount(0);
      if (reference) {
        const tension = nativeText.find(shape => nodes(shape).some(node => node.type === "text" && node.text.includes("張力")));
        expect(nodes(tension)).toMatchObject([{type:"text",text:"(張力 "},{type:"mathInline",tex:"T"},{type:"text",text:")"}]);
        const voltmeter = nativeText.find(shape => nodes(shape).some(node => node.type === "text" && node.text === "V"));
        expect(nodes(voltmeter)).toMatchObject([{type:"text",text:"V"}]);
      }
      const native = converted.shapes.filter((shape) => shape.type === "geo" || shape.type === "line");
      expect(native).toHaveLength(reference ? 73 : 4);
      expect(converted.shapes.some((shape) => shape.type === "image")).toBe(true);
      expect(converted.assets).not.toHaveProperty(target.type === "image" ? target.props.assetId : "");
      await page.screenshot({ path: testInfo.outputPath("svg-converted.png") });
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+z`);
      const roundCoordinates = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, child) => typeof child === "number" ? Math.round(child * 100) / 100 : child));
      await expect.poll(async () => roundCoordinates(await snapshot())).toEqual(roundCoordinates(before));
      await page.keyboard.press(`${modifier}+Shift+z`);
      await expect.poll(async () => roundCoordinates(await snapshot())).toEqual(roundCoordinates(converted));
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
      await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("SVG変換確認");
      expect(roundCoordinates(await snapshot())).toEqual(roundCoordinates(converted));
      if (!reference) {
        await rightClickImage();
        await page.getByRole("menuitem", { name: "グループ解除", exact: true }).click();
        await expect.poll(async () => (await snapshot()).shapes.some((shape) => shape.type === "group")).toBe(false);
        const rectangle = (await snapshot()).shapes.find((shape) => shape.type === "geo")!;
        await page.locator(`.overlay-shape[data-overlay-shape-id="${rectangle.id}"]`).click();
        await page.keyboard.press("ArrowRight");
        await expect.poll(async () => (await snapshot()).shapes.find((shape) => shape.id === rectangle.id)?.x).toBeGreaterThan(rectangle.x);
        const enterText = async (id: string) => {
          const target = page.locator(`.overlay-canvas-editor .overlay-shape-text[data-overlay-shape-id="${id}"]`);
          await target.click();
          await expect(target).toHaveClass(/selected/);
          await page.waitForTimeout(650);
          const box = (await target.boundingBox())!;
          await page.mouse.dblclick(box.x + box.width * 0.3, box.y + box.height * 0.4);
          const editor = page.locator(".ProseMirror.overlay-text-shape-content");
          await expect(editor).toBeVisible();
          return editor;
        };
        const text = nativeText.find(shape => nodes(shape).some(node => node.type === "text" && node.text === "装置図"))!;
        const editor = await enterText(text.id);
        await editor.click();
        await page.keyboard.press(`${modifier}+ArrowRight`);
        await page.keyboard.insertText("更新");
        await page.keyboard.press("Escape");
        await expect.poll(async () => nodes((await snapshot()).shapes.find(shape => shape.id === text.id)).filter(node => node.type === "text").map(node => node.text).join("")).toBe("装置図更新");
        const formula = nativeText.find(shape => nodes(shape).some(node => node.type === "mathInline"))!;
        const mathEditor = await enterText(formula.id);
        await mathEditor.locator(".inline-math-node").click();
        const field = mathEditor.locator("math-field");
        await expect(field).toBeFocused();
        await page.keyboard.press("End");
        await page.keyboard.type("+1");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Escape");
        await expect.poll(async () => nodes((await snapshot()).shapes.find(shape => shape.id === formula.id)).find(node => node.type === "mathInline")?.tex).toMatch(/V.*z.*\+1/);
        const edited = await snapshot();
        await page.reload();
        await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
        await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("SVG変換確認");
        expect(roundCoordinates(await snapshot())).toEqual(roundCoordinates(edited));
      }
      await page.screenshot({ path: testInfo.outputPath("svg-reloaded.png") });
      expect(errors).toEqual([]);
      console.log(`SVG conversion verified: ${native.length} geometry, ${nativeText.length} text shapes / ${mathNodes.length} math nodes, ${Object.keys(converted.assets).length} preserved SVG fragments`);
    } finally {
      if (dictionaryBefore) await writeFile(dictionary, dictionaryBefore);
      await app.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
