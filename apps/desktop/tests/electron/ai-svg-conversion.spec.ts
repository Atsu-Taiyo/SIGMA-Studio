import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout, type OverlayShape } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const SVG_SKILL = path.join(APP_ROOT, "electron/official-skills/sigma-svg-figure/SKILL.md");

/** The skill's figure with text, math (θ), a V arrow, a Q arc, a rotated block and a dashed line. */
function slopeFigure(): string {
  const figures = [...readFileSync(SVG_SKILL, "utf8").matchAll(/```svg\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());
  return figures.find((svg) => svg.includes("θ"))!;
}

async function ink(png: Buffer) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, dark: Uint8Array.from({ length: image.width * image.height }, (_, i) => 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2] < 140 ? 1 : 0) };
}

/** The share of `from`'s dark pixels with a dark pixel of `to` within 3px. */
function overlap(from: Awaited<ReturnType<typeof ink>>, to: Awaited<ReturnType<typeof ink>>) {
  let total = 0, kept = 0;
  for (let y = 0; y < from.height; y++) for (let x = 0; x < from.width; x++) {
    if (!from.dark[y * from.width + x]) continue;
    total++;
    search: for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const px = x + dx, py = y + dy;
      if (px >= 0 && py >= 0 && px < to.width && py < to.height && to.dark[py * to.width + px]) { kept++; break search; }
    }
  }
  return kept / Math.max(1, total);
}

test("convert_svg_image measures with the app, is approved like any proposal, matches the canvas conversion and is saved", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-ai-svg-conversion-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const source = ensurePageLayout({
    ...sampleDocument, docId: "ai_svg_conversion", metadata: { title: "SVG変換の確認" },
    content: [{ type: "paragraph", id: "before_figure", children: [{ type: "text", text: "次の図を見て答えなさい。" }] }],
  });
  const sourceFile = path.join(profile, "SVG変換の確認.sigma");
  writeFileSync(sourceFile, JSON.stringify(source));
  const launch = (openFile?: string) => electron.launch({ args: openFile ? [APP_ROOT, openFile] : [APP_ROOT], cwd: APP_ROOT, env });
  let app = await launch(sourceFile);
  const client = new Client({ name: "ai-svg-conversion", version: "1" });
  try {
    let page: Page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    await page.reload();
    await expect(page.getByText("次の図を見て答えなさい。").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".startup-splash")).toBeHidden();
    const fileId = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.title === "SVG変換の確認")!.fileId;
    const saved = async () => (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!.pageLayout!.overlay!.overlaySnapshot!;
    const revision = async () => (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.fileId === fileId)!.revision;
    const approve = async () => {
      await page.getByRole("button", { name: "適用", exact: true }).first().click();
      await expect.poll(() => page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" }))).toEqual([]);
      // Let the approval's animation and highlight finish before the page is measured.
      await page.waitForTimeout(1500);
    };

    // The MCP server the AI talks to, pointed at this app's render bridge.
    const bridgeFile = path.join(profile, "data", "ai-run-context", "render-bridge.json");
    await expect.poll(() => existsSync(bridgeFile)).toBe(true);
    await client.connect(new StdioClientTransport({
      command: await app.evaluate(() => process.execPath),
      args: [path.join(APP_ROOT, "dist-electron/sigma-doc-mcp-server.cjs")],
      env: { PATH: process.env.PATH ?? "", HOME: os.homedir(), ELECTRON_RUN_AS_NODE: "1", SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_STUDIO_RENDER_BRIDGE_FILE: bridgeFile },
      stderr: "pipe",
    }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: { fileId, expectedRevision: await revision(), ...args } });
      expect(result.isError, JSON.stringify(result).slice(0, 2000)).not.toBe(true);
      return (result.structuredContent as { data: Record<string, unknown> }).data;
    };
    const svg = slopeFigure();
    const insertApproved = async (args: Record<string, unknown>) => {
      await call("insert_svg_image", { svg, name: "斜面と重力", ...args });
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden();
      await approve();
      return (await saved()).shapes.filter((shape) => shape.type === "image").at(-1)!;
    };

    // 1. The figure as the AI drew it, approved.
    const image = await insertApproved({ targetId: "before_figure" });
    // The approval's transition can briefly draw the new image twice: measure the first.
    const frame = page.locator(`.overlay-shape-image[data-overlay-shape-id="${image.id}"]`).first();
    await expect.poll(() => frame.locator("img").first().evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
    await frame.scrollIntoViewIfNeeded();
    await page.mouse.move(20, 100);
    await page.waitForTimeout(500);
    const box = (await frame.boundingBox())!;
    const clip = { x: Math.round(box.x) - 4, y: Math.round(box.y) - 4, width: Math.round(box.width) + 8, height: Math.round(box.height) + 8 };
    const before = await page.screenshot({ clip, path: testInfo.outputPath("ai-conversion-before.png") });

    // 2. convert_svg_image: measured by the app's hidden print page, proposed, not yet applied.
    const converted = await call("convert_svg_image", { shapeId: image.id });
    expect(converted.verification).toMatchObject({ validation: { ok: true }, svgConversion: { source: "app-bridge", warnings: [] } });
    expect(converted.toolResult).toMatchObject({ data: { conversion: { measurement: "app", keptAsSvgCount: 0, groupId: image.id } } });
    expect((await saved()).shapes.find((shape) => shape.id === image.id)?.type).toBe("image");

    // 3. The user approves it like any other proposal.
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("ai-conversion-pending.png") });
    await approve();
    const afterApproval = await saved();
    expect(afterApproval.shapes.find((shape) => shape.id === image.id)?.type).toBe("group");
    expect(afterApproval.shapes.filter((shape) => shape.type === "image")).toEqual([]);
    const parts = afterApproval.shapes.filter((shape) => shape.parentId === image.id);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.some((shape) => shape.type === "text" && shape.props.blocks.some((block) => block.type === "paragraph"
      && block.children.some((child) => child.type === "mathInline")))).toBe(true);

    // 4. It looks the same as the SVG did.
    await page.mouse.move(20, 100);
    await page.waitForTimeout(500);
    const after = await page.screenshot({ clip, path: testInfo.outputPath("ai-conversion-after.png") });
    const [a, b] = [await ink(before), await ink(after)];
    expect(overlap(a, b), "ink of the SVG found after the conversion").toBeGreaterThan(0.95);
    expect(overlap(b, a), "ink after the conversion found in the SVG").toBeGreaterThan(0.95);

    // 5. The same figure converted from the canvas menu lands on the same geometry: the app measured both.
    const copy = await insertApproved({ targetId: "before_figure", x: 120, y: 700 });
    const copyFrame = page.locator(`.overlay-shape-image[data-overlay-shape-id="${copy.id}"]`).first();
    await expect.poll(() => copyFrame.locator("img").first().evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
    await copyFrame.scrollIntoViewIfNeeded();
    const copyBox = (await copyFrame.boundingBox())!;
    await page.mouse.click(copyBox.x + copyBox.width / 2, copyBox.y + copyBox.height / 2, { button: "right" });
    await page.getByRole("menuitem", { name: "図形に変換", exact: true }).click();
    await expect(page.getByTestId("svg-conversion-message")).toContainText("個の図形に変換しました");
    await expect.poll(async () => (await saved()).shapes.find((shape) => shape.id === copy.id)?.type).toBe("group");
    const final = await saved();
    const geometry = (groupId: string, origin: OverlayShape) => final.shapes.filter((shape) => shape.parentId === groupId)
      .map((shape) => ({ type: shape.type, x: shape.x - origin.x, y: shape.y - origin.y, w: "w" in shape.props ? shape.props.w : 0, h: "h" in shape.props ? shape.props.h : 0 }));
    const viaTool = geometry(image.id, image), viaCanvas = geometry(copy.id, copy);
    expect(viaTool.map((part) => part.type)).toEqual(viaCanvas.map((part) => part.type));
    viaTool.forEach((part, index) => {
      for (const key of ["x", "y", "w", "h"] as const) expect(Math.abs(part[key] - viaCanvas[index]![key]), `${part.type} ${key}`).toBeLessThan(0.5);
    });

    // 6. Saved: reopening shows the converted figure.
    await client.close();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const reopened = (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!.pageLayout!.overlay!.overlaySnapshot!;
    expect(reopened.shapes.find((shape) => shape.id === image.id)?.type).toBe("group");
    expect(reopened.shapes.filter((shape) => shape.parentId === image.id)).toHaveLength(parts.length);
  } finally {
    await client.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
