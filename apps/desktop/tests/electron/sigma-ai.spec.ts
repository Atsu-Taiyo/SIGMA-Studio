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

// サブエージェント (AI設定で内蔵AIのスイッチをオンにしたとき)。本物の dsh がサブエージェントを動かし、
// 子が教材の MCP ツールで提案を作り、親が完了の知らせを受けて仕上げるまでを通す。
//   - 子は親と同じ道具 (教材ツール・skill) を持つ
//   - 子からのさらなる起動は、設定した深さ (ここでは入れ子なし) で dsh が断る
//   - 親が先に応答を終えても、子の作業と親の最終報告を待つ (実行を途中で畳まない)
test("the built-in AI delegates to a subagent: the child edits through the material tools and the run waits for it", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const nestedRefusals: string[] = [];
  const childTools: string[][] = [];
  const gateway = await startGatewayFixture(async (request) => {
    const prompt = promptOf(request);
    const results = toolResults(request);
    if (prompt.includes("CHILD_TASK")) {
      // 子: 会話を引き継がないので、親が指示に書いた fileId と runId だけが頼り。
      childTools.push((request.tools ?? []).map((tool) => tool.function.name));
      const fileId = /fileId=(\S+)/u.exec(prompt)?.[1] ?? "";
      const runId = /runId=(\S+)/u.exec(prompt)?.[1] ?? "";
      if (results.length === 0) {
        return { tool: "subagent", arguments: { description: "さらに分担", prompt: "GRANDCHILD_TASK" } };
      }
      if (results.length === 1) {
        nestedRefusals.push(results[0]!);
        // 親が先に応答を終えるよう、子の作業を少し遅らせる。
        await sleep(1_500);
        return { tool: TOOL("get_edit_context"), arguments: { fileId, runId } };
      }
      if (results.length === 2) {
        const revision = Number(/"(?:revision|fileRevision)"\s*:\s*(\d+)/u.exec(results[0] ?? "")?.[1] ?? "0");
        return {
          tool: TOOL("insert_content"),
          arguments: {
            fileId, runId, expectedRevision: revision, targetId: "END_OF_DOCUMENT",
            content: { format: "markdown", markdown: "まとめ: 三角形の内角の和は180度である。" },
          },
        };
      }
      return { text: "まとめの段落を末尾に追加する提案を作りました。" };
    }
    const { fileId, runId } = identifiers(request);
    if (results.length === 0) {
      return {
        say: "まとめの追記をサブエージェントに任せます。",
        tool: "subagent",
        arguments: { description: "まとめの追記", prompt: `CHILD_TASK fileId=${fileId} runId=${runId} 教材の末尾にまとめを1文追加してください。` },
      };
    }
    if (!prompt.includes("Background subagent")) {
      return { text: "サブエージェントに任せました。完了を待ちます。" };
    }
    return { text: "サブエージェントが、まとめの段落を末尾に追加しました。" };
  });
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-ai-subagent-"));
  const env = launchEnv(profile, gateway);
  // 内蔵AIのサブエージェントは、はじめはオフ。設定でオンにした状態から始める。
  writeFileSync(path.join(profile, "data", "settings.json"), JSON.stringify({ uiLocale: "ja", aiSubagents: { providers: { sigma: true } } }));
  const source = ensurePageLayout({
    ...sampleDocument,
    docId: "sigma_ai_subagent",
    metadata: { title: "内蔵AIのサブエージェント" },
    content: [
      { type: "paragraph", id: "p_intro", children: [{ type: "text", text: "三角形の内角を調べる。" }] },
    ],
  });
  const sourceFile = path.join(profile, "内蔵AIのサブエージェント.sigma");
  writeFileSync(sourceFile, JSON.stringify(source));

  const app = await electron.launch({ args: [APP_ROOT, sourceFile], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^(https?|file):/u, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
    });
    await page.reload();
    await expect(page.getByText("三角形の内角を調べる。").first()).toBeVisible({ timeout: 180_000 });
    await expect(page.locator(".startup-splash")).toBeHidden();

    const sidebar = await openSideChat(page);
    const composer = sidebar.locator(".ai-chat-composer textarea");
    await expect(composer).toBeVisible();
    await composer.fill("末尾にまとめを追加して。");
    await sidebar.locator(".ai-chat-send-button").click();

    // 親の最終報告は、子が終わった知らせを受けた後のターンで出る。ここまで実行が続いている。
    await expect(sidebar).toContainText("サブエージェントが、まとめの段落を末尾に追加しました。", { timeout: 180_000 });
    await keep(testInfo, "chat-subagent", await sidebar.screenshot());

    const fileId = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.title === "内蔵AIのサブエージェント")!.fileId;
    const proposals = (await page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })))
      .filter((proposal) => proposal.fileId === fileId);
    // 子が作った編集も、親と同じ実行の承認待ちの提案になる (教材にはまだ入らない)。
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.provider).toBe("sigma");
    expect(JSON.stringify((await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!.content)).not.toContain("まとめ:");

    await sidebar.getByRole("button", { name: "適用", exact: true }).first().click();
    await expect.poll(async () => page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" }))).toEqual([]);
    const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
    expect(JSON.stringify(saved!.content)).toContain("まとめ: 三角形の内角の和は180度である。");

    // 親: 方針の節と subagent ツールを受け取っている。
    const first = gateway.requests[0]!;
    expect(promptOf(first)).toContain("サブエージェントの方針:");
    expect(promptOf(first)).toContain("サブエージェント（subagentツール）を使えます");
    expect((first.tools ?? []).map((tool) => tool.function.name)).toContain("subagent");
    // 子: 親と同じ道具を持つ。シェルやファイルの道具は増えていない。
    expect(childTools[0]).toEqual(expect.arrayContaining([TOOL("get_edit_context"), TOOL("insert_content"), "skill", "subagent"]));
    expect(childTools[0]!.filter((name) => !name.startsWith("mcp__sigma-studio-local__")
      && !["skill", "subagent", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name))).toEqual([]);
    // 入れ子なしの設定: 子からの起動は dsh が断る。
    expect(nestedRefusals).toHaveLength(1);
    expect(nestedRefusals[0]).toMatch(/exceeds maxDepth 1/u);
    // 親は完了の知らせを受けて、もう 1 ターン動いている。
    expect(gateway.requests.some((request) => promptOf(request).includes("Background subagent"))).toBe(true);
    expect(gateway.rejected).toBe(0);
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
