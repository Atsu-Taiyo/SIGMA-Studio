import { expect, test } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { DesktopAiEditChatRoom, DesktopAiResourceManifestEntry, DesktopAiResourceTree } from "@/types/desktop";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.describe("design system dialogs", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await installDesktopRuntimeMock(page, sampleDocument, { ai: { enabled: true } });
    await page.goto("/");
    await expect(page.locator(".startup-splash")).toBeHidden();
  });

  test("command settings uses one circular close affordance and preserves Escape while recording", async ({ page }) => {
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("menuitem", { name: "ショートカット設定" }).click();

    const dialog = page.getByRole("dialog", { name: "ショートカット設定" });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.parentElement?.parentElement === document.body)).toBe(true);
    expect(await page.locator(".app-shell").evaluate((element) => element.closest("[inert]") !== null)).toBe(true);
    await expect(dialog.getByRole("textbox", { name: "コマンドを検索" })).toBeFocused();
    const closeButton = dialog.getByRole("button", { name: "閉じる", exact: true });
    await expect(closeButton).toHaveCount(1);
    const closeButtonShape = await closeButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        radius: Number.parseFloat(style.borderTopLeftRadius),
      };
    });
    expect(closeButtonShape.width).toBeCloseTo(closeButtonShape.height, 1);
    expect(closeButtonShape.radius).toBeGreaterThanOrEqual(closeButtonShape.height / 2);

    const customToggle = dialog.getByRole("button", { name: "カスタムコマンド" });
    await expect(customToggle).toHaveAttribute("aria-expanded", "false");
    await customToggle.click();
    await expect(customToggle).toHaveAttribute("aria-expanded", "true");

    await dialog.getByRole("button", { name: /キー割り当てを変更/ }).first().click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("変更をキャンセルしました")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(await page.locator(".app-shell").evaluate((element) => element.closest("[inert]") !== null)).toBe(false);
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  });

  test("TeX command reference shows rendered cards, copies commands, and filters inside the dialog", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("menuitem", { name: "数式コマンド確認" }).click();

    const dialog = page.getByRole("dialog", { name: "数式コマンド確認" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toHaveCount(0);
    const searchInput = dialog.getByRole("searchbox", { name: "TeXコマンドを検索" });
    await expect(searchInput).toBeFocused();
    const cards = dialog.getByRole("listitem");
    await expect(cards).not.toHaveCount(0);
    await expect(dialog.getByText("基本", { exact: true })).toHaveCount(0);
    await expect(cards.first().locator(".math-preview")).toBeVisible();
    const cardColors = await cards.first().evaluate((card) => {
      const preview = card.querySelector<HTMLElement>('[role="img"]');
      return {
        card: getComputedStyle(card).backgroundColor,
        preview: preview ? getComputedStyle(preview).backgroundColor : null,
      };
    });
    expect(cardColors.card).toBe("rgb(255, 255, 255)");
    expect(cardColors.preview).toBe("rgba(0, 0, 0, 0)");

    await searchInput.fill("frac");
    expect(await cards.count()).toBeGreaterThanOrEqual(3);
    await expect(dialog.getByText(String.raw`\frac{a}{b}`, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("img", { name: "分数の表示結果", exact: true })).toBeVisible();

    await searchInput.fill("￥ga");
    await expect(dialog.getByText("ガンマ", { exact: true })).toBeVisible();
    await expect(dialog.getByText(String.raw`\gamma`, { exact: true })).toBeVisible();

    await searchInput.fill(String.raw`\text`);
    await expect(dialog.getByText(String.raw`\text{条件}`, { exact: true })).toBeVisible();

    await searchInput.fill(String.raw`\begin`);
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(15);
    await expect(dialog.getByText(String.raw`\begin{aligned}x+y&=3\\x-y&=1\end{aligned}`, { exact: true })).toBeVisible();

    await searchInput.fill("幾何");
    await expect(dialog.getByText("角", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "角をコピー", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "角をコピーしました", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(String.raw`\angle ABC`);

    await searchInput.fill("該当なし");
    await expect(cards).toHaveCount(0);
    await expect(dialog.getByText("該当するコマンドがありません")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("app settings uses the shared header and closes with Escape", async ({ page }) => {
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("menuitem", { name: "アプリ設定" }).click();

    const dialog = page.getByRole("dialog", { name: "設定" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toHaveCount(1);
    await expect(dialog.getByRole("heading", { name: "フォント" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "アプリ" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("AI history keeps search beside close and renders dense provider-title rows", async ({ page }) => {
    const now = "2026-07-16T00:00:00.000Z";
    const rooms: DesktopAiEditChatRoom[] = [
      { version: 1, id: "room-chatgpt", documentIdentityKey: "file_e2e_document", title: "一次関数を整理", provider: "chatgpt", agentThreadId: null, createdAt: now, updatedAt: now, turns: [] },
      { version: 1, id: "room-claude", documentIdentityKey: "file_e2e_document", title: "Claudeで例題を追加", provider: "claude", agentThreadId: null, createdAt: now, updatedAt: now, turns: [] },
      { version: 1, id: "room-antigravity", documentIdentityKey: "file_e2e_document", title: "図形を整える", provider: "antigravity", agentThreadId: null, createdAt: now, updatedAt: now, turns: [] },
    ];
    await page.addInitScript(({ seededRooms }) => {
      const aiEdit = window.desktopAPI?.aiEdit;
      if (!aiEdit) {
        return;
      }
      aiEdit.listChatRooms = async (documentIdentityKey?: string) => structuredClone(
        documentIdentityKey
          ? seededRooms.filter((room) => room.documentIdentityKey === documentIdentityKey)
          : seededRooms,
      );
    }, { seededRooms: rooms });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();

    await page.getByRole("button", { name: "AI", exact: true }).click();
    await page.getByRole("menuitem", { name: "AIチャットを開く" }).click();
    const sidebar = page.locator(".ai-sidebar-panel");
    await sidebar.getByRole("button", { name: /履歴を表示/ }).click();

    const dialog = page.getByRole("dialog", { name: "AI会話履歴" });
    await expect(dialog).toBeVisible();
    const searchButton = dialog.getByRole("button", { name: "履歴を検索" });
    const closeButton = dialog.getByRole("button", { name: "閉じる", exact: true });
    const [searchBox, closeBox] = await Promise.all([searchButton.boundingBox(), closeButton.boundingBox()]);
    expect(searchBox).not.toBeNull();
    expect(closeBox).not.toBeNull();
    expect(searchBox!.x).toBeLessThan(closeBox!.x);

    const rows = dialog.locator(".ai-chat-room-dialog-item");
    await expect(rows).toHaveCount(3);
    await expect(dialog.locator('.ai-chat-room-dialog-item[data-provider="chatgpt"]')).toHaveCount(1);
    await expect(dialog.locator('.ai-chat-room-dialog-item[data-provider="claude"]')).toHaveCount(1);
    await expect(dialog.locator('.ai-chat-room-dialog-item[data-provider="antigravity"]')).toHaveCount(1);
    await expect(dialog.locator(".ai-chat-room-dialog-preview, .ai-chat-room-dialog-time")).toHaveCount(0);

    await searchButton.click();
    const searchInput = dialog.getByRole("textbox", { name: "履歴を検索" });
    await expect(searchInput).toBeFocused();
    await searchInput.fill("Claude");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("Claudeで例題を追加");
  });

  test("AI settings shows a skeleton, keyboard tabs, and one active nested modal", async ({ page }) => {
    await page.addInitScript(() => {
      const bridge = window.desktopAPI;
      if (!bridge) {
        return;
      }
      const instruction: DesktopAiResourceManifestEntry = {
        id: "instruction_global",
        kind: "instruction",
        title: "AIへの指示",
        sourcePath: "/tmp/AGENTS.md",
        enabled: true,
        providers: ["codex", "claude", "antigravity"],
        loadMode: "always",
        description: "E2E instruction",
        tags: [],
        workspaceId: null,
        updatedAt: "2026-07-15T00:00:00.000Z",
      };
      const tree: DesktopAiResourceTree = {
        sourceRoot: "/tmp/ai",
        codexRuntimeRoot: "/tmp/codex",
        claudeRuntimeRoot: "/tmp/claude",
        geminiRuntimeRoot: "/tmp/gemini",
        resources: [instruction],
      };
      const file = { resource: instruction, content: "教材編集の意図を保つ。" };
      bridge.aiResources = {
        getTree: async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 300));
          return structuredClone(tree);
        },
        readFile: async () => structuredClone(file),
        saveFile: async () => structuredClone(file),
        saveInstruction: async () => structuredClone(file),
        createSkill: async () => structuredClone(file),
        deleteResource: async () => ({ ok: true }),
        setResourceEnabled: async (_resourceId, enabled) => ({ ...instruction, enabled }),
        onChanged: () => () => undefined,
      };
    });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();

    await page.getByRole("button", { name: "AI", exact: true }).click();
    await page.getByRole("menuitem", { name: "AI設定" }).click();

    const dialog = page.locator('[role="dialog"][aria-label="AI設定"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("status", { name: "AI設定を読み込み中" })).toBeVisible();
    await expect(dialog.getByRole("status", { name: "AI設定を読み込み中" })).toBeHidden();

    const chatGptTab = dialog.getByRole("tab", { name: "ChatGPT" });
    const claudeTab = dialog.getByRole("tab", { name: "Claude" });
    await chatGptTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(claudeTab).toHaveAttribute("aria-selected", "true");
    await expect(claudeTab).toBeFocused();

    const workspaceTrigger = dialog.locator('button[aria-label="対象ワークスペース"]');
    await workspaceTrigger.click();
    const workspaceDialog = page.getByRole("dialog", { name: "ワークスペースを選択" });
    await expect(workspaceDialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "false");
    await expect(dialog.locator("..")).toHaveAttribute("inert", "");
    await expect(dialog.locator("..")).toHaveAttribute("aria-hidden", "true");

    // Nested actions can remove their opener (for example after deleting a resource).
    // Focus must then fall back into the still-open parent modal rather than the page.
    await workspaceTrigger.evaluate((element) => element.remove());

    await page.keyboard.press("Escape");
    await expect(workspaceDialog).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.locator("..")).not.toHaveAttribute("inert", "");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    expect(await page.locator(".app-shell").evaluate((element) => element.closest("[inert]") !== null)).toBe(true);
  });
});
