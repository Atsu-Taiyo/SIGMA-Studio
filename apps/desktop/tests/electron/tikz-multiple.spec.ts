import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SigmaDocument } from "@/features/document";

test("mixed TeX paste keeps separate figures, editable text, failed source, undo and saved reload", async ({}, testInfo) => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-tikz-multiple-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1400, 1000));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.tikz));
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".workspace-tab-group")).toHaveCount(1);
    const doc: SigmaDocument = { version: "2.0", docId: "tikz-multiple-test", metadata: { title: "複数TikZ確認" },
      content: [
        { type: "paragraph", id: "before", children: [{ type: "text", text: "挿入位置" }] },
        { type: "paragraph", id: "after", children: [{ type: "text", text: "既存の末尾" }] },
      ], outputProfiles: { student: {}, teacher: {}, answerBook: {} } };
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, doc);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("複数TikZ確認");
    const first = String.raw`\begin{tikzpicture}\draw[thick] (0,0) circle (\radius);\end{tikzpicture}`;
    const broken = String.raw`\begin{tikzpicture}\unknownSigmaCommand\end{tikzpicture}`;
    const last = String.raw`\begin{tikzpicture}\draw[-Latex] (0,0) -- (3,0);\end{tikzpicture}`;
    const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\usetikzlibrary{calc}
\newcommand{\radius}{0.6}
\begin{document}
最初の本文 $x^2$。
${first}
図の間の本文。
${broken}
${Array.from({ length: 12 }, (_, index) => `説明${index + 1}。${"本文と図の順番を保ちながら、複数ページにわたる文書を貼り付けます。".repeat(4)}`).join("\n\n")}
次の数式。
\[y=x+1\]
${last}
最後の本文。
\end{document}`;
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), source);
    await page.locator('.page-flow [data-sigma-doc-id="before"]').first().click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+v" : "Control+v");
    const batch = page.getByRole("dialog", { name: "TeXを貼り付け" });
    await expect(batch).toBeVisible();
    await expect(batch).toContainText("1個の図を変換できませんでした", { timeout: 60_000 });
    await batch.getByRole("button", { name: "閉じる", exact: true }).last().click();
    const saved = async () => (await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId))!;
    const figures = async () => (await saved()).pageLayout?.overlay?.overlaySnapshot?.shapes.filter(s => s.type === "image") ?? [];
    await expect.poll(async () => (await figures()).length).toBe(2);
    const imported = await saved();
    const failedBlockId = imported.content.find(b => b.type === "codeBlock")!.id;
    await writeFile(testInfo.outputPath("body-layout.json"), JSON.stringify(await page.locator(".page-flow [data-sigma-doc-id]").evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect();
      return { id: node.getAttribute("data-sigma-doc-id"), text: node.textContent?.slice(0, 150), top: rect.top, height: rect.height };
    })), null, 2));
    await expect(page.locator(`.page-flow [data-sigma-doc-id="${failedBlockId}"]`).first()).toContainText("unknownSigmaCommand");
    await expect(page.locator(`.page-flow [data-sigma-doc-id="${failedBlockId}"]`).first()).toBeVisible();
    expect(imported.content[0].id).toBe("before");
    expect(imported.content.at(-1)!.id).toBe("after");
    expect(imported.content[1]).toMatchObject({ type: "paragraph", children: [{ text: "最初の本文 " }, { tex: "x^2" }, { text: "。" }] });
    expect(imported.content.find(b => b.type === "codeBlock")).toMatchObject({ children: [{ text: expect.stringContaining(broken) }] });
    const shapes = await figures();
    expect(shapes.map(s => s.props.tikz?.source)).toEqual([first, last]);
    expect(shapes.every(s => s.props.tikz?.environment.preamble.includes(String.raw`\newcommand{\radius}{0.6}`))).toBe(true);
    const images = page.locator(".overlay-shape-image");
    await expect(images).toHaveCount(2);
    const boxes = await images.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
    expect(boxes[0].bottom).toBeLessThan(boxes[1].top);
    await page.screenshot({ path: testInfo.outputPath("tikz-multiple.png"), fullPage: true });

    // One canonical operation owns both text and images, including persisted assets.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect.poll(async () => (await saved()).content.length).toBe(2);
    expect(await figures()).toHaveLength(0);
    expect(Object.keys((await saved()).pageLayout?.overlay?.overlaySnapshot?.assets ?? {})).toHaveLength(0);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
    await expect.poll(async () => (await figures()).length).toBe(2);
    await page.reload();
    await expect(images).toHaveCount(2);
    await expect(page.locator(`.page-flow [data-sigma-doc-id="${failedBlockId}"]`).first()).toBeVisible();
    const target = images.first();
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByRole("textbox", { name: "コード", exact: true })).toHaveValue(first);
    const changed = first.replace("circle (\\radius)", "rectangle (1,0.6)");
    await page.getByRole("textbox", { name: "コード", exact: true }).fill(changed);
    try {
      await expect(page.getByRole("button", { name: "適用", exact: true })).toBeEnabled({ timeout: 30_000 });
    } catch (error) {
      await testInfo.attach("tikz-dialog", { body: await page.getByRole("dialog", { name: "TikZを編集" }).innerText(), contentType: "text/plain" });
      await page.screenshot({ path: testInfo.outputPath("tikz-edit-failure.png") });
      throw error;
    }
    await page.getByRole("button", { name: "適用", exact: true }).click();
    await expect.poll(async () => (await figures()).map(s => s.props.tikz?.source)).toEqual([changed, last]);
    expect((await saved()).content).toEqual(imported.content);
    await page.screenshot({ path: testInfo.outputPath("tikz-multiple-reloaded.png"), fullPage: true });
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
