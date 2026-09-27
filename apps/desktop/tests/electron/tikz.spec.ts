import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SigmaDocument } from "@/features/document";

test("TikZ paste, click editing, environment settings and saved reload use the real desktop bridge", async ({}, testInfo) => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-tikz-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate((win) => win.setContentSize(1400, 1000));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.tikz));
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".workspace-tab-group")).toHaveCount(1);
    const doc: SigmaDocument = { version: "2.0", docId: "tikz-test", metadata: { title: "TikZ確認" },
      content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "図を貼り付ける" }] }],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} } };
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, doc);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("TikZ確認");

    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("menuitem", { name: "TeX・TikZ環境設定" }).click();
    await page.getByRole("tab", { name: "TikZ", exact: true }).click();
    // arrows.meta is supplied by the engine even when the user only adds calc.
    await page.getByLabel("TikZライブラリ", { exact: true }).fill("calc");
    await page.getByLabel("パッケージ", { exact: true }).fill(String.raw`\usepackage{amssymb}`);
    await page.screenshot({ path: testInfo.outputPath("tikz-settings.png") });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId))?.metadata.tikzEnvironment?.libraries).toBe("calc");

    const source = String.raw`\begin{tikzpicture}
\draw[-Latex] (-1,0) -- (3,0) node[right] {$x$};
\draw[-Latex] (0,-1) -- (0,2) node[above] {$y$};
\draw[thick] (0,0) circle (1);
\end{tikzpicture}`;
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), source);
    await page.locator('.page-flow [contenteditable="true"]').first().click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+v" : "Control+v");
    const image = page.locator(".overlay-shape-image").first();
    await expect(image).toBeVisible({ timeout: 30_000 });
    const saved = async () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
    const imageSource = async () => (await saved())?.pageLayout?.overlay?.overlaySnapshot?.shapes.find(s => s.type === "image")?.props;
    await expect.poll(imageSource).toMatchObject({ tikz: { source, environment: { libraries: "calc" } } });
    const tapImage = async () => {
      const box = (await image.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    await tapImage();
    const dialog = page.getByRole("dialog", { name: "TikZを編集" });
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveAttribute("aria-modal", "true");
    await expect(dialog.locator("img")).toHaveCount(0);
    await expect(dialog.getByRole("tab")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "プレビュー", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "コード", exact: true })).toHaveValue(source);
    const paintedImage = image.locator("img.overlay-image-shape");
    const originalSrc = await paintedImage.getAttribute("src");
    const changed = source.replace("circle (1)", "rectangle (2,1)");
    await page.getByRole("textbox", { name: "コード", exact: true }).fill(changed);
    await expect(page.getByRole("button", { name: "適用", exact: true })).toBeEnabled();
    await expect(paintedImage).not.toHaveAttribute("src", originalSrc!);
    // The image on the page previews the draft, while saves still contain the original.
    expect(await imageSource()).toMatchObject({ tikz: { source } });
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("tikz-editor.png") });

    // Environment controls are disclosed only by the icon; switching preserves the code.
    const environment = dialog.getByRole("button", { name: "TikZ環境", exact: true });
    await expect(environment).toHaveAttribute("aria-expanded", "false");
    await expect(dialog.getByLabel("パッケージ", { exact: true })).toHaveCount(0);
    await environment.click();
    await expect(environment).toHaveAttribute("aria-expanded", "true");
    await dialog.getByLabel("コマンド・環境の定義", { exact: true }).fill(String.raw`\tikzset{every path/.style={blue}}`);
    await expect(page.getByRole("button", { name: "適用", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("tikz-image-environment.png") });
    await environment.click();
    await expect(dialog.getByRole("textbox", { name: "コード", exact: true })).toHaveValue(changed);
    const committedPreview = await paintedImage.getAttribute("src");
    await page.getByRole("button", { name: "適用", exact: true }).click();
    await expect.poll(imageSource).toMatchObject({ tikz: { source: changed } });
    await expect(paintedImage).toHaveAttribute("src", committedPreview!);
    expect(Object.keys((await saved())!.pageLayout!.overlay!.overlaySnapshot!.assets)).toHaveLength(1);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect.poll(imageSource).toMatchObject({ tikz: { source } });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
    await expect.poll(imageSource).toMatchObject({ tikz: { source: changed } });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(image).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("tikz-reloaded.png") });
    await tapImage();
    await page.screenshot({ path: testInfo.outputPath("tikz-after-tap.png") });
    await expect(page.getByRole("textbox", { name: "コード", exact: true })).toHaveValue(changed);
    const unchanged = await imageSource();
    await page.getByRole("button", { name: "適用", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await imageSource()).toEqual(unchanged);
    await tapImage();
    await expect(page.getByRole("textbox", { name: "コード", exact: true })).toHaveValue(changed);

    const savedSource = await paintedImage.getAttribute("src");
    const savedProps = await imageSource();
    await dialog.getByRole("textbox", { name: "コード", exact: true }).fill(changed.replace("rectangle (2,1)", "circle (2)"));
    await expect(dialog.getByRole("button", { name: "適用", exact: true })).toBeEnabled();
    await expect(paintedImage).not.toHaveAttribute("src", savedSource!);
    expect(await imageSource()).toEqual(savedProps);
    await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(paintedImage).toHaveAttribute("src", savedSource!);
    expect(await imageSource()).toEqual(savedProps);
    await tapImage();

    await page.getByRole("textbox", { name: "コード", exact: true }).fill(String.raw`\begin{tikzpicture}\invalidcommand;\end{tikzpicture}`);
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "適用", exact: true })).toBeDisabled();
    await expect(paintedImage).toHaveAttribute("src", savedSource!);
    expect(await imageSource()).toMatchObject({ tikz: { source: changed } });
    await page.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
