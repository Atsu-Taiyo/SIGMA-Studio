import { expect, test, type Page } from "@playwright/test";
import type { SigmaDocument } from "@sigma-studio/viewer";
import sampleDocument from "../../examples/editor-react18/src/sample-document.json";

const storageKey = "sigma-sdk-answer-share-document-v2";

test("Viewer display settings preserve SigmaDoc; edits survive host save and reload", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".viewer-stage")).toBeVisible();
  await expect(page.locator(".viewer-stage")).not.toBeEmpty();
  await expect(page.locator(".viewer-error")).toHaveCount(0);
  const originalTitle = await page.locator("#material-heading").innerText();

  await page.getByRole("button", { name: "解答だけ", exact: true }).click();
  await expect(page.locator(".parameter-output")).toContainText("solution");
  await expect(page.getByRole("checkbox", { name: "問題番号を隠す" })).toBeChecked();
  await page.getByRole("button", { name: "高さ制限を解除" }).click();
  await expect(page.locator(".parameter-output")).toContainText("undefined");
  await expect(page.locator("#material-heading")).toHaveText(originalTitle);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull();

  await page.getByRole("button", { name: "この教材を編集", exact: true }).click();
  const title = page.getByRole("textbox", { name: "教材タイトル", exact: true });
  // An untitled sample uses a body-derived title in the editor input.
  await expect(title).toBeVisible();
  const updatedTitle = "React 18 保存と再読込の確認";
  await title.fill(updatedTitle);
  await expect.poll(() => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).metadata.title : null;
  }, storageKey)).toBe(updatedTitle);
  // The first load uses the raw legacy sample. Display-only Viewer controls and
  // opening the Editor must preserve every field until the explicit title edit.
  const expected = structuredClone(sampleDocument) as unknown as SigmaDocument;
  expected.metadata.title = updatedTitle;
  expect(withoutSaveTimestamps(await readSavedDocument(page)))
    .toEqual(withoutSaveTimestamps(expected));

  const paragraphId = "p_1e465f2e-5571-4cf8-88ad-818451b870b8";
  const body = page.locator(`[data-sigma-doc-id="${paragraphId}"]`).first();
  const addedText = " React 18で追記した本文";
  await body.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(addedText);
  await expect(body).toHaveText(`解答${addedText}`);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).toContain(addedText);
  const editedBlock = expected.content.find((block) => block.id === paragraphId);
  if (editedBlock?.type !== "paragraph" || editedBlock.children[0]?.type !== "text") {
    throw new Error("The editing fixture must contain the target paragraph's leading text node.");
  }
  editedBlock.children[0].text += addedText;
  expect(withoutSaveTimestamps(await readSavedDocument(page)))
    .toEqual(withoutSaveTimestamps(expected));
  await expect(page.locator(".save-state.saving")).toHaveCount(0);

  await page.reload();
  await expect(title).toHaveValue(updatedTitle);
  await expect(body).toHaveText(`解答${addedText}`);
  // Reload goes through the host's public parser, which normalizes this older
  // sample's legacy pagination fields. Save again to inspect the complete
  // reloaded document, rather than only the paragraph currently visible in DOM.
  const { parseSigmaDocument } = await import("@sigma-studio/viewer");
  const expectedReloaded = parseSigmaDocument(expected);
  const resavedTitle = `${updatedTitle}（再保存）`;
  expectedReloaded.metadata.title = resavedTitle;
  await title.fill(resavedTitle);
  await expect.poll(async () => (await readSavedDocument(page)).metadata.title).toBe(resavedTitle);
  expect(withoutSaveTimestamps(await readSavedDocument(page)))
    .toEqual(withoutSaveTimestamps(expectedReloaded));
  await expect(page.locator(".save-state.saving")).toHaveCount(0);
  // The browser's history returns to the host Viewer with the same document.
  await page.goBack();
  await expect(page.locator("#material-heading")).toHaveText(resavedTitle);
  await page.reload();
  await expect(page.locator("#material-heading")).toHaveText(resavedTitle);
  // Top-level prose is visible in the complete view, outside problem parts.
  await page.getByRole("button", { name: "完全版", exact: true }).click();
  await expect(page.locator(".viewer-stage")).toContainText(addedText);
  await expect(page.locator(".viewer-error")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

function readSavedDocument(page: Page): Promise<SigmaDocument> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey);
}

function withoutSaveTimestamps(document: SigmaDocument): SigmaDocument {
  // Keep the complete structure, including unknown legacy fields. Only the
  // clocks that may advance during save are outside this preservation contract.
  const comparable = structuredClone(document);
  delete comparable.updatedAt;
  if (comparable.pageLayout?.overlay) delete comparable.pageLayout.overlay.updatedAt;
  return comparable;
}
