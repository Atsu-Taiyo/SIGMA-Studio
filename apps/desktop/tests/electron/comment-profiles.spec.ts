import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import type { SessionInfo } from "@/features/collaboration/model/bridge";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const ME = "11111111-1111-4111-8111-111111111111";
const HANAKO = "22222222-2222-4222-8222-222222222222";

type ProfileTest = {
  me: { displayName?: string; avatarVersion: number };
  names: (string | null)[];
  avatars: { type: string; base64: string }[];
  updates: string[];
};

/**
 * 名前とアイコンを変える画面から、コメントの差出人・宛先の候補・ヘッダーまでを実機で通す。差し替えるのは
 * main の共同編集の口 (アカウント・メンバー・プロフィール) とアイコン画像の口だけで、画面・preload・
 * 画像の縮小・コメントの保存 (共有文書の CRDT) は本物。共有サーバー側 (保存・画像・公開範囲) は
 * 非公開リポの `apps/collaboration/test/profiles.test.ts` が、main の取り回しは `profiles.test.ts` が持つ。
 */
test("profile name and picture changes reach the header, comment authors and mention candidates", async () => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-comment-profiles-"));
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
    const at = new Date(Date.now() - 3 * 60_000).toISOString();
    const document: SigmaDocument = {
      version: "2.0", docId: "comment_profiles", metadata: { title: "名前とアイコンの確認" },
      content: [{ id: "p1", type: "paragraph", children: [{ type: "text", text: "名前とアイコンを変えたら、コメントにも出る。" }] }],
      comments: [{
        id: "thread", anchor: { type: "block", blockId: "p1" }, createdAt: at,
        messages: [
          { id: "m_hanako", authorId: HANAKO, authorName: "佐藤 花子", createdAt: at, body: [{ type: "text", text: "見出しを短くしませんか？" }] },
          { id: "m_me", authorId: ME, authorName: "Atsushi Kim", createdAt: at, body: [{ type: "text", text: "そうします。" }] },
        ],
      }],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    };
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, document);
    const pictures = await page.evaluate(() => Object.fromEntries(["#2563eb", "#f97316", "#9ca3af"].map((color) => {
      const canvas = window.document.createElement("canvas");
      canvas.width = canvas.height = 48;
      const context = canvas.getContext("2d")!;
      context.fillStyle = color;
      context.fillRect(0, 0, 48, 48);
      return [color, canvas.toDataURL("image/png").split(",")[1]];
    })));
    const shared = new SharedDocument();
    shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared-profiles", epoch: 1 });
    const session: SessionInfo = { binding: { localFileId: fileId, docId: document.docId, sharedDocumentId: "shared-profiles", epoch: 1, protocol: 1 }, state: toBase64(shared.snapshot()), actorId: ME, role: "owner", status: "saved", assets: {} };
    await app.evaluate(({ ipcMain, protocol }, { session, pictures, ME, HANAKO }) => {
      const state: ProfileTest = { me: { avatarVersion: 0 }, names: [], avatars: [], updates: [] };
      (globalThis as unknown as { profileTest: ProfileTest }).profileTest = state;
      const replace = (name: string, handler: (...args: unknown[]) => unknown) => {
        ipcMain.removeHandler(`collaboration:${name}`);
        ipcMain.handle(`collaboration:${name}`, (_event, ...args) => handler(...args));
      };
      const mine = () => ({
        userId: ME, providerDisplayName: "Atsushi Kim", providerAvatarUrl: "https://lh3.googleusercontent.com/a/me=s96-c",
        avatarVersion: state.me.avatarVersion, ...(state.me.displayName ? { displayName: state.me.displayName } : {}),
      });
      replace("info", () => ({
        configured: true,
        user: {
          actorId: ME, email: "me@example.test", displayName: state.me.displayName ?? "Atsushi Kim",
          avatarUrl: "https://lh3.googleusercontent.com/a/me=s96-c",
          ...(state.me.avatarVersion > 0 ? { avatarVersion: state.me.avatarVersion } : {}),
        },
        sessions: [session], restrictedFileIds: [],
      }));
      replace("members", () => [
        { user_id: ME, role: "owner", email: "me@example.test" },
        { user_id: HANAKO, role: "editor", email: "hanako@example.test" },
      ]);
      replace("profile", () => mine());
      replace("profiles", (ids) => (ids as string[]).flatMap((id): Record<string, unknown>[] => id === HANAKO
        ? [{ userId: HANAKO, displayName: "花子 (名前を変えた)", providerDisplayName: "佐藤 花子", avatarVersion: 5 }]
        : id === ME ? [mine()] : []));
      replace("update-profile", (input) => {
        const name = (input as { displayName: string | null }).displayName;
        state.names.push(name);
        state.me.displayName = name ?? undefined;
        return mine();
      });
      replace("set-avatar", (bytes, type) => {
        state.avatars.push({ type: String(type), base64: Buffer.from(bytes as Uint8Array).toString("base64") });
        state.me.avatarVersion += 1;
        return mine();
      });
      replace("clear-avatar", () => { state.me.avatarVersion = 0; return mine(); });
      replace("update", (_fileId, update) => { state.updates.push(String(update)); });
      for (const name of ["view", "visible-files", "presence", "flush"]) replace(name, () => undefined);
      const png = (color: string) => Buffer.from(pictures[color], "base64");
      protocol.unhandle("sigma-collaboration-profile");
      protocol.handle("sigma-collaboration-profile", (request) => {
        const url = new URL(request.url);
        const color = url.searchParams.get("user") === HANAKO ? "#f97316" : url.searchParams.get("user") === ME ? "#2563eb" : "#9ca3af";
        return new Response(png(color), { headers: { "Content-Type": "image/png" } });
      });
    }, { session, pictures, ME, HANAKO });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const state = () => app.evaluate(() => (globalThis as unknown as { profileTest: ProfileTest }).profileTest);
    const rail = page.locator("[data-comment-rail]");
    const card = rail.locator(".comment-thread-card").first();

    // 1. 相手は今の名前とアイコンで出る (コメントに残っているのは変える前の名前)。
    await expect(card.locator(".comment-thread-card-header .comment-author-line")).toContainText("花子 (名前を変えた)");
    await expect(card.locator(".comment-thread-card-header .comment-author-line img")).toHaveAttribute("src", `sigma-collaboration-profile://avatar?user=${HANAKO}&v=5`);

    // 2. 自分の名前とアイコンを変える。
    await page.getByRole("button", { name: "Atsushi Kim のアカウント" }).click();
    await page.getByRole("button", { name: "名前とアイコンを変更" }).click();
    const dialog = page.getByRole("dialog", { name: "名前とアイコン" });
    await expect(dialog).toBeVisible();
    const nameInput = dialog.getByLabel("表示名");
    await expect(nameInput).toHaveAttribute("placeholder", "Atsushi Kim");
    await nameInput.fill("木村 篤");
    const photo = await page.evaluate(async () => {
      // 横長の写真 (切り抜く範囲は動かさず、真ん中の正方形のまま適用する)。
      const canvas = window.document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 600;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#16a34a";
      context.fillRect(0, 0, 900, 600);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await dialog.locator('input[type="file"]').setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from(photo, "base64") });
    await page.getByRole("dialog", { name: "アイコンの範囲" }).getByRole("button", { name: "適用", exact: true }).click();
    await expect(dialog.getByTestId("profile-avatar-preview").locator("img")).toHaveAttribute("src", /^blob:/);
    await dialog.screenshot({ path: test.info().outputPath("profile-dialog.png") });
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    const saved = await state();
    expect(saved.names).toEqual(["木村 篤"]);
    expect(saved.avatars.map((avatar) => avatar.type)).toEqual(["image/webp"]);
    // 横長の写真を、真ん中で正方形に切り抜いて 256px 四方に縮めて送る。
    expect(await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/webp" }));
      return { width: bitmap.width, height: bitmap.height, bytes: bytes.byteLength };
    }, saved.avatars[0].base64)).toMatchObject({ width: 256, height: 256, bytes: expect.any(Number) });

    // 3. ヘッダーと、自分が書いたコメントに新しい名前とアイコンが出る。
    await expect(page.getByRole("button", { name: "木村 篤 のアカウント" })).toBeVisible();
    await card.locator(".comment-reply-summary").click();
    const myReply = card.locator(".comment-message.reply").filter({ hasText: "そうします。" });
    await expect(myReply.locator(".comment-author-line")).toContainText("木村 篤");
    await expect(myReply.locator(".comment-author-line img")).toHaveAttribute("src", `sigma-collaboration-profile://avatar?user=${ME}&v=1`);
    await expect.poll(() => myReply.locator(".comment-author-line img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);

    // 4. 宛先の候補も、相手の今の名前とアイコンで出る。
    const reply = card.getByRole("textbox", { name: "返信" });
    await reply.click();
    await reply.pressSequentially("@花");
    const option = page.locator("[data-comment-popover]").getByRole("option", { name: /花子 \(名前を変えた\)/ });
    await expect(option).toBeVisible();
    await expect(option.locator("img")).toHaveAttribute("src", `sigma-collaboration-profile://avatar?user=${HANAKO}&v=5`);
    await reply.press("Enter");
    await reply.pressSequentially("確認しました");
    await reply.press("Enter");

    // 5. 書いたコメントには、名前と一緒に共有アカウントの ID が残る (名前を変えても引き直せる)。
    await expect.poll(async () => (await state()).updates.length).toBeGreaterThan(0);
    for (const update of (await state()).updates) shared.applyUpdate(fromBase64(update));
    const posted = (shared.project() as unknown as SigmaDocument).comments![0].messages.at(-1)!;
    expect(posted).toMatchObject({ authorId: ME, authorName: "木村 篤" });
    expect(posted.body.find((node) => node.type === "text" && node.mentionUserId)).toMatchObject({ mentionUserId: HANAKO, text: "@花子 (名前を変えた)" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: test.info().outputPath("comment-profiles.png"), animations: "disabled" });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
