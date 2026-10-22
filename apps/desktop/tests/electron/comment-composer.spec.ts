import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const TARGET = "練習として、定義域が a ≦ x ≦ a + 1 のときの最小値を a で場合分けして求めてみよう。";

type ComposerTest = { avatarRequests: string[]; aiRuns: Array<{ provider: string; instruction: string }>; avatarUrl: string };

/**
 * コメントの入力欄 (Figma・Claude と同じ形) を実機で通す。差し替えるのは main の外向きの口だけ —
 * アカウント (`collaboration:info`)、Claude の接続状態、AI の実行 (`ai-edit:run`)、アカウントの
 * アイコン画像 (`sigma-collaboration-profile:`)。入力欄・候補・保存・AI への配送は本物。
 */
test("comments: floating @ list, @claude in the text, Enter to send, and the account avatar", async () => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-comment-composer-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const avatarPng = await page.evaluate(() => {
      const canvas = window.document.createElement("canvas");
      canvas.width = canvas.height = 48;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#f4b183";
      context.fillRect(0, 0, 48, 48);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    // ウィンドウができたあと (本物の handler が登録済み) に差し替える。
    await app.evaluate(({ ipcMain, protocol }, avatarPng) => {
      const state: ComposerTest = { avatarRequests: [], aiRuns: [], avatarUrl: "https://lh3.googleusercontent.com/a/composer-test=s96-c" };
      (globalThis as unknown as { composerTest: ComposerTest }).composerTest = state;
      const replace = (channel: string, handler: (...args: unknown[]) => unknown) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (_event, ...args) => handler(...args));
      };
      replace("collaboration:info", () => ({
        configured: true,
        user: { actorId: "me", displayName: "Atsushi Kim", email: "me@example.test", avatarUrl: state.avatarUrl },
        sessions: [],
        restrictedFileIds: [],
      }));
      replace("claude:get-status", () => ({
        available: true, running: false, loggedIn: true, claudeBin: "claude", configuredClaudeBin: null,
        account: { apiKeySource: "none" }, error: null,
      }));
      replace("ai-edit:run", (_runId, payload) => {
        const { provider, instruction } = payload as { provider: string; instruction: string };
        state.aiRuns.push({ provider, instruction });
        return { draft: { summary: "途中式を足しました。", operations: [] } };
      });
      const bytes = Buffer.from(avatarPng, "base64");
      protocol.unhandle("sigma-collaboration-profile");
      protocol.handle("sigma-collaboration-profile", (request) => {
        state.avatarRequests.push(request.url);
        return request.url.includes("broken")
          ? new Response(null, { status: 404 })
          : new Response(bytes, { headers: { "Content-Type": "image/png" } });
      });
    }, avatarPng);
    const document: SigmaDocument = {
      version: "2.0", docId: "comment_composer", metadata: { title: "コメント入力の確認" },
      content: [
        { type: "paragraph", id: "p1", children: [{ type: "text", text: "関数 y = x^2 - 4x + 3 の最小値を求めよ。" }] },
        { type: "paragraph", id: "p2", children: [{ type: "text", text: TARGET }] },
      ],
      comments: [],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    };
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const storage = window.desktopAPI!.storage;
      const { file } = await storage.createFileFromDocument({ document });
      await storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const state = () => app.evaluate(() => (globalThis as unknown as { composerTest: ComposerTest }).composerTest);
    const imageLoaded = (locator: import("@playwright/test").Locator) => locator.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0);

    // 1. 本文を選ぶと、AI への依頼とコメントは書式と同じ帯に並ぶ (右下の別のチップに分けない)。
    const target = page.locator(".ProseMirror p", { hasText: "練習として" }).first();
    // カーソルを置いただけでは何も選んでいないので、帯もチップも出さない。
    await target.click();
    await page.waitForTimeout(400);
    await expect(page.locator(".selection-action-popover")).toHaveCount(0);
    await target.click({ clickCount: 3 });
    const band = page.locator(".selection-action-popover").filter({ has: page.getByRole("button", { name: "コメントを追加", exact: true }) });
    await expect(band).toHaveCount(1);
    await expect(band.getByRole("button", { name: "AIに追加" })).toBeVisible();
    await expect(band.getByRole("button", { name: "ポケットに追加" })).toBeVisible();
    await expect(page.locator(".selection-action-popover--trailing")).toHaveCount(0);
    // 帯の「コメント」から、ピンと入力欄だけの浮かぶ欄が、帯の下ではなく選んだ文のすぐ下に開く。
    // 書いている間は、選択の操作 (帯・チップ) を重ねない。「@」だけのボタンは無い。
    await band.getByRole("button", { name: "コメントを追加", exact: true }).click();
    const floating = page.locator("[data-floating-comment-composer]");
    await expect(floating).toBeVisible();
    expect((await floating.boundingBox())!.y).toBeGreaterThanOrEqual((await target.boundingBox())!.y + (await target.boundingBox())!.height);
    await expect(page.locator(".selection-action-popover")).toHaveCount(0);
    const input = floating.getByRole("textbox", { name: "コメントを追加" });
    await expect(input).toBeFocused();
    await expect(page.locator(".comment-mention-trigger")).toHaveCount(0);
    await expect(floating.getByRole("button", { name: "追加", exact: true })).toBeDisabled();
    // アカウントのアイコンは CSP に弾かれる Google の URL ではなく、main の経路から読む。
    const pinImage = floating.locator("img");
    await expect.poll(() => imageLoaded(pinImage)).toBe(true);
    expect(await pinImage.getAttribute("src")).toMatch(/^sigma-collaboration-profile:\/\/avatar\?url=/);

    // 2. 「@」の候補は入力欄に差し込まず、キャレットの下に浮かべる。共有していない教材では AI だけ。
    await input.pressSequentially("確認 @cl");
    const menu = page.locator("[data-comment-popover]");
    await expect(menu.getByRole("option", { name: /^Claude/ })).toBeVisible();
    await expect(floating.locator("[data-comment-popover]")).toHaveCount(0);
    await expect(menu.getByRole("group", { name: "メンバー" })).toHaveCount(0);
    const menuBox = (await menu.boundingBox())!;
    const inputBox = (await input.boundingBox())!;
    expect(menuBox.y).toBeGreaterThanOrEqual(inputBox.y + 10);
    await input.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(input).toContainText("@claude");
    await expect(floating).toBeVisible();

    // 3. 「Claude に送信」の切り替えは置かない。AI の宛先は本文の @claude だけで、消せば宛てない。
    await expect(page.getByRole("checkbox", { name: "Claude に送信" })).toHaveCount(0);
    for (let index = 0; index < "@claude ".length; index += 1) await input.press("Backspace");
    await expect(menu).toHaveCount(0);
    await expect(input).not.toContainText("@claude");
    await expect(input).toBeFocused();

    // 4. 変換を確定する Enter では送らない。確定してから Enter で送る。Shift+Enter は改行。
    await input.press("End");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "かくにん", selectionStart: 4, selectionEnd: 4 });
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await cdp.send("Input.insertText", { text: "かくにん" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await expect(floating).toBeVisible();
    await expect(input).toContainText("かくにん");
    await input.press("Shift+Enter");
    await input.pressSequentially("2行目");
    await input.press("Enter");
    await expect(floating).toHaveCount(0);

    const rail = page.locator("[data-comment-rail]");
    const card = rail.locator(".comment-thread-card", { hasText: "2行目" });
    await expect(card).toBeVisible();
    await expect(card.locator(".comment-thread-card-header .comment-time")).toHaveText("今");
    await expect.poll(() => imageLoaded(card.locator(".comment-thread-card-header .comment-author-line img"))).toBe(true);
    await expect.poll(async () => (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))?.comments?.length).toBe(1);
    const saved = (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!;
    const text = saved.comments![0].messages[0].body.map((node) => node.type === "text" ? node.text : "").join("");
    expect(text).toBe("確認 かくにん\n2行目");
    expect(saved.comments![0].messages[0].authorName).toBe("Atsushi Kim");
    expect((await state()).aiRuns).toEqual([]);

    // 5. 返信の本文に @claude と書いて送ると、Claude が動く。
    await card.locator(".comment-reply-summary").click();
    const reply = card.getByRole("textbox", { name: "返信" });
    await reply.click();
    await reply.pressSequentially("@claude 途中式を足して");
    await expect(menu).toHaveCount(0);
    await expect(reply).toContainText("@claude");
    await reply.press("Enter");
    await expect.poll(async () => (await state()).aiRuns.length).toBe(1);
    const [run] = (await state()).aiRuns;
    expect(run.provider).toBe("claude");
    expect(run.instruction).toContain("途中式を足して");
    expect(run.instruction).not.toContain("@claude");
    await expect(card.locator(".comment-message .comment-mention.is-agent")).toHaveText("@claude");
    // Enter で送っても焦点は欄に残る。送った文を欄に残さない。
    await expect(reply).toHaveText("");
    await expect(card).toContainText("途中式を足しました。");

    // 返信と AI の返事がファイルへ書かれてから読み直す。
    const authors = async () => (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))?.comments?.[0].messages.map((message) => message.authorName);
    await expect.poll(authors, { timeout: 20_000 }).toEqual(["Atsushi Kim", "Atsushi Kim", "Claude"]);

    // 6. アイコンが読めないときは、灰色の丸ではなく頭文字に戻す。
    await app.evaluate(() => {
      (globalThis as unknown as { composerTest: ComposerTest }).composerTest.avatarUrl = "https://lh3.googleusercontent.com/a/broken=s96-c";
    });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const restored = page.locator("[data-comment-rail] .comment-thread-card", { hasText: "2行目" });
    await expect(restored.locator(".comment-thread-card-header .comment-author-line .comment-author-avatar")).toHaveText("AK");
    await expect(restored.locator(".comment-thread-card-header .comment-author-line img")).toHaveCount(0);
    expect((await state()).avatarRequests.some((url) => url.includes("broken"))).toBe(true);
    await expect(restored.locator(".comment-reply-summary")).toContainText("2件の返信");
    const reloaded = (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!;
    const replyText = reloaded.comments![0].messages[1].body.map((node) => node.type === "text" ? node.text : "").join("");
    expect(replyText).toBe("@claude 途中式を足して");
    await page.screenshot({ path: test.info().outputPath("comment-composer.png") });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
