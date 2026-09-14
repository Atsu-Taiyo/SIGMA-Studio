import { expect, test, type Page } from "@playwright/test";

import { getDefaultPageLayout } from "@/lib/page-layout";
import type { SigmaDocument } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

function createWhiteboardDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "whiteboard_comments_e2e",
    metadata: { title: "ホワイトボードコメントE2E" },
    content: [],
    pageLayout: {
      ...getDefaultPageLayout("whiteboard"),
      overlay: {
        overlaySnapshot: {
          version: 1,
          shapes: [{
            id: "comment_target_shape",
            type: "geo",
            x: 180,
            y: 140,
            rotation: 0,
            props: {
              w: 180,
              h: 100,
              geo: "rectangle",
              fill: "solid",
              color: "#111111",
              fillColor: "#ffffff",
              labelColor: "#111111",
              dash: "solid",
              size: "m",
            },
          }],
          assets: {},
        },
      },
    },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

test("ホワイトボードの表ボタンからクリックで2行2列の表を置ける", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await installDesktopRuntimeMock(page, createWhiteboardDocument());
  await page.goto("/");

  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();

  const tableButton = page.getByRole("button", { name: "表", exact: true }).first();
  await expect(tableButton).toBeVisible();
  await tableButton.click();

  await expect(page.getByRole("dialog", { name: "表を挿入" })).toHaveCount(0);
  const canvas = await page.locator(".whiteboard-page-canvas").boundingBox();
  await page.mouse.click(canvas!.x + 300, canvas!.y + 200);

  const table = page.locator(".overlay-table-shape").first();
  await expect(table).toBeVisible();
  await expect(table.locator("tr")).toHaveCount(2);
  await expect(table.locator("tr").first().locator("td")).toHaveCount(2);
});

test("ホワイトボードの図形コメントを保存し、Undo/Redoと新しい画面で復元できる", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await installDesktopRuntimeMock(page, createWhiteboardDocument());
  await page.goto("/");

  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
  const commentToggle = page.locator(".comment-dock-toggle");
  await expect(commentToggle).toBeVisible();
  await expect(commentToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".comment-dock")).toBeHidden();

  await commentToggle.click();
  const dock = page.locator(".comment-dock");
  await expect(dock).toBeVisible();
  await expect(dock.locator(".comment-dock-header").getByRole("button", { name: "コメントを追加" })).toBeVisible();
  await expect(dock).toContainText("コメントする図形やテキストを選択してください。");
  await expect(dock).toContainText("図形やテキストを選んでから「コメントを追加」を押します。");
  await dock.locator(".comment-dock-header").getByRole("button", { name: "コメントを追加" }).click();
  await expect(dock).toBeVisible();
  await expect(dock.locator(".comment-compose-card.pending")).toHaveCount(0);
  await dock.getByRole("button", { name: "コメントを閉じる" }).click();

  const editorShape = page.locator('.overlay-canvas-editor [data-overlay-shape-id="comment_target_shape"]');
  await editorShape.click();
  await expect(page.locator('.overlay-shape.selected[data-overlay-shape-id="comment_target_shape"]')).toBeVisible();
  await expect(page.locator(".selection-action-popover")).not.toContainText("コメント");
  await page.getByRole("button", { name: "コメントを追加" }).click();

  await expect(commentToggle).toHaveAttribute("aria-expanded", "true");
  await expect(dock).toBeVisible();
  await expect(dock.locator(".comment-compose-card.pending")).toBeVisible();
  await dock.locator(".comment-rich-text-editor").fill("この図形を確認してください");
  await dock.getByRole("button", { name: "追加", exact: true }).click();

  await expect(dock.locator(".comment-thread-card")).toContainText("この図形を確認してください");
  await expect(dock.locator(".comment-anchor-label")).toContainText("図形");
  await expect(page.locator(".comment-dock-badge")).toHaveText("1");

  await expect.poll(async () => (await savedDocument(page))?.comments?.length).toBe(1);
  const created = (await savedDocument(page))!;
  const thread = created.comments![0];
  expect(thread.anchor).toMatchObject({ type: "overlayShape", shapeIds: ["comment_target_shape"] });
  expect(thread.messages).toHaveLength(1);
  expect(thread.messages[0].body).toEqual([{ type: "text", text: "この図形を確認してください" }]);
  const targetShape = created.pageLayout!.overlay!.overlaySnapshot!.shapes.find((shape) => shape.id === "comment_target_shape");
  expect(targetShape).toBeDefined();
  expect(await readbackDocument(page)).toEqual(created);

  // Return focus to the document before using its toolbar history commands.
  await editorShape.click();
  await page.getByRole("button", { name: "元に戻す", exact: true }).first().click();
  // Toolbar clicks close this popover; inspect the reopened panel after history changes.
  await expect(commentToggle).toHaveAttribute("aria-expanded", "false");
  await commentToggle.click();
  await expect(dock).toBeVisible();
  await expect(dock.locator(".comment-thread-card")).toHaveCount(0);
  await expect(page.locator(".comment-dock-badge")).toHaveCount(0);
  await expect.poll(async () => (await savedDocument(page))?.comments ?? []).toEqual([]);
  const undone = await readbackDocument(page);
  expect(undone?.comments ?? []).toEqual([]);
  expect(undone?.pageLayout?.overlay?.overlaySnapshot?.shapes.find((shape) => shape.id === "comment_target_shape")).toEqual(targetShape);

  await page.getByRole("button", { name: "やり直す", exact: true }).first().click();
  await expect(commentToggle).toHaveAttribute("aria-expanded", "false");
  await commentToggle.click();
  await expect(dock).toBeVisible();
  await expect(dock.locator(`.comment-thread-card[data-comment-card-key="${thread.id}"]`)).toContainText("この図形を確認してください");
  await expect(page.locator(".comment-dock-badge")).toHaveText("1");
  await expect.poll(async () => (await savedDocument(page))?.comments).toEqual([thread]);
  const saved = (await savedDocument(page))!;
  expect(await readbackDocument(page)).toEqual(saved);

  // This desktop mock resets on navigation. Seed a fresh renderer from the
  // actual saved/read-back document; this does not claim OS-file persistence.
  const restoredPage = await page.context().newPage();
  try {
    await restoredPage.setViewportSize({ width: 1500, height: 950 });
    await installDesktopRuntimeMock(restoredPage, saved);
    await restoredPage.goto("/");
    await expect(restoredPage.locator(".startup-splash")).toBeHidden();
    await expect(restoredPage.locator('.overlay-canvas-editor [data-overlay-shape-id="comment_target_shape"]')).toBeVisible();
    await restoredPage.locator(".comment-dock-toggle").click();
    const restoredCard = restoredPage.locator(`.comment-thread-card[data-comment-card-key="${thread.id}"]`);
    await expect(restoredCard).toContainText("この図形を確認してください");
    await expect(restoredCard.locator(".comment-anchor-label")).toContainText("図形");
    await restoredCard.locator(".comment-anchor-label").click();
    await expect(restoredPage.locator(`.overlay-comment-marker[data-comment-thread-id="${thread.id}"]`)).toBeVisible();
    const restored = await readbackDocument(restoredPage);
    expect(restored?.comments).toEqual([thread]);
    expect(restored?.pageLayout?.overlay?.overlaySnapshot?.shapes.find((shape) => shape.id === "comment_target_shape")).toEqual(targetShape);
  } finally {
    await restoredPage.close();
  }
});

async function savedDocument(page: Page): Promise<SigmaDocument | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    return raw ? JSON.parse(raw) as SigmaDocument : null;
  });
}

async function readbackDocument(page: Page): Promise<SigmaDocument | null> {
  return page.evaluate(async () => window.desktopAPI?.storage.loadDocument("file_e2e_document") ?? null);
}
