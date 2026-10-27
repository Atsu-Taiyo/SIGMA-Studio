import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { ProblemNode, SigmaDocument } from "@/features/document";

const root = path.resolve(__dirname, "../..");
const seed: ProblemNode = {
  type: "problem", id: "previous", tags: ["元のタグ"], lead: [], hints: [],
  prompt: [{ type: "paragraph", id: "previous_prompt", children: [{ type: "text", text: "元の問題文" }] }],
  solution: [{ type: "paragraph", id: "previous_solution", children: [{ type: "text", text: "元の解答" }] }],
  answer: { type: "text", expected: "元の正答" },
  numbering: { enabled: true, value: 7, fontFamily: '"Noto Serif JP", serif', fontSize: 10, fontWeight: 700, format: "fullwidth", widthPx: 22, heightPx: 24, borderWidthPx: .5, borderRadiusPx: 0, offsetYPx: 2 },
  frame: { enabled: true, styleId: "fancybox", borderWidthPx: .5, borderRadiusPx: 0 },
  areaLayout: { lead: { hidden: true }, prompt: { minHeightMm: 20, widthMm: 90, paddingPx: { top: 3, right: 4, bottom: 5, left: 6 }, marginTopPx: 0, marginBottomPx: 0 } },
};

for (const mode of ["menu", "slash", "nested-slash", "first-in-box"] as const) {
  test(`new problems inherit the preceding presentation through ${mode}, save and restart`, async ({}, testInfo) => {
    const profile = mkdtempSync(path.join(tmpdir(), "sigma-problem-style-"));
    const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SIGMA_STUDIO_DEV_SERVER_URL;
    if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
    const launch = () => electron.launch({ args: [root], cwd: root, env });
    let app = await launch();
    try {
      let page = await app.firstWindow();
      await (await app.browserWindow(page)).evaluate(w => w.setContentSize(1400, 1100));
      await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
      await expect(page.locator(".startup-splash")).toBeHidden();
      const source: SigmaDocument = {
        version: "2.0", docId: "problem_style_inheritance", metadata: { title: "問題書式の引き継ぎ", styleUnits: { fontSize: "pt" } },
        outputProfiles: { student: {}, teacher: {}, answerBook: {} },
        content: [
          ...(mode === "nested-slash" ? [{ type: "boxBlock" as const, id: "box", styleId: "plain", blocks: [seed, { type: "paragraph" as const, id: "trigger", children: [] }] }] : mode === "first-in-box" ? [seed, { type: "boxBlock" as const, id: "box", styleId: "plain", blocks: [{ type: "paragraph" as const, id: "trigger", children: [] }] }] : [seed, { type: "paragraph" as const, id: "trigger", children: [] }]),
          { ...seed, id: "later", tags: [], prompt: [{ type: "paragraph", id: "later_prompt", children: [{ type: "text", text: "後ろの問題" }] }], solution: [], numbering: { value: 30, fontFamily: "sans-serif" } },
        ],
      };
      const fileId = await page.evaluate(async document => {
        localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
        await window.desktopAPI!.settings!.setUiLocale!("ja");
        const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
        await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
        return file.fileId;
      }, source);
      await page.reload();
      const load = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
      const problems = (document: SigmaDocument): ProblemNode[] => document.content.flatMap(b => b.type === "boxBlock" ? b.blocks.filter(b => b.type === "problem") : b.type === "problem" ? [b] : []);
      const before = problems((await load())!);
      await page.locator('p[data-sigma-doc-id="trigger"]').click();
      if (mode === "menu") {
        await page.getByRole("button", { name: "挿入", exact: true }).click();
        await page.getByRole("menu", { name: "挿入", exact: true }).getByRole("menuitem", { name: "問題", exact: true }).click();
      } else {
        await page.keyboard.type("/problem");
        await expect(page.locator(".slash-command-popover")).toBeVisible();
        await page.keyboard.press("Enter");
      }
      await expect.poll(async () => problems((await load())!).length).toBe(3);
      const saved = (await load())!, all = problems(saved), inserted = all[1];
      const expectedNumbering = { ...seed.numbering };delete expectedNumbering.value;
      expect(inserted.numbering).toEqual(expectedNumbering);
      expect(inserted.frame).toEqual(seed.frame);
      expect(inserted.areaLayout).toEqual(seed.areaLayout);
      expect(inserted.tags).toEqual([]);
      expect(JSON.stringify(inserted.prompt)).not.toContain("元の問題文");
      expect(inserted.answer?.expected).toBe("");
      expect([all[0], all[2]]).toEqual(before);
      const nested = mode === "nested-slash" || mode === "first-in-box";
      const marker = nested
        ? page.locator(`[data-problem-id="${inserted.id}"] [data-problem-number]`).first()
        : page.locator(`[data-problem-id="${inserted.id}"] .problem-number-marker`);
      if (nested) await expect(marker).toHaveAttribute("data-problem-number", "８");
      else { await expect(marker).toHaveText("８");await expect(marker).toHaveCSS("font-family", '"Noto Serif JP", serif');await expect(marker).toHaveCSS("width", "22px"); }
      await page.screenshot({ path: testInfo.outputPath("inherited-problem.png") });
      await app.close();app = await launch();page = await app.firstWindow();
      await expect(page.locator(`[data-problem-id="${inserted.id}"]`).first()).toBeVisible();
      expect(problems((await load())!)[1]).toEqual(inserted);
    } finally {
      await app.close();
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
}
