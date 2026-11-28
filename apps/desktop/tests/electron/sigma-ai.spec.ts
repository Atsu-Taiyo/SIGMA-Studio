import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout } from "@/features/document";
import { promptOf, startGatewayFixture, toolResults, type GatewayRequest } from "./sigma-ai-gateway-fixture";

const APP_ROOT = path.resolve(__dirname, "../..");
const SVG_SKILL = path.join(APP_ROOT, "electron/official-skills/sigma-svg-figure/SKILL.md");
const TOOL = (name: string) => `mcp__sigma-studio-local__${name}`;

function launchEnv(profile: string, gateway: { url: string; token: string }): Record<string, string> {
  mkdirSync(path.join(profile, "data"), { recursive: true });
  writeFileSync(path.join(profile, "data", "settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  env.SIGMA_AI_GATEWAY_URL = gateway.url;
  env.SIGMA_AI_GATEWAY_TOKEN = gateway.token;
  // dsh は Electron 内蔵の Node では動かない。テストを動かしている Node を使わせる。
  const staged = process.env.SIGMA_STUDIO_DSH_RUNTIME_DIR;
  env.SIGMA_STUDIO_NODE_BIN = staged
    ? path.join(staged, "node", ...(process.platform === "win32" ? ["node.exe"] : ["bin", "node"]))
    : process.execPath;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  return env;
}

async function openSideChat(page: Page): Promise<Locator> {
  const sidebar = page.locator(".ai-chat-host--sidebar");
  if (!(await sidebar.isVisible().catch(() => false))) {
    const toolbarButton = page.getByRole("button", { name: "AIチャットを開く" }).first();
    if (await toolbarButton.isVisible().catch(() => false)) {
      await toolbarButton.click();
    } else {
      await page.locator(".app-menu-button", { hasText: /^AI$/ }).click();
      await page.getByRole("menuitem", { name: "AIチャットを開く" }).click();
    }
  }
  await expect(sidebar).toBeVisible();
  return sidebar;
}

async function keep(testInfo: TestInfo, name: string, body: Buffer) {
  writeFileSync(testInfo.outputPath(`${name}.png`), body);
  await testInfo.attach(name, { body, contentType: "image/png" });
}

function identifiers(request: GatewayRequest): { fileId: string; runId: string } {
  const prompt = promptOf(request);
  return {
    fileId: /fileId は「(.+?)」/u.exec(prompt)?.[1] ?? "",
    runId: /runIdは「(.+?)」/u.exec(prompt)?.[1] ?? "",
  };
}

test("the built-in AI edits through DeepSeek Harness: reads the material, proposes an SVG figure, and the approved figure is saved", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const triangle = /```svg\r?\n([\s\S]*?)```/u.exec(readFileSync(SVG_SKILL, "utf8"))![1]!.trim();
  const gateway = await startGatewayFixture((request, index) => {
    const { fileId, runId } = identifiers(request);
    if (index === 0) {
      return { say: "教材を確認します。", tool: TOOL("get_edit_context"), arguments: { fileId, runId } };
    }
    if (index === 1) {
      const revision = Number(/"(?:revision|fileRevision)"\s*:\s*(\d+)/u.exec(toolResults(request)[0] ?? "")?.[1] ?? "0");
      return {
        tool: TOOL("insert_svg_image"),
        arguments: { fileId, runId, expectedRevision: revision, targetId: "before_figure", svg: triangle, name: "直角三角形ABC", w: 320 },
      };
    }
    return { text: "直角三角形の図を、冒頭の文の下に入れました。" };
  });
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-ai-"));
  const env = launchEnv(profile, gateway);
  const source = ensurePageLayout({
    ...sampleDocument,
    docId: "sigma_ai_figure",
    metadata: { title: "内蔵AIの確認" },
    content: [
      { type: "paragraph", id: "before_figure", children: [{ type: "text", text: "次の図を見て答えなさい。" }] },
    ],
  });
  const sourceFile = path.join(profile, "内蔵AIの確認.sigma");
  writeFileSync(sourceFile, JSON.stringify(source));

  const app = await electron.launch({ args: [APP_ROOT, sourceFile], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^(https?|file):/u, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
      // 使い方・Star の誘いは時間がたつとサイドチャットの下に重なり、遅い端末では承認ボタンや入力欄を塞ぐ。
      localStorage.setItem("sigma-studio:usage-guide-dismissed:v1", "1");
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
    });
    await page.reload();
    await expect(page.getByText("次の図を見て答えなさい。").first()).toBeVisible({ timeout: 180_000 });
    await expect(page.locator(".startup-splash")).toBeHidden();

    // 接続先と実行環境が揃っていれば、ログインも設定も無しで使える。
    expect(await page.evaluate(() => window.desktopAPI!.sigmaAi!.getStatus())).toMatchObject({
      available: true, model: "deepseek/deepseek-v4.1-flash-1017", error: null,
    });

    const sidebar = await openSideChat(page);
    const composer = sidebar.locator(".ai-chat-composer textarea");
    await expect(composer).toBeVisible();
    await keep(testInfo, "chat-empty", await sidebar.screenshot());

    // Paste an actual PNG through the composer and observe the model request.
    await composer.evaluate((element) => {
      const png = atob("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAANklEQVRIie3WuQkAQAwDwem/aV0VhgsWnAuMnmVuTwJ6kVy0gqaqWG2qwVmTKaoQeAkd/UzXDzaH/C7qwiXmAAAAAElFTkSuQmCC");
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(png, (byte) => byte.charCodeAt(0))], "reference.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await expect(sidebar.getByRole("img", { name: "添付画像: reference.png" })).toBeVisible();
    await composer.fill("冒頭の文の下に直角三角形の図を入れて。");
    await sidebar.locator(".ai-chat-send-button").click();
    await expect(sidebar.locator(".ai-chat-turn.user").last()).toContainText("直角三角形の図を入れて");

    // 提案は承認待ちとして記録される。承認するまで教材には入らない。
    const fileId = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.title === "内蔵AIの確認")!.fileId;
    await expect.poll(async () => (await page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })))
      .filter((proposal) => proposal.fileId === fileId).length, { timeout: 180_000 }).toBe(1);
    await expect(sidebar).toContainText("直角三角形の図を、冒頭の文の下に入れました。", { timeout: 120_000 });
    await keep(testInfo, "chat-proposal", await sidebar.screenshot());
    await keep(testInfo, "window-proposal", await page.screenshot());

    const proposal = (await page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })))[0]!;
    expect(proposal.provider).toBe("sigma");
    expect((await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!.pageLayout?.overlay?.overlaySnapshot?.shapes ?? []).toEqual([]);

    await sidebar.getByRole("button", { name: "適用", exact: true }).first().click();
    await expect.poll(async () => page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" }))).toEqual([]);
    const image = page.locator("img.overlay-image-shape").first();
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("alt", "直角三角形ABC");
    await keep(testInfo, "window-applied", await page.screenshot());

    const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
    expect(saved!.pageLayout!.overlay!.overlaySnapshot!.shapes.some((shape) => shape.type === "image")).toBe(true);

    // モデルへ届いたもの: 許可したモデルだけを、教材の MCP ツールとスキルだけを持たせて呼んでいる。
    expect(gateway.rejected).toBe(0);
    expect(gateway.requests.length).toBeGreaterThanOrEqual(3);
    const first = gateway.requests[0]!;
    expect(first.model).toBe("deepseek/deepseek-v4.1-flash-1017");
    const userContent = first.messages.find((message) => message.role === "user")?.content;
    expect(userContent).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "image_url", image_url: expect.objectContaining({ url: expect.stringMatching(/^data:image\/(png|jpeg);base64,/) }),
    })]));
    const toolNames = (first.tools ?? []).map((tool) => tool.function.name);
    expect(toolNames).toEqual(expect.arrayContaining([TOOL("get_edit_context"), TOOL("insert_svg_image"), TOOL("convert_svg_image"), TOOL("edit_text"), "skill"]));
    expect(toolNames.filter((name) => !name.startsWith("mcp__sigma-studio-local__") && !["skill", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name))).toEqual([]);
    expect(promptOf(first)).toContain("sigma-svg-figure");
  } finally {
    await app.close().catch(() => undefined);
    await gateway.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

// 人と内蔵AIが同じ段落を同時に直しても、どちらの編集も落とさない (MISS R2・#249)。
// 内蔵AIも他のAIと同じ MCP サーバーと提案の経路を通るので、(1) AIが読んだ後・書く前の人の編集は
// 読んだ内容を基準に合成され、(2) 提案の後・承認の前の人の編集は承認時に三者マージされる。
test("the built-in AI never overwrites a person's concurrent edit: edits made after it read and after it proposed both survive approval", async () => {
  test.setTimeout(300_000);
  const paragraphText = (document: { content: Array<{ id?: string; children?: Array<{ type: string; text?: string }> }> } | null) =>
    (document?.content.find((block) => block.id === "story")?.children ?? []).map((node) => node.text ?? "").join("");
  let readSeen!: () => void;
  const aiHasRead = new Promise<void>((resolve) => { readSeen = resolve; });
  let humanDone!: () => void;
  const humanEdited = new Promise<void>((resolve) => { humanDone = resolve; });
  const gateway = await startGatewayFixture(async (request, index) => {
    const { fileId, runId } = identifiers(request);
    if (index === 0) return { tool: TOOL("get_edit_context"), arguments: { fileId, runId } };
    if (index === 1) {
      // AIは古い内容を読んだまま。ここで人が同じ段落を直すのを待ってから書く。
      const revision = Number(/"(?:revision|fileRevision)"\s*:\s*(\d+)/u.exec(toolResults(request)[0] ?? "")?.[1] ?? "0");
      readSeen();
      await humanEdited;
      return {
        tool: TOOL("edit_text"),
        arguments: {
          fileId, runId, expectedRevision: revision,
          edit: { action: "patch", operations: [{ op: "replace_text", target: { type: "text", blockId: "story", text: "cat" }, replacement: "dog" }] },
        },
      };
    }
    return { text: "cat を dog に直しました。" };
  });
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-ai-merge-"));
  const env = launchEnv(profile, gateway);
  const source = ensurePageLayout({
    ...sampleDocument,
    docId: "sigma_ai_merge",
    metadata: { title: "内蔵AIと人の同時編集" },
    content: [{ type: "paragraph", id: "story", children: [{ type: "text", text: "The cat sat on the mat." }] }],
  });
  const sourceFile = path.join(profile, "内蔵AIと人の同時編集.sigma");
  writeFileSync(sourceFile, JSON.stringify(source));

  const app = await electron.launch({ args: [APP_ROOT, sourceFile], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^(https?|file):/u, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
      // 使い方・Star の誘いは時間がたつとサイドチャットの下に重なり、遅い端末では承認ボタンや入力欄を塞ぐ。
      localStorage.setItem("sigma-studio:usage-guide-dismissed:v1", "1");
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
    });
    await page.reload();
    await expect(page.getByText("The cat sat on the mat.").first()).toBeVisible({ timeout: 180_000 });
    await expect(page.locator(".startup-splash")).toBeHidden();
    const fileId = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.title === "内蔵AIと人の同時編集")!.fileId;
    const saved = () => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
    const pending = async () => (await page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })))
      .filter((proposal) => proposal.fileId === fileId);
    /** 人の編集 (保存 IPC。renderer の自動保存と同じ CAS を通る)。 */
    const humanReplace = async (from: string, to: string) => {
      const current = (await saved())!;
      const revision = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.fileId === fileId)!.revision;
      const next = { ...current, content: current.content.map((block) => block.id === "story"
        ? { ...block, children: [{ type: "text", text: paragraphText(current).replace(from, to) }] } : block) };
      const result = await page.evaluate(({ id, document, expectedRevision }) => (
        window.desktopAPI!.storage.saveDocument(id, document as never, { expectedRevision })
      ), { id: fileId, document: next, expectedRevision: revision });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    };

    const sidebar = await openSideChat(page);
    await sidebar.locator(".ai-chat-composer textarea").fill("cat を dog に直して。");
    await sidebar.locator(".ai-chat-send-button").click();

    // (1) AIが読んだ後、書く前に、人が同じ段落の別の語を直す。
    await aiHasRead;
    await humanReplace("mat", "rug");
    humanDone();
    await expect.poll(async () => (await pending()).length, { timeout: 180_000 }).toBe(1);
    await expect(sidebar).toContainText("cat を dog に直しました。", { timeout: 120_000 });
    expect((await pending())[0]!.provider).toBe("sigma");
    // 提案は承認待ち。教材には人の編集だけが入っている。
    expect(paragraphText(await saved())).toBe("The cat sat on the rug.");

    // (2) 提案の後、承認の前に、人がさらに別の語を直す。
    await humanReplace("sat", "slept");
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const reopened = await openSideChat(page);
    await expect.poll(async () => page.getByRole("button", { name: "適用", exact: true }).count(), { timeout: 60_000 }).toBeGreaterThan(0);
    await page.getByRole("button", { name: "適用", exact: true }).first().click();
    await expect.poll(async () => (await pending()).length, { timeout: 60_000 }).toBe(0);
    await expect(reopened).toBeVisible();

    // AIの編集 (dog) と、人の2回の編集 (rug・slept) がすべて残る。
    expect(paragraphText(await saved())).toBe("The dog slept on the rug.");
    expect(gateway.rejected).toBe(0);
  } finally {
    humanDone();
    await app.close().catch(() => undefined);
    await gateway.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

// 使用状況と権限を、実アプリで通す。モデルの応答と中継の利用枠だけが偽物で、
// ローカル中継・dsh・MCP サーバー・設定ファイルは本物。
//   (1) 権限「読み取りのみ」: 設定に保存され、AI が編集ツールを呼んでも MCP サーバーが断り、提案は作られない。
//   (2) 応答の使用量がコンテキストの輪に出て、中継の利用枠が入力欄と AI設定に出る。
//   (3) 利用枠を使い切ると、送る前に一行で分かり、送っても上限の文で止まる (再試行で粘らない)。
test("the built-in AI shows context and allowance, obeys the read-only permission, and stops when the week's allowance is used up", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const triangle = /```svg\r?\n([\s\S]*?)```/u.exec(readFileSync(SVG_SKILL, "utf8"))![1]!.trim();
  const resetsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const seen: { prompts: string[]; refusals: string[] } = { prompts: [], refusals: [] };
  const gateway = await startGatewayFixture((request, index) => {
    const { fileId, runId } = identifiers(request);
    if (index === 0) {
      seen.prompts.push(promptOf(request));
      // 権限を無視して編集しようとするモデル。断るのは指示ではなく MCP サーバー。
      return { tool: TOOL("insert_svg_image"), arguments: { fileId, runId, expectedRevision: 0, targetId: "lead", svg: triangle, name: "三角形", w: 320 } };
    }
    if (index === 1) {
      seen.refusals.push(toolResults(request)[0] ?? "");
      return { tool: TOOL("get_edit_context"), arguments: { fileId, runId } };
    }
    return { text: "この教材は1つの段落だけでできています。" };
  });
  gateway.allowance = { plan: "pro", included: true, weekly: { usedRatio: 0.42, resetsAt, reached: false } };
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-ai-usage-"));
  const env = launchEnv(profile, gateway);
  const source = ensurePageLayout({
    ...sampleDocument,
    docId: "sigma_ai_usage",
    metadata: { title: "内蔵AIの使用状況" },
    content: [{ type: "paragraph", id: "lead", children: [{ type: "text", text: "次の図を見て答えなさい。" }] }],
  });
  const sourceFile = path.join(profile, "内蔵AIの使用状況.sigma");
  writeFileSync(sourceFile, JSON.stringify(source));
  const settingsFile = () => JSON.parse(readFileSync(path.join(profile, "data", "settings.json"), "utf8")) as Record<string, unknown>;

  const app = await electron.launch({ args: [APP_ROOT, sourceFile], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^(https?|file):/u, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
      // 使い方・Star の誘いは時間がたつとサイドチャットの下に重なり、遅い端末では承認ボタンや入力欄を塞ぐ。
      localStorage.setItem("sigma-studio:usage-guide-dismissed:v1", "1");
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
    });
    await page.reload();
    await expect(page.getByText("次の図を見て答えなさい。").first()).toBeVisible({ timeout: 180_000 });
    await expect(page.locator(".startup-splash")).toBeHidden();
    const fileId = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.title === "内蔵AIの使用状況")!.fileId;
    const pending = async () => (await page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })))
      .filter((proposal) => proposal.fileId === fileId);

    const sidebar = await openSideChat(page);
    const composer = sidebar.locator(".ai-chat-composer textarea");
    await expect(composer).toBeVisible();

    // (1) 権限のピル。既定は「承認を求める」で、選ぶと設定ファイルに入る。
    const permission = sidebar.getByRole("button", { name: /^AIの権限: / });
    await expect(permission).toHaveAccessibleName("AIの権限: 承認を求める");
    await permission.click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(3);
    await keep(testInfo, "permission-menu", await page.screenshot());
    await page.getByRole("menuitemradio", { name: /^読み取りのみ/ }).click();
    await expect(permission).toHaveAccessibleName("AIの権限: 読み取りのみ");
    await expect.poll(() => settingsFile().aiReadOnlyMode).toBe(true);

    await composer.fill("冒頭の文の下に三角形の図を入れて。");
    await sidebar.locator(".ai-chat-send-button").click();
    await expect(sidebar).toContainText("この教材は1つの段落だけでできています。", { timeout: 180_000 });
    // 指示にも一文が入り、それを無視した編集ツールは MCP サーバーが断る。読み取りツールは通る。
    expect(seen.prompts[0]).toContain("利用者はAIの権限を「読み取りのみ」にしています。");
    expect(seen.refusals[0]).toContain("PERMISSION_DENIED");
    expect(seen.refusals[0]).toContain("AIの権限が「読み取りのみ」のため、このツールは使えません。");
    expect(toolResults(gateway.requests[2]!)[0]).not.toContain("PERMISSION_DENIED");
    expect(await pending()).toEqual([]);
    expect((await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!.pageLayout?.overlay?.overlaySnapshot?.shapes ?? []).toEqual([]);

    // (2) 応答の使用量 (偽の中継は 1 応答 120 トークン) が輪に出て、押すと利用枠も出る。
    const usage = sidebar.getByRole("button", { name: /^使用状況/ });
    await expect(usage).toHaveAccessibleName("使用状況: コンテキスト 1%");
    await usage.click();
    const popover = page.getByRole("dialog", { name: "使用状況" });
    await expect(popover).toContainText("120 / 1M トークン (1%)");
    await expect(popover).toContainText("SIGMA AI の利用枠");
    await expect(popover).toContainText("42% 使用");
    await expect(popover).toContainText("にリセット");
    await keep(testInfo, "usage-popover", await page.screenshot());

    // AI設定の「使用状況」には、すべての AI が並ぶ。
    await popover.getByRole("button", { name: "すべてのAIの使用状況" }).click();
    const settings = page.locator(".ai-settings-dialog");
    await expect(settings.locator("#ai-settings-usage")).toBeVisible();
    const sigmaRow = settings.locator('.ai-usage-provider[data-provider="sigma"]');
    await expect(sigmaRow).toContainText("プラン: Pro");
    await expect(sigmaRow.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
    await expect(settings.locator('.ai-usage-provider[data-provider="antigravity"]')).toContainText("このAIは利用枠を知らせません。");
    await keep(testInfo, "usage-settings", await page.screenshot());
    // 同じ画面の「接続・動作」で権限を戻すと、入力欄のピルも同じ値になる。
    await settings.getByRole("button", { name: "接続・動作" }).click();
    await settings.getByTestId("desktop-settings-ai-permission").click();
    await page.getByRole("option", { name: /^承認を求める/ }).click();
    await expect.poll(() => settingsFile().aiReadOnlyMode).toBeUndefined();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(permission).toHaveAccessibleName("AIの権限: 承認を求める");

    // (3) 利用枠を使い切った。開き直すと、送る前の一行と輪の印で分かる。
    gateway.allowance = { plan: "pro", included: true, weekly: { usedRatio: 1, resetsAt, reached: true } };
    await usage.click();
    await expect(page.getByRole("dialog", { name: "使用状況" })).toContainText("上限に達しています");
    await page.keyboard.press("Escape");
    await expect(sidebar.getByRole("status")).toContainText("SIGMA AI の利用枠を使い切りました。");
    await expect(usage).toHaveAccessibleName(/SIGMA AI: 上限に達しています$/u);
    const requestsBefore = gateway.requests.length;
    await composer.fill("続けて、段落を直して。");
    await sidebar.locator(".ai-chat-send-button").click();
    // 理由だけを、戻る日時つきで見せる (内部の呼び出し名や、埋め残しの記号を混ぜない)。
    const stopped = sidebar.locator(".ai-chat-turn").last();
    await expect(stopped).toContainText(/今週の SIGMA AI の利用枠を使い切りました。\d+月\d+日\(.\) \d+:\d+ にリセットされます。/u, { timeout: 120_000 });
    await expect(stopped).not.toContainText("Error invoking remote method");
    await expect(stopped).not.toContainText("{");
    await keep(testInfo, "limit-reached", await sidebar.screenshot());
    // モデルへは 1 度も届かず、断られた後に粘って送り直してもいない。
    expect(gateway.requests.length).toBe(requestsBefore);
    expect(gateway.refused).toBe(1);
    expect(gateway.rejected).toBe(0);
  } finally {
    await app.close().catch(() => undefined);
    await gateway.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

// 本物の中継と本物の DeepSeek を使う確認。料金がかかり結果も毎回違うので、明示したときだけ動かす:
//   SIGMA_AI_LIVE=1 SIGMA_AI_GATEWAY_URL=... SIGMA_AI_GATEWAY_TOKEN=... pnpm run test:e2e:electron sigma-ai
test("live: the built-in AI draws a figure, rewrites text, and converts the figure with the real model", async ({}, testInfo) => {
  const url = process.env.SIGMA_AI_GATEWAY_URL ?? "";
  const token = process.env.SIGMA_AI_GATEWAY_TOKEN ?? "";
  test.skip(process.env.SIGMA_AI_LIVE !== "1" || !url || !token, "needs SIGMA_AI_LIVE=1 and a deployed gateway");
  test.setTimeout(900_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-ai-live-"));
  const env = launchEnv(profile, { url, token });
  const source = ensurePageLayout({
    ...sampleDocument,
    docId: "sigma_ai_live",
    metadata: { title: "内蔵AIの実地確認" },
    content: [
      { type: "paragraph", id: "lead", children: [{ type: "text", text: "次の図を見て答えなさい。" }] },
    ],
  });
  const sourceFile = path.join(profile, "内蔵AIの実地確認.sigma");
  writeFileSync(sourceFile, JSON.stringify(source));

  const app = await electron.launch({ args: [APP_ROOT, sourceFile], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^(https?|file):/u, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
      // 使い方・Star の誘いは時間がたつとサイドチャットの下に重なり、遅い端末では承認ボタンや入力欄を塞ぐ。
      localStorage.setItem("sigma-studio:usage-guide-dismissed:v1", "1");
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      localStorage.setItem("sigma-studio:github-star-disabled:v1", "1");
    });
    await page.reload();
    await expect(page.getByText("次の図を見て答えなさい。").first()).toBeVisible({ timeout: 180_000 });
    await expect(page.locator(".startup-splash")).toBeHidden();
    const sidebar = await openSideChat(page);
    const composer = sidebar.locator(".ai-chat-composer textarea");
    const fileId = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.title === "内蔵AIの実地確認")!.fileId;
    const pending = async () => (await page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })))
      .filter((proposal) => proposal.fileId === fileId);
    const shapes = async () => (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!
      .pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];

    // 案内のモーダル (使い方・GitHub の Star) が出ていると、背後の承認ボタンは操作対象から外れる。
    // 実行が長いと途中で出るので、出るたびに閉じる。
    const dismissPrompts = async () => {
      const never = page.getByRole("button", { name: "もう表示しない" });
      if (await never.isVisible().catch(() => false)) await never.click();
      const star = page.getByRole("dialog").filter({ hasText: "GitHubのStarで応援しませんか" });
      if (await star.isVisible().catch(() => false)) await star.getByRole("button").first().click();
    };
    // 依頼を送り、提案が出て実行が終わるまで待ち、出た提案をすべて適用する。
    const ask = async (label: string, request: string) => {
      const started = Date.now();
      await composer.fill(request);
      await sidebar.locator(".ai-chat-send-button").click();
      await expect.poll(async () => (await pending()).length, { timeout: 420_000 }).toBeGreaterThan(0);
      await expect(sidebar.locator(".ai-chat-send-button")).toBeVisible({ timeout: 420_000 });
      await dismissPrompts();
      await expect.poll(async () => {
        await dismissPrompts();
        return page.getByRole("button", { name: "適用", exact: true }).count();
      }, { timeout: 60_000 }).toBeGreaterThan(0);
      const proposals = await pending();
      await keep(testInfo, `${label}-proposal`, await page.screenshot());
      writeFileSync(testInfo.outputPath(`${label}.txt`), [
        `seconds: ${Math.round((Date.now() - started) / 1000)}`,
        `proposals: ${JSON.stringify(proposals.map((proposal) => ({ provider: proposal.provider, summary: (proposal as { summary?: unknown }).summary })))}`,
        await sidebar.innerText(),
      ].join("\n\n"));
      for (const proposal of proposals) expect(proposal.provider).toBe("sigma");
      for (let guard = 0; guard < 6 && (await pending()).length > 0; guard += 1) {
        await dismissPrompts();
        await page.getByRole("button", { name: "適用", exact: true }).first().click();
        await page.waitForTimeout(1_500);
      }
      await expect.poll(async () => (await pending()).length, { timeout: 60_000 }).toBe(0);
      await keep(testInfo, `${label}-applied`, await page.screenshot());
    };

    // 道具を持たせない 1 回の問い合わせ (枠の描画・スキルの下書き・作風の要約と同じ経路)。
    const frame = await page.evaluate(() => window.desktopAPI!.aiSkillDraft!.generate({
      provider: "sigma",
      prompt: "角が丸い、細い二重線の枠にして。",
      context: { title: "", description: "", currentContent: "" },
      purpose: "frameDrawing",
      frameTarget: "problem",
    }));
    writeFileSync(testInfo.outputPath("0-frame.json"), JSON.stringify(frame, null, 2));
    expect(frame, JSON.stringify(frame).slice(0, 400)).toMatchObject({ ok: true });
    expect((frame as { text: string }).text).toContain("<svg");

    await ask("1-figure", "冒頭の文の下に、直角三角形ABC（角Cが直角、AB=5, BC=3, CA=4）の図を入れて。");
    expect((await shapes()).some((shape) => shape.type === "image")).toBe(true);

    await ask("2-text", "冒頭の文を「次の図を見て，辺ABの長さを求めなさい。」に書き換えて。");
    const afterText = JSON.stringify((await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!.content);
    expect(afterText).toContain("辺ABの長さを求めなさい");

    await ask("3-convert", "さっきの三角形の図を、部品ごとに編集できる図形に変換して。");
    expect((await shapes()).some((shape) => shape.type !== "image")).toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
