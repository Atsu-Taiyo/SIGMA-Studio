import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const INTEGRAL = String.raw`\int_0^1 x\,dx`;
const EXPLICIT = String.raw`\textstyle \sum_{i=1}^n i`;

function fixture(legacy: "uniform" | "texDefault" | undefined): SigmaDocument {
  return {
    version: "2.0", docId: `style_${legacy ?? "default"}`,
    metadata: { title: `数式表示 ${legacy ?? "default"}`, mathFractionSizing: legacy, styleUnits: { fontSize: "pt" } },
    content: [
      { type: "paragraph", id: "integral", children: [{ type: "mathInline", id: "m_integral", tex: INTEGRAL, fontSize: 11, display: "inline" }] },
      { type: "paragraph", id: "explicit", children: [{ type: "mathInline", id: "m_explicit", tex: EXPLICIT, fontSize: 11, display: "inline" }] },
      { type: "paragraph", id: "body", children: [{ type: "text", text: "保存確認" }] },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

test("legacy math sizing is ignored in Electron editing and PDF preview, explicit textstyle survives saving", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!process.env.SIGMA_STUDIO_E2E_BASE_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-math-style-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const launch = () => electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const ids = await page.evaluate(async documents => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const storage = window.desktopAPI!.storage;
      const ids = [];
      for (const document of documents) ids.push((await storage.createFileFromDocument({ document })).file.fileId);
      await storage.saveWorkspace({ openFileIds: ids, activeFileId: ids[0] });
      return ids;
    }, [fixture("texDefault"), fixture("uniform"), fixture(undefined)]);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const integralMarkup: string[] = [];
    for (const id of ids) {
      await page.locator(`[data-tab-id="document:${id}"]`).getByRole("tab").click();
      const math = page.locator('.page-flow [data-id="m_integral"]').first();
      await expect(math.locator(".ML__large-op")).toBeVisible();
      await expect(page.locator('.page-flow [data-id="m_explicit"] .ML__small-op').first()).toBeVisible();
      integralMarkup.push(await math.locator(".math-preview").innerHTML());
    }
    expect(new Set(integralMarkup).size).toBe(1);
    await page.locator(`[data-tab-id="document:${ids[0]}"]`).getByRole("tab").click();
    for (const [id, operator] of [["m_integral", "ML__large-op"], ["m_explicit", "ML__small-op"]]) {
      await page.locator(`.page-flow [data-id="${id}"]`).first().click();
      const field = page.locator("math-field.inline-math-field");
      await expect(field).toBeVisible();
      await expect.poll(() => field.evaluate((element, operator) => ({
        mode: (element as HTMLElement & { defaultMode: string }).defaultMode,
        operator: Boolean(element.shadowRoot?.querySelector(`.${operator}`)),
      }), operator)).toEqual({ mode: "math", operator: true });
      await field.press("Enter");
      await expect(field).toHaveCount(0);
    }
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("menuitem", { name: "ページ設定" }).click();
    await expect(page.locator(".page-settings-dialog")).toBeVisible();
    await expect(page.getByText("分数を常に同じ大きさで表示", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "適用", exact: true }).click();
    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "エクスポート" }).hover();
    await page.getByRole("menuitem", { name: "PDFを書き出し" }).click();
    const preview = page.getByRole("dialog", { name: "PDFプレビュー" });
    await expect(preview.locator('.paged-surface-page [data-id="m_integral"] .ML__large-op').first()).toBeVisible();
    await expect(preview.locator('.paged-surface-page [data-id="m_explicit"] .ML__small-op').first()).toBeVisible();
    await testInfo.attach("legacy-document-pdf-preview", { body: await page.screenshot({ path: testInfo.outputPath("legacy-document-pdf-preview.png") }), contentType: "image/png" });
    const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), ids[0]);
    expect(saved!.metadata.mathFractionSizing).toBe("texDefault");
    expect(JSON.stringify(saved!.content)).toContain("\\\\textstyle");
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('.page-flow [data-id="m_integral"] .ML__large-op').first()).toBeVisible();
    await expect(page.locator('.page-flow [data-id="m_explicit"] .ML__small-op').first()).toBeVisible();
    expect((await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), ids[0]))!.content).toEqual(saved!.content);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
