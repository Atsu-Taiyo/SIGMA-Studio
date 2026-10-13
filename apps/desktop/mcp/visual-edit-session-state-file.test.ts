import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("visual edit session state files", () => {
  it("writes a run-scoped file and restores the session as it was", async () => {
    const directory = await runContextDirectory();
    const material = { id: "material_1" } as MaterialItem;
    const { port, loadMaterials } = stateFiles(directory, { materials: [material] });
    const session = visualSession();
    const target = port.resolveTarget(session)!;
    expect(target.key).toBe(path.join(directory, visualSessionStateFileName("claude", "run_state", session.sessionId)));
    expect(path.basename(target.key)).toBe("claude-run_state.visual_session_state-1.visual-session-state.json");

    await expect(target.write(port.serialize(session, 1), 1)).resolves.toBe("written");
    await expect(target.readGeneration()).resolves.toBe(1);
    expect(await fs.readdir(directory)).toEqual([path.basename(target.key)]);

    const restored = await port.load(session.sessionId);
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

  it("refuses to overwrite a newer saved generation", async () => {
    const directory = await runContextDirectory();
    const { port } = stateFiles(directory);
    const session = visualSession();
    const target = port.resolveTarget(session)!;
    await target.write(port.serialize(session, 3), 3);

    await expect(target.write(port.serialize({ ...session, revision: 9 }, 3), 3)).resolves.toBe("superseded");
    await expect(target.write(port.serialize({ ...session, revision: 9 }, 2), 2)).resolves.toBe("superseded");
    expect((await port.load(session.sessionId))?.session.revision).toBe(1);
    await expect(target.write(port.serialize({ ...session, revision: 4 }, 4), 4)).resolves.toBe("written");
    expect((await port.load(session.sessionId))?.session.revision).toBe(4);
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
    await fs.mkdir(target.key);
    await expect(target.write(port.serialize(session, 1), 1)).resolves.toBe("failed");
  });

  it("only restores this provider's intact files for the requested session", async () => {
    const directory = await runContextDirectory();
    const claude = stateFiles(directory).port;
    const session = visualSession();
    await claude.resolveTarget(session)!.write(claude.serialize(session, 1), 1);

    await expect(stateFiles(directory, { provider: "antigravity" }).port.load(session.sessionId)).resolves.toBeNull();
    await expect(claude.load("visual_session_other")).resolves.toBeNull();

    const filePath = claude.resolveTarget(session)!.key;
    const [header, body] = (await fs.readFile(filePath, "utf8")).split("\n");
    await fs.writeFile(filePath, `${header}\n${body!.slice(0, 40)}`, "utf8");
    await expect(claude.load(session.sessionId)).resolves.toBeNull();

    const otherHeader = JSON.stringify({ ...JSON.parse(header!), sessionId: "visual_session_other" });
    await fs.writeFile(filePath, `${otherHeader}\n${body}`, "utf8");
    await expect(claude.load(session.sessionId)).resolves.toBeNull();
  });

  it("removes the file and tolerates a missing one", async () => {
    const directory = await runContextDirectory();
    const { port } = stateFiles(directory);
    const session = visualSession();
    const target = port.resolveTarget(session)!;
    await target.write(port.serialize(session, 1), 1);
    await target.remove();
    await expect(target.remove()).resolves.toBeUndefined();
    await expect(target.readGeneration()).resolves.toBeNull();
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
