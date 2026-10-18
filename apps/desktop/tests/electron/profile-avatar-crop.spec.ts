import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import type { SessionInfo } from "@/features/collaboration/model/bridge";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const ME = "11111111-1111-4111-8111-111111111111";
const GOOGLE_AVATAR = "https://lh3.googleusercontent.com/a/me=s96-c";
const SHOTS = process.env.SIGMA_STUDIO_E2E_SHOT_DIR;

/** 共有サーバーの代わり。main のプロセスに置き、再起動のときはテストから中身を渡し直す。 */
type FakeProfileServer = {
  avatarVersion: number;
  lastVersion: number;
  /** 版ごとに保存した画像 (送られたまま)。 */
  avatars: Record<string, { type: string; base64: string }>;
  setCalls: number;
  clearCalls: number;
};

type Rgb = [number, number, number];
const RED: Rgb = [220, 38, 38];
const GREEN: Rgb = [22, 163, 74];
const BLUE: Rgb = [37, 99, 235];

/**
 * アイコンの範囲を選ぶ画面を実機で通す。縦長・横長の写真で見せたい部分を選んで保存し、ヘッダーと
 * コメントの差出人に、選んだ範囲 (真ん中ではない) が出ることを画素で確かめる。キャンセルでは何も変わらず、
 * 「Google のアイコンに戻す」とも併用でき、アプリを起動し直しても同じアイコンが出る。
 * 差し替えるのは main の共同編集の口 (アカウント・プロフィール・アイコン画像) だけで、画面・preload・
 * 画像の切り抜きと縮小は本物。共有サーバーでの保存は非公開リポの試験が持つ。
 */
test("the picture crop picks the part of tall and wide photos, cancels cleanly and survives a restart", async () => {
  test.setTimeout(240_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-avatar-crop-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const document: SigmaDocument = {
    version: "2.0", docId: "avatar_crop", metadata: { title: "アイコンの範囲の確認" },
    content: [{ id: "p1", type: "paragraph", children: [{ type: "text", text: "アイコンの見せたい部分を選ぶ。" }] }],
    comments: [{
      id: "thread", anchor: { type: "block", blockId: "p1" }, createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      messages: [{ id: "m_me", authorId: ME, authorName: "Atsushi Kim", createdAt: new Date(Date.now() - 3 * 60_000).toISOString(), body: [{ type: "text", text: "顔が見えるようにしました。" }] }],
    }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };

  let app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  let server: FakeProfileServer = { avatarVersion: 0, lastVersion: 0, avatars: {}, setCalls: 0, clearCalls: 0 };
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, document);
    const shared = new SharedDocument();
    shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared-avatar-crop", epoch: 1 });
    const session: SessionInfo = { binding: { localFileId: fileId, docId: document.docId, sharedDocumentId: "shared-avatar-crop", epoch: 1, protocol: 1 }, state: toBase64(shared.snapshot()), actorId: ME, role: "owner", status: "saved", assets: {} };
    await installFakeServer(app, session, server);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const readServer = () => app.evaluate(() => (globalThis as unknown as { fakeProfileServer: FakeProfileServer }).fakeProfileServer);
    const account = page.getByRole("button", { name: "Atsushi Kim のアカウント" });
    const commentAvatar = page.locator("[data-comment-rail] .comment-thread-card").first().locator(".comment-thread-card-header .comment-author-line img");
    await expect(account.locator("img")).toHaveAttribute("src", `sigma-collaboration-profile://avatar?url=${encodeURIComponent(GOOGLE_AVATAR)}`);

    const openProfile = async () => {
      await account.click();
      await page.getByRole("button", { name: "名前とアイコンを変更" }).click();
      const dialog = page.getByRole("dialog", { name: "名前とアイコン" });
      await expect(dialog).toBeVisible();
      return dialog;
    };
    const cropDialog = page.getByRole("dialog", { name: "アイコンの範囲" });
    const stage = cropDialog.getByTestId("avatar-crop-stage");
    const choose = async (dialog: Locator, name: string, photo: string) => {
      await dialog.locator('input[type="file"]').setInputFiles({ name, mimeType: "image/png", buffer: Buffer.from(photo, "base64") });
      await expect(cropDialog).toBeVisible();
      await expect.poll(() => stage.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    };
    /** 画像を枠の一辺の `fx`・`fy` 倍だけドラッグする。 */
    const dragPicture = async (fx: number, fy: number) => {
      const frame = (await cropDialog.getByTestId("avatar-crop-frame").boundingBox())!;
      const x = frame.x + frame.width / 2;
      const y = frame.y + frame.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let step = 1; step <= 8; step += 1) await page.mouse.move(x + (fx * frame.width * step) / 8, y + (fy * frame.height * step) / 8);
      await page.mouse.up();
    };

    // 縦長は上が赤 (顔)・下が緑、横長は左が緑・右が青。真ん中の正方形のままだと、どちらも真ん中は緑になる。
    const tall = await photoPng(page, 600, 900, (y) => (y < 360 ? RED : GREEN), "vertical");
    const wide = await photoPng(page, 900, 600, (x) => (x < 540 ? GREEN : BLUE), "horizontal");

    // 1. 選んでからキャンセルすると、今のアイコン (Google) のまま、何も送らない。
    let dialog = await openProfile();
    await choose(dialog, "tall.png", tall);
    await expect(cropDialog.getByRole("button", { name: "縮小" })).toBeDisabled();
    await cropDialog.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(cropDialog).toBeHidden();
    await expect(dialog.getByTestId("profile-avatar-preview").locator("img")).toHaveAttribute("src", `sigma-collaboration-profile://avatar?url=${encodeURIComponent(GOOGLE_AVATAR)}`);
    await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    // Esc でも同じ (名前とアイコンのダイアログは閉じない)。
    await choose(dialog, "tall.png", tall);
    await page.keyboard.press("Escape");
    await expect(cropDialog).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();

    // 2. 縦長の写真の上 (顔) を選び、少し拡大して保存する。
    await choose(dialog, "tall.png", tall);
    await dragPicture(0, 0.6); // 画像を下へ動かすと、上が枠に入る (上端で止まる)。
    await stage.press("+"); // キーボードでも拡大できる。
    await expect(cropDialog.getByRole("slider", { name: "拡大率" })).toHaveAttribute("aria-valuetext", "125%");
    await expect(cropDialog.getByRole("button", { name: "縮小" })).toBeEnabled();
    await shot(cropDialog, "crop-tall.png");
    await cropDialog.getByRole("button", { name: "適用", exact: true }).click();
    await expect(cropDialog).toBeHidden();
    const preview = dialog.getByTestId("profile-avatar-preview").locator("img");
    await expect(preview).toHaveAttribute("src", /^blob:/);
    await expect(dialog.getByRole("button", { name: "範囲を調整" })).toBeVisible();
    await shot(dialog, "profile-after-crop.png");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    server = await readServer();
    expect(server).toMatchObject({ avatarVersion: 1, setCalls: 1, clearCalls: 0 });
    const first = server.avatars["1"];
    expect(first.type).toBe("image/webp");
    // 送ったのは 256px 四方で、真ん中が赤 (顔)。下の端は緑 (範囲は上から 60px・一辺 480px)。
    expect(await imageInfo(page, first.base64, first.type)).toMatchObject({ width: 256, height: 256 });
    expectColor(await pixelOf(page, first.base64, first.type, 0.5, 0.5), RED);
    expectColor(await pixelOf(page, first.base64, first.type, 0.5, 0.95), GREEN);
    // ヘッダーとコメントの差出人も、選んだ範囲 (赤) で出る。
    await expect(account.locator("img")).toHaveAttribute("src", `sigma-collaboration-profile://avatar?user=${ME}&v=1`);
    await expect(commentAvatar).toHaveAttribute("src", `sigma-collaboration-profile://avatar?user=${ME}&v=1`);
    expectColor(await renderedCenter(page, account.locator("img")), RED);
    expectColor(await renderedCenter(page, commentAvatar), RED);

    // 3. 横長の写真の右 (青) を選んでから「Google のアイコンに戻す」を押すと、Google のアイコンに戻る。
    dialog = await openProfile();
    await choose(dialog, "wide.png", wide);
    await dragPicture(-0.8, 0);
    await cropDialog.getByRole("button", { name: "適用", exact: true }).click();
    await expect(cropDialog).toBeHidden();
    await dialog.getByRole("button", { name: "Google のアイコンに戻す" }).click();
    await expect(dialog.getByRole("button", { name: "範囲を調整" })).toBeHidden();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    server = await readServer();
    expect(server).toMatchObject({ avatarVersion: 0, setCalls: 1, clearCalls: 1 });
    await expect(account.locator("img")).toHaveAttribute("src", `sigma-collaboration-profile://avatar?url=${encodeURIComponent(GOOGLE_AVATAR)}`);

    // 4. 細かい縞 (1px ごとの白黒) の写真を割り切れない比 (1500px → 256px) で縮めても、縞が残らず灰色に
    //    均される。間引くだけの縮め方 (画素を拾うだけ・canvas から作った画像を一度に縮める) だと 0〜255 の縞が残る。
    dialog = await openProfile();
    await choose(dialog, "stripes.png", await stripesPng(page, 1500));
    await cropDialog.getByRole("button", { name: "適用", exact: true }).click();
    await expect(cropDialog).toBeHidden();
    const smooth = await previewStats(preview);
    expect(smooth.width).toBe(256);
    expect(smooth.min).toBeGreaterThan(80);
    expect(smooth.max).toBeLessThan(176);

    // 5. 選び直して、横長の写真の右 (青) で保存する。調整し直す画面は、前に決めた範囲から始まる。
    await choose(dialog, "wide.png", wide);
    await dragPicture(-0.8, 0);
    await shot(cropDialog, "crop-wide.png");
    await cropDialog.getByRole("button", { name: "適用", exact: true }).click();
    await dialog.getByRole("button", { name: "範囲を調整" }).click();
    await expect(cropDialog).toBeVisible();
    const placement = await stage.locator("img").evaluate((image: HTMLImageElement) => image.style.left);
    expect(placement).toBe("-50%");
    await cropDialog.getByRole("button", { name: "キャンセル", exact: true }).click();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    server = await readServer();
    expect(server).toMatchObject({ avatarVersion: 2, setCalls: 2, clearCalls: 1 });
    expectColor(await pixelOf(page, server.avatars["2"].base64, server.avatars["2"].type, 0.5, 0.5), BLUE);
    expectColor(await pixelOf(page, server.avatars["2"].base64, server.avatars["2"].type, 0.05, 0.5), GREEN);
    await expect(account.locator("img")).toHaveAttribute("src", `sigma-collaboration-profile://avatar?user=${ME}&v=2`);
    expectColor(await renderedCenter(page, account.locator("img")), BLUE);
    expectColor(await renderedCenter(page, commentAvatar), BLUE);
    await page.waitForTimeout(300);
    await shot(page, "after-save.png");
    expect(errors).toEqual([]);

    // 6. アプリを起動し直しても、保存したアイコン (青) が出る。
    await app.close();
    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await installFakeServer(app, session, server);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const accountAfter = page.getByRole("button", { name: "Atsushi Kim のアカウント" });
    await expect(accountAfter.locator("img")).toHaveAttribute("src", `sigma-collaboration-profile://avatar?user=${ME}&v=2`);
    expectColor(await renderedCenter(page, accountAfter.locator("img")), BLUE);
    const commentAfter = page.locator("[data-comment-rail] .comment-thread-card").first().locator(".comment-thread-card-header .comment-author-line img");
    expectColor(await renderedCenter(page, commentAfter), BLUE);
    await page.waitForTimeout(300);
    await shot(page, "after-restart.png");
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

async function installFakeServer(app: ElectronApplication, session: SessionInfo, initial: FakeProfileServer) {
  await app.evaluate(({ ipcMain, protocol }, { session, initial, ME, GOOGLE_AVATAR }) => {
    const state: FakeProfileServer = JSON.parse(JSON.stringify(initial));
    (globalThis as unknown as { fakeProfileServer: FakeProfileServer }).fakeProfileServer = state;
    const replace = (name: string, handler: (...args: unknown[]) => unknown) => {
      ipcMain.removeHandler(`collaboration:${name}`);
      ipcMain.handle(`collaboration:${name}`, (_event, ...args) => handler(...args));
    };
    const mine = () => ({ userId: ME, providerDisplayName: "Atsushi Kim", providerAvatarUrl: GOOGLE_AVATAR, avatarVersion: state.avatarVersion });
    replace("info", () => ({
      configured: true,
      user: {
        actorId: ME, email: "me@example.test", displayName: "Atsushi Kim", avatarUrl: GOOGLE_AVATAR,
        ...(state.avatarVersion > 0 ? { avatarVersion: state.avatarVersion } : {}),
      },
      sessions: [session], restrictedFileIds: [],
    }));
    replace("members", () => [{ user_id: ME, role: "owner", email: "me@example.test" }]);
    replace("profile", () => mine());
    replace("profiles", (ids) => ((ids as string[]).includes(ME) ? [mine()] : []));
    replace("update-profile", () => mine());
    replace("set-avatar", (bytes, type) => {
      // 版は戻さない (共有サーバーと同じく、外して付け直しても新しい URL になる)。
      state.lastVersion += 1;
      state.avatarVersion = state.lastVersion;
      state.avatars[String(state.avatarVersion)] = { type: String(type), base64: Buffer.from(bytes as Uint8Array).toString("base64") };
      state.setCalls += 1;
      return mine();
    });
    replace("clear-avatar", () => { state.avatarVersion = 0; state.clearCalls += 1; return mine(); });
    for (const name of ["update", "view", "visible-files", "presence", "flush"]) replace(name, () => undefined);
    // Google のアイコンは灰色の1画素。
    const gray = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8+/btfwAJYQPWkk1x8QAAAABJRU5ErkJggg==", "base64");
    protocol.unhandle("sigma-collaboration-profile");
    protocol.handle("sigma-collaboration-profile", (request) => {
      const url = new URL(request.url);
      const saved = url.searchParams.get("user") === ME ? state.avatars[url.searchParams.get("v") ?? ""] : undefined;
      if (saved) return new Response(Buffer.from(saved.base64, "base64"), { headers: { "Content-Type": saved.type } });
      return new Response(gray, { headers: { "Content-Type": "image/png" } });
    });
  }, { session, initial, ME, GOOGLE_AVATAR });
}

/** 2 色に塗り分けた写真 (PNG の base64)。`color` は縦なら y、横なら x から色を決める。 */
async function photoPng(page: Page, width: number, height: number, color: (at: number) => Rgb, direction: "vertical" | "horizontal") {
  const length = direction === "vertical" ? height : width;
  const bands = Array.from({ length }, (_, at) => color(at));
  return page.evaluate(({ width, height, bands, direction }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    bands.forEach(([r, g, b], at) => {
      context.fillStyle = `rgb(${r} ${g} ${b})`;
      if (direction === "vertical") context.fillRect(0, at, width, 1);
      else context.fillRect(at, 0, 1, height);
    });
    return canvas.toDataURL("image/png").split(",")[1];
  }, { width, height, bands, direction });
}

/** 1px ごとに白黒が入れ替わる縞 (縮め方が粗いと、縮めた後も白黒が残る)。 */
function stripesPng(page: Page, side: number) {
  return page.evaluate((side) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = side;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, side, side);
    context.fillStyle = "#000";
    for (let x = 0; x < side; x += 2) context.fillRect(x, 0, 1, side);
    return canvas.toDataURL("image/png").split(",")[1];
  }, side);
}

function imageInfo(page: Page, base64: string, type: string) {
  return page.evaluate(async ({ base64, type }) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))], { type }));
    return { width: bitmap.width, height: bitmap.height };
  }, { base64, type });
}

/** 画像の (fx, fy) の割合の位置の色。 */
function pixelOf(page: Page, base64: string, type: string, fx: number, fy: number): Promise<Rgb> {
  return page.evaluate(async ({ base64, type, fx, fy }) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))], { type }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const [r, g, b] = context.getImageData(Math.min(bitmap.width - 1, Math.floor(fx * bitmap.width)), Math.min(bitmap.height - 1, Math.floor(fy * bitmap.height)), 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, { base64, type, fx, fy });
}

/** 画面に描かれたアイコンの真ん中の色 (別のスキームの画像は canvas で読めないので、画面を撮って読む)。 */
async function renderedCenter(page: Page, image: Locator): Promise<Rgb> {
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  const png = (await image.screenshot({ animations: "disabled" })).toString("base64");
  return pixelOf(page, png, "image/png", 0.5, 0.5);
}

/** 見本 (送る前の 256px の画像) の大きさと明るさの幅。 */
function previewStats(preview: Locator) {
  return preview.evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let min = 255;
    let max = 0;
    for (let index = 0; index < data.length; index += 4) {
      min = Math.min(min, data[index]);
      max = Math.max(max, data[index]);
    }
    return { width: canvas.width, height: canvas.height, min, max };
  });
}

function expectColor(actual: Rgb, expected: Rgb) {
  const distance = Math.max(...actual.map((value, index) => Math.abs(value - expected[index])));
  expect(distance, `rgb(${actual.join(" ")}) should be close to rgb(${expected.join(" ")})`).toBeLessThan(40);
}

async function shot(target: Page | Locator, name: string) {
  if (!SHOTS) return;
  await target.screenshot({ path: path.join(SHOTS, name), animations: "disabled" });
}
