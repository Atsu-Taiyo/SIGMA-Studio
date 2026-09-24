import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { EXAMPLE_TEX_PREAMBLE } from "@/lib/tex-environment-examples";
import { ensurePageLayout } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const formulas = [
  ["root", String.raw`\sqrt{\boxed{\quad}}`],
  ["answer", String.raw`\sqrt{\answerbox{\text{コ}}}`],
  ["thick", String.raw`\sqrt{\thickanswerbox{\text{コ}}}`],
  ["outer", String.raw`\sqrt{\outerthickanswerbox{\text{コ}}}`],
  ["empty", String.raw`\sqrt{\answerbox{}}`],
  ["boxed_a", String.raw`\sqrt{\boxed{a}}`],
  ["fraction", String.raw`\sqrt{\boxed{\frac{x_1}{y}}}`],
  ["index", String.raw`\sqrt[3]{\boxed{\quad}}`],
  ["control", String.raw`\sqrt{x}+\sqrt{2}`],
];

for (const fontSize of [12, 24]) {
  test(`radical answer box stays below its bar at ${fontSize}pt through editing and reload`, async ({}, testInfo) => {
    const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-radical-square-"));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SIGMA_STUDIO_DEV_SERVER_URL;
    env.SIGMA_STUDIO_USER_DATA_DIR = profile;
    if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
    const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => Boolean(window.desktopAPI));
      const source = ensurePageLayout({ ...sampleDocument, docId: "radical_square", metadata: { title: "ルート内の解答欄", texPreamble: EXAMPLE_TEX_PREAMBLE, styleUnits: { fontSize: "pt" } }, content: formulas.map(([id, tex]) => ({
        type: "paragraph" as const, id: `p_${id}`, children: [
          { type: "text" as const, text: `${id}　` },
          { type: "mathInline" as const, id, tex, display: "inline" as const, semanticRole: "expression" as const, fontSize },
        ],
      })) });
      const fileId = await page.evaluate(async (document) => {
        localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
        await window.desktopAPI!.settings!.setUiLocale!("ja");
        const storage = window.desktopAPI!.storage;
        const created = await storage.createFileFromDocument({ document });
        await storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
        return created.file.fileId;
      }, source);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator(".startup-splash")).toBeHidden();
      await expect(page.locator('[data-sigma-doc-id="p_control"]').first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: testInfo.outputPath("preview.png") });
      for (const [id] of formulas.slice(0, -1)) {
        const node = page.locator(`.page-flow .inline-math-node[data-id="${id}"]`);
        await node.screenshot({ path: testInfo.outputPath(`static-${id}.png`) });
        expect(await boxGap(node, false), `static ${id}`).toBeGreaterThan(1);
        await page.evaluate((id) => window.dispatchEvent(new CustomEvent("sigma-studio:edit-inline-math", { detail: { cursorPosition: "end", id } })), id);
        const field = node.locator("math-field");
        await expect(field).toBeFocused();
        await expect.poll(() => boxGap(field, true), { message: `editing ${id}` }).toBeGreaterThan(1);
        await field.screenshot({ path: testInfo.outputPath(`editing-${id}.png`) });
        if (id === "root") await page.screenshot({ path: testInfo.outputPath("editing-page.png") });
        await page.keyboard.press("Enter");
      }
      expect(await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId)).toMatchObject({ content: source.content });
      const rootNode = page.locator('.page-flow .inline-math-node[data-id="root"]');
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:edit-inline-math", { detail: { cursorPosition: "end", id: "root" } })));
      const rootField = rootNode.locator("math-field");
      await expect(rootField).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.type("7");
      await expect.poll(() => boxGap(rootField, true)).toBeGreaterThan(1);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Meta+s");
      await expect.poll(async () => {
        const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
        const paragraph = saved?.content.find((block) => block.id === "p_root");
        return paragraph?.type === "paragraph"
          ? paragraph.children.find((run) => run.type === "mathInline")?.tex
          : undefined;
      }).toMatch(/\\boxed\{[^}]*7\}/);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator(".startup-splash")).toBeHidden();
      await expect(rootNode).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      for (const [id] of formulas.slice(0, -1)) {
        expect(await boxGap(page.locator(`.page-flow .inline-math-node[data-id="${id}"]`), false), `reloaded ${id}`).toBeGreaterThan(1);
      }
      await page.screenshot({ path: testInfo.outputPath("reloaded.png") });
    } finally {
      await app.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });
}

async function boxGap(node: Locator, editing: boolean) {
  return node.evaluate((el, editing) => {
    const root = editing ? el.shadowRoot! : el;
    const box = root.querySelector<HTMLElement>(".ML__box")!;
    const line = box.closest(".ML__vlist")!.querySelector<HTMLElement>(".ML__sqrt-line")!;
    const gap = box.getBoundingClientRect().top - line.getBoundingClientRect().top;
    return gap - line.getBoundingClientRect().height;
  }, editing);
}
