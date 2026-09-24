import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");

test("AI typography reaches Electron, saved documents, and restart through the real MCP tools", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-ai-typography-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const launch = () => electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  let app = await launch();
  const client = new Client({ name: "ai-typography-regression", version: "1" });
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    const source = ensurePageLayout({ ...sampleDocument, docId: "ai_typography", metadata: { title: "AI書式の回帰確認", styleUnits: { fontSize: "pt" } }, content: [
      { type: "paragraph", id: "unchanged", children: [{ type: "text", text: "変更しない本文" }] },
    ] });
    source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
      id: "ai_shape", type: "text", x: 100, y: 260, rotation: 0,
      props: { w: 260, h: 40, color: "#111111", size: "m", blocks: [{ type: "paragraph", id: "shape_p", children: [
        { type: "text", text: "図中文字", fontSize: 9, fontFamily: "serif", marks: ["bold"] },
      ] }] },
    }] } };
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), source);
    await page.reload();
    await expect(page.locator('[data-sigma-doc-id="unchanged"]').first()).toBeVisible();
    await client.connect(new StdioClientTransport({
      command: await app.evaluate(() => process.execPath),
      args: [path.join(APP_ROOT, "dist-electron/sigma-doc-mcp-server.cjs")],
      env: { PATH: process.env.PATH ?? "", HOME: os.homedir(), ELECTRON_RUN_AS_NODE: "1", SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_STUDIO_MCP_TOOL_PROFILE: "app" },
      stderr: "pipe",
    }));
    const fileId = created.file.fileId;
    const apply = async (name: string, args: Record<string, unknown>) => {
      const files = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
      const expectedRevision = files.find((file) => file.fileId === fileId)!.revision;
      const result = await client.callTool({ name, arguments: { fileId, expectedRevision, ...args } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true });
      const proposals = await page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" }));
      const proposal = proposals.find((item) => item.fileId === fileId)!;
      expect(proposal).toBeDefined();
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden();
      await page.getByRole("button", { name: "適用", exact: true }).first().click();
      await expect.poll(async () => page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })))
        .toEqual([]);
    };
    await apply("insert_content", { targetId: "END_OF_DOCUMENT", content: { format: "blocks", blocks: [{
      type: "paragraph", id: "ai_styled", fontFamily: "Noto Serif JP", fontSize: 18,
      runs: ["AI生成本文 ", { type: "math", tex: "x+1" }, { text: " 注記", fontSize: 9 }],
    }] } });
    await apply("update_shape", { shapeId: "ai_shape", fontSize: 18 });
    const verify = async () => {
      await expect(page.locator(".startup-splash")).toBeHidden();
      const body = page.locator('[data-sigma-doc-id="ai_styled"]').first();
      await expect(body).toBeVisible();
      await expect(body.getByText("AI生成本文", { exact: false }).first()).toHaveCSS("font-size", "24px");
      await expect(body.getByText("AI生成本文", { exact: false }).first()).toHaveCSS("font-family", /Noto Serif JP/);
      await expect(body.getByText("注記", { exact: false }).first()).toHaveCSS("font-size", "12px");
      const shape = page.locator('.overlay-shape-text[data-overlay-shape-id="ai_shape"]');
      await expect(shape.getByText("図中文字", { exact: true }).first()).toHaveCSS("font-size", "24px");
      const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
      expect(saved!.content[0]).toEqual(source.content[0]);
      expect(saved!.content[1]).toMatchObject({ children: [
        { text: "AI生成本文 ", fontFamily: "Noto Serif JP", fontSize: 18 },
        { type: "mathInline", fontFamily: "Noto Serif JP", fontSize: 18 },
        { text: " 注記", fontFamily: "Noto Serif JP", fontSize: 9 },
      ] });
    };
    await page.reload();
    await verify();
    await page.screenshot({ path: testInfo.outputPath("ai-typography.png") });
    await client.close();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await verify();
  } finally {
    await client.close();
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
