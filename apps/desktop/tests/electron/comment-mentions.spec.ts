import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";
import { getDefaultPageLayout } from "@/lib/page-layout";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { toBase64, fromBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import type { SessionInfo } from "@/features/collaboration/model/bridge";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");

test("desktop comments select collaborators and retain recipients after shared reload", async ({}, testInfo) => {
  test.setTimeout(180_000);
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-comment-mentions-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    if (env.SIGMA_STUDIO_DEV_SERVER_URL) expect(new URL(page.url()).origin).toBe(new URL(env.SIGMA_STUDIO_DEV_SERVER_URL).origin);
    const document = createBlankDocument("共同編集コメント確認");
    document.pageLayout = getDefaultPageLayout("whiteboard");
    document.content = [];
    document.comments = [{
      id: "thread", anchor: { type: "canvasRegion", bounds: { x: 100, y: 100, w: 200, h: 100 } }, createdAt: "2026-09-24T00:00:00Z",
      messages: [{ id: "first", authorName: "Collaborator", createdAt: "2026-09-24T00:00:00Z", body: [{ type: "text", text: "確認してください" }] }],
    }];
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const storage = window.desktopAPI!.storage;
      const created = await storage.createFileFromDocument({ document });
      await storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, document);
    const shared = new SharedDocument();
    shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared-mentions", epoch: 1 });
    const session: SessionInfo = { binding: { localFileId: fileId, docId: document.docId, sharedDocumentId: "shared-mentions", epoch: 1, protocol: 1 }, state: toBase64(shared.snapshot()), actorId: "author", role: "owner", status: "saved", assets: {} };
    // Stub the service at the main-process IPC boundary. Renderer, preload,
    // comment UI and shared-document CRDT are the actual desktop implementations.
    await app.evaluate(({ ipcMain }, session) => {
      const state = { session, updates: [] as string[], userId: "author", memberFiles: [] as string[] };
      (globalThis as unknown as { mentionTest: typeof state }).mentionTest = state;
      const replace = (name: string, handler: (...args: unknown[]) => unknown) => { ipcMain.removeHandler(`collaboration:${name}`); ipcMain.handle(`collaboration:${name}`, (_event, ...args) => handler(...args)); };
      replace("info", () => ({ configured: true, user: { actorId: state.userId, displayName: "投稿者" }, sessions: [state.session], restrictedFileIds: [] }));
      replace("members", (fileId) => { state.memberFiles.push(String(fileId)); return [{ user_id: "author", role: "owner", email: "self@example.test" }, { user_id: "recipient", role: "editor", email: "collaborator@example.test" }]; });
      replace("update", (_fileId, update) => { state.updates.push(String(update)); });
      for (const name of ["view", "visible-files", "presence", "flush"]) replace(name, () => undefined);
    }, session);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await page.locator(".comment-dock-toggle").click();
    const dock = page.locator(".comment-dock");
    await dock.getByRole("button", { name: "返信する", exact: true }).click();
    const input = dock.locator(".comment-reply-composer .comment-rich-text-editor");
    await input.fill("@coll");
    await expect(dock.getByRole("option", { name: "collaborator@example.test", exact: true })).toBeVisible();
    await expect(dock.getByRole("option", { name: "self@example.test", exact: true })).toHaveCount(0);
    await input.press("Enter");
    await expect(input.locator('[data-comment-mention="recipient"]')).toHaveText("@collaborator@example.test");
    await input.pressSequentially(" 確認をお願いします");
    await dock.getByRole("button", { name: "返信", exact: true }).click();
    await expect(dock.locator('.rich-inline-content [data-comment-mention="recipient"]')).toHaveText("@collaborator@example.test");
    await expect.poll(async () => app.evaluate(() => (globalThis as unknown as { mentionTest: { updates: string[] } }).mentionTest.updates.length)).toBeGreaterThan(0);
    const updates = await app.evaluate(() => (globalThis as unknown as { mentionTest: { updates: string[] } }).mentionTest.updates);
    updates.forEach((update) => shared.applyUpdate(fromBase64(update)));
    const saved = shared.project() as unknown as SigmaDocument;
    expect(saved.comments?.[0].messages[1].body.some((node) => node.type === "text" && node.mentionUserId === "recipient")).toBe(true);
    expect(saved.comments?.[0].messages[1].authorName).toBe("投稿者");
    await app.evaluate((_electron, state) => {
      const test = (globalThis as unknown as { mentionTest: { session: SessionInfo; userId: string } }).mentionTest;
      test.session.state = state;
      test.userId = "recipient";
      test.session.actorId = "recipient";
    }, toBase64(shared.snapshot()));
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator(".comment-dock-mention-badge")).toHaveText("@1");
    await page.locator(".comment-dock-toggle").click();
    await dock.locator(".comment-reply-summary").click();
    await expect(dock.locator('.comment-mention.is-self')).toHaveText("@collaborator@example.test");
    await page.screenshot({ path: testInfo.outputPath("comment-mention-desktop.png") });
    const memberFiles = await app.evaluate(() => (globalThis as unknown as { mentionTest: { memberFiles: string[] } }).mentionTest.memberFiles);
    expect(memberFiles).toEqual([fileId]);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
