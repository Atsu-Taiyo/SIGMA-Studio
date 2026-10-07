import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AiEditRunContext } from "../../electron/ai-edit-run-context";
import { ensurePageLayout } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";

const APP_ROOT = path.resolve(__dirname, "../..");

// Only provider availability and its final answer are fixtures. Proposals, their attribution,
// approval, persistence, preload, and renderer all use the real desktop implementation.
test("a long floating answer keeps approval reachable after resizing and saves through a restart", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-inline-approval-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const launch = () => electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  let app = await launch();
  const client = new Client({ name: "inline-approval-regression", version: "1" });
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    const source = ensurePageLayout({ ...sampleDocument, docId: "inline_approval", metadata: { title: "承認ボタンの実機検証" }, content: [
      { type: "paragraph", id: "p_target", children: [{ type: "text", text: "変更前の本文です。" }] },
      { type: "paragraph", id: "p_keep", children: [{ type: "text", text: "この段落はそのまま残します。" }] },
    ] });
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), source);
    const fileId = created.file.fileId;
    const originalFileIds = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).map((file) => file.fileId).sort();
    await app.evaluate(({ ipcMain }) => {
      const fixture = globalThis as typeof globalThis & {
        inlineApprovalRequest?: { runId: string; payload: { roomId: string; turnId: string } };
        resolveInlineApproval?: (result: unknown) => void;
      };
      ipcMain.removeHandler("codex:get-status");
      ipcMain.handle("codex:get-status", () => ({ available: true, running: false, loggedIn: true, codexHome: "", codexBin: "codex", configuredCodexBin: null, account: { type: "chatgpt" }, error: null }));
      ipcMain.removeHandler("codex:list-models");
      ipcMain.handle("codex:list-models", () => ({ models: [{ id: "gpt-e2e-runtime", label: "UI fixture", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ id: "high" }] }] }));
      ipcMain.removeHandler("ai-edit:run");
      ipcMain.handle("ai-edit:run", (_event, runId: string, payload: { roomId: string; turnId: string }) => new Promise((resolve) => {
        fixture.inlineApprovalRequest = { runId, payload };
        fixture.resolveInlineApproval = resolve;
      }));
    });
    await page.reload();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_target"]')).toBeVisible();
    await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.text-flow-editor [data-sigma-doc-id="p_target"]')!;
      block.closest<HTMLElement>('[contenteditable="true"]')!.focus();
      const range = document.createRange();
      range.selectNodeContents(block);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.locator('.selection-action-popover button[aria-label="AIに追加"]').click();
    const composer = page.locator(".ai-chat-composer--inline");
    await composer.locator("textarea").fill("本文を変更してください。");
    await composer.locator(".ai-chat-send-button").click();
    await expect.poll(() => app.evaluate(() => Boolean((globalThis as typeof globalThis & { inlineApprovalRequest?: unknown }).inlineApprovalRequest))).toBe(true);
    const request = await app.evaluate(() => (globalThis as typeof globalThis & { inlineApprovalRequest: { runId: string; payload: { roomId: string; turnId: string } } }).inlineApprovalRequest);
    expect(request.payload.roomId).toBeTruthy();
    expect(request.payload.turnId).toBeTruthy();
    const revision = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.fileId === fileId)!.revision;
    expect(request.runId).toMatch(/^[a-zA-Z0-9_-]+$/);
    const contextPath = path.join(profile, "data/ai-run-context", `chatgpt-${request.runId}.run-context.json`);
    mkdirSync(path.dirname(contextPath), { recursive: true });
    const context: AiEditRunContext = { version: 1, runId: request.runId, provider: "chatgpt", fileId, fileRevision: revision,
      createdAt: new Date().toISOString(), selectedId: "p_target", references: [], attachments: [], mentionedDocuments: [],
      roomId: request.payload.roomId, turnId: request.payload.turnId };
    writeFileSync(contextPath, JSON.stringify(context));
    await client.connect(new StdioClientTransport({
      command: await app.evaluate(() => process.execPath), args: [path.join(APP_ROOT, "dist-electron/sigma-doc-mcp-server.cjs")],
      env: { PATH: process.env.PATH ?? "", HOME: os.homedir(), ELECTRON_RUN_AS_NODE: "1", SIGMA_STUDIO_USER_DATA_DIR: profile,
        SIGMA_STUDIO_MCP_TOOL_PROFILE: "app", SIGMA_STUDIO_RUN_CONTEXT_FILE: contextPath, SIGMA_STUDIO_MCP_PROVIDER: "chatgpt" },
      stderr: "pipe",
    }));
    const result = await client.callTool({ name: "edit_text", arguments: { fileId, expectedRevision: revision, runId: request.runId,
      edit: { action: "patch", operations: [{ op: "replace_text", target: { type: "text", blockId: "p_target", text: "変更前" }, replacement: "変更後" }] } } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: true });
    await app.evaluate((_electron, nextDocument) => {
      (globalThis as typeof globalThis & { resolveInlineApproval: (result: unknown) => void }).resolveInlineApproval({
        draft: { summary: Array.from({ length: 45 }, (_, i) => `### 確認事項 ${i + 1}\n長い回答でも変更内容と承認操作を確認できます。`).join("\n\n"), plan: [], operations: [], warnings: [] },
        nextDocument, operationResults: [], logs: [], repaired: false, changedIds: [], status: "answer", agentThreadId: "ui-fixture-thread", runtime: "codex-mcp",
      });
    }, source);
    const card = page.locator(".ai-inline-result");
    const approval = card.getByRole("button", { name: "適用", exact: true });
    await expect(approval).toBeVisible();
    for (const size of [[1500, 950], [800, 600]]) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), size);
      await expect.poll(() => approval.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      })).toBe(true);
      const content = card.locator(".ai-inline-result-content");
      expect(await content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(approval).toBeInViewport({ ratio: 1 });
    }
    await page.screenshot({ path: testInfo.outputPath("long-answer-approval.png") });
    await approval.click();
    await expect.poll(() => page.evaluate(async () => (await window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })).length)).toBe(0);
    const diskPath = path.join(profile, "data/documents", `${fileId}.sigmadoc.json`);
    await expect.poll(() => readFileSync(diskPath, "utf8")).toContain("変更後の本文です。");
    await client.close();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_target"]')).toHaveText("変更後の本文です。");
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_keep"]')).toHaveText("この段落はそのまま残します。");
    await expect.poll(() => page.evaluate(async () => (await window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })).length)).toBe(0);
    expect((await page.evaluate(() => window.desktopAPI!.storage.listFiles())).map((file) => file.fileId).sort()).toEqual(originalFileIds);
  } finally {
    await client.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
