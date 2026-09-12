import { expect, test, type Locator, type Page } from "@playwright/test";
import type { WorkspaceOverviewResult } from "@/lib/workspace-repository";

import {
  createDefaultWorkspaceMockSeed,
  installWorkspaceRuntimeMock,
  MOCK_FILE_IN_FOLDER_ID,
  MOCK_FILE_K10_ID,
  MOCK_FILE_K2_ID,
  MOCK_FILE_K2_TITLE,
  MOCK_FOLDER_A_ID,
  MOCK_FOLDER_A_NAME,
  MOCK_FOLDER_B_ID,
  MOCK_FOLDER_B_NAME,
  MOCK_FOLDER_EMPTY_ID,
  MOCK_WORKSPACE_1_ID,
  MOCK_WORKSPACE_1_NAME,
  MOCK_WORKSPACE_2_NAME,
} from "./workspace-runtime-mock";

function appUrl(path: string): string {
  return process.env.SIGMA_STUDIO_E2E_BASE_URL ? new URL(path, process.env.SIGMA_STUDIO_E2E_BASE_URL).toString() : path;
}

async function gotoWorkspace(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(appUrl("/workspace"), { waitUntil: "domcontentloaded" });
}

/** Sets the persisted view preference before the app boots, for tests that
 * aren't themselves exercising the toggle/sort UI. */
async function seedViewPreference(
  page: Page,
  preference: { mode: "grid" | "list"; sortKey?: "name" | "updatedAt"; sortDirection?: "asc" | "desc" },
): Promise<void> {
  await page.addInitScript((pref) => {
    window.localStorage.setItem("sigma-studio:workspace-view-preference", JSON.stringify(pref));
  }, preference);
}

function itemLocator(page: Page, key: string): Locator {
  return page.locator(`[data-item-key="${key}"]`);
}

async function readOverview(page: Page, workspaceId: string): Promise<WorkspaceOverviewResult> {
  return page.evaluate(
    (id) => (window.desktopAPI as unknown as {
      storage: { getWorkspaceOverview: (workspaceId: string) => Promise<WorkspaceOverviewResult> };
    }).storage.getWorkspaceOverview(id),
    workspaceId,
  );
}

test("switching to list view persists the preference across a reload", async ({ page }) => {
  await installWorkspaceRuntimeMock(page, createDefaultWorkspaceMockSeed());
  await gotoWorkspace(page);

  await expect(page.getByRole("table")).toHaveCount(0);
  await page.getByRole("button", { name: "リスト表示" }).click();

  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "名前" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "更新日時" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "場所" })).toBeVisible();

  const stored = await page.evaluate(() => window.localStorage.getItem("sigma-studio:workspace-view-preference"));
  expect(stored).not.toBeNull();
  expect(JSON.parse(stored as string)).toMatchObject({ mode: "list" });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("table")).toBeVisible();
  const storedAfterReload = await page.evaluate(() => window.localStorage.getItem("sigma-studio:workspace-view-preference"));
  expect(JSON.parse(storedAfterReload as string)).toMatchObject({ mode: "list" });
});

test("sorting by name and updated-at orders rows, flips aria-sort, and keeps folders above files", async ({ page }) => {
  await installWorkspaceRuntimeMock(page, createDefaultWorkspaceMockSeed());
  await gotoWorkspace(page);
  await page.getByRole("button", { name: "リスト表示" }).click();

  const rowKeys = () => page.locator("tr[data-item-key]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-item-key")));

  await page.getByRole("button", { name: "名前" }).click();
  await expect(page.getByRole("columnheader", { name: "名前" })).toHaveAttribute("aria-sort", "ascending");

  let keys = await rowKeys();
  const folderCount = keys.filter((key) => key?.startsWith("folder:")).length;
  expect(folderCount).toBeGreaterThan(0);
  expect(keys.slice(0, folderCount).every((key) => key?.startsWith("folder:"))).toBe(true);
  expect(keys.slice(folderCount).every((key) => key?.startsWith("file:"))).toBe(true);
  let k2Index = keys.indexOf(`file:${MOCK_FILE_K2_ID}`);
  let k10Index = keys.indexOf(`file:${MOCK_FILE_K10_ID}`);
  expect(k2Index).toBeGreaterThanOrEqual(0);
  expect(k10Index).toBeGreaterThanOrEqual(0);
  expect(k2Index).toBeLessThan(k10Index);

  await page.getByRole("button", { name: "名前" }).click();
  await expect(page.getByRole("columnheader", { name: "名前" })).toHaveAttribute("aria-sort", "descending");

  keys = await rowKeys();
  expect(keys.slice(0, folderCount).every((key) => key?.startsWith("folder:"))).toBe(true);
  expect(keys.slice(folderCount).every((key) => key?.startsWith("file:"))).toBe(true);
  k2Index = keys.indexOf(`file:${MOCK_FILE_K2_ID}`);
  k10Index = keys.indexOf(`file:${MOCK_FILE_K10_ID}`);
  expect(k10Index).toBeLessThan(k2Index);

  await page.getByRole("button", { name: "更新日時" }).click();
  await expect(page.getByRole("columnheader", { name: "更新日時" })).toHaveAttribute("aria-sort", "descending");
  await expect(page.getByRole("columnheader", { name: "名前" })).toHaveAttribute("aria-sort", "none");
});

test("場所 column shows the containing folder while searching and the workspace name at root", async ({ page }) => {
  await installWorkspaceRuntimeMock(page, createDefaultWorkspaceMockSeed());
  await gotoWorkspace(page);
  await page.getByRole("button", { name: "リスト表示" }).click();

  await page.getByLabel("教材を検索").fill("フォルダ内");
  const nestedRow = page.locator(`tr[data-item-key="file:${MOCK_FILE_IN_FOLDER_ID}"]`);
  await expect(nestedRow).toBeVisible();
  await expect(nestedRow.locator(".workspace-list-cell-location")).toHaveText(MOCK_FOLDER_B_NAME);

  await page.getByLabel("検索をクリア").click();
  const rootRow = page.locator(`tr[data-item-key="file:${MOCK_FILE_K2_ID}"]`);
  await expect(rootRow).toBeVisible();
  await expect(rootRow.locator(".workspace-list-cell-location")).toHaveText(MOCK_WORKSPACE_1_NAME);
});

async function runDragAndDropScenario(page: Page, viewMode: "grid" | "list"): Promise<void> {
  await seedViewPreference(page, { mode: viewMode, sortKey: "name", sortDirection: "asc" });
  await installWorkspaceRuntimeMock(page, createDefaultWorkspaceMockSeed());
  await gotoWorkspace(page);

  // file -> folder: 教材2 (root) into フォルダA.
  await itemLocator(page, `file:${MOCK_FILE_K2_ID}`).dragTo(itemLocator(page, `folder:${MOCK_FOLDER_A_ID}`));

  // folder -> folder: フォルダZ (root, empty) into フォルダA (nesting it).
  await itemLocator(page, `folder:${MOCK_FOLDER_EMPTY_ID}`).dragTo(itemLocator(page, `folder:${MOCK_FOLDER_A_ID}`));

  // file -> sidebar workspace entry: 教材10 into 第二ワークスペース.
  const secondWorkspaceEntry = page.locator(".workspace-nav-item", { hasText: MOCK_WORKSPACE_2_NAME });
  await itemLocator(page, `file:${MOCK_FILE_K10_ID}`).dragTo(secondWorkspaceEntry);

  const mainOverview = await readOverview(page, MOCK_WORKSPACE_1_ID);
  expect(mainOverview.state).toBe("ready");
  if (mainOverview.state !== "ready") {
    throw new Error("expected ready overview");
  }
  const movedFile = mainOverview.overview.files.find((file) => file.fileId === MOCK_FILE_K2_ID);
  expect(movedFile?.folderId).toBe(MOCK_FOLDER_A_ID);
  const movedFolder = mainOverview.overview.folders.find((folder) => folder.id === MOCK_FOLDER_EMPTY_ID);
  expect(movedFolder?.parentFolderId).toBe(MOCK_FOLDER_A_ID);
  expect(mainOverview.overview.files.some((file) => file.fileId === MOCK_FILE_K10_ID)).toBe(false);

  const secondWorkspace = mainOverview.overview.workspaces.find((workspace) => workspace.name === MOCK_WORKSPACE_2_NAME);
  expect(secondWorkspace).toBeTruthy();
  const secondOverview = secondWorkspace ? await readOverview(page, secondWorkspace.id) : null;
  expect(secondOverview?.state).toBe("ready");
  if (secondOverview?.state === "ready") {
    expect(secondOverview.overview.files.some((file) => file.fileId === MOCK_FILE_K10_ID)).toBe(true);
  }
}

test("drag and drop moves a file into a folder, nests a folder, and moves a file to another workspace (grid view)", async ({ page }) => {
  await runDragAndDropScenario(page, "grid");
});

test("drag and drop moves a file into a folder, nests a folder, and moves a file to another workspace (list view)", async ({ page }) => {
  await runDragAndDropScenario(page, "list");
});

test("right-clicking a folder row in list view offers rename and delete", async ({ page }) => {
  await installWorkspaceRuntimeMock(page, createDefaultWorkspaceMockSeed());
  await gotoWorkspace(page);
  await page.getByRole("button", { name: "リスト表示" }).click();

  const row = page.locator(`tr[data-item-key="folder:${MOCK_FOLDER_EMPTY_ID}"]`);
  await expect(row).toBeVisible();
  await row.click({ button: "right" });

  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "名前を変更" })).toBeVisible();
  const deleteItem = menu.getByRole("menuitem", { name: "削除" });
  await expect(deleteItem).toBeVisible();
  await expect(deleteItem).toBeEnabled();

  await deleteItem.click();
  await page.getByRole("dialog").getByRole("button", { name: "削除する" }).click();
  await expect(row).toHaveCount(0);
});

test("the multi-level breadcrumb navigates between folders and accepts a drop back to root", async ({ page }) => {
  await installWorkspaceRuntimeMock(page, createDefaultWorkspaceMockSeed());
  await gotoWorkspace(page);

  const breadcrumb = page.getByLabel("現在の場所");

  await itemLocator(page, `folder:${MOCK_FOLDER_A_ID}`).dblclick();
  await expect(breadcrumb.locator(".workspace-breadcrumb-item")).toHaveCount(2);
  await expect(breadcrumb.getByText(MOCK_FOLDER_A_NAME, { exact: true })).toBeVisible();

  await itemLocator(page, `folder:${MOCK_FOLDER_B_ID}`).dblclick();
  await expect(breadcrumb.locator(".workspace-breadcrumb-item")).toHaveCount(3);
  await expect(breadcrumb.getByText(MOCK_FOLDER_B_NAME, { exact: true })).toBeVisible();

  // Click フォルダA crumb -> back at フォルダA.
  await breadcrumb.getByText(MOCK_FOLDER_A_NAME, { exact: true }).click();
  await expect(breadcrumb.locator(".workspace-breadcrumb-item")).toHaveCount(2);
  await expect(itemLocator(page, `folder:${MOCK_FOLDER_B_ID}`)).toBeVisible();

  // Back into フォルダB, then drop フォルダ内教材 onto the root crumb.
  await itemLocator(page, `folder:${MOCK_FOLDER_B_ID}`).dblclick();
  const nestedFile = itemLocator(page, `file:${MOCK_FILE_IN_FOLDER_ID}`);
  await expect(nestedFile).toBeVisible();
  await nestedFile.dragTo(breadcrumb.getByText(MOCK_WORKSPACE_1_NAME, { exact: true }));

  const overview = await readOverview(page, MOCK_WORKSPACE_1_ID);
  expect(overview.state).toBe("ready");
  if (overview.state === "ready") {
    const file = overview.overview.files.find((candidate) => candidate.fileId === MOCK_FILE_IN_FOLDER_ID);
    expect(file?.folderId).toBeNull();
  }
});

test("deleting the second workspace removes it and its contents, then disables deleting the last one", async ({ page }) => {
  await installWorkspaceRuntimeMock(page, createDefaultWorkspaceMockSeed());
  await gotoWorkspace(page);

  const secondWorkspaceButton = page.locator(".workspace-nav-item", { hasText: MOCK_WORKSPACE_2_NAME });
  await expect(secondWorkspaceButton).toBeVisible();
  await secondWorkspaceButton.click({ button: "right" });

  const menu = page.getByRole("menu", { name: `${MOCK_WORKSPACE_2_NAME} の操作` });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "ワークスペースを削除" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("教材 0 件");
  await expect(dialog).toContainText("フォルダ 0 件");

  await dialog.getByRole("button", { name: "削除する" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".workspace-nav-item", { hasText: MOCK_WORKSPACE_2_NAME })).toHaveCount(0);

  const remainingWorkspaceButton = page.locator(".workspace-nav-item", { hasText: MOCK_WORKSPACE_1_NAME });
  await remainingWorkspaceButton.click({ button: "right" });
  const remainingMenu = page.getByRole("menu", { name: `${MOCK_WORKSPACE_1_NAME} の操作` });
  const deleteItem = remainingMenu.getByRole("menuitem", { name: "ワークスペースを削除" });
  await expect(deleteItem).toBeDisabled();
  await expect(deleteItem).toHaveAttribute("title", "最後のワークスペースは削除できません。");
});

test("opening an empty folder shows the folder empty-state variant", async ({ page }) => {
  await installWorkspaceRuntimeMock(page, createDefaultWorkspaceMockSeed());
  await gotoWorkspace(page);

  await itemLocator(page, `folder:${MOCK_FOLDER_EMPTY_ID}`).dblclick();
  const emptyState = page.locator('[data-empty-variant="folder"]');
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toContainText("このフォルダは空です");
  await expect(emptyState.getByRole("button", { name: "教材を作成" })).toBeVisible();
});

test("inline rename in list view accepts a full pressSequentially-typed value for a folder and a file", async ({ page }) => {
  await installWorkspaceRuntimeMock(page, createDefaultWorkspaceMockSeed());
  await gotoWorkspace(page);
  await page.getByRole("button", { name: "リスト表示" }).click();

  // Folder rename via right-click context menu.
  const folderRow = page.locator(`tr[data-item-key="folder:${MOCK_FOLDER_A_ID}"]`);
  await folderRow.click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "名前を変更" }).click();

  const folderInput = page.getByLabel("フォルダ名");
  await expect(folderInput).toBeFocused();
  // fill() は1イベントで値を差し込むため「1文字打つと全選択され直す」退行を検出できない。
  // 必ず pressSequentially で1文字ずつ打つこと (S1のリグレッションネット、リスト表示版)。
  await folderInput.pressSequentially("改称フォルダA");
  await expect(folderInput).toHaveValue("改称フォルダA");
  await folderInput.press("Enter");
  await expect(folderInput).toBeHidden();
  await expect(page.locator(`tr[data-item-key="folder:${MOCK_FOLDER_A_ID}"] .workspace-list-name-text`)).toHaveText("改称フォルダA");

  // File rename via the row's own action menu.
  const fileRow = page.locator(`tr[data-item-key="file:${MOCK_FILE_K2_ID}"]`);
  await fileRow.hover();
  await fileRow.getByRole("button", { name: `${MOCK_FILE_K2_TITLE} の操作` }).click();
  await page.getByRole("menuitem", { name: "名前を変更" }).click();

  const fileInput = page.getByLabel("教材名");
  await expect(fileInput).toBeFocused();
  await fileInput.pressSequentially("改称教材2");
  await expect(fileInput).toHaveValue("改称教材2");
  await fileInput.press("Enter");
  await expect(fileInput).toBeHidden();
  await expect(page.locator(`tr[data-item-key="file:${MOCK_FILE_K2_ID}"] .workspace-list-name-text`)).toHaveText("改称教材2");
});
