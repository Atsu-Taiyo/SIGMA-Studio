import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");

test("full-height sidebar and compact comment cards keep document and browser state", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-dock-comments-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const document: SigmaDocument = {
      version: "2.0", docId: "dock_comments", metadata: { title: "サイドバーとコメントの確認" },
      content: [{ type: "paragraph", id: "body", children: [{ type: "text", text: "コメント対象の本文" }] }],
      comments: [{
        id: "thread", anchor: { type: "block", blockId: "body", quote: "コメント対象の本文" }, createdAt: "2026-10-03T00:00:00Z",
        messages: ["田中", "佐藤"].map((authorName, i) => ({ id: `message_${i}`, authorName, createdAt: "2026-10-03T00:00:00Z", body: [{ type: "text", text: `${authorName}の確認` }] })),
      }],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    };
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const storage = window.desktopAPI!.storage;
      const { file } = await storage.createFileFromDocument({ document });
      await storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const rail = page.locator("[data-comment-rail]");
    await expect(rail.locator(".comment-thread-card")).toBeVisible();
    await expect(rail.locator('[data-participant-count="2"]')).toBeVisible();

    await page.getByRole("button", { name: "サイドバーを開く", exact: true }).click();
    const dock = page.locator("[data-right-dock]");
    await expect(dock).toBeVisible();
    await expect.poll(() => dock.evaluate(element => {
      const box = element.getBoundingClientRect();
      return Math.max(Math.abs(box.top), Math.abs(box.bottom - innerHeight));
    })).toBeLessThan(2);
    await dock.locator('[data-tool="files"]').click();
    await expect(dock).toContainText(document.metadata.title!);
    await dock.getByRole("button", { name: "新しいタブを開く", exact: true }).click();
    await dock.locator('[data-tool="browser"]').click();
    await expect(dock.locator('[role="tab"][data-kind="browser"]')).toHaveCount(1);
    await dock.getByRole("button", { name: "サイドバーを閉じる", exact: true }).click();
    await expect(dock).toBeHidden();
    const peek = page.locator("[data-right-dock-peek]");
    await expect(peek).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("wide-comments-and-browser.png") });
    await peek.locator('[data-kind="browser"]').click();
    await expect(dock).toHaveAttribute("data-page", "browser");
    await dock.getByRole("button", { name: "サイドバーを閉じる", exact: true }).click();

    await page.setViewportSize({ width: 900, height: 800 });
    await expect(rail).toHaveAttribute("data-compact", "true");
    await rail.getByRole("button", { name: /^コメントを開く:/ }).click();
    await expect(rail.locator(".comment-thread-card")).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("compact-expanded-comments.png") });
    await rail.getByRole("button", { name: "コメントをたたむ", exact: true }).click();
    await expect(rail.locator(".comment-thread-card")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
    expect(saved!.content).toEqual(document.content);
    expect(saved!.comments).toEqual(document.comments);
    await expect(page.locator("[data-right-dock-peek]")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
