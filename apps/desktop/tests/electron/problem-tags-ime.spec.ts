import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type CDPSession, type Page } from "@playwright/test";
import { ensurePageLayout } from "@/features/document";
import type { ParagraphNode, ProblemNode, SigmaDocument } from "@/types/sigma-doc";

const APP_ROOT = path.resolve(__dirname, "../..");
const PROMPT_TEXT = "方程式 x² + 2x + 1 = 0 を解きなさい。";

/**
 * Tags typed with the Japanese IME: the Enter that confirms the conversion used to make the chip
 * while Chromium then wrote the confirmed word back into the field, so the word stayed behind the
 * chip (and became a second tag on blur). The word has to move into the chip, and only it is saved.
 */
test("a tag typed with the IME becomes a chip without leaving the word in the field, and is saved", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-problem-tags-ime-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    // Finish the initial empty workspace bootstrap before installing the fixture.
    await expect(page.locator(".text-flow-editor").first()).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const created = await page.evaluate(
      (document) => window.desktopAPI!.storage.createFileFromDocument({ document }),
      createDocument(),
    );
    await page.reload();

    const dialog = await openProblemSettings(page);
    const field = dialog.locator(".problem-tag-input-shell input");
    const chips = dialog.locator(".problem-tag-tip-label");
    await field.click();
    const ime = await page.context().newCDPSession(page);

    await composeAndConfirm(ime, ["び", "びぶ", "びぶん", "微分"], "微分");
    await dialog.screenshot({ path: testInfo.outputPath("ime-confirmed.png") });
    // Confirming the conversion only confirms it: no chip yet, the word is still where it was typed.
    await expect(field).toHaveValue("微分");
    await expect(chips).toHaveCount(0);
    await field.press("Enter");
    await expect(chips).toHaveText(["微分"]);
    await expect(field).toHaveValue("");
    await dialog.screenshot({ path: testInfo.outputPath("ime-chip.png") });

    // A separator inside the conversion splits the confirmed words, not the reading.
    await composeAndConfirm(ime, ["せきぶん", "せきぶん、", "せきぶん、きょくげん", "積分、極限"], "積分、極限");
    await expect(chips).toHaveText(["微分", "積分"]);
    await expect(field).toHaveValue("極限");
    await field.press("Enter");
    await expect(chips).toHaveText(["微分", "積分", "極限"]);

    // Typed (non-IME) tags with symbols keep working, and Backspace in the empty field drops the last chip.
    await field.pressSequentially("C++/数II");
    await field.press("Enter");
    await field.pressSequentially("tmp");
    await field.press("Enter");
    await expect(chips).toHaveText(["微分", "積分", "極限", "C++/数II", "tmp"]);
    await field.press("Backspace");
    await expect(chips).toHaveText(["微分", "積分", "極限", "C++/数II"]);
    await expect(field).toHaveValue("");

    // Closing the dialog commits nothing extra (the field is empty), and the real bridge saves the tags.
    await dialog.getByRole("button", { name: "閉じる" }).click();
    await expect(dialog).toBeHidden();
    const expectedTags = ["微分", "積分", "極限", "C++/数II"];
    await expect.poll(async () => {
      const saved = await page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId), created.file.fileId);
      const problem = saved?.content.find((block): block is ProblemNode => block.type === "problem");
      return { tags: problem?.tags, prompt: promptText(problem) };
    }, { timeout: 15_000 }).toEqual({ tags: expectedTags, prompt: PROMPT_TEXT });

    await page.reload();
    const reopened = await openProblemSettings(page);
    await expect(reopened.locator(".problem-tag-tip-label")).toHaveText(expectedTags);
    await expect(reopened.locator(".problem-tag-input-shell input")).toHaveValue("");
    // Nothing typed into the tag field reached the problem text.
    await expect(page.locator('[data-sigma-doc-id="problem_tags_ime_prompt"]').first()).toHaveText(PROMPT_TEXT);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

async function openProblemSettings(page: Page) {
  const prompt = page.locator('[data-problem-area="prompt"][data-problem-id="problem_tags_ime"]').first();
  await expect(prompt).toBeVisible();
  await prompt.hover();
  await prompt.getByRole("button", { name: "問題操作" }).click();
  await page.getByRole("menu", { name: "問題操作" }).getByRole("menuitem", { name: "問題の設定…" }).click();
  const dialog = page.getByRole("dialog", { name: "問題設定" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Converts with the IME and confirms with Enter in the order Chromium on macOS delivers it: the
 * Enter keydown arrives while the text is still composed, then the confirmed text is committed.
 */
async function composeAndConfirm(ime: CDPSession, steps: readonly string[], committed: string) {
  for (const text of steps) {
    await ime.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  }
  await ime.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 36 });
  await ime.send("Input.insertText", { text: committed });
  await ime.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 });
}

function promptText(problem: ProblemNode | undefined) {
  return problem?.prompt
    .flatMap((block) => (block.type === "paragraph" ? block.children : []))
    .map((run) => (run.type === "text" ? run.text : ""))
    .join("");
}

function createDocument(): SigmaDocument {
  return ensurePageLayout({
    version: "2.0",
    docId: "problem_tags_ime_doc",
    metadata: { title: "問題のタグ" },
    content: [{
      type: "problem",
      id: "problem_tags_ime",
      tags: [],
      lead: [],
      prompt: [paragraph("problem_tags_ime_prompt", PROMPT_TEXT)],
      solution: [],
      hints: [],
    }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  });
}

function paragraph(id: string, text: string): ParagraphNode {
  return { id, type: "paragraph", children: [{ type: "text", text }] };
}
