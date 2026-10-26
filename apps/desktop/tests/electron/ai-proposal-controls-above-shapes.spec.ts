import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ensurePageLayout, type SigmaDocument } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";

const APP_ROOT = path.resolve(__dirname, "../..");

/**
 * AI 提案の承認バーは紙面の図形より上の層にある (押した場所に図形が重なっていても、図形を選ばずに承認できる)。
 * 本文カードは本文フローの中に組まれるので、塗りのある図形がちょうど覆う位置に置き、実際のマウス操作で
 * 「適用」を押す。承認 → 保存 → 図形が選ばれていないことまで見る。
 */
test("the approval bar of an AI proposal stays clickable over a shape that covers it", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-ai-controls-above-shapes-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const client = new Client({ name: "ai-controls-above-shapes", version: "1" });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    const base = ensurePageLayout({ ...sampleDocument, docId: "ai_controls_above_shapes", metadata: { title: "承認バーと図形の重なり" }, content: [
      { type: "paragraph", id: "p_target", children: [{ type: "text", text: "変更前の本文です。" }] },
      { type: "paragraph", id: "p_keep", children: [{ type: "text", text: "この段落はそのまま残します。" }] },
    ] });
    // 本文の上半分を覆う塗りの四角。カードはこの下に組まれる。
    const cover = {
      id: "shape_cover",
      type: "geo",
      x: 0,
      y: 0,
      rotation: 0,
      props: { w: 760, h: 320, geo: "rectangle", fill: "solid", color: "#88aadd", labelColor: "#111111", dash: "solid", size: "m" },
    };
    const source = {
      ...base,
      pageLayout: { ...base.pageLayout, overlay: { overlaySnapshot: { version: 1, shapes: [cover], assets: {} } } },
    } as SigmaDocument;
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), source);
    const fileId = created.file.fileId;
    await page.reload();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_target"]')).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.setViewportSize({ width: 1400, height: 900 });

    await client.connect(new StdioClientTransport({
      command: await app.evaluate(() => process.execPath),
      args: [path.join(APP_ROOT, "dist-electron/sigma-doc-mcp-server.cjs")],
      env: { PATH: process.env.PATH ?? "", HOME: os.homedir(), ELECTRON_RUN_AS_NODE: "1", SIGMA_STUDIO_USER_DATA_DIR: profile },
      stderr: "pipe",
    }));
    const revision = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.fileId === fileId)!.revision;
    const result = await client.callTool({ name: "edit_text", arguments: { fileId, expectedRevision: revision,
      edit: { action: "patch", operations: [{ op: "replace_text", target: { type: "text", blockId: "p_target", text: "変更前" }, replacement: "変更後" }] } } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);

    // バーは紙面の操作の層 (図形の層より上) に描かれ、カードには見えない場所取りだけが残る。
    await expect(page.locator('[data-ai-proposal-card="page"]')).toHaveCount(1);
    const head = page.locator(".page-controls-layer > .ai-proposal-card-head");
    const approve = head.getByRole("button", { name: "適用", exact: true });
    await expect(approve).toBeVisible();
    const placeholderBox = (await page.locator('[data-ai-proposal-card="page"] [data-page-control-placeholder]').boundingBox())!;
    const headBox = (await head.boundingBox())!;
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(headBox[key] - placeholderBox[key]), key).toBeLessThanOrEqual(1);
    }
    const box = (await approve.boundingBox())!;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    // 前提: 押す場所は図形の範囲の中。
    const shapeBox = await page.locator('[data-overlay-shape-id="shape_cover"]').first().boundingBox();
    expect(shapeBox, "the cover shape is rendered").not.toBeNull();
    expect(center.x > shapeBox!.x && center.x < shapeBox!.x + shapeBox!.width && center.y > shapeBox!.y && center.y < shapeBox!.y + shapeBox!.height,
      `button ${JSON.stringify(center)} inside shape ${JSON.stringify(shapeBox)}`).toBe(true);
    // 見た目でも押せる: その点の最前面はボタン (図形ではない)。
    expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".page-controls-layer button")), center)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("approval-over-shape.png") });

    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.up();

    await expect.poll(() => page.evaluate(async () => (await window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })).length)).toBe(0);
    const diskPath = path.join(profile, "data/documents", `${fileId}.sigmadoc.json`);
    await expect.poll(() => readFileSync(diskPath, "utf8")).toContain("変更後の本文です。");
    await expect(page.locator(".overlay-shape.selected")).toHaveCount(0);
    await expect(page.locator(".overlay-canvas-editor")).toHaveCount(0);
  } finally {
    await client.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
