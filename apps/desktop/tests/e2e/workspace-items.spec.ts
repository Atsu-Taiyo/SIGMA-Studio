import { expect, test, type Locator, type Page } from "@playwright/test";
import type { SigmaDocument } from "@/types/sigma-doc";

import {
  installWorkspaceRuntimeMock,
  type WorkspaceRuntimeMockSeed,
} from "./workspace-runtime-mock";

const WORKSPACE_FILE_ID = "file_workspace_items_e2e";
const WORKSPACE_ID = "workspace_items_e2e";

const WORKSPACE_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_workspace_preview_e2e",
  metadata: { title: "二次関数の確認" },
  content: [
    {
      type: "heading",
      id: "preview_heading",
      level: 2,
      children: [
        { type: "text", text: "二次関数の確認 " },
        { type: "mathInline", id: "preview_heading_math", tex: "y=ax^2", display: "inline" },
      ],
    },
    {
      type: "paragraph",
      id: "preview_body",
      children: [{ type: "text", text: "グラフの開き方と係数の関係を読み取る。" }],
    },
    {
      type: "problem",
      id: "preview_problem",
      tags: [],
      lead: [],
      prompt: [{
        type: "paragraph",
        id: "preview_problem_prompt",
        children: [
          { type: "text", text: "関数 " },
          { type: "mathInline", id: "preview_problem_math", tex: "y=2x^2", display: "inline" },
          { type: "text", text: " のグラフについて答えなさい。" },
        ],
      }],
      answer: { type: "text", expected: "上に開く" },
      solution: [{
        type: "paragraph",
        id: "preview_problem_solution",
        children: [{ type: "text", text: "係数が正なので上に開く。" }],
      }],
      hints: [],
    },
  ],
  outputProfiles: {
    student: { showSolutions: false, showHints: false, includeAnswers: false },
    teacher: { showSolutions: true, showHints: true, includeAnswers: true },
    answerBook: { onlySolutions: true, showSolutions: true, showHints: false, includeAnswers: true },
  },
  pageLayout: {
    preset: "B5",
    orientation: "portrait",
    pageSize: { widthMm: 182, heightMm: 257 },
    marginsMm: { top: 18, right: 16, bottom: 18, left: 16 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
  },
};

test("lists materials as table rows only, with no thumbnails or view switch, and opens them on double-click", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  // A stale "grid" choice from before the list became the only view must not bring the cards back.
  await page.addInitScript(() => {
    window.localStorage.setItem("sigma-studio:workspace-view-preference", JSON.stringify({ mode: "grid", sortKey: "name", sortDirection: "asc" }));
  });
  await installWorkspaceRuntimeMock(page, buildWorkspaceSeed());

  await page.goto(appUrl("/workspace"), { waitUntil: "domcontentloaded" });

  const row = fileRow(page);
  await expect(row).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(row.locator(".workspace-list-name-text")).toHaveText("二次関数の確認");
  await expect(page.locator(".workspace-content img")).toHaveCount(0);
  await expect(page.locator(".paged-thumbnail-host")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "グリッド表示", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "リスト表示", exact: true })).toHaveCount(0);

  // Drive semantics: a single click selects rather than opens (see
  // use-workspace-selection.ts) -- double-click opens.
  await row.dblclick();
  await expect(page).toHaveURL(new RegExp(`\\?fileId=${WORKSPACE_FILE_ID}$`));
});

test("single click selects a workspace row without navigating", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await installWorkspaceRuntimeMock(page, buildWorkspaceSeed());

  await page.goto(appUrl("/workspace"), { waitUntil: "domcontentloaded" });

  const row = fileRow(page);
  await expect(row).toBeVisible();

  await row.click();

  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(page).not.toHaveURL(new RegExp(`\\?fileId=${WORKSPACE_FILE_ID}$`));
});

test("pressing Enter on the focused row opens it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await installWorkspaceRuntimeMock(page, buildWorkspaceSeed());

  await page.goto(appUrl("/workspace"), { waitUntil: "domcontentloaded" });

  const row = fileRow(page);
  // A plain click both selects and moves DOM focus onto the row (roving
  // tabIndex), matching how a keyboard user would have arrived there via
  // Tab/arrow-key navigation.
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");

  await row.press("Enter");
  await expect(page).toHaveURL(new RegExp(`\\?fileId=${WORKSPACE_FILE_ID}$`));
});

test("Escape clears the current selection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await installWorkspaceRuntimeMock(page, buildWorkspaceSeed());

  await page.goto(appUrl("/workspace"), { waitUntil: "domcontentloaded" });

  const row = fileRow(page);
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");

  await row.press("Escape");
  await expect(row).toHaveAttribute("aria-selected", "false");
});

test("keeps the workspace tree collapsed and renames the workspace inline from the context menu", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await installWorkspaceRuntimeMock(page, buildWorkspaceSeed());

  await page.goto(appUrl("/workspace"), { waitUntil: "domcontentloaded" });

  const workspaceEntry = page.locator(".workspace-nav-entry");
  const workspaceButton = workspaceEntry.locator(".workspace-nav-item");
  const workspaceTree = workspaceEntry.locator(".workspace-tree");
  await expect(workspaceButton).toHaveAttribute("aria-expanded", "false");
  await expect(workspaceTree).toBeHidden();

  await workspaceButton.click({ button: "right" });
  const workspaceMenu = page.getByRole("menu", { name: "マイ教材 の操作" });
  await expect(workspaceMenu).toBeVisible();
  await workspaceMenu.getByRole("menuitem", { name: "名前を変更" }).click();

  // No dialog anymore: the nav entry's name swaps in place for an inline
  // <input>, autofocused and fully selected.
  const nameInput = workspaceEntry.getByLabel("ワークスペース名");
  await expect(nameInput).toBeFocused();
  await expect(nameInput).toHaveValue("マイ教材");
  await expect.poll(() => nameInput.evaluate((input) => ({
    start: (input as HTMLInputElement).selectionStart,
    end: (input as HTMLInputElement).selectionEnd,
  }))).toEqual({ start: 0, end: 4 });

  // The draft lives only in WorkspaceInlineRenameInput's own state, not in
  // any parent-owned object a background refresh could re-key an effect on
  // -- this is the regression net for the original "renaming resets after
  // the first keystroke" bug, now expressed against the inline input.
  await page.evaluate(() => {
    (window as typeof window & { __triggerWorkspaceChange?: () => void }).__triggerWorkspaceChange?.();
  });
  await page.waitForTimeout(650);
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toBeFocused();

  // fill() は1イベントで値を差し込むため「1文字ごとに全選択され直す」退行を検出できない。
  // 必ず pressSequentially で1文字ずつ打つこと。
  await nameInput.pressSequentially("数学教材");
  await expect(nameInput).toHaveValue("数学教材");
  await expect(nameInput.evaluate((input) => {
    const field = input as HTMLInputElement;
    return field.selectionStart === field.selectionEnd;
  })).resolves.toBe(true);

  await nameInput.press("Enter");
  await expect(nameInput).toBeHidden();
  await expect(workspaceEntry.locator(".workspace-nav-name")).toHaveText("数学教材");

  await workspaceButton.click();
  await expect(workspaceButton).toHaveAttribute("aria-expanded", "true");
  await expect(workspaceTree).toBeVisible();
  await expect(workspaceTree.getByText("二次関数の確認", { exact: true })).toBeVisible();
});

test("disables deleting the workspace from the nav context menu when it is the last one", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await installWorkspaceRuntimeMock(page, buildWorkspaceSeed());

  await page.goto(appUrl("/workspace"), { waitUntil: "domcontentloaded" });

  const workspaceEntry = page.locator(".workspace-nav-entry");
  const workspaceButton = workspaceEntry.locator(".workspace-nav-item");

  await workspaceButton.click({ button: "right" });
  const workspaceMenu = page.getByRole("menu", { name: "マイ教材 の操作" });
  await expect(workspaceMenu).toBeVisible();

  const deleteMenuItem = workspaceMenu.getByRole("menuitem", { name: "ワークスペースを削除" });
  await expect(deleteMenuItem).toBeVisible();
  await expect(deleteMenuItem).toBeDisabled();
  await expect(deleteMenuItem).toHaveAttribute("title", "最後のワークスペースは削除できません。");
});

test("uses the workspace row action menu for rename, template add, and delete", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await installWorkspaceRuntimeMock(page, buildWorkspaceSeed());

  await page.goto(appUrl("/workspace"), { waitUntil: "domcontentloaded" });

  const row = fileRow(page);
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole("button", { name: "二次関数の確認 の操作" }).click();
  await page.getByRole("menuitem", { name: "名前を変更" }).click();

  // No dialog anymore: the row's title swaps in place for an inline <input>.
  const fileNameInput = page.getByLabel("教材名");
  await expect(fileNameInput).toBeFocused();
  // fill() ではなく pressSequentially。理由は上の「ワークスペース名を変更」テストと同じ。
  await fileNameInput.pressSequentially("リネーム済み教材");
  await expect(fileNameInput).toHaveValue("リネーム済み教材");
  await fileNameInput.press("Enter");
  await expect(fileNameInput).toBeHidden();

  await expect(row.locator(".workspace-list-name-text")).toHaveText("リネーム済み教材");

  await row.hover();
  await row.getByRole("button", { name: "リネーム済み教材 の操作" }).click();
  await page.getByRole("menuitem", { name: "テンプレートに追加" }).click();
  await expect(page.getByText("テンプレートに追加しました")).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => {
    const api = (window as unknown as {
      desktopAPI: {
        templates: {
          listTemplates: () => Promise<Array<{ name: string }>>;
        };
      };
    }).desktopAPI;
    return (await api.templates.listTemplates()).map((template) => template.name);
  })).toContain("リネーム済み教材");

  await row.hover();
  await row.getByRole("button", { name: "リネーム済み教材 の操作" }).click();
  await page.getByRole("menuitem", { name: "削除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "削除する" }).click();
  await expect(row).toHaveCount(0);
});

test("an optimistic rename survives a background overview refresh mid-flight", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  // The rename's own repository round trip is deliberately slow (700ms) so
  // the storage watcher's 400ms-debounced silent reload (triggered below)
  // lands from a mocked backing store that hasn't caught up yet -- exactly
  // the race applyPendingRenames/pendingRenamesRef exist to cover. Without
  // that overlay, the reload at ~400ms would revert the row to its old
  // title until the slow rename finally resolves at ~700ms.
  await installWorkspaceRuntimeMock(page, buildWorkspaceSeed(), { renameDelayMs: 700 });

  await page.goto(appUrl("/workspace"), { waitUntil: "domcontentloaded" });

  const row = fileRow(page);
  const title = row.locator(".workspace-list-name-text");
  await row.hover();
  await row.getByRole("button", { name: "二次関数の確認 の操作" }).click();
  await page.getByRole("menuitem", { name: "名前を変更" }).click();

  const fileNameInput = page.getByLabel("教材名");
  await expect(fileNameInput).toBeFocused();
  await fileNameInput.pressSequentially("最新の教材名");
  await fileNameInput.press("Enter");

  // Commit is optimistic: the row already shows the new title even though
  // the mocked rename call won't resolve for 700ms.
  await expect(title).toHaveText("最新の教材名");

  await page.evaluate(() => {
    (window as typeof window & { __triggerWorkspaceChange?: () => void }).__triggerWorkspaceChange?.();
  });

  // Read the DOM once, synchronously, at a fixed checkpoint inside the
  // 400-700ms window -- not via an auto-retrying matcher, which would mask
  // a one-frame-then-recovers regression by waiting for the eventually
  // correct state instead of catching a transient revert.
  await page.waitForTimeout(550);
  expect(await title.textContent()).toBe("最新の教材名");

  // ...and it stays correct once the slow rename call itself resolves.
  await page.waitForTimeout(300);
  await expect(title).toHaveText("最新の教材名");
});

function fileRow(page: Page): Locator {
  return page.locator(`tr[data-item-key="file:${WORKSPACE_FILE_ID}"]`);
}

function appUrl(path: string): string {
  return process.env.SIGMA_STUDIO_E2E_BASE_URL ? new URL(path, process.env.SIGMA_STUDIO_E2E_BASE_URL).toString() : path;
}

// A single workspace / single file seed matching the old (now-removed)
// inline mock exactly, so every assertion below -- including "the last
// workspace can't be deleted" -- still holds unchanged.
function buildWorkspaceSeed(): WorkspaceRuntimeMockSeed {
  return {
    activeWorkspaceId: WORKSPACE_ID,
    workspaces: [
      { id: WORKSPACE_ID, name: "マイ教材" },
    ],
    files: [
      {
        fileId: WORKSPACE_FILE_ID,
        workspaceId: WORKSPACE_ID,
        folderId: null,
        title: WORKSPACE_DOCUMENT.metadata.title,
        document: WORKSPACE_DOCUMENT,
      },
    ],
  };
}
