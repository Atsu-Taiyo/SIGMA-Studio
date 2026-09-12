import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LocalAiEditRunContextStore,
  loadAiEditRunContext,
  prepareAiEditRunContext,
  runContextDirPath,
  sweepOrphanPerRunContextFiles,
  toolActivityFileName,
  visualSessionsFileName,
  SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV,
  type AiEditRunContext,
} from "./ai-edit-run-context";
import { LocalSigmaDocStore } from "./local-sigma-doc-store";
import { findBlock } from "@/lib/document-tree";
import { sampleDocument } from "@/lib/sample-document";
import { computeDocumentBlockHashes } from "@/lib/sigma-doc-block-hash";

describe("loadAiEditRunContext / LocalAiEditRunContextStore", () => {
  let userDataDir: string;
  let store: LocalAiEditRunContextStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-run-context-"));
    store = new LocalAiEditRunContextStore(userDataDir, "claude");
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  const validContext: AiEditRunContext = {
    version: 1,
    runId: "run_1",
    createdAt: "2026-07-02T00:00:00.000Z",
    provider: "claude",
    fileId: "file_1",
    fileRevision: 1,
    selectedId: "block_1",
    references: [{ kind: "block", targetId: "block_1" }],
    attachments: [],
    mentionedDocuments: [],
  };

  it("roundtrips a written context through loadAiEditRunContext", async () => {
    await store.write(validContext);
    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: store.getRunContextFilePath(),
    });

    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context).toEqual(validContext);
    }
  });

  it("returns state:none when the env var is unset or blank", () => {
    expect(loadAiEditRunContext({}).state).toBe("none");
    expect(loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: "  " }).state).toBe("none");
  });

  it("returns state:none when the env var is set but the file is missing", () => {
    const missingPath = path.join(userDataDir, "does-not-exist.json");
    expect(loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: missingPath }).state).toBe("none");
  });

  it("returns state:invalid with a non-empty error when the file is not valid JSON", async () => {
    const filePath = path.join(userDataDir, "bad.json");
    await fs.writeFile(filePath, "{not json", "utf8");

    const result = loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: filePath });
    expect(result.state).toBe("invalid");
    if (result.state === "invalid") {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns state:invalid when the JSON fails schema validation", async () => {
    const filePath = path.join(userDataDir, "invalid-schema.json");
    await fs.writeFile(filePath, JSON.stringify({ ...validContext, fileId: undefined, version: 2 }), "utf8");

    const result = loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: filePath });
    expect(result.state).toBe("invalid");
    if (result.state === "invalid") {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("clear() deletes the file, is idempotent, and subsequent loads report none", async () => {
    await store.write(validContext);
    await store.clear();
    await expect(store.clear()).resolves.not.toThrow();

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: store.getRunContextFilePath(),
    });
    expect(result.state).toBe("none");
  });
});

describe("LocalAiEditRunContextStore per-provider file paths", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-run-context-provider-"));
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("pins the claude run-context file path (regression)", () => {
    const store = new LocalAiEditRunContextStore(userDataDir, "claude");
    expect(store.getRunContextFilePath()).toBe(
      path.join(userDataDir, "data", "ai-run-context", "claude.run-context.json"),
    );
  });

  it("uses a chatgpt.run-context.json path under ai-run-context for the chatgpt provider", () => {
    const store = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    expect(store.getRunContextFilePath().endsWith(path.join("ai-run-context", "chatgpt.run-context.json"))).toBe(
      true,
    );
  });

  it("uses an antigravity.run-context.json path under ai-run-context for the Antigravity provider", () => {
    const store = new LocalAiEditRunContextStore(userDataDir, "antigravity");
    expect(store.getRunContextFilePath().endsWith(path.join("ai-run-context", "antigravity.run-context.json"))).toBe(
      true,
    );
  });
});

describe("prepareAiEditRunContext per-provider isolation", () => {
  let userDataDir: string;
  let sigmaDocStore: LocalSigmaDocStore;
  let claudeStore: LocalAiEditRunContextStore;
  let chatgptStore: LocalAiEditRunContextStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-run-context-isolation-"));
    sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });
    claudeStore = new LocalAiEditRunContextStore(userDataDir, "claude");
    chatgptStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("writes provider: chatgpt and round-trips through loadAiEditRunContext", async () => {
    const files = await sigmaDocStore.listFiles();
    const fileId = files[0]?.fileId;

    await prepareAiEditRunContext({
      provider: "chatgpt",
      runContextStore: chatgptStore,
      sigmaDocStore,
      runId: "run_chatgpt",
      payload: { fileId },
    });

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: chatgptStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context.provider).toBe("chatgpt");
      expect(result.context.runId).toBe("run_chatgpt");
    }
  });

  it("writes provider: antigravity and round-trips through loadAiEditRunContext", async () => {
    const geminiStore = new LocalAiEditRunContextStore(userDataDir, "antigravity");
    const files = await sigmaDocStore.listFiles();
    const fileId = files[0]?.fileId;

    await prepareAiEditRunContext({
      provider: "antigravity",
      runContextStore: geminiStore,
      sigmaDocStore,
      runId: "run_antigravity",
      payload: { fileId },
    });

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: geminiStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context.provider).toBe("antigravity");
      expect(result.context.runId).toBe("run_antigravity");
    }
  });

  it("keeps claude and chatgpt run-context files independent: each holds its own payload, cleanup of one leaves the other", async () => {
    const files = await sigmaDocStore.listFiles();
    const fileId = files[0]?.fileId;

    const claudeCleanup = await prepareAiEditRunContext({
      provider: "claude",
      runContextStore: claudeStore,
      sigmaDocStore,
      runId: "run_claude_concurrent",
      payload: { fileId, selectedId: "block_claude" },
    });
    const chatgptCleanup = await prepareAiEditRunContext({
      provider: "chatgpt",
      runContextStore: chatgptStore,
      sigmaDocStore,
      runId: "run_chatgpt_concurrent",
      payload: { fileId, selectedId: "block_chatgpt" },
    });

    const claudeResult = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: claudeStore.getRunContextFilePath(),
    });
    const chatgptResult = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: chatgptStore.getRunContextFilePath(),
    });
    expect(claudeResult.state).toBe("ready");
    expect(chatgptResult.state).toBe("ready");
    if (claudeResult.state === "ready" && chatgptResult.state === "ready") {
      expect(claudeResult.context.runId).toBe("run_claude_concurrent");
      expect(claudeResult.context.provider).toBe("claude");
      expect(chatgptResult.context.runId).toBe("run_chatgpt_concurrent");
      expect(chatgptResult.context.provider).toBe("chatgpt");
    }

    await claudeCleanup();

    const claudeAfterCleanup = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: claudeStore.getRunContextFilePath(),
    });
    const chatgptStillReady = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: chatgptStore.getRunContextFilePath(),
    });
    expect(claudeAfterCleanup.state).toBe("none");
    expect(chatgptStillReady.state).toBe("ready");

    await chatgptCleanup();
  });
});

describe("prepareAiEditRunContext requestSelection (依頼時の選択スナップショット)", () => {
  let userDataDir: string;
  let sigmaDocStore: LocalSigmaDocStore;
  let runContextStore: LocalAiEditRunContextStore;
  let fileId: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-run-context-selection-"));
    sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });
    runContextStore = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "run_sel" });
    fileId = (await sigmaDocStore.listFiles())[0]!.fileId;
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function loadWrittenContext() {
    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("ready");
    return result.state === "ready" ? result.context : (() => { throw new Error("context missing"); })();
  }

  it("captures the selected block's content hash at run start", async () => {
    const document = await sigmaDocStore.loadDocument(fileId);
    const expectedHashes = computeDocumentBlockHashes(document!);
    const blockId = document!.content[0]!.id;

    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_sel",
      payload: { fileId, selectedId: blockId },
    });

    const context = await loadWrittenContext();
    expect(context.requestSelection).toEqual({
      blockIds: [blockId],
      hashes: { [blockId]: expectedHashes[blockId] },
      capturedRevision: context.fileRevision,
    });
  });

  it("captures selected-block hashes from the live payload document before disk catches up", async () => {
    const blockId = "p_ab_point_intro";
    const diskDocument = await sigmaDocStore.loadDocument(fileId);
    const diskBlock = diskDocument ? findBlock(diskDocument, blockId) : null;
    if (diskBlock?.type !== "paragraph") {
      throw new Error("test paragraph missing");
    }
    const diskMath = diskBlock.children.find((child) => child.type === "mathInline");
    if (!diskMath) {
      throw new Error("test inline math missing");
    }
    delete diskMath.semanticRole;
    const observedRevision = (await sigmaDocStore.listFiles())
      .find((file) => file.fileId === fileId)?.revision;
    if (observedRevision === undefined) {
      throw new Error("test file revision missing");
    }
    await expect(sigmaDocStore.saveDocument(fileId, diskDocument!, {
      expectedRevision: observedRevision,
    })).resolves.toMatchObject({ ok: true });

    const persistedDocument = await sigmaDocStore.loadDocument(fileId);
    if (!persistedDocument) {
      throw new Error("persisted test document missing");
    }
    const payloadDocument = structuredClone(persistedDocument);
    const payloadBlock = findBlock(payloadDocument, blockId);
    if (payloadBlock?.type !== "paragraph") {
      throw new Error("payload test paragraph missing");
    }
    const payloadMath = payloadBlock.children.find((child) => child.type === "mathInline");
    if (!payloadMath) {
      throw new Error("payload test inline math missing");
    }
    payloadMath.semanticRole = "expression";

    const diskHash = computeDocumentBlockHashes(persistedDocument)[blockId];
    const payloadHash = computeDocumentBlockHashes(payloadDocument)[blockId];
    expect(payloadHash).not.toBe(diskHash);

    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_sel",
      payload: { fileId, selectedId: blockId, document: payloadDocument },
    });

    const context = await loadWrittenContext();
    expect(context.requestSelection).toEqual({
      blockIds: [blockId],
      hashes: { [blockId]: payloadHash },
      capturedRevision: context.fileRevision,
    });
    expect(context.requestSelection?.hashes[blockId]).not.toBe(diskHash);
  });

  it("falls back to the disk document when the live payload document is malformed", async () => {
    const document = await sigmaDocStore.loadDocument(fileId);
    if (!document) {
      throw new Error("persisted test document missing");
    }
    const blockId = document.content[0]!.id;
    const expectedHash = computeDocumentBlockHashes(document)[blockId];

    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_sel",
      payload: {
        fileId,
        selectedId: blockId,
        document: { content: [] },
      },
    });

    const context = await loadWrittenContext();
    expect(context.requestSelection).toEqual({
      blockIds: [blockId],
      hashes: { [blockId]: expectedHash },
      capturedRevision: context.fileRevision,
    });
  });

  it("includes references[].targetId and overlay-selection shape ids, deduped with selectedId", async () => {
    const document = await sigmaDocStore.loadDocument(fileId);
    const blockId = document!.content[0]!.id;
    // problem 内のネストされたブロック (computeDocumentBlockHashes はネストもハッシュ化する)。
    const otherBlockId = "p_yotte";

    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_sel",
      payload: {
        fileId,
        selectedId: blockId,
        references: [{
          kind: "block",
          targetId: otherBlockId,
          overlaySelection: { shapes: [{ id: "shape_missing_from_doc" }] },
        }],
      },
    });

    const context = await loadWrittenContext();
    expect(context.requestSelection?.blockIds).toEqual([blockId, otherBlockId, "shape_missing_from_doc"]);
    // ドキュメントに存在しないID (依頼直前に消えた等) は hashes に載らない = 承認時に変更扱い。
    expect(Object.keys(context.requestSelection?.hashes ?? {})).toEqual([blockId, otherBlockId]);
  });

  it("captures every block covered by a multi-block text selection", async () => {
    const document = await sigmaDocStore.loadDocument(fileId);
    const expectedHashes = computeDocumentBlockHashes(document!);
    const selectedBlockIds = ["p_ab_point_intro", "p_ab_param_formula", "p_yotte"];

    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_sel",
      payload: {
        fileId,
        selectedId: "p_ab_point_intro",
        references: [{
          kind: "textSelection",
          targetId: "p_ab_point_intro",
          selectedText: "選択範囲",
          textRange: {
            type: "textRange",
            start: { blockId: "p_ab_point_intro", offset: 0 },
            end: { blockId: "p_ab_product_formula", offset: 0 },
            quote: "選択範囲",
          },
        }],
      },
    });

    const context = await loadWrittenContext();
    expect(context.requestSelection?.blockIds).toEqual(selectedBlockIds);
    expect(context.requestSelection?.hashes).toEqual(Object.fromEntries(
      selectedBlockIds.map((id) => [id, expectedHashes[id]]),
    ));
  });

  it("records an explicit empty selection (blockIds: []) for an unselected request", async () => {
    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_sel",
      payload: { fileId },
    });

    const context = await loadWrittenContext();
    expect(context.requestSelection).toEqual({
      blockIds: [],
      hashes: {},
      capturedRevision: context.fileRevision,
    });
  });
});

describe("LocalAiEditRunContextStore per-run (runId-scoped) file paths", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-run-context-per-run-"));
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("scopes the file name to provider-runId when a runId is given", () => {
    const store = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "run_a" });
    expect(store.getRunContextFilePath()).toBe(
      path.join(userDataDir, "data", "ai-run-context", "claude-run_a.run-context.json"),
    );
  });

  it("gives two concurrent runs on the same provider distinct files", async () => {
    const runA = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "run_a" });
    const runB = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "run_b" });
    expect(runA.getRunContextFilePath()).not.toBe(runB.getRunContextFilePath());

    const base = {
      version: 1 as const,
      createdAt: "2026-07-02T00:00:00.000Z",
      provider: "claude" as const,
      fileId: "file_1",
      fileRevision: 1,
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
    };
    await runA.write({ ...base, runId: "run_a" });
    await runB.write({ ...base, runId: "run_b" });

    const resultA = loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runA.getRunContextFilePath() });
    const resultB = loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runB.getRunContextFilePath() });
    expect(resultA.state).toBe("ready");
    expect(resultB.state).toBe("ready");
    if (resultA.state === "ready" && resultB.state === "ready") {
      expect(resultA.context.runId).toBe("run_a");
      expect(resultB.context.runId).toBe("run_b");
    }

    // Clearing run A must not touch run B's file (regression for the
    // concurrent-same-provider overwrite/clobber defect).
    await runA.clear();
    const stillReadyB = loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runB.getRunContextFilePath() });
    expect(stillReadyB.state).toBe("ready");
  });

  it("sanitizes unsafe characters out of the runId when building the file name", () => {
    const store = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "../../etc/passwd" });
    const filePath = store.getRunContextFilePath();
    expect(path.dirname(filePath)).toBe(path.join(userDataDir, "data", "ai-run-context"));
    expect(path.basename(filePath)).toMatch(/^claude-[a-zA-Z0-9_-]+\.run-context\.json$/);
  });
});

describe("LocalAiEditRunContextStore#clearIfRunId", () => {
  let userDataDir: string;
  let store: LocalAiEditRunContextStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-run-context-clear-if-"));
    store = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  const contextFor = (runId: string): AiEditRunContext => ({
    version: 1,
    runId,
    createdAt: "2026-07-02T00:00:00.000Z",
    provider: "chatgpt",
    fileId: "file_1",
    fileRevision: 1,
    selectedId: null,
    references: [],
    attachments: [],
    mentionedDocuments: [],
  });

  it("deletes the file when its runId matches the expected one", async () => {
    await store.write(contextFor("run_mine"));
    await store.clearIfRunId("run_mine");

    const result = loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: store.getRunContextFilePath() });
    expect(result.state).toBe("none");
  });

  it("does NOT delete the file when a different (newer, concurrent) run has since overwritten it", async () => {
    await store.write(contextFor("run_stale_owner"));
    // A concurrent run on the same provider overwrites the shared file before
    // the first run's cleanup fires.
    await store.write(contextFor("run_newer"));

    await store.clearIfRunId("run_stale_owner");

    const result = loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: store.getRunContextFilePath() });
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context.runId).toBe("run_newer");
    }
  });

  it("is a no-op when the file does not exist", async () => {
    await expect(store.clearIfRunId("run_missing")).resolves.not.toThrow();
  });
});

describe("loadAiEditRunContext with runId/provider (shared-MCP-server correlation)", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-run-context-runid-resolve-"));
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  const contextFor = (runId: string, provider: "claude" | "chatgpt" | "antigravity" = "chatgpt"): AiEditRunContext => ({
    version: 1,
    runId,
    createdAt: "2026-07-02T00:00:00.000Z",
    provider,
    fileId: "file_1",
    fileRevision: 1,
    selectedId: null,
    references: [],
    attachments: [],
    mentionedDocuments: [],
  });

  it("resolves the per-run file next to the static one when both runId and provider are given", async () => {
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    const perRunStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt", { runId: "run_b" });
    await staticStore.write(contextFor("run_a"));
    await perRunStore.write(contextFor("run_b"));

    const result = loadAiEditRunContext(
      { [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: staticStore.getRunContextFilePath() },
      { runId: "run_b", provider: "chatgpt" },
    );
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context.runId).toBe("run_b");
    }
  });

  it("falls back to the static file when runId is omitted", async () => {
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    await staticStore.write(contextFor("run_static"));

    const result = loadAiEditRunContext(
      { [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: staticStore.getRunContextFilePath() },
      { provider: "chatgpt" },
    );
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context.runId).toBe("run_static");
    }
  });

  it("falls back to the static file when provider is omitted (runId alone cannot build the per-run file name)", async () => {
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    await staticStore.write(contextFor("run_static"));

    const result = loadAiEditRunContext(
      { [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: staticStore.getRunContextFilePath() },
      { runId: "run_b" },
    );
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context.runId).toBe("run_static");
    }
  });

  it("returns state:none (not the static file's content) when runId+provider are given but no per-run file was ever written", async () => {
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    await staticStore.write(contextFor("run_static"));

    const result = loadAiEditRunContext(
      { [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: staticStore.getRunContextFilePath() },
      { runId: "run_never_written", provider: "chatgpt" },
    );
    expect(result.state).toBe("none");
  });

  it("stays backward compatible when called with only the env argument (existing call sites)", async () => {
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "claude");
    await staticStore.write(contextFor("run_static", "claude"));

    const result = loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: staticStore.getRunContextFilePath() });
    expect(result.state).toBe("ready");
  });
});

describe("toolActivityFileName", () => {
  it("scopes the file name to provider-runId when a runId is given, matching runContextFileName's convention", () => {
    expect(toolActivityFileName("antigravity", "run_a")).toBe("antigravity-run_a.tool-activity.jsonl");
  });

  it("falls back to a provider-level static file name when runId is omitted", () => {
    expect(toolActivityFileName("antigravity")).toBe("antigravity.tool-activity.jsonl");
    expect(toolActivityFileName("antigravity", "")).toBe("antigravity.tool-activity.jsonl");
  });

  it("sanitizes unsafe characters out of the runId, matching runContextFileName's behavior", () => {
    const name = toolActivityFileName("antigravity", "../../etc/passwd");
    expect(name).toMatch(/^antigravity-[a-zA-Z0-9_-]+\.tool-activity\.jsonl$/);
  });
});

describe("visualSessionsFileName", () => {
  it("scopes the file name to provider-runId when a runId is given", () => {
    expect(visualSessionsFileName("claude", "run_a")).toBe("claude-run_a.visual-sessions.json");
  });

  it("uses a provider-level name when runId is omitted", () => {
    expect(visualSessionsFileName("chatgpt")).toBe("chatgpt.visual-sessions.json");
    expect(visualSessionsFileName("chatgpt", "")).toBe("chatgpt.visual-sessions.json");
  });

  it("sanitizes unsafe characters out of the runId", () => {
    const name = visualSessionsFileName("antigravity", "../../etc/passwd");
    expect(name).toMatch(/^antigravity-[a-zA-Z0-9_-]+\.visual-sessions\.json$/);
  });
});

describe("runContextDirPath", () => {
  it("matches the directory LocalAiEditRunContextStore writes into", () => {
    const userDataPath = path.join("/tmp", "sigma-example-user-data");
    expect(runContextDirPath(userDataPath)).toBe(path.join(userDataPath, "data", "ai-run-context"));
    const store = new LocalAiEditRunContextStore(userDataPath, "antigravity");
    expect(path.dirname(store.getRunContextFilePath())).toBe(runContextDirPath(userDataPath));
  });
});

describe("sweepOrphanPerRunContextFiles", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-run-context-sweep-"));
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("deletes only per-run (provider-runId) files for the given provider, leaving the static provider file and other providers' files intact", async () => {
    const claudeRunA = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "run_a" });
    const claudeRunB = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "run_b" });
    const claudeStatic = new LocalAiEditRunContextStore(userDataDir, "claude");
    const chatgptRun = new LocalAiEditRunContextStore(userDataDir, "chatgpt", { runId: "run_c" });

    const base = {
      version: 1 as const,
      createdAt: "2026-07-02T00:00:00.000Z",
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
      fileId: "file_1",
      fileRevision: 1,
    };
    await claudeRunA.write({ ...base, runId: "run_a", provider: "claude" });
    await claudeRunB.write({ ...base, runId: "run_b", provider: "claude" });
    await claudeStatic.write({ ...base, runId: "run_static", provider: "claude" });
    await chatgptRun.write({ ...base, runId: "run_c", provider: "chatgpt" });

    await sweepOrphanPerRunContextFiles(userDataDir, "claude");

    expect(loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: claudeRunA.getRunContextFilePath() }).state).toBe("none");
    expect(loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: claudeRunB.getRunContextFilePath() }).state).toBe("none");
    expect(loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: claudeStatic.getRunContextFilePath() }).state).toBe("ready");
    expect(loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: chatgptRun.getRunContextFilePath() }).state).toBe("ready");
  });

  it("does not throw when the run-context directory does not exist yet", async () => {
    await expect(sweepOrphanPerRunContextFiles(userDataDir, "claude")).resolves.not.toThrow();
  });

  it("also deletes per-run and static tool-activity JSONL files for the given provider, leaving other providers' files intact", async () => {
    // F5: ToolActivityWatcher.stop() best-effort-deletes the per-run file itself, but a crash
    // mid-run (or the static file, which the watcher never deletes) can leave these behind.
    // sweepOrphanPerRunContextFiles runs at app startup, so it should clean these up too.
    const dir = runContextDirPath(userDataDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, toolActivityFileName("antigravity", "run_a")), "{}\n", "utf8");
    await fs.writeFile(path.join(dir, toolActivityFileName("antigravity", "run_b")), "{}\n", "utf8");
    await fs.writeFile(path.join(dir, toolActivityFileName("antigravity")), "{}\n", "utf8");
    await fs.writeFile(path.join(dir, visualSessionsFileName("antigravity", "run_a")), "{}", "utf8");
    await fs.writeFile(path.join(dir, visualSessionsFileName("antigravity", "run_b")), "{}", "utf8");
    await fs.writeFile(path.join(dir, toolActivityFileName("claude", "run_c")), "{}\n", "utf8");
    await fs.writeFile(path.join(dir, visualSessionsFileName("claude", "run_c")), "{}", "utf8");

    await sweepOrphanPerRunContextFiles(userDataDir, "antigravity");

    const remaining = await fs.readdir(dir);
    expect(remaining).not.toContain(toolActivityFileName("antigravity", "run_a"));
    expect(remaining).not.toContain(toolActivityFileName("antigravity", "run_b"));
    expect(remaining).not.toContain(toolActivityFileName("antigravity"));
    expect(remaining).not.toContain(visualSessionsFileName("antigravity", "run_a"));
    expect(remaining).not.toContain(visualSessionsFileName("antigravity", "run_b"));
    expect(remaining).toContain(toolActivityFileName("claude", "run_c"));
    expect(remaining).toContain(visualSessionsFileName("claude", "run_c"));
  });

  it("removes the entire orphan preview directory, including file/session/unscoped run previews", async () => {
    const previewsDir = path.join(runContextDirPath(userDataDir), "previews");
    await fs.mkdir(path.join(previewsDir, "claude-run_a"), { recursive: true });
    await fs.mkdir(path.join(previewsDir, "claude-run_b"), { recursive: true });
    await fs.mkdir(path.join(previewsDir, "chatgpt-run_c"), { recursive: true });
    await fs.mkdir(path.join(previewsDir, "file_123"), { recursive: true });
    await fs.mkdir(path.join(previewsDir, "run-run_unknown_provider"), { recursive: true });
    await fs.mkdir(path.join(previewsDir, "visual-session-456"), { recursive: true });
    await fs.writeFile(path.join(previewsDir, "claude-run_a", "visual-1.png"), "png", "utf8");

    await sweepOrphanPerRunContextFiles(userDataDir, "claude");

    await expect(fs.access(previewsDir)).rejects.toThrow();
  });
});

describe("prepareAiEditRunContext concurrency: cleanup does not clobber a newer concurrent run", () => {
  let userDataDir: string;
  let sigmaDocStore: LocalSigmaDocStore;
  let sharedStore: LocalAiEditRunContextStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-run-context-race-"));
    sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });
    // Both "runs" below intentionally share the same static (provider-level)
    // store, reproducing the Codex/Antigravity shape where the MCP server's
    // run-context file path is fixed at app startup and shared by every run.
    sharedStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("run A's cleanup does not delete run B's context after B has started writing to the same shared file", async () => {
    const files = await sigmaDocStore.listFiles();
    const fileId = files[0]?.fileId;

    const cleanupA = await prepareAiEditRunContext({
      provider: "chatgpt",
      runContextStore: sharedStore,
      sigmaDocStore,
      runId: "run_a",
      payload: { fileId, selectedId: "block_a" },
    });

    // Run B starts concurrently on the same provider and overwrites the
    // shared file before A's turn finishes and its cleanup fires.
    await prepareAiEditRunContext({
      provider: "chatgpt",
      runContextStore: sharedStore,
      sigmaDocStore,
      runId: "run_b",
      payload: { fileId, selectedId: "block_b" },
    });

    await cleanupA();

    const result = loadAiEditRunContext({ [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: sharedStore.getRunContextFilePath() });
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context.runId).toBe("run_b");
    }
  });
});

describe("prepareAiEditRunContext", () => {
  let userDataDir: string;
  let sigmaDocStore: LocalSigmaDocStore;
  let runContextStore: LocalAiEditRunContextStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-run-context-prepare-"));
    sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });
    runContextStore = new LocalAiEditRunContextStore(userDataDir, "claude");
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  function staleContext(fileId: string): AiEditRunContext {
    return {
      version: 1,
      runId: "run_stale",
      createdAt: "2026-07-02T00:00:00.000Z",
      provider: "claude",
      fileId,
      fileRevision: 1,
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
    };
  }

  it("writes a run-context file matching the current file revision and returns a cleanup that deletes it", async () => {
    const files = await sigmaDocStore.listFiles();
    const fileId = files[0]?.fileId;
    expect(fileId).toBeTruthy();

    const cleanup = await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_abc",
      payload: {
        fileId,
        selectedId: "block_1",
        attachments: [
          {
            id: "att_1",
            name: "diagram.png",
            mimeType: "image/png",
            dataUrl: "data:image/png;base64,AAAA",
          },
        ],
        mentionedDocuments: [],
      },
    });

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context.runId).toBe("run_abc");
      expect(result.context.provider).toBe("claude");
      expect(result.context.fileId).toBe(fileId);
      expect(result.context.fileRevision).toBe(files[0]?.revision ?? 1);
    }

    await cleanup();
    const afterCleanup = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextStore.getRunContextFilePath(),
    });
    expect(afterCleanup.state).toBe("none");
  });

  it("persists roomId/turnId/sessionLabel attribution fields when the payload carries them", async () => {
    const files = await sigmaDocStore.listFiles();
    const fileId = files[0]?.fileId;
    expect(fileId).toBeTruthy();

    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_attrib",
      payload: {
        fileId,
        roomId: "room_1",
        turnId: "turn_1",
        sessionLabel: "第1回授業",
      },
    });

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context.roomId).toBe("room_1");
      expect(result.context.turnId).toBe("turn_1");
      expect(result.context.sessionLabel).toBe("第1回授業");
    }
  });

  it("omits roomId/turnId/sessionLabel entirely when the payload does not carry them (older callers)", async () => {
    const files = await sigmaDocStore.listFiles();
    const fileId = files[0]?.fileId;

    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_no_attrib",
      payload: { fileId },
    });

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context.roomId).toBeUndefined();
      expect(result.context.turnId).toBeUndefined();
      expect(result.context.sessionLabel).toBeUndefined();
    }
  });

  it("writes nothing and returns a no-op cleanup when the payload has no fileId", async () => {
    const cleanup = await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_no_file",
      payload: {},
    });

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("none");

    await expect(cleanup()).resolves.not.toThrow();
  });

  it("drops attachments with an empty dataUrl and keeps valid ones", async () => {
    const files = await sigmaDocStore.listFiles();
    const fileId = files[0]?.fileId;

    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_sanitize_attachments",
      payload: {
        fileId,
        attachments: [
          { id: "att_ok", name: "diagram.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
          { id: "att_empty", name: "broken.png", mimeType: "image/png", dataUrl: "" },
        ],
        mentionedDocuments: [],
      },
    });

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context.attachments).toHaveLength(1);
      expect(result.context.attachments[0]?.id).toBe("att_ok");
    }
  });

  it("drops a single malformed mentionedDocument item via per-item safeParse and keeps the valid one", async () => {
    const files = await sigmaDocStore.listFiles();
    const fileId = files[0]?.fileId;

    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_sanitize_mentioned_documents",
      payload: {
        fileId,
        mentionedDocuments: [
          {
            id: "doc_ok",
            fileId: "file_ok",
            title: "OK",
            documentPath: "/ok.json",
            revision: 1,
            excerpt: "抜粋",
            document: { docId: "doc_ok" } as unknown as never,
          },
          // missing documentPath -> fails the item schema and should be dropped, not
          // fail the whole write.
          {
            id: "doc_bad",
            fileId: "file_bad",
            revision: 1,
          } as unknown as never,
        ],
      },
    });

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.context.mentionedDocuments).toHaveLength(1);
      expect(result.context.mentionedDocuments[0]?.id).toBe("doc_ok");
    }
  });

  it("clears a stale run-context file when the payload has no fileId", async () => {
    const files = await sigmaDocStore.listFiles();
    await runContextStore.write(staleContext(files[0]!.fileId));

    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_stale_no_file",
      payload: {},
    });

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("none");
  });

  it("clears a stale run-context file when the fileId is unknown", async () => {
    const files = await sigmaDocStore.listFiles();
    await runContextStore.write(staleContext(files[0]!.fileId));

    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_stale_unknown_file",
      payload: { fileId: "file_does_not_exist" },
    });

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("none");
  });

  it("clears a stale run-context file when the sanitized payload fails schema validation", async () => {
    const files = await sigmaDocStore.listFiles();
    const fileId = files[0]?.fileId;
    await runContextStore.write(staleContext(fileId!));

    await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_stale_invalid_after_sanitize",
      payload: {
        fileId,
        references: [{ kind: "block" } as unknown as { kind: string; targetId: string }],
      },
    });

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("none");
  });

  it("writes nothing when the sanitized payload still fails schema validation", async () => {
    const files = await sigmaDocStore.listFiles();
    const fileId = files[0]?.fileId;

    const cleanup = await prepareAiEditRunContext({
      provider: "claude",
      runContextStore,
      sigmaDocStore,
      runId: "run_invalid_after_sanitize",
      payload: {
        fileId,
        // reference is malformed (missing targetId) and survives sanitization,
        // so schema validation should still reject the whole payload.
        references: [{ kind: "block" } as unknown as { kind: string; targetId: string }],
      },
    });

    const result = loadAiEditRunContext({
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextStore.getRunContextFilePath(),
    });
    expect(result.state).toBe("none");
    await expect(cleanup()).resolves.not.toThrow();
  });

  it("write() is atomic: no leftover tmp file and the written file always parses", async () => {
    const files = await sigmaDocStore.listFiles();
    const fileId = files[0]?.fileId;
    await runContextStore.write({
      version: 1,
      runId: "run_atomic",
      createdAt: "2026-07-02T00:00:00.000Z",
      provider: "claude",
      fileId: fileId!,
      fileRevision: 1,
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
    });

    const dir = path.dirname(runContextStore.getRunContextFilePath());
    const entries = await fs.readdir(dir);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);

    const raw = await fs.readFile(runContextStore.getRunContextFilePath(), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("clear() is best-effort and does not throw when the target cannot be unlinked", async () => {
    const filePath = runContextStore.getRunContextFilePath();
    await fs.mkdir(filePath, { recursive: true });
    await fs.writeFile(path.join(filePath, "child.txt"), "x", "utf8");

    await expect(runContextStore.clear()).resolves.not.toThrow();
  });
});
