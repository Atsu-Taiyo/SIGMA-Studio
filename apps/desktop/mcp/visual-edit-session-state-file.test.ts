import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import fsPromises from "node:fs/promises";

import { createSigmaDocAgentSession, executeSigmaDocAgentDraftTool } from "@/lib/ai/sigma-doc-agent-tools";
import { sampleDocument } from "@/lib/sample-document";
import type { MaterialItem } from "@/types/material";
import { visualSessionStateFileName } from "../electron/ai-edit-run-context";
import { createVisualEditSessionStateFiles } from "./visual-edit-session-state-file";
import { deriveVisualPreviewCode, type VisualEditSession } from "./visual-edit-session-lifecycle";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function runContextDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-visual-state-"));
  directories.push(directory);
  return directory;
}

function stateFiles(directory: string, options: { provider?: "claude" | "chatgpt" | "antigravity"; materials?: MaterialItem[] } = {}) {
  const loadMaterials = vi.fn(async () => options.materials ?? []);
  const port = createVisualEditSessionStateFiles({
    // The MCP server finds the run-context directory from its run-context file env.
    env: { SIGMA_STUDIO_RUN_CONTEXT_FILE: path.join(directory, "claude-run_state.run-context.json") },
    provider: () => options.provider ?? "claude",
    loadMaterials,
  });
  return { port, loadMaterials };
}

function visualSession(overrides: Partial<VisualEditSession> = {}): VisualEditSession {
  const targetId = "problem_complex_square_product_range";
  const agentSession = createSigmaDocAgentSession({ document: sampleDocument, selectedId: targetId });
  const inserted = executeSigmaDocAgentDraftTool(agentSession, "draft_insert_shape", {
    targetId, kind: "rectangle", x: 100, y: 100,
  });
  expect(inserted.ok, inserted.message).toBe(true);
  const createdAt = "2026-10-13T00:00:00.000Z";
  return {
    sessionId: "visual_session_state-1",
    file: {
      fileId: "file_state", workspaceId: "workspace", folderId: null, docId: sampleDocument.docId,
      title: "State", revision: 3, createdAt, updatedAt: createdAt,
    },
    baseDocument: sampleDocument,
    targetId,
    agentSession,
    revision: 1,
    lastPreviewRevision: 1,
    lastPreviewSource: "app-bridge",
    lastPreviewCode: deriveVisualPreviewCode("visual_session_state-1", 1),
    lastRenderFailure: null,
    lastInspection: { passed: true, inspectedRevision: 1, errorCount: 0, warningCount: 0, issues: [], shapeCount: 1 },
    lastReview: null,
    visualEvents: [{ toolName: "visual_insert_shape", status: "ok", message: "added", changedIds: agentSession.changedIds, createdAt }],
    createdAt,
    updatedAt: createdAt,
    runId: "run_state",
    provider: "claude",
    proposed: false,
    discarded: false,
    sourceAnalysis: "A rectangle drawn beside the problem statement.",
    plannedShapes: [{ kind: "rectangle", purpose: "outline" }],
    ...overrides,
  };
}

/** The published file of one generation, next to the session's base name. */
function generationFile(target: { key: string }, generation: number): string {
  return target.key.replace(/\.visual-session-state\.json$/, `.g${generation}.visual-session-state.json`);
}

describe("visual edit session state files", () => {
  it("writes a run-scoped generation file and restores the session as it was", async () => {
    const directory = await runContextDirectory();
    const material = { id: "material_1" } as MaterialItem;
    const { port, loadMaterials } = stateFiles(directory, { materials: [material] });
    const session = visualSession();
    const target = port.resolveTarget(session)!;
    expect(target.key).toBe(path.join(directory, visualSessionStateFileName("claude", "run_state", session.sessionId)));

    await expect(target.write(port.serialize(session, 1), 1)).resolves.toBe("written");
    await expect(target.readGeneration()).resolves.toBe(1);
    expect(await fs.readdir(directory)).toEqual(["claude-run_state.visual_session_state-1.g1.visual-session-state.json"]);

    const restored = await port.load(session.sessionId, "run_state");
    expect(restored?.generation).toBe(1);
    const resumed = restored!.session;
    expect(resumed).toMatchObject({
      sessionId: session.sessionId,
      file: session.file,
      targetId: session.targetId,
      revision: 1,
      lastPreviewCode: session.lastPreviewCode,
      lastInspection: session.lastInspection,
      visualEvents: session.visualEvents,
      runId: "run_state",
      provider: "claude",
      proposed: false,
      discarded: false,
      sourceAnalysis: session.sourceAnalysis,
      plannedShapes: session.plannedShapes,
    });
    expect(resumed.baseDocument).toEqual(session.baseDocument);
    expect(resumed.agentSession.draftDocument).toEqual(session.agentSession.draftDocument);
    expect(resumed.agentSession.operations).toEqual(session.agentSession.operations);
    expect(resumed.agentSession.changedIds).toEqual(session.agentSession.changedIds);
    expect(resumed.agentSession.toolEvents).toEqual(session.agentSession.toolEvents);
    expect(resumed.agentSession.baseDocument).toEqual(session.agentSession.baseDocument);
    // Per-operation documents are not stored; they are rebuilt from the saved operations
    // (the draft document itself is stored, so rebuilt timestamps never reach a proposal).
    expect(resumed.agentSession.operationResults.map((result) => result.draft))
      .toEqual(session.agentSession.operationResults.map((result) => result.draft));
    expect(resumed.agentSession.materials).toEqual([material]);
    expect(loadMaterials).toHaveBeenCalledOnce();
  });

  it("publishes each generation once and never lets an older one replace a newer one", async () => {
    const directory = await runContextDirectory();
    const { port } = stateFiles(directory);
    const session = visualSession();
    const target = port.resolveTarget(session)!;
    await expect(target.write(port.serialize(session, 3), 3)).resolves.toBe("written");

    await expect(target.write(port.serialize({ ...session, revision: 9 }, 3), 3)).resolves.toBe("superseded");
    await expect(target.write(port.serialize({ ...session, revision: 9 }, 2), 2)).resolves.toBe("superseded");
    expect((await port.load(session.sessionId, "run_state"))?.session.revision).toBe(1);
    await expect(target.write(port.serialize({ ...session, revision: 4 }, 4), 4)).resolves.toBe("written");
    expect((await port.load(session.sessionId, "run_state"))?.session.revision).toBe(4);
    // Older generations are cleaned up after a newer one is published; no temporary file is left.
    expect(await fs.readdir(directory)).toEqual([path.basename(generationFile(target, 4))]);
  });

  it("lets only one of two processes publish the same generation", async () => {
    const directory = await runContextDirectory();
    const session = visualSession();
    const older = stateFiles(directory).port;
    const newer = stateFiles(directory).port;
    await older.resolveTarget(session)!.write(older.serialize(session, 1), 1);
    for (let round = 0; round < 10; round += 1) {
      const generation = round + 2;
      const outcomes = await Promise.all([
        older.resolveTarget(session)!.write(older.serialize({ ...session, revision: 100 + round }, generation), generation),
        newer.resolveTarget(session)!.write(newer.serialize({ ...session, revision: 200 + round }, generation), generation),
      ]);
      expect([...outcomes].sort()).toEqual(["superseded", "written"]);
      const restored = await newer.load(session.sessionId, "run_state");
      expect(restored?.generation).toBe(generation);
      expect(restored?.session.revision).toBe(outcomes[0] === "written" ? 100 + round : 200 + round);
    }
  });

  it("refuses a slow write that was overtaken while it was still writing", async () => {
    const directory = await runContextDirectory();
    const session = visualSession();
    // Two ports stand in for two MCP server processes of the same run.
    const older = stateFiles(directory).port;
    const newer = stateFiles(directory).port;
    await older.resolveTarget(session)!.write(older.serialize(session, 1), 1);
    // The older process is slow to write generation 2; meanwhile the newer one publishes 2 and 3
    // (and cleans up 2), so the slow write can no longer collide by name.
    const writeFile = fsPromises.writeFile.bind(fsPromises);
    const slowStale = vi.spyOn(fsPromises, "writeFile").mockImplementation(async (...args: Parameters<typeof fsPromises.writeFile>) => {
      if (String(args[1]).includes('"revision":99')) await new Promise((resolve) => setTimeout(resolve, 150));
      return writeFile(...args);
    });
    try {
      const stale = older.resolveTarget(session)!.write(older.serialize({ ...session, revision: 99 }, 2), 2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(newer.resolveTarget(session)!.write(newer.serialize({ ...session, revision: 2 }, 2), 2)).resolves.toBe("written");
      await expect(newer.resolveTarget(session)!.write(newer.serialize({ ...session, revision: 3 }, 3), 3)).resolves.toBe("written");
      await expect(stale).resolves.toBe("superseded");
    } finally {
      slowStale.mockRestore();
    }
    const restored = await newer.load(session.sessionId, "run_state");
    expect(restored?.generation).toBe(3);
    expect(restored?.session.revision).toBe(3);
    expect((await fs.readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("does not save sessions without a run, and reports a failed write instead of throwing", async () => {
    const directory = await runContextDirectory();
    const { port } = stateFiles(directory);
    expect(port.resolveTarget(visualSession({ runId: null }))).toBeNull();
    expect(port.resolveTarget(visualSession({ provider: null }))).toBeNull();
    expect(createVisualEditSessionStateFiles({ env: {}, provider: () => "claude", loadMaterials: async () => [] })
      .resolveTarget(visualSession())).toBeNull();

    const session = visualSession();
    const target = port.resolveTarget(session)!;
    const link = vi.spyOn(fsPromises, "link").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    try {
      await expect(target.write(port.serialize(session, 1), 1)).resolves.toBe("failed");
    } finally {
      link.mockRestore();
    }
  });

  it("removes the older saved state when a newer one cannot be written", async () => {
    const directory = await runContextDirectory();
    const { port } = stateFiles(directory);
    const session = visualSession();
    const target = port.resolveTarget(session)!;
    await expect(target.write(port.serialize(session, 1), 1)).resolves.toBe("written");

    const link = vi.spyOn(fsPromises, "link").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    try {
      await expect(target.write(port.serialize({ ...session, revision: 2 }, 2), 2)).resolves.toBe("failed");
    } finally {
      link.mockRestore();
    }
    // Restoring generation 1 would silently lose the change the tool call reported.
    await expect(port.load(session.sessionId, "run_state")).resolves.toBeNull();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("only restores this provider's intact files for the requested session", async () => {
    const directory = await runContextDirectory();
    const claude = stateFiles(directory).port;
    const session = visualSession();
    await claude.resolveTarget(session)!.write(claude.serialize(session, 1), 1);

    await expect(stateFiles(directory, { provider: "antigravity" }).port.load(session.sessionId, "run_state")).resolves.toBeNull();
    await expect(claude.load("visual_session_other", "run_state")).resolves.toBeNull();

    const filePath = generationFile(claude.resolveTarget(session)!, 1);
    const [header, body] = (await fs.readFile(filePath, "utf8")).split("\n");
    await fs.writeFile(filePath, `${header}\n${body!.slice(0, 40)}`, "utf8");
    await expect(claude.load(session.sessionId, "run_state")).resolves.toBeNull();

    const otherHeader = JSON.stringify({ ...JSON.parse(header!), sessionId: "visual_session_other" });
    await fs.writeFile(filePath, `${otherHeader}\n${body}`, "utf8");
    await expect(claude.load(session.sessionId, "run_state")).resolves.toBeNull();

    // A newest generation that cannot be read is not replaced by an older one.
    await fs.writeFile(filePath, `${header}\n${body}`, "utf8");
    await fs.writeFile(generationFile(claude.resolveTarget(session)!, 2), "broken", "utf8");
    await expect(claude.load(session.sessionId, "run_state")).resolves.toBeNull();
  });

  it("only restores the calling run's session, even with a valid sessionId", async () => {
    const directory = await runContextDirectory();
    const { port } = stateFiles(directory);
    const session = visualSession();
    await port.resolveTarget(session)!.write(port.serialize(session, 1), 1);

    await expect(port.load(session.sessionId, "run_other")).resolves.toBeNull();
    await expect(port.load(session.sessionId, "")).resolves.toBeNull();
    // A file under this run's name whose header names another run is not this run's session.
    const filePath = generationFile(port.resolveTarget(session)!, 1);
    const [header, body] = (await fs.readFile(filePath, "utf8")).split("\n");
    await fs.writeFile(filePath, `${JSON.stringify({ ...JSON.parse(header!), runId: "run_other" })}\n${body}`, "utf8");
    await expect(port.load(session.sessionId, "run_state")).resolves.toBeNull();
  });

  it("retires a finished session so neither a load nor a late write brings it back", async () => {
    const directory = await runContextDirectory();
    const { port } = stateFiles(directory);
    const session = visualSession();
    const target = port.resolveTarget(session)!;
    await target.write(port.serialize(session, 1), 1);
    await expect(target.isRetired()).resolves.toBe(false);

    await target.retire();
    await expect(target.retire()).resolves.toBeUndefined();
    await expect(target.isRetired()).resolves.toBe(true);
    await expect(target.readGeneration()).resolves.toBeNull();
    await expect(port.load(session.sessionId, "run_state")).resolves.toBeNull();
    await expect(target.write(port.serialize(session, 2), 2)).resolves.toBe("superseded");
    // Only the marker is left, and it is named like the other state files so run cleanup removes it.
    expect(await fs.readdir(directory)).toEqual(["claude-run_state.visual_session_state-1.terminal.visual-session-state.json"]);
  });

  it("clears every saved generation without marking the session finished", async () => {
    const directory = await runContextDirectory();
    const { port } = stateFiles(directory);
    const session = visualSession();
    const target = port.resolveTarget(session)!;
    await target.write(port.serialize(session, 1), 1);
    await target.clear();
    await expect(target.readGeneration()).resolves.toBeNull();
    await expect(target.isRetired()).resolves.toBe(false);
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
