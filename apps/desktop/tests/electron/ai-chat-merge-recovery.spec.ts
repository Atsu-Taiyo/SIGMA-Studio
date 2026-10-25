import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { AiEditRunContext } from "../../electron/ai-edit-run-context";
import { ensurePageLayout, type InlineNode, type SigmaDocument } from "@/features/document";
import { findBlock } from "@/lib/document-tree";
import { sampleDocument } from "@/lib/sample-document";

/**
 * Issue #249 (MISS R24): after one failure, continuing in the same AI chat kept ending in "conflict".
 * The real app (renderer, preload, main's approval and save, the real local MCP server) runs it; only the
 * provider and its final answer are fixtures, as in `ai-inline-approval.spec.ts`.
 *
 * 1. The AI proposes a change of a paragraph, the person deletes that paragraph in the editor, and the
 *    approval is a conflict (the target is gone). The next message of the same chat writes again: it used
 *    to fail with "現在の作業案と教材が競合しています" on every tool call. Now the change without a place
 *    is left out (and said so), the new change is approved, saved, and still there after a restart.
 * 2. The AI reads a paragraph, the person types into it, the AI writes the paragraph as it read it. The
 *    write used to be refused (REVISION_MISMATCH); now it is merged, the card says the proposal was
 *    adjusted, and the approval saves both the typing and the AI's change.
 */

const APP_ROOT = path.resolve(__dirname, "../..");

type RunRequest = { runId: string; payload: { roomId: string; turnId: string } };

function paragraphText(document: SigmaDocument | null, id: string): string | null {
  const block = document ? findBlock(document, id) : null;
  if (!block) return null;
  return ((block as { children?: InlineNode[] }).children ?? []).map((node) => (node.type === "text" ? node.text : "")).join("");
}

test("the same AI chat goes on after a failed approval, and a write merges the typing made after the AI read", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-ai-chat-merge-recovery-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const launch = () => electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  let app: ElectronApplication = await launch();
  const clients: Client[] = [];
  try {
    let page: Page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:ui-locale", "ja");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    const source = ensurePageLayout({ ...sampleDocument, docId: "ai_chat_merge_recovery", metadata: { title: "同じチャットで続ける" }, content: [
      { type: "paragraph", id: "p_first", children: [{ type: "text", text: "最初の段落です。" }] },
      { type: "paragraph", id: "p_target", children: [{ type: "text", text: "変更前の本文です。" }] },
      { type: "paragraph", id: "p_keep", children: [{ type: "text", text: "この段落はそのまま残します。" }] },
      { type: "paragraph", id: "p_human", children: [{ type: "text", text: "人が書いている段落です。" }] },
    ] });
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), source);
    const fileId = created.file.fileId;
    const diskPath = path.join(profile, "data/documents", `${fileId}.sigmadoc.json`);
    const disk = () => JSON.parse(readFileSync(diskPath, "utf8")) as SigmaDocument;
    const revision = async () => (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.fileId === fileId)!.revision;
    const pendingProposals = () => page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" }));

    // The provider fixture: every send of the chat is recorded and answered when the test says so.
    await app.evaluate(({ ipcMain }) => {
      const fixture = globalThis as typeof globalThis & { runRequests?: RunRequest[]; runResolvers?: Array<(result: unknown) => void> };
      fixture.runRequests = [];
      fixture.runResolvers = [];
      ipcMain.removeHandler("codex:get-status");
      ipcMain.handle("codex:get-status", () => ({ available: true, running: false, loggedIn: true, codexHome: "", codexBin: "codex", configuredCodexBin: null, account: { type: "chatgpt" }, error: null }));
      ipcMain.removeHandler("codex:list-models");
      ipcMain.handle("codex:list-models", () => ({ models: [{ id: "gpt-e2e-runtime", label: "UI fixture", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ id: "high" }] }] }));
      ipcMain.removeHandler("ai-edit:run");
      ipcMain.handle("ai-edit:run", (_event, runId: string, payload: { roomId: string; turnId: string }) => new Promise((resolve) => {
        fixture.runRequests!.push({ runId, payload });
        fixture.runResolvers!.push(resolve);
      }));
    });
    const targetUrl = new URL(page.url());
    targetUrl.searchParams.set("fileId", fileId);
    await page.goto(targetUrl.href);
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_target"]')).toBeVisible();

    const placeCaret = (blockId: string, at: "start" | "end") => page.evaluate(({ id, edge }) => {
      const block = document.querySelector<HTMLElement>(`.text-flow-editor [data-sigma-doc-id="${id}"]`)!;
      block.closest<HTMLElement>('[contenteditable="true"]')!.focus({ preventScroll: true });
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
      const range = document.createRange();
      if (nodes.length === 0) range.setStart(block, 0);
      else if (edge === "start") range.setStart(nodes[0]!, 0);
      else range.setStart(nodes.at(-1)!, nodes.at(-1)!.data.length);
      range.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    }, { id: blockId, edge: at });
    const sidebar = page.locator(".ai-sidebar-panel");
    const composer = sidebar.locator(".ai-chat-composer:not(.ai-chat-composer--inline)");
    /** Sends a message of the sidebar chat about `blockId` (its room stays the same between sends). */
    const send = async (blockId: string, instruction: string): Promise<RunRequest> => {
      const before = await app.evaluate(() => (globalThis as typeof globalThis & { runRequests: RunRequest[] }).runRequests.length);
      await page.locator(`.text-flow-editor [data-sigma-doc-id="${blockId}"]`).first().click();
      await expect(composer.locator(".ai-chat-chip")).toBeVisible();
      await composer.locator("textarea").fill(instruction);
      await composer.locator(".ai-chat-send-button").click();
      await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { runRequests: RunRequest[] }).runRequests.length)).toBe(before + 1);
      return app.evaluate((_electron, index) => (globalThis as typeof globalThis & { runRequests: RunRequest[] }).runRequests[index]!, before);
    };
    /** The run's MCP server, started as the desktop starts it for a turn (its own run context). */
    const mcpFor = async (request: RunRequest, selectedId: string) => {
      const contextPath = path.join(profile, "data/ai-run-context", `chatgpt-${request.runId}.run-context.json`);
      mkdirSync(path.dirname(contextPath), { recursive: true });
      const context: AiEditRunContext = { version: 1, runId: request.runId, provider: "chatgpt", fileId, fileRevision: await revision(),
        createdAt: new Date().toISOString(), selectedId, references: [], attachments: [], mentionedDocuments: [],
        roomId: request.payload.roomId, turnId: request.payload.turnId };
      writeFileSync(contextPath, JSON.stringify(context));
      const client = new Client({ name: "ai-chat-merge-recovery", version: "1" });
      await client.connect(new StdioClientTransport({
        command: await app.evaluate(() => process.execPath), args: [path.join(APP_ROOT, "dist-electron/sigma-doc-mcp-server.cjs")],
        env: { PATH: process.env.PATH ?? "", HOME: os.homedir(), ELECTRON_RUN_AS_NODE: "1", SIGMA_STUDIO_USER_DATA_DIR: profile,
          SIGMA_STUDIO_RUN_CONTEXT_FILE: contextPath, SIGMA_STUDIO_MCP_PROVIDER: "chatgpt" },
        stderr: "pipe",
      }));
      clients.push(client);
      return client;
    };
    const finishRun = (index: number) => app.evaluate((_electron, { position, nextDocument }) => {
      (globalThis as typeof globalThis & { runResolvers: Array<(result: unknown) => void> }).runResolvers[position]!({
        draft: { summary: "編集案を作りました。", plan: [], operations: [], warnings: [] },
        nextDocument, operationResults: [], logs: [], repaired: false, changedIds: [], status: "answer", agentThreadId: "ui-fixture-thread", runtime: "codex-mcp",
      });
    }, { position: index, nextDocument: source });
    const payloadOf = (result: Awaited<ReturnType<Client["callTool"]>>) => result.structuredContent as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };

    // --- 1. The same chat after the target of its proposal was deleted ---
    await page.getByRole("button", { name: "AI", exact: true }).click();
    await page.getByRole("menuitem", { name: "AIチャットを開く" }).click();
    await expect(sidebar).toBeVisible();
    const first = await send("p_target", "本文を変更してください。");
    const firstClient = await mcpFor(first, "p_target");
    const firstWrite = payloadOf(await firstClient.callTool({ name: "edit_text", arguments: { fileId, expectedRevision: await revision(), runId: first.runId,
      edit: { action: "patch", operations: [{ op: "replace_text", target: { type: "text", blockId: "p_target", text: "変更前" }, replacement: "変更後" }] } } }));
    expect(firstWrite.ok, JSON.stringify(firstWrite)).toBe(true);
    await finishRun(0);
    await expect.poll(async () => (await pendingProposals()).length).toBe(1);

    // The person joins the paragraph to the one before it in the editor (Backspace at its start): the
    // block the AI changed is gone.
    await placeCaret("p_target", "start");
    await page.keyboard.press("Backspace");
    await expect.poll(() => findBlock(disk(), "p_target"), { timeout: 20_000 }).toBeNull();
    const [stale] = await pendingProposals();
    expect(await page.evaluate((id) => window.desktopAPI!.storage.approveMcpEditProposal(id), stale!.proposalId))
      .toMatchObject({ ok: false, code: "conflict", conflictReason: "anchor-missing" });

    // The next message of the same chat.
    await page.screenshot({ path: testInfo.outputPath("after-conflict.png") });
    const second = await send("p_keep", "代わりに、この後に一文を足してください。");
    expect(second.payload.roomId).toBe(first.payload.roomId);
    const secondClient = await mcpFor(second, "p_keep");
    const secondWrite = payloadOf(await secondClient.callTool({ name: "insert_content", arguments: { fileId, expectedRevision: await revision(), runId: second.runId,
      targetId: "p_keep", content: { format: "blocks", blocks: ["AIが足した一文です。"] } } }));
    expect(secondWrite.ok, JSON.stringify(secondWrite)).toBe(true);
    expect(secondWrite.data?.roomAdjustment).toMatchObject({ droppedChanges: [expect.objectContaining({ ids: ["p_target"] })] });
    await finishRun(1);
    await expect.poll(async () => (await pendingProposals()).map((proposal) => proposal.conflict ?? null)).toEqual([null]);
    const [revised] = await pendingProposals();
    expect(revised!.warnings?.join("\n") ?? "").toContain("現在の編集内容に合わせて提案を調整しました。");
    // The proposal says it was adjusted wherever it is listed (here, the sidebar chat).
    await expect(sidebar.locator("[data-ai-proposal-merge-notice]").first()).toHaveText("現在の編集内容に合わせて提案を調整しました。");
    await page.screenshot({ path: testInfo.outputPath("continued-chat.png") });
    expect(await page.evaluate((id) => window.desktopAPI!.storage.approveMcpEditProposal(id), revised!.proposalId)).toMatchObject({ ok: true });
    await expect.poll(() => disk().content.map((block) => paragraphText(disk(), block.id))).toEqual([
      "最初の段落です。変更前の本文です。", "この段落はそのまま残します。", "AIが足した一文です。", "人が書いている段落です。",
    ]);
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_keep"] + [data-sigma-doc-id]')).toHaveText("AIが足した一文です。");

    // --- 2. A write merged with the typing made after the AI read the paragraph ---
    // The run's own target is reserved while it runs, so the AI rewrites another paragraph than the one
    // the message was sent about (the person can type there meanwhile).
    const third = await send("p_keep", "下の段落を書き直してください。");
    expect(third.payload.roomId).toBe(first.payload.roomId);
    const thirdClient = await mcpFor(third, "p_human");
    const readRevision = await revision();
    expect(payloadOf(await thirdClient.callTool({ name: "get_block", arguments: { fileId, blockId: "p_human", runId: third.runId } })).ok).toBe(true);
    await placeCaret("p_human", "end");
    await page.keyboard.insertText("【人の追記】");
    await expect.poll(() => paragraphText(disk(), "p_human"), { timeout: 20_000 }).toBe("人が書いている段落です。【人の追記】");
    // The library has the typing's revision too (the MCP server reads the revision from it).
    await expect.poll(revision).toBeGreaterThan(readRevision);
    const thirdWrite = payloadOf(await thirdClient.callTool({ name: "edit_text", arguments: { fileId, expectedRevision: readRevision, runId: third.runId,
      edit: { action: "update", blockId: "p_human", text: "AIが書き直した段落です。" } } }));
    expect(thirdWrite.ok, JSON.stringify(thirdWrite)).toBe(true);
    expect(thirdWrite.data?.readStateMerge).toMatchObject({ mergedIds: ["p_human"] });
    await finishRun(2);
    const card = page.locator('.page-flow [data-flow-extension-node-id^="extension:ai-proposal:p_human:"] > [data-ai-proposal-card="page"]');
    await expect(card.locator("[data-ai-proposal-bar-details] [data-ai-proposal-merge-notice]")).toHaveText("現在の編集内容に合わせて提案を調整しました。");
    await card.screenshot({ path: testInfo.outputPath("adjusted-card.png") });
    // 承認バーは紙面の操作の層 (図形より上) に持ち上げてある。紙面のカードはこの 1 枚だけ。
    await page.locator(".page-controls-layer > .ai-proposal-card-head").getByRole("button", { name: "適用", exact: true }).click();
    await expect.poll(async () => (await pendingProposals()).length).toBe(0);
    const merged = paragraphText(disk(), "p_human");
    expect(merged).toContain("【人の追記】");
    expect(merged).toContain("AIが書き直した");

    // --- Saved, and the same after a restart ---
    for (const client of clients) await client.close();
    clients.length = 0;
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_human"]')).toHaveText(merged!);
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_keep"]')).toHaveText("この段落はそのまま残します。");
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_target"]')).toHaveCount(0);
    expect(await page.evaluate(async () => (await window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })).length)).toBe(0);
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
