import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { paragraphDocument, replaceParagraphDraft } from "../tests/fixtures/proposal-document";
import { getSourceDependencies } from "../tests/helpers/source-dependencies";
import type { VisualSessionsStatusFile } from "../electron/visual-session-status";
import {
  deriveVisualPreviewCode,
  VisualEditSessionLifecycle,
  type VisualEditSession,
  type VisualEditSessionLifecyclePorts,
  type VisualEditSessionStart,
  type VisualEditSessionStatePort,
  type VisualEditSessionCaller,
  type VisualInspectionResult,
  type VisualReviewInput,
} from "./visual-edit-session-lifecycle";

const START = Date.parse("2026-09-09T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function sessionInput(sessionId: string, overrides: Partial<VisualEditSessionStart> = {}): VisualEditSessionStart {
  const document = paragraphDocument(["anchor"]);
  const createdAt = new Date(START).toISOString();
  return {
    sessionId,
    file: {
      fileId: "file_visual", workspaceId: "workspace", folderId: null, docId: document.docId,
      title: "Visual document", revision: 1, createdAt, updatedAt: createdAt,
    },
    baseDocument: document,
    targetId: "anchor",
    agentSession: {
      baseDocument: document, draftDocument: document, selectedId: "anchor",
      references: [], attachments: [], mentionedDocuments: [], materials: [], operations: [],
      operationResults: [], mutationOperations: [], changedIds: [], toolEvents: [],
    },
    createdAt,
    runId: "run_visual",
    provider: "claude",
    ...overrides,
  };
}

function harness() {
  const clock = { now: START };
  const directory = { value: "initial" };
  const writes: Array<{ key: string; status: VisualSessionsStatusFile }> = [];
  const write = vi.fn(async (key: string, status: VisualSessionsStatusFile) => {
    writes.push({ key, status: structuredClone(status) });
  });
  const resolveStatusTarget: VisualEditSessionLifecyclePorts["resolveStatusTarget"] = (provider, runId) => {
    if (!provider || !runId) return null;
    const key = `${directory.value}/${provider}/${runId}`;
    return { key, write: (status) => write(key, status) };
  };
  const lifecycle = new VisualEditSessionLifecycle({ now: () => clock.now, resolveStatusTarget });
  return { lifecycle, clock, directory, writes, write };
}

function addOperation(lifecycle: VisualEditSessionLifecycle, session: VisualEditSession): void {
  session.agentSession.operations.push(replaceParagraphDraft("anchor", "changed").operations[0]);
  lifecycle.markChanged(session);
}

function inspection(session: VisualEditSession, overrides: Partial<VisualInspectionResult> = {}): VisualInspectionResult {
  return {
    passed: true, inspectedRevision: session.revision, errorCount: 0, warningCount: 0,
    issues: [], shapeCount: 1, ...overrides,
  };
}

function reviewInput(session: VisualEditSession, overrides: Partial<VisualReviewInput> = {}): VisualReviewInput {
  return {
    verdict: "pass", score: 10, previewCode: deriveVisualPreviewCode(session.sessionId, session.revision),
    sourceImageSummary: "Source", previewSummary: "Preview", ...overrides,
  };
}

function makeReviewable(lifecycle: VisualEditSessionLifecycle, session: VisualEditSession): void {
  addOperation(lifecycle, session);
  lifecycle.recordPreview(session, session.revision, deriveVisualPreviewCode(session.sessionId, session.revision), "app-bridge");
  lifecycle.recordInspection(session, inspection(session));
}

describe("visual session status publication", () => {
  it("captures full snapshots when queued and writes each destination in order", async () => {
    const h = harness();
    const started = deferred();
    const release = deferred();
    h.write.mockImplementationOnce(async (key, status) => {
      h.writes.push({ key, status: structuredClone(status) });
      started.resolve();
      await release.promise;
    });
    const first = h.lifecycle.begin(sessionInput("z_session", {
      runId: "  run_visual  ", sourceAnalysis: "Original shape analysis", plannedShapes: [{ kind: "rectangle", purpose: "outline" }],
    }));
    h.lifecycle.begin(sessionInput("a_session"));
    addOperation(h.lifecycle, first);
    // A later in-memory change must not rewrite already-enqueued scalar snapshots.
    first.agentSession.operations.push(replaceParagraphDraft("anchor", "later").operations[0]);
    expect(h.write).not.toHaveBeenCalled();
    await started.promise;
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].status.sessions).toEqual([{
      sessionId: "z_session", targetId: "anchor", operationCount: 0, revision: 0,
      lastReviewPassed: null, proposed: false, discarded: false,
      sourceAnalysis: "Original shape analysis", plannedShapes: [{ kind: "rectangle", purpose: "outline" }],
    }]);
    expect(h.lifecycle.cacheSizes().pending).toBe(1);

    release.resolve();
    await h.lifecycle.flushStatusWrites();
    expect(h.writes.map(({ status }) => status.sessions.map(({ sessionId, operationCount, revision }) => ({ sessionId, operationCount, revision })))).toEqual([
      [{ sessionId: "z_session", operationCount: 0, revision: 0 }],
      [{ sessionId: "a_session", operationCount: 0, revision: 0 }, { sessionId: "z_session", operationCount: 0, revision: 0 }],
      [{ sessionId: "a_session", operationCount: 0, revision: 0 }, { sessionId: "z_session", operationCount: 1, revision: 1 }],
    ]);
    expect(h.lifecycle.cacheSizes().pending).toBe(0);
  });

  it("resolves destinations at enqueue time and allows independent destinations to progress", async () => {
    const h = harness();
    const firstStarted = deferred();
    const nextStarted = deferred();
    const release = deferred();
    h.write.mockImplementation(async (key, status) => {
      h.writes.push({ key, status: structuredClone(status) });
      if (key.startsWith("initial/")) {
        firstStarted.resolve();
        await release.promise;
      } else {
        nextStarted.resolve();
      }
    });
    const session = h.lifecycle.begin(sessionInput("first"));
    h.directory.value = "changed";
    addOperation(h.lifecycle, session);
    await Promise.all([firstStarted.promise, nextStarted.promise]);
    expect(h.writes.map(({ key }) => key)).toEqual(["initial/claude/run_visual", "changed/claude/run_visual"]);
    release.resolve();
    await h.lifecycle.flushStatusWrites();
    expect(h.lifecycle.cacheSizes().pending).toBe(0);
  });

  it.each(["proposed", "discarded"] as const)("publishes %s before releasing the live session", async (state) => {
    const h = harness();
    const session = h.lifecycle.begin(sessionInput("terminal"));
    await h.lifecycle.flushStatusWrites();
    const started = deferred();
    const release = deferred();
    h.write.mockImplementationOnce(async (key, status) => {
      h.writes.push({ key, status: structuredClone(status) });
      started.resolve();
      await release.promise;
    });

    const finishing = h.lifecycle.finish(session, state);
    expect(h.lifecycle.peek(session.sessionId)).toBe(session);
    await started.promise;
    expect(h.lifecycle.peek(session.sessionId)).toBe(session);
    expect(h.writes.at(-1)?.status.sessions[0]).toMatchObject({ proposed: state === "proposed", discarded: state === "discarded" });
    release.resolve();
    await finishing;
    expect(h.lifecycle.peek(session.sessionId)).toBeUndefined();

    h.lifecycle.begin(sessionInput("next"));
    await h.lifecycle.flushStatusWrites();
    expect(h.writes.at(-1)?.status.sessions.map(({ sessionId }) => sessionId)).toEqual(["next", "terminal"]);
  });

  it.each([
    { provider: null, runId: "run_visual" },
    { provider: "claude" as const, runId: "  " },
  ])("keeps unattributed completion silent: %j", async (attribution) => {
    const h = harness();
    const session = h.lifecycle.begin(sessionInput("silent", attribution));
    await h.lifecycle.finish(session, "discarded");
    await h.lifecycle.flushStatusWrites();
    expect(h.writes).toEqual([]);
    expect(h.lifecycle.peek(session.sessionId)).toBeUndefined();
    expect(h.lifecycle.cacheSizes()).toEqual({ terminal: 0, pending: 0 });
    // Preserve the existing distinction: no attributed terminal record was created.
    expect(session.proposed).toBe(false);
    expect(session.discarded).toBe(false);
  });

  it("remembers attributed terminal state even when no status destination is available", async () => {
    const resolveStatusTarget = vi.fn(() => null);
    const lifecycle = new VisualEditSessionLifecycle({ now: () => START, resolveStatusTarget });
    const session = lifecycle.begin(sessionInput("no_destination"));
    await lifecycle.finish(session, "proposed");
    expect(resolveStatusTarget).toHaveBeenCalledTimes(2);
    expect(lifecycle.cacheSizes()).toEqual({ terminal: 1, pending: 0 });
    expect(lifecycle.peek(session.sessionId)).toBeUndefined();
    expect(session.proposed).toBe(true);
  });

  it("isolates snapshots by provider and run while retaining terminal entries in their own run", async () => {
    const h = harness();
    const terminal = h.lifecycle.begin(sessionInput("same_run"));
    await h.lifecycle.finish(terminal, "proposed");
    h.lifecycle.begin(sessionInput("other_run", { runId: "run_other" }));
    h.lifecycle.begin(sessionInput("other_provider", { provider: "chatgpt" }));
    h.lifecycle.begin(sessionInput("current"));
    await h.lifecycle.flushStatusWrites();
    expect(h.writes.filter(({ key }) => key.endsWith("/claude/run_other")).at(-1)?.status.sessions.map(({ sessionId }) => sessionId)).toEqual(["other_run"]);
    expect(h.writes.filter(({ key }) => key.endsWith("/chatgpt/run_visual")).at(-1)?.status.sessions.map(({ sessionId }) => sessionId)).toEqual(["other_provider"]);
    expect(h.writes.filter(({ key }) => key.endsWith("/claude/run_visual")).at(-1)?.status.sessions.map(({ sessionId }) => sessionId)).toEqual(["current", "same_run"]);
  });

  it("expires sessions strictly after one hour and queues discarded state before deleting live state", async () => {
    const h = harness();
    const session = h.lifecycle.begin(sessionInput("expired"));
    await h.lifecycle.flushStatusWrites();
    h.clock.now += 500;
    h.lifecycle.touch(session);
    expect(session.updatedAt).toBe(new Date(h.clock.now).toISOString());
    expect(h.writes).toHaveLength(1);
    h.clock.now += HOUR;
    expect(h.lifecycle.get(session.sessionId)).toBe(session);
    h.clock.now += 1;
    expect(() => h.lifecycle.get(session.sessionId)).toThrow(`visual edit session が見つかりません: ${session.sessionId}`);
    expect(h.lifecycle.peek(session.sessionId)).toBeUndefined();
    expect(h.writes).toHaveLength(1);
    await h.lifecycle.flushStatusWrites();
    expect(h.writes.at(-1)?.status.sessions[0]).toMatchObject({ sessionId: "expired", discarded: true });
  });

  it("retains the latest 200 terminal sessions and drains more than 200 distinct pending destinations", async () => {
    const h = harness();
    for (let index = 0; index < 201; index += 1) {
      const session = h.lifecycle.begin(sessionInput(`terminal_${String(index).padStart(3, "0")}`));
      await h.lifecycle.finish(session, "discarded");
    }
    await h.lifecycle.flushStatusWrites();
    expect(h.lifecycle.cacheSizes()).toEqual({ terminal: 200, pending: 0 });
    expect(h.writes.at(-1)?.status.sessions).toHaveLength(200);
    expect(h.writes.at(-1)?.status.sessions.map(({ sessionId }) => sessionId)).not.toContain("terminal_000");
    expect(h.writes.at(-1)?.status.sessions.at(-1)?.sessionId).toBe("terminal_200");

    const release = deferred();
    h.write.mockImplementation(async () => release.promise);
    for (let index = 0; index < 201; index += 1) {
      h.lifecycle.begin(sessionInput(`pending_${index}`, { runId: `run_${index}` }));
    }
    expect(h.lifecycle.cacheSizes().pending).toBe(201);
    release.resolve();
    await h.lifecycle.flushStatusWrites();
    expect(h.lifecycle.cacheSizes().pending).toBe(0);
  });
});

describe("visual session review generations", () => {
  it("invalidates every review after a mutation and rejects late preview results", async () => {
    const h = harness();
    const session = h.lifecycle.begin(sessionInput("revision"));
    makeReviewable(h.lifecycle, session);
    expect(h.lifecycle.review(session, reviewInput(session)).review.passed).toBe(true);
    const oldRevision = session.revision;
    const oldCode = session.lastPreviewCode!;
    addOperation(h.lifecycle, session);
    expect(session).toMatchObject({ revision: oldRevision + 1, lastPreviewRevision: oldRevision, lastPreviewSource: null, lastPreviewCode: null, lastInspection: null, lastReview: null });
    expect(h.lifecycle.isRenderStale(session, oldRevision)).toBe(true);
    h.lifecycle.recordPreview(session, oldRevision, oldCode, "svg-fallback");
    expect(session.lastPreviewSource).toBeNull();
    expect(() => h.lifecycle.review(session, reviewInput(session))).toThrow("最後の変更後にrender_visual_edit_sessionが実行されていません。");
    h.lifecycle.recordPreview(session, session.revision, deriveVisualPreviewCode(session.sessionId, session.revision), "svg-resource");
    h.lifecycle.recordPreview(session, oldRevision, oldCode, "app-bridge");
    expect(session.lastPreviewSource).toBe("svg-resource");
    expect(session.lastPreviewRevision).toBe(session.revision);
    await h.lifecycle.flushStatusWrites();
  });

  it("keeps the current render failure diagnostic and ignores a stale success or failure", async () => {
    const h = harness();
    const session = h.lifecycle.begin(sessionInput("failure"));
    addOperation(h.lifecycle, session);
    h.lifecycle.recordRenderFailure(session, session.revision, "bridge unavailable");
    expect(h.lifecycle.describeMissingRenderError(session)).toContain("bridge unavailable");
    addOperation(h.lifecycle, session);
    expect(session.lastRenderFailure).toEqual({ revision: 1, reason: "bridge unavailable" });
    expect(h.lifecycle.describeMissingRenderError(session)).toBe("最後の変更後にrender_visual_edit_sessionが実行されていません。");
    h.lifecycle.recordRenderFailure(session, session.revision, "current failure");
    h.lifecycle.recordRenderFailure(session, 1, "old failure");
    h.lifecycle.recordPreview(session, 1, "AAAAA", "svg-fallback");
    expect(session.lastRenderFailure?.reason).toBe("current failure");
    h.lifecycle.recordPreview(session, session.revision, "BBBBB", "app-bridge");
    expect(session.lastRenderFailure).toBeNull();
    await h.lifecycle.flushStatusWrites();
  });

  it.each([
    { name: "low score", input: { score: 0 }, inspected: "current", passed: true },
    { name: "reported issues", input: { score: 100, issues: ["missing label"] }, inspected: "current", passed: false },
    { name: "revision requested", input: { verdict: "needs_revision" as const }, inspected: "current", passed: false },
    { name: "wrong badge", input: { previewCode: "WRONG", nextActions: ["keep this action"] }, inspected: "current", passed: false },
    { name: "no inspection", input: {}, inspected: "missing", passed: false },
    { name: "old inspection", input: {}, inspected: "old", passed: false },
    { name: "failed inspection", input: {}, inspected: "failed", passed: false },
  ])("applies the existing machine review conditions: $name", async ({ input, inspected, passed }) => {
    const h = harness();
    const session = h.lifecycle.begin(sessionInput("review"));
    addOperation(h.lifecycle, session);
    h.lifecycle.recordPreview(session, session.revision, deriveVisualPreviewCode(session.sessionId, session.revision), "app-bridge");
    if (inspected !== "missing") {
      h.lifecycle.recordInspection(session, inspection(session, {
        inspectedRevision: inspected === "old" ? session.revision - 1 : session.revision,
        passed: inspected !== "failed",
      }));
    }
    h.clock.now += 100;
    const result = h.lifecycle.review(session, reviewInput(session, input));
    expect(result.review.passed).toBe(passed);
    expect(result.review.minScore).toBe(95);
    expect(result.review.createdAt).toBe(new Date(h.clock.now).toISOString());
    expect(session.updatedAt).toBe(result.review.createdAt);
    expect(session.visualEvents.at(-1)).toMatchObject({ toolName: "review_visual_edit_session", status: passed ? "ok" : "error", createdAt: result.review.createdAt });
    if (input.previewCode) {
      expect(result.review.nextActions).toEqual(["keep this action", "previewFileをview_imageツールで開いて画像右上のコードを読み取り、正しいpreviewCodeでreview_visual_edit_sessionを再実行してください。"]);
    }
    await h.lifecycle.flushStatusWrites();
    expect(h.writes.at(-1)?.status.sessions[0].lastReviewPassed).toBe(passed);
  });

  it("checks proposal preconditions in order and reruns inspection only after the review gates pass", async () => {
    const h = harness();
    const lifecycle: VisualEditSessionLifecycle = h.lifecycle;
    const session = lifecycle.begin(sessionInput("propose"));
    const inspect = vi.fn(() => inspection(session));
    expect(() => h.lifecycle.assertReadyForProposal(session, inspect)).toThrow("提案化する図形操作がありません。");
    addOperation(h.lifecycle, session);
    expect(() => h.lifecycle.assertReadyForProposal(session, inspect)).toThrow("render_visual_edit_session");
    h.lifecycle.recordPreview(session, session.revision, deriveVisualPreviewCode(session.sessionId, session.revision), "app-bridge");
    expect(() => h.lifecycle.assertReadyForProposal(session, inspect)).toThrow("inspect_visual_edit_session");
    h.lifecycle.recordInspection(session, inspection(session, { passed: false }));
    expect(() => h.lifecycle.assertReadyForProposal(session, inspect)).toThrow("品質検査に通過していない");
    h.lifecycle.recordInspection(session, inspection(session));
    expect(() => h.lifecycle.assertReadyForProposal(session, inspect)).toThrow("review_visual_edit_session");
    h.lifecycle.review(session, reviewInput(session, { issues: ["wrong label"] }));
    expect(() => h.lifecycle.assertReadyForProposal(session, inspect)).toThrow("視覚レビューに合格していない");
    expect(inspect).not.toHaveBeenCalled();
    h.lifecycle.review(session, reviewInput(session));
    inspect.mockReturnValueOnce(inspection(session, { passed: false }));
    expect(() => h.lifecycle.assertReadyForProposal(session, inspect)).toThrow("commit直前の品質再検査に失敗");
    expect(inspect).toHaveBeenCalledOnce();
    lifecycle.assertReadyForProposal(session, inspect);
    expect(inspect).toHaveBeenCalledTimes(2);
    await h.lifecycle.flushStatusWrites();
  });
});

/**
 * Two lifecycles sharing one saved store and one status file stand in for two MCP server
 * processes of the same run (Claude and Antigravity start one per turn).
 */
function sharedRunStorage() {
  const clock = { now: START };
  const saved = new Map<string, { generation: number; serialized: string }>();
  const statusFiles = new Map<string, VisualSessionsStatusFile>();
  const stateWrites = vi.fn();
  const failWrites = new Set<string>();
  const retired = new Set<string>();
  const resolveStatusTarget: VisualEditSessionLifecyclePorts["resolveStatusTarget"] = (provider, runId) => {
    if (!provider || !runId) return null;
    const key = `${provider}/${runId}`;
    return {
      key,
      read: async () => structuredClone(statusFiles.get(key) ?? null),
      write: async (status) => { statusFiles.set(key, structuredClone(status)); },
    };
  };
  const sessionState: VisualEditSessionStatePort = {
    resolveTarget: (session) => {
      if (!session.provider || !session.runId) return null;
      const sessionId = session.sessionId;
      return {
        key: `state/${sessionId}`,
        readGeneration: async () => saved.get(sessionId)?.generation ?? null,
        isRetired: async () => retired.has(sessionId),
        write: async (serialized, generation) => {
          stateWrites(sessionId, generation);
          if (retired.has(sessionId)) return "superseded";
          if (failWrites.has(sessionId)) {
            saved.delete(sessionId);
            return "failed";
          }
          const current = saved.get(sessionId);
          if (current && current.generation >= generation) return "superseded";
          saved.set(sessionId, { generation, serialized });
          return "written";
        },
        clear: async () => { saved.delete(sessionId); },
        retire: async () => { retired.add(sessionId); saved.delete(sessionId); },
      };
    },
    serialize: (session) => JSON.stringify(session),
    load: async (sessionId, runId) => {
      if (retired.has(sessionId)) return null;
      const entry = saved.get(sessionId);
      const session = entry ? JSON.parse(entry.serialized) as VisualEditSession : null;
      return entry && session?.runId === runId ? { generation: entry.generation, session } : null;
    },
  };
  const process = () => new VisualEditSessionLifecycle({ now: () => clock.now, resolveStatusTarget, sessionState });
  const status = (sessionId: string) => statusFiles.get("claude/run_visual")?.sessions.find((item) => item.sessionId === sessionId);
  return { clock, saved, statusFiles, stateWrites, failWrites, retired, process, status };
}

/** The run the MCP server process belongs to (from its run-context file); the tool call did not pass a runId. */
const RUN: VisualEditSessionCaller = { runId: "run_visual", explicit: false };

describe("visual sessions saved per run", () => {
  it("resumes a session from another process with its operations and review generations", async () => {
    const storage = sharedRunStorage();
    const first = storage.process();
    const session = first.begin(sessionInput("resumed"));
    await first.persist(session);
    makeReviewable(first, session);
    await first.persist(session);
    expect(storage.saved.get("resumed")?.generation).toBe(2);

    const next: VisualEditSessionLifecycle = storage.process();
    expect(next.peek("resumed")).toBeUndefined();
    const resumed = await next.resolve("resumed", RUN);
    expect(resumed).toMatchObject({
      sessionId: "resumed", revision: 1, lastPreviewRevision: 1, runId: "run_visual", provider: "claude",
      lastPreviewCode: deriveVisualPreviewCode("resumed", 1),
      lastInspection: { passed: true, inspectedRevision: 1 },
    });
    expect(resumed.agentSession.operations).toHaveLength(1);
    expect(next.review(resumed, reviewInput(resumed)).review.passed).toBe(true);
    const inspect = vi.fn(() => inspection(resumed));
    next.assertReadyForProposal(resumed, inspect);
    expect(inspect).toHaveBeenCalledOnce();
    expect(await next.resolve("resumed", RUN)).toBe(resumed);
  });

  it("restores one object for concurrent calls and keeps the unknown-session error", async () => {
    const storage = sharedRunStorage();
    const first = storage.process();
    await first.persist(first.begin(sessionInput("concurrent")));

    const next = storage.process();
    const [a, b] = await Promise.all([next.resolve("concurrent", RUN), next.resolve("concurrent", RUN)]);
    expect(a).toBe(b);
    await expect(next.resolve("missing", RUN)).rejects.toThrow("visual edit session が見つかりません: missing");
    await expect(next.find("missing", RUN)).resolves.toBeUndefined();
  });

  it("re-reads state another process advanced and never overwrites it with stale memory", async () => {
    const storage = sharedRunStorage();
    const first = storage.process();
    const stale = first.begin(sessionInput("contended"));
    await first.persist(stale);

    const next = storage.process();
    const advanced = await next.resolve("contended", RUN);
    addOperation(next, advanced);
    await next.persist(advanced);
    expect(storage.saved.get("contended")?.generation).toBe(2);

    // The earlier process picks the newer saved state instead of its own memory.
    const reread = await first.resolve("contended", RUN);
    expect(reread).not.toBe(stale);
    expect(reread.revision).toBe(1);

    // A write from memory that is older than the saved state is refused and dropped.
    const third = storage.process();
    const staleCopy = await third.resolve("contended", RUN);
    addOperation(next, advanced);
    await next.persist(advanced);
    addOperation(third, staleCopy);
    await third.persist(staleCopy);
    expect(third.peek("contended")).toBeUndefined();
    expect(JSON.parse(storage.saved.get("contended")!.serialized).revision).toBe(2);
    expect((await third.resolve("contended", RUN)).revision).toBe(2);
  });

  it.each(["proposed", "discarded"] as const)("records %s before removing the saved state and does not restore it again", async (state) => {
    const storage = sharedRunStorage();
    const first = storage.process();
    const session = first.begin(sessionInput("finished"));
    addOperation(first, session);
    await first.persist(session);

    const next = storage.process();
    const resumed = await next.resolve("finished", RUN);
    await next.finish(resumed, state);
    expect(storage.saved.has("finished")).toBe(false);
    expect(storage.status("finished")).toMatchObject({ proposed: state === "proposed", discarded: state === "discarded" });

    // Even if a late write brought the file back, this process does not resume a finished session.
    storage.saved.set("finished", { generation: 9, serialized: JSON.stringify(resumed) });
    await expect(next.find("finished", RUN)).resolves.toBeUndefined();
    await next.persist(resumed);
    expect(storage.saved.get("finished")?.generation).toBe(9);
  });

  it("discards a saved session that expired and removes its state", async () => {
    const storage = sharedRunStorage();
    const first = storage.process();
    const session = first.begin(sessionInput("stale_saved"));
    addOperation(first, session);
    await first.persist(session);

    storage.clock.now += HOUR + 1;
    const next = storage.process();
    await expect(next.resolve("stale_saved", RUN)).rejects.toThrow("visual edit session が見つかりません: stale_saved");
    expect(storage.saved.has("stale_saved")).toBe(false);
    expect(storage.status("stale_saved")).toMatchObject({ operationCount: 1, discarded: true });
  });

  it("keeps sessions of the same run that only another process knows in the status file, finished ones included", async () => {
    const storage = sharedRunStorage();
    const first = storage.process();
    for (const sessionId of ["kept_a", "kept_b"]) {
      const session = first.begin(sessionInput(sessionId));
      addOperation(first, session);
      await first.persist(session);
    }
    const finishedElsewhere = first.begin(sessionInput("finished_elsewhere"));
    await first.finish(finishedElsewhere, "discarded");
    await first.flushStatusWrites();

    const next = storage.process();
    const resumed = await next.resolve("kept_a", RUN);
    await next.finish(resumed, "proposed");
    await next.flushStatusWrites();
    expect(storage.statusFiles.get("claude/run_visual")?.sessions.map(({ sessionId, proposed, discarded }) => ({ sessionId, proposed, discarded }))).toEqual([
      { sessionId: "finished_elsewhere", proposed: false, discarded: true },
      { sessionId: "kept_a", proposed: true, discarded: false },
      { sessionId: "kept_b", proposed: false, discarded: false },
    ]);
  });

  it("waits for the session's state and status writes before the tool call returns", async () => {
    const storage = sharedRunStorage();
    const lifecycle = storage.process();
    const session = lifecycle.begin(sessionInput("durable"));
    addOperation(lifecycle, session);
    await lifecycle.persist(session);
    expect(storage.saved.get("durable")?.generation).toBe(1);
    expect(storage.status("durable")).toMatchObject({ operationCount: 1 });
    expect(lifecycle.cacheSizes().pending).toBe(0);
  });

  it("reports whether the state was saved, and never leaves an older state to resume after a failed write", async () => {
    const storage = sharedRunStorage();
    const first = storage.process();
    const session = first.begin(sessionInput("unsaved"));
    await expect(first.persist(session)).resolves.toBe("saved");
    addOperation(first, session);
    storage.failWrites.add("unsaved");
    await expect(first.persist(session)).resolves.toBe("not-saved");
    // This process keeps working from memory; another process cannot resume a stale copy.
    expect(first.peek("unsaved")).toBe(session);
    expect(storage.saved.has("unsaved")).toBe(false);
    await expect(storage.process().find("unsaved", RUN)).resolves.toBeUndefined();

    storage.failWrites.delete("unsaved");
    await expect(first.persist(session)).resolves.toBe("saved");
    expect((await storage.process().resolve("unsaved", RUN)).revision).toBe(1);
  });

  it("reports a change another process got ahead of instead of treating it as saved", async () => {
    const storage = sharedRunStorage();
    const first = storage.process();
    const stale = first.begin(sessionInput("raced"));
    await first.persist(stale);
    const next = storage.process();
    const advanced = await next.resolve("raced", RUN);
    addOperation(next, advanced);
    await expect(next.persist(advanced)).resolves.toBe("saved");

    // `first` still holds generation 1 and writes generation 2, which `next` already saved.
    addOperation(first, stale);
    await expect(first.persist(stale)).resolves.toBe("superseded");
    expect(JSON.parse(storage.saved.get("raced")!.serialized).revision).toBe(1);
    expect(first.peek("raced")).toBeUndefined();
  });

  it("does not resume a session another process recorded as finished before it could remove the state", async () => {
    const storage = sharedRunStorage();
    const first = storage.process();
    const session = first.begin(sessionInput("crashed_after_finish"));
    addOperation(first, session);
    await first.persist(session);
    // The status says proposed, but the process stopped before deleting the saved state.
    storage.statusFiles.set("claude/run_visual", {
      version: 1,
      updatedAt: new Date(START).toISOString(),
      sessions: [{ ...storage.status("crashed_after_finish")!, proposed: true }],
    });

    const next = storage.process();
    await expect(next.find("crashed_after_finish", RUN)).resolves.toBeUndefined();
    expect(storage.saved.has("crashed_after_finish")).toBe(false);
  });

  it("does not save writes already queued for a session after another process got ahead of it", async () => {
    const storage = sharedRunStorage();
    const first = storage.process();
    const stale = first.begin(sessionInput("queued"));
    await first.persist(stale);
    const next = storage.process();
    const advanced = await next.resolve("queued", RUN);
    addOperation(next, advanced);
    await next.persist(advanced);

    // Two concurrent tool calls on the stale copy queue two writes. The first is refused; the
    // second must not land as a newer generation on top of the other process's change.
    addOperation(first, stale);
    await expect(Promise.all([first.persist(stale), first.persist(stale)])).resolves.toEqual(["superseded", "superseded"]);
    expect(storage.saved.get("queued")?.generation).toBe(2);
    expect(JSON.parse(storage.saved.get("queued")!.serialized).agentSession.operations).toHaveLength(1);
  });

  it("keeps a finished session's record when another process rewrites the run's status, so it is not resumed", async () => {
    const storage = sharedRunStorage();
    const first = storage.process();
    const session = first.begin(sessionInput("finished_then_crashed"));
    addOperation(first, session);
    await first.persist(session);
    // The status says proposed, but the process stopped before retiring the saved state.
    storage.statusFiles.set("claude/run_visual", {
      version: 1,
      updatedAt: new Date(START).toISOString(),
      sessions: [{ ...storage.status("finished_then_crashed")!, proposed: true }],
    });

    // A new process of the same run starts another session and rewrites the status file.
    const next = storage.process();
    await next.persist(next.begin(sessionInput("another")));
    await next.flushStatusWrites();
    expect(storage.status("finished_then_crashed")).toMatchObject({ proposed: true });

    await expect(storage.process().find("finished_then_crashed", RUN)).resolves.toBeUndefined();
  });

  it("drops a copy another process proposed, even while this process still holds it", async () => {
    const storage = sharedRunStorage();
    const first = storage.process();
    const session = first.begin(sessionInput("double_propose"));
    addOperation(first, session);
    await first.persist(session);
    const next = storage.process();
    await next.finish(await next.resolve("double_propose", RUN), "proposed");

    await expect(first.find("double_propose", RUN)).resolves.toBeUndefined();
    expect(first.peek("double_propose")).toBeUndefined();
  });

  it("restores and exposes sessions only to their own run", async () => {
    const storage = sharedRunStorage();
    const first = storage.process();
    const session = first.begin(sessionInput("owned"));
    await first.persist(session);

    const other = storage.process();
    await expect(other.find("owned", { runId: "run_other", explicit: false })).resolves.toBeUndefined();
    await expect(other.find("owned", { runId: null, explicit: false })).resolves.toBeUndefined();
    // A process that already holds the session still refuses a call that names another run.
    await expect(first.find("owned", { runId: "run_other", explicit: true })).resolves.toBeUndefined();
    await expect(first.find("owned", { runId: "run_visual", explicit: true })).resolves.toBe(session);
    expect((await storage.process().resolve("owned", { runId: "run_visual", explicit: true })).sessionId).toBe("owned");
  });

  it("keeps sessions without a run in memory only", async () => {
    const storage = sharedRunStorage();
    const lifecycle = storage.process();
    const session = lifecycle.begin(sessionInput("memory_only", { runId: undefined }));
    await lifecycle.persist(session);
    expect(storage.stateWrites).not.toHaveBeenCalled();
    expect(await lifecycle.resolve("memory_only", RUN)).toBe(session);
    await expect(storage.process().find("memory_only", RUN)).resolves.toBeUndefined();
  });
});

describe("visual lifecycle dependencies", () => {
  it("keeps lifecycle transitions independent of MCP transport, storage IO and the server controller", () => {
    const source = readFileSync(new URL("./visual-edit-session-lifecycle.ts", import.meta.url), "utf8");
    const runtimeDependencies = getSourceDependencies(source).filter((dependency) => !dependency.typeOnly);
    expect(runtimeDependencies.map(({ specifier }) => specifier)).toEqual(["node:crypto"]);
    const contract = readFileSync(new URL("../electron/visual-session-status.ts", import.meta.url), "utf8");
    expect(getSourceDependencies(contract)).toEqual([]);
  });
});
