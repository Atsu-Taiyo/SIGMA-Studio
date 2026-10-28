import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { DEFAULT_SERIF_BODY_FONT_FAMILY, type ProblemNode, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const source: SigmaDocument = {
  version: "2.0", docId: "problem_layout_controls",
  metadata: { title: "問題の寸法", styleUnits: { fontSize: "pt" } },
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  content: [{
    type: "problem", id: "q", tags: [],
    lead: [{ type: "paragraph", id: "title", children: [{ type: "text", text: "次の問いに答えよ。" }] }],
    prompt: [{ type: "paragraph", id: "body", children: [{ type: "text", text: "式を計算せよ。" }, { type: "mathInline", id: "formula", tex: "x^2+1", display: "inline" }] }],
    solution: [], hints: [], frame: { enabled: true },
  }],
};

for (const scaleFactor of [1, 2]) {
test(`number geometry and area insets are editable, saved and retained after restart at DPR ${scaleFactor}`, async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-problem-layout-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const launch = () => electron.launch({ args: [APP_ROOT, `--force-device-scale-factor=${scaleFactor}`], cwd: APP_ROOT, env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(w => w.setContentSize(1300, 1000));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await expect(page.locator(".startup-splash")).toBeHidden();
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, source);
    await page.reload();
    const area = (name: string) => page.locator(`section[data-problem-id="q"][data-problem-area="${name}"]`);
    await expect(area("prompt")).toBeVisible();
    await area("prompt").locator(".problem-action-button").dispatchEvent("click");
    await page.getByRole("menuitem", { name: "問題の設定…" }).click();
    await page.getByRole("button", { name: "番号の形と位置" }).click();
    await page.getByTestId("problem-number-font-size").fill("10");
    await page.getByTestId("problem-number-widthPx").fill("24");
    await page.getByTestId("problem-number-heightPx").fill("22");
    await page.getByTestId("problem-number-gapPx").fill("3");
    await page.getByTestId("problem-number-borderWidthPx").fill("0.5");
    await page.getByTestId("problem-number-borderRadiusPx").fill("0");
    await page.getByTestId("problem-number-outlineWidthPx").fill("0.5");
    await page.getByTestId("problem-number-outlineOffsetPx").fill("1.5");
    await page.getByTestId("problem-number-textOffsetXPx").fill("1.25");
    await page.getByTestId("problem-number-format").click();
    await page.getByRole("option", { name: "１, ２, ３" }).click();
    await page.getByRole("button", { name: "エリアの寸法と余白" }).click();
    await page.getByTestId("problem-area-padding-enabled").check();
    for (const [side, value] of [["top", "2"], ["right", "5"], ["bottom", "4"], ["left", "3"]]) await page.getByTestId(`problem-area-padding-${side}`).fill(value);
    await page.getByTestId("problem-area-margin-top").fill("0");
    await page.getByTestId("problem-area-margin-bottom").fill("0");
    await page.getByTestId("problem-area-min-height").fill("15");
    await page.getByTestId("problem-area-width").fill("70");
    await page.getByTestId("problem-frame-borderWidthPx").fill("0.5");
    // Escape dismisses without a blur: the last visible edit must already be canonical.
    await page.getByTestId("problem-number-font-family").click();
    await page.getByRole("option", { name: "Noto Serif JP" }).click();
    await page.screenshot({ path: testInfo.outputPath("problem-layout-settings.png") });
    await page.keyboard.press("Escape");
    async function checkGeometry(p: Page) {
      expect(await p.evaluate(() => window.devicePixelRatio)).toBe(scaleFactor);
      const marker = p.locator('[data-problem-id="q"] .problem-number-marker');
      await expect(marker).toHaveText("１");
      await expect(marker).toHaveCSS("width", "24px");
      await expect(marker).toHaveCSS("height", "22px");
      await expect(marker).toHaveCSS("font-family", DEFAULT_SERIF_BODY_FONT_FAMILY);
      await expect(marker).toHaveCSS("border-radius", "0px");
      // Chromium snaps nonzero rules to at least one device pixel. Keep the authored
      // half CSS pixel exact, then check its used width at both display densities.
      const ruleWidth = `${Math.max(1, 0.5 * scaleFactor) / scaleFactor}px`;
      await expect(marker).toHaveCSS("--problem-number-outline-width", "0.5px");
      await expect(marker).toHaveCSS("--problem-number-border-width", "0.5px");
      await expect(marker).toHaveCSS("outline-width", ruleWidth);
      await expect(marker).toHaveCSS("border-left-width", ruleWidth);
      await expect(marker).toHaveCSS("padding-left", "2.5px");
      const prompt = p.locator('section[data-problem-id="q"][data-problem-area="prompt"]');
      await expect(prompt).toHaveCSS("padding-top", "2px");
      await expect(prompt).toHaveCSS("padding-left", "3px");
      await expect(prompt).toHaveCSS("margin-bottom", "0px");
      await expect(prompt).toHaveCSS("--problem-frame-border-width", "0.5px");
      await expect(prompt).toHaveCSS("border-left-width", ruleWidth);
      const width = await prompt.evaluate(e => e.getBoundingClientRect().width);
      expect(Math.abs(width - 70 * 96 / 25.4)).toBeLessThan(0.1);
    }
    const load = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
    await expect.poll(async () => ((await load())?.content[0] as ProblemNode).areaLayout?.prompt?.widthMm).toBe(70);
    const saved = (await load())!.content[0] as ProblemNode;
    expect(saved.numbering).toMatchObject({ fontSize: 10, widthPx: 24, heightPx: 22, gapPx: 3, format: "fullwidth", borderWidthPx: 0.5, outlineWidthPx: 0.5, fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY });
    expect(saved.areaLayout?.prompt?.paddingPx).toEqual({ top: 2, right: 5, bottom: 4, left: 3 });
    expect(saved.frame).toMatchObject({ borderWidthPx: 0.5 });
    expect(saved.prompt).toEqual((source.content[0] as ProblemNode).prompt);
    await checkGeometry(page);
    await page.screenshot({ path: testInfo.outputPath("problem-layout.png") });
    await app.close();
    app = await launch();page = await app.firstWindow();
    await expect(page.locator('[data-problem-id="q"] .problem-number-marker')).toBeVisible();
    await checkGeometry(page);
    expect((await load())!.content[0]).toEqual(saved);
    const textWidth = await page.evaluate(() => { const c = document.createElement("canvas").getContext("2d")!; c.font = "16px monospace"; return c.measureText("MMMM").width; });
    await page.evaluate(async ({ source, width }) => {
      const document: SigmaDocument = { ...source, docId: "zero_width_rule", metadata: { ...source.metadata, title: "ゼロ幅の数式" }, content: [{
        type: "problem", id: "tight", tags: [], lead: [], hints: [], solution: [], numbering: { enabled: false },
        areaLayout: { lead: { hidden: true }, prompt: { widthMm: width * 25.4 / 96, paddingPx: { top: 0, right: 0, bottom: 0, left: 0 } } },
        prompt: [{ type: "paragraph", id: "tight_line", lineHeight: "1", children: [{ type: "text", text: "MMMM", fontFamily: "monospace", fontSize: 12 }, { type: "mathInline", id: "height_only", tex: "\\rule[-0.2em]{0em}{1em}", display: "inline", fontSize: 12 }] }],
      }] };
      const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
    }, { source, width: textWidth + 2 });
    await page.reload();
    const rule = page.locator('.inline-math-node[data-id="height_only"]');
    await expect(rule).toHaveAttribute("data-zero-width-math-rule", "");
    await expect(rule).toHaveCSS("margin-left", "0px");
    const wraps = await rule.evaluate(e => { const text = e.closest("p")!.querySelector('span[style*="monospace"]')!; const r = document.createRange(); r.selectNodeContents(text); return e.getBoundingClientRect().bottom > r.getBoundingClientRect().bottom + 5; });
    expect(wraps).toBe(false);
    await page.evaluate(async source => {
      const nested: ProblemNode = { type: "problem", id: "nested_q", tags: [], lead: [], hints: [], solution: [], numbering: { enabled: false },
        areaLayout: { prompt: { widthMm: 70, offsetXPx: 9, paddingPx: { top: 20, right: 12, bottom: 20, left: 12 } } },
        prompt: [{ type: "paragraph", id: "nested_line", children: [{ type: "text", text: "入れ子の寸法" }] }],
      };
      const document: SigmaDocument = { ...source, docId: "nested_width_offset", content: [
        { type: "boxBlock", id: "outer_box", styleId: "plain", blocks: [nested] },
      ] };
      const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
    }, source);
    await page.reload();
    const nestedArea = page.locator(".sigma-doc-nested-problem-area").filter({ has: page.locator('[data-sigma-doc-id="nested_line"]') });
    await expect(nestedArea).toBeVisible();
    await expect(nestedArea).toHaveCSS("position", "relative");
    await expect(nestedArea).toHaveCSS("left", "9px");
    await expect(nestedArea).toHaveCSS("box-sizing", "border-box");
    await expect(nestedArea).toHaveCSS("padding-left", "12px");
    expect(await nestedArea.evaluate(el => parseFloat(getComputedStyle(el).width))).toBeCloseTo(70 * 96 / 25.4, 1);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
}
