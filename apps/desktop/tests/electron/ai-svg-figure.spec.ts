import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const SVG_SKILL = path.join(APP_ROOT, "electron/official-skills/sigma-svg-figure/SKILL.md");

/** 公式スキルの例をそのまま使う。スキルの例が実アプリで描画できなくなったら気づけるように。 */
function skillSvgExamples(): string[] {
  return [...readFileSync(SVG_SKILL, "utf8").matchAll(/```svg\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());
}

test("an SVG figure from insert_svg_image is approved, drawn, saved, and still there after a restart", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-svg-figure-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  // 教材ファイルを引数に起動すると、その教材が開いた状態から始まる (保存・読み込みは本物のstorage)。
  const source = ensurePageLayout({
    ...sampleDocument,
    docId: "ai_svg_figure",
    metadata: { title: "SVG図の確認" },
    content: [
      { type: "paragraph", id: "before_figure", children: [{ type: "text", text: "次の図を見て答えなさい。" }] },
    ],
  });
  const sourceFile = path.join(profile, "SVG図の確認.sigma");
  writeFileSync(sourceFile, JSON.stringify(source));
  const launch = (openFile?: string) => electron.launch({ args: openFile ? [APP_ROOT, openFile] : [APP_ROOT], cwd: APP_ROOT, env });
  let app = await launch(sourceFile);
  const client = new Client({ name: "ai-svg-figure", version: "1" });
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    await page.reload();
    await expect(page.getByText("次の図を見て答えなさい。").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".startup-splash")).toBeHidden();

    // 公式スキルは初回に12本すべて公式(管理下)として入り、SVGのskillが最初に並ぶ。
    const tree = await page.evaluate(() => window.desktopAPI!.aiResources!.getTree()) as {
      resources: Array<{ id: string; origin?: string; officialState?: string; loadMode: string }>;
    };
    const official = tree.resources.filter((resource) => resource.origin === "official");
    expect(official.map((resource) => resource.id)).toEqual([
      "official-svg-figure", "official-image-material", "official-graph", "official-graph3d",
      "official-problem", "official-body", "official-table", "official-page-layout",
      "official-proofreading", "official-shape", "official-material-library", "official-document-management",
    ]);
    expect(official.every((resource) => resource.officialState === "managed" && resource.loadMode === "auto")).toBe(true);
    const svgSkill = await page.evaluate(() => window.desktopAPI!.aiResources!.readFile("official-svg-figure")) as { content: string };
    expect(svgSkill.content).toContain("insert_svg_image");
    expect(svgSkill.content).toContain("update_svg_image");

    const opened = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.title === "SVG図の確認")!;
    expect(opened).toBeDefined();
    const fileId = opened.fileId;
    const firstBlockId = (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!.content[0]!.id;

    await client.connect(new StdioClientTransport({
      command: await app.evaluate(() => process.execPath),
      args: [path.join(APP_ROOT, "dist-electron/sigma-doc-mcp-server.cjs")],
      env: { PATH: process.env.PATH ?? "", HOME: os.homedir(), ELECTRON_RUN_AS_NODE: "1", SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_STUDIO_MCP_TOOL_PROFILE: "app" },
      stderr: "pipe",
    }));
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["insert_svg_image", "update_svg_image", "insert_content", "edit_problem"]));
    expect(tools).not.toContain("insert_body_content");

    const [triangle] = skillSvgExamples();
    const files = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
    const expectedRevision = files.find((file) => file.fileId === fileId)!.revision;
    const inserted = await client.callTool({
      name: "insert_svg_image",
      arguments: { fileId, expectedRevision, targetId: firstBlockId, svg: triangle, name: "直角三角形ABC", w: 320 },
    });
    expect(inserted.isError, JSON.stringify(inserted)).not.toBe(true);
    expect(inserted.structuredContent).toMatchObject({ ok: true, data: { proposalCreated: true } });
    const proposals = await page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" }));
    expect(proposals.filter((item) => item.fileId === fileId)).toHaveLength(1);

    // 承認するまで教材本体には入らない。承認するとSVGが画像として描かれる。
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.getByRole("button", { name: "適用", exact: true }).first().click();
    await expect.poll(async () => page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })))
      .toEqual([]);

    const drawn = async () => {
      const image = page.locator("img.overlay-image-shape").first();
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml/);
      await expect(image).toHaveAttribute("alt", "直角三角形ABC");
      const box = (await image.boundingBox())!;
      // w:320 で挿入し、縦横比は viewBox(320:220) のまま。
      expect(Math.round(box.width / box.height * 100)).toBe(Math.round(320 / 220 * 100));
    };
    await drawn();
    await page.screenshot({ path: testInfo.outputPath("svg-figure-applied.png") });

    const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
    const snapshot = saved!.pageLayout!.overlay!.overlaySnapshot!;
    const image = snapshot.shapes.find((shape) => shape.type === "image")!;
    expect(image.anchor).toMatchObject({ type: "block", blockId: firstBlockId });
    const asset = snapshot.assets[(image.props as { assetId: string }).assetId]!;
    expect(asset.props.mimeType).toBe("image/svg+xml");
    expect(Buffer.from(asset.props.src.split(",")[1]!, "base64").toString()).toBe(triangle);

    // 再起動しても、SVGは保存された教材から同じように描かれる。
    await client.close();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(page.locator(".startup-splash")).toBeHidden();
    const restored = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
    const restoredSnapshot = restored!.pageLayout!.overlay!.overlaySnapshot!;
    expect(restoredSnapshot.shapes.some((shape) => shape.type === "image")).toBe(true);
    // 前回開いていた教材が開き直されるなら、そのまま描画も確かめる。
    if (await page.getByText("次の図を見て答えなさい。").first().isVisible().catch(() => false)) await drawn();
  } finally {
    await client.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
