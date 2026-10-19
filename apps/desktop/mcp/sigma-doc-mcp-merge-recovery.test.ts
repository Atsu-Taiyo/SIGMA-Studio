import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSigmaDocMcpServer } from "./sigma-doc-mcp-server-core";
import { BODY_IMPLEMENTATION_ROUTES, type BodyImplementationName } from "./sigma-doc-mcp-app-tools";
import { LocalAiEditRunContextStore } from "../electron/ai-edit-run-context";
import { LocalMcpEditProposalStore } from "../electron/local-sigma-doc-proposal-store";
import { LocalSigmaDocStore } from "../electron/local-sigma-doc-store";
import { createProposalApprovalCoordinator } from "../electron/proposal-approval";
import type { SigmaDocument } from "@/features/document";
import { createTranslator } from "@/lib/i18n";
import { deleteBlocksFromDocument, findBlock, updateBlockInDocument } from "@/lib/document-tree";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";

/**
 * Issue #249: after one failure the same AI chat kept reporting "conflict", and a write was refused
 * because the human had edited what the AI read. These cases run the real MCP server, proposal store
 * and approval on a local document, and check what is saved.
 */

const ENV_KEYS = ["SIGMA_STUDIO_DATA_DIR", "SIGMA_STUDIO_USER_DATA_DIR", "SIGMA_STUDIO_RUN_CONTEXT_FILE", "SIGMA_STUDIO_MCP_PROVIDER"] as const;
const LONG_TEXT = "一二三四五六七八九十。この段落は途中を人が直しても両端をAIが直せる長さにしてある。終わり";

const paragraph = (id: string, text: string) => ({ id, type: "paragraph" as const, children: [{ type: "text" as const, text }] });

function fixtureDocument(): SigmaDocument {
  return parseSigmaDocument({
    version: "2.0",
    docId: "doc_merge_recovery",
    metadata: { title: "合成の確認" },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    content: [
      paragraph("p_1", "第1段落。"),
      paragraph("p_2", "第2段落はAIが直す。"),
      paragraph("p_3", "第3段落。"),
      paragraph("p_4", "第4段落。"),
      paragraph("p_5", "第5段落は人が直す。"),
      paragraph("p_long", LONG_TEXT),
    ],
  });
}

function payloadOf(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
  if (structured.ok === true) {
    return { ...(structured.data as Record<string, unknown>), ok: true, message: structured.message };
  }
  const error = structured.error as Record<string, unknown>;
  return { ...((error.details as Record<string, unknown> | undefined) ?? {}), ok: false, error: error.message, errorCode: error.code };
}

function bodyToolCall(implementation: BodyImplementationName, args: Record<string, unknown>) {
  const route = BODY_IMPLEMENTATION_ROUTES[implementation];
  const common = new Set(["fileId", "expectedRevision", "runId", "writeMode", "sourceReferences"]);
  if (!("action" in route)) {
    const { blocks, ...rest } = args;
    return { name: route.name, arguments: { ...rest, ...(blocks === undefined ? {} : { content: { format: "blocks", blocks } }) } };
  }
  const root = Object.fromEntries(Object.entries(args).filter(([key]) => common.has(key)));
  const edit = Object.fromEntries(Object.entries(args).filter(([key]) => !common.has(key)));
  return { name: route.name, arguments: { ...root, edit: { action: route.action, ...edit } } };
}

const textOf = (document: SigmaDocument, id: string) => {
  const block = findBlock(document, id) as { children?: Array<{ text?: string }> } | null;
  return block?.children?.map((child) => child.text ?? "").join("") ?? null;
};
const withText = (id: string, text: string) => (document: SigmaDocument) => updateBlockInDocument(
  document,
  id,
  (block) => ({ ...block, children: [{ type: "text", text }] } as never),
);

describe("AI edits merged with the human's edits (issue #249)", () => {
  let userDataDir: string;
  let client: Client;
  let fileId: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-merge-recovery-"));
    const store = new LocalSigmaDocStore(userDataDir);
    await store.initializeWorkspace({ initialDocument: fixtureDocument() });
    fileId = (await store.listFiles())[0]!.fileId;
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "claude";
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = new LocalAiEditRunContextStore(userDataDir, "claude").getRunContextFilePath();
    const server = createSigmaDocMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "merge-recovery", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  /** A turn of the same chat (room): each turn is its own run, as the desktop starts them. */
  async function startTurn(runId: string): Promise<number> {
    const revision = await currentRevision();
    await new LocalAiEditRunContextStore(userDataDir, "claude", { runId }).write({
      version: 1, runId, createdAt: new Date().toISOString(), provider: "claude", fileId, fileRevision: revision,
      selectedId: null, references: [], attachments: [], mentionedDocuments: [], roomId: "room_merge", turnId: runId,
    });
    return revision;
  }
  async function currentRevision(): Promise<number> {
    return (await new LocalSigmaDocStore(userDataDir).listFiles()).find((file) => file.fileId === fileId)!.revision;
  }
  async function loadDocument(): Promise<SigmaDocument> {
    return (await new LocalSigmaDocStore(userDataDir).loadDocument(fileId))!;
  }
  /** The human's edit, saved as the editor's autosave does. */
  async function humanSaves(edit: (document: SigmaDocument) => SigmaDocument): Promise<number> {
    const store = new LocalSigmaDocStore(userDataDir);
    const result = await store.saveDocument(fileId, edit(await loadDocument()), { expectedRevision: await currentRevision() });
    expect(result.ok).toBe(true);
    return result.revision!;
  }
  async function pendingProposals() {
    const store = new LocalMcpEditProposalStore(userDataDir);
    const listed = await store.listProposals({ status: "pending" });
    return Promise.all(listed.map(async (proposal) => (await store.loadProposal(proposal.proposalId))!));
  }
  function approve(proposalId: string) {
    return createProposalApprovalCoordinator({
      localSigmaDocStore: new LocalSigmaDocStore(userDataDir),
      localMcpProposalStore: new LocalMcpEditProposalStore(userDataDir),
      broadcastLocalStoreChange: () => {},
      runPostSaveHooks: async () => {},
      translate: createTranslator("ja", "error"),
    }).approveSingleProposal(proposalId);
  }
  const read = (blockId: string, runId: string) => client.callTool({ name: "get_block", arguments: { fileId, blockId, runId } });
  const updateText = (blockId: string, text: string, expectedRevision: number, runId: string) => client.callTool(
    bodyToolCall("update_rich_content", { fileId, blockId, text, expectedRevision, runId }),
  );
  const insertParagraph = (text: string, expectedRevision: number, runId: string) => client.callTool(
    bodyToolCall("insert_body_content", { fileId, targetId: "END_OF_DOCUMENT", expectedRevision, blocks: [text], runId }),
  );

  it("keeps the chat working after a change of it lost its target, and says what it left out", async () => {
    const revision = await startTurn("run_1");
    expect(payloadOf(await updateText("p_2", "第2段落をAIが直した。", revision, "run_1")).ok).toBe(true);
    await humanSaves((document) => deleteBlocksFromDocument(document, ["p_2"]));
    const [stale] = await pendingProposals();
    // Approving now is a conflict: the AI's target is gone (nothing is decided for the person).
    expect(await approve(stale!.proposalId)).toMatchObject({ ok: false, code: "conflict", conflictReason: "anchor-missing" });

    // The same chat goes on. Before, every write failed with "現在の作業案と教材が競合しています".
    const next = await startTurn("run_2");
    const first = payloadOf(await insertParagraph("次の依頼の段落", next, "run_2"));
    expect(first.ok).toBe(true);
    expect(first.roomAdjustment).toMatchObject({ droppedChanges: [expect.objectContaining({ ids: ["p_2"], reason: "anchor-missing" })] });
    expect((first.toolResult as { message: string }).message).toContain("現在の編集内容に合わせて提案を調整しました。");
    const second = payloadOf(await insertParagraph("もう一つ", next, "run_2"));
    expect(second.ok).toBe(true);

    const [proposal] = await pendingProposals();
    expect(proposal!.conflict).toBeUndefined();
    expect(proposal!.draft.warnings.join("\n")).toContain("現在の編集内容に合わせて提案を調整しました。");
    expect(await approve(proposal!.proposalId)).toMatchObject({ ok: true });
    const document = await loadDocument();
    expect(findBlock(document, "p_2")).toBeNull();
    expect(document.content.map((block) => textOf(document, block.id))).toEqual(expect.arrayContaining(["次の依頼の段落", "もう一つ"]));
  });

  it("merges a write with the human's edit made after the AI read the paragraph", async () => {
    const revision = await startTurn("run_1");
    expect(payloadOf(await read("p_2", "run_1")).ok).toBe(true);
    await humanSaves(withText("p_2", "人の追記。第2段落はAIが直す。"));

    const written = payloadOf(await updateText("p_2", "第2段落はAIが直した。", revision, "run_1"));

    // Before: REVISION_MISMATCH ("対象ブロックが編集されているため"), and the AI had to read and write again.
    expect(written.ok).toBe(true);
    expect(written.readStateMerge).toMatchObject({ mergedIds: ["p_2"] });
    const [proposal] = await pendingProposals();
    expect(proposal!.mergeCarry?.humanEditedUnits).toEqual(["p_2"]);
    expect(await approve(proposal!.proposalId)).toMatchObject({ ok: true, mergeReport: { humanEditedUnits: ["p_2"] } });
    expect(textOf(await loadDocument(), "p_2")).toBe("人の追記。第2段落はAIが直した。");
  });

  it("applies only the AI's paragraph and keeps the human's edit of another paragraph, before and after the write", async () => {
    const revision = await startTurn("run_1");
    await read("p_2", "run_1");
    await humanSaves(withText("p_5", "第5段落は人が直した。"));
    expect(payloadOf(await updateText("p_2", "第2段落はAIが直した。", revision, "run_1")).ok).toBe(true);
    await humanSaves(withText("p_5", "第5段落は人が直した。さらに追記。"));

    const [proposal] = await pendingProposals();
    expect(await approve(proposal!.proposalId)).toMatchObject({ ok: true });
    const document = await loadDocument();
    expect(textOf(document, "p_2")).toBe("第2段落はAIが直した。");
    expect(textOf(document, "p_5")).toBe("第5段落は人が直した。さらに追記。");
    expect(textOf(document, "p_1")).toBe("第1段落。");
  });

  it("does not replace the untouched middle when the AI changed both ends of a paragraph the human typed into", async () => {
    const revision = await startTurn("run_1");
    await read("p_long", "run_1");
    // The human types in the middle after the AI read it, and again after the AI wrote.
    await humanSaves(withText("p_long", LONG_TEXT.replace("途中を", "途中を【人1】")));
    const aiText = `【AI先頭】${LONG_TEXT.replace("終わり", "おしまい")}`;
    expect(payloadOf(await updateText("p_long", aiText, revision, "run_1")).ok).toBe(true);
    await humanSaves(withText("p_long", LONG_TEXT.replace("途中を", "途中を【人1】").replace("両端を", "両端を【人2】")));

    const [proposal] = await pendingProposals();
    expect(await approve(proposal!.proposalId)).toMatchObject({ ok: true });
    expect(textOf(await loadDocument(), "p_long")).toBe(
      `【AI先頭】${LONG_TEXT.replace("途中を", "途中を【人1】").replace("両端を", "両端を【人2】").replace("終わり", "おしまい")}`,
    );
  });

  it("still asks the AI to re-read a target it never read in this run that the human changed", async () => {
    const revision = await humanSaves((document) => document);
    await startTurn("run_1");
    await humanSaves(withText("p_2", "人が直した第2段落。"));

    const written = payloadOf(await updateText("p_2", "AIが上書き", revision, "run_1"));

    // What the AI saw of p_2 is unknown, so the write is not merged blindly (the human's edit stays).
    expect(written).toMatchObject({ ok: false, errorCode: "REVISION_MISMATCH", conflictBlockIds: ["p_2"] });
    expect(await pendingProposals()).toHaveLength(0);
  });

  it("does not insert twice when an approval reached the document but the proposal stayed pending", async () => {
    const revision = await startTurn("run_1");
    expect(payloadOf(await client.callTool({
      name: "insert_shape",
      arguments: { fileId, targetId: "p_3", id: "ai_shape_once", kind: "rectangle", x: 100, y: 120, expectedRevision: revision, runId: "run_1" },
    })).ok).toBe(true);
    const [pending] = await pendingProposals();
    // The approval saved the document, but its answer was lost before the proposal was resolved.
    await humanSaves(() => pending!.nextDocument);

    const next = await startTurn("run_2");
    expect(payloadOf(await insertParagraph("次の依頼", next, "run_2")).ok).toBe(true);
    const [proposal] = await pendingProposals();
    expect(await approve(proposal!.proposalId)).toMatchObject({ ok: true });

    const document = await loadDocument();
    expect(document.pageLayout?.overlay?.overlaySnapshot?.shapes.filter((shape) => shape.id === "ai_shape_once")).toHaveLength(1);
    expect(document.content.some((block) => textOf(document, block.id) === "次の依頼")).toBe(true);
  });
});
