import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { MathfieldElement } from "mathlive";
import type { SigmaDocument } from "@/features/document";
import { ORDERED_INLINE_MATH_TEMPLATE_GROUPS } from "@/lib/inline-math-templates";

const APP_ROOT = path.resolve(__dirname, "../..");
const ARROW = ".sigma-esvect-d-arrow";

function launchEnv(profile: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  return env;
}

async function open(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1200, 850));
  await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
  return page;
}

const math = (id: string, tex: string) => ({ type: "paragraph" as const, id, children: [{ type: "mathInline" as const, id: `${id}_math`, tex, display: "inline" as const }] });

async function launch() {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-esvect-"));
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env: launchEnv(profile) });
  const page = await open(app);
  const source: SigmaDocument = {
    version: "2.0", docId: "esvect_vectors", metadata: { title: "ベクトル" },
    content: [
      math("vector", String.raw`\vv{AB}`),
      math("legacy", String.raw`\vec{a}+\overrightarrow{AB}`),
      math("script", String.raw`x_{\vv{u}}+\left\lvert\vv{AB}\right\rvert^{2}`),
      ...["p0", "p1"].map(id => ({ type: "paragraph" as const, id, children: [{ type: "text" as const, text: id }] })),
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
  const fileId = await page.evaluate(async document => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    localStorage.setItem("sigma-studio:inline-math-input-mode", "mathlive");
    await window.desktopAPI!.settings!.setUiLocale!("ja");
    const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
    await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
    return file.fileId;
  }, source);
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
  return { app, page, fileId, profile };
}

/** The arrow's top above the operand's glyph box, and its width, in the vector's em. */
async function arrowGeometry(root: Locator) {
  return root.evaluate(element => {
    const scope = element.querySelector("math-field")?.shadowRoot ?? element;
    const arrow = scope.querySelector<HTMLElement>(".sigma-esvect-d-arrow");
    if (!arrow) return null;
    const operandRow = Array.from(arrow.parentElement!.children).find(row => row !== arrow && !row.querySelector(".ML__rule"));
    const walker = operandRow && document.createTreeWalker(operandRow, NodeFilter.SHOW_TEXT);
    const text = walker?.nextNode();
    if (!text) return null;
    const range = document.createRange();
    range.selectNodeContents(text);
    const em = parseFloat(getComputedStyle(arrow).fontSize);
    const a = arrow.getBoundingClientRect();
    return { rise: (range.getBoundingClientRect().top - a.top) / em, width: a.width / em };
  });
}

async function caretAtParagraphEnd(page: Page, id: string): Promise<Locator> {
  const paragraph = page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
  await paragraph.click();
  await paragraph.evaluate(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last: Node | null = null;
    while (walker.nextNode()) last = walker.currentNode;
    getSelection()!.collapse(last, last!.textContent!.length);
  });
  return paragraph;
}

async function savedMath(page: Page, fileId: string) {
  const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
  return Object.fromEntries((saved?.content ?? []).map(block => [
    block.id,
    block.type === "paragraph" ? block.children.map(run => run.type === "mathInline" ? `$${run.tex}$` : run.type === "text" ? run.text : "").join("") : "",
  ]));
}

test("esvect \\vv renders, edits in the same box, inserts from the palette and shortcut, and saves", async () => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!process.env.SIGMA_STUDIO_E2E_BASE_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Build the renderer first");
  const { app, page, fileId, profile } = await launch();
  let active = app;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const vector = page.locator('.page-flow [data-id="vector_math"]').first();
    await expect(vector.locator(ARROW)).toHaveCount(1);
    // Existing \vec and \overrightarrow documents keep rendering as before.
    const legacy = page.locator('.page-flow [data-id="legacy_math"]').first();
    await expect(legacy.locator(ARROW)).toHaveCount(0);
    await expect(legacy.locator(".ML__error")).toHaveCount(0);
    // Inside a script the arrow keeps esvect's place above the operand and its width.
    const script = page.locator('.page-flow [data-id="script_math"]').first();
    await expect(script.locator(ARROW)).toHaveCount(2);
    // (The scripted vector's arrow stays at esvect's 0.8334em minimum, not the parent's size.)
    expect((await arrowGeometry(script))!.width).toBeLessThan(0.9);

    // Editing: the same box and arrow as the page, and an edit inside the vector is kept.
    const staticGeometry = (await arrowGeometry(vector))!;
    await vector.click();
    const field = vector.locator("math-field");
    await expect(field).toBeFocused();
    await expect.poll(() => field.evaluate(el => el.shadowRoot?.querySelectorAll(".sigma-esvect-d-arrow").length)).toBe(1);
    const editingGeometry = (await arrowGeometry(vector))!;
    expect(Math.abs(editingGeometry.rise - staticGeometry.rise)).toBeLessThan(0.02);
    expect(Math.abs(editingGeometry.width - staticGeometry.width)).toBeLessThan(0.02);
    await field.evaluate(el => {
      const mf = el as MathfieldElement;
      mf.executeCommand("moveToMathfieldStart");
      mf.executeCommand("moveToNextChar");
      mf.executeCommand("moveToNextChar");
    });
    await page.keyboard.type("C");
    await expect.poll(() => field.evaluate(el => (el as MathfieldElement).getValue("latex"))).toBe(String.raw`\vv{ACB}`);
    await page.keyboard.press("Escape");
    await expect(vector.locator("math-field")).toHaveCount(0);

    // The Σ palette's vector template and Ctrl+W insert \vv.
    const templates = ORDERED_INLINE_MATH_TEMPLATE_GROUPS.flatMap(group => group.templates);
    const vectorTemplate = page.locator(".inline-math-template-button").nth(templates.findIndex(template => template.id === "vector-accent"));
    const p0 = await caretAtParagraphEnd(page, "p0");
    await page.getByRole("button", { name: "数式", exact: true }).first().hover();
    await vectorTemplate.click();
    await expect(p0.locator("math-field")).toBeFocused();
    await page.keyboard.type("PQ");
    await page.keyboard.press("Escape");
    await expect(p0.locator("math-field")).toHaveCount(0);
    const p1 = await caretAtParagraphEnd(page, "p1");
    await page.keyboard.press("Control+m");
    await expect(p1.locator("math-field")).toBeFocused();
    await page.keyboard.press("Control+w");
    await page.keyboard.type("a");
    await page.keyboard.press("Escape");
    await expect(p1.locator("math-field")).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+s");
    const expected = { vector: String.raw`$\vv{ACB}$`, p0: String.raw`p0$\vv{PQ}$`, p1: String.raw`p1$\vv{a}$` };
    await expect.poll(() => savedMath(page, fileId)).toMatchObject(expected);
    expect(errors).toEqual([]);

    await active.close();
    active = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env: launchEnv(profile) });
    const restored = await open(active);
    expect(await savedMath(restored, fileId)).toMatchObject(expected);
    await expect(restored.locator(`.page-flow [data-sigma-doc-id="p0"] ${ARROW}`).first()).toBeVisible();
  } finally {
    await active.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
