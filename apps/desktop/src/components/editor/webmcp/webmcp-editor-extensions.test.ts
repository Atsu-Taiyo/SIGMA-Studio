// @vitest-environment happy-dom

import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { EditorExtensionContextValue } from "@/components/editor/editor-extension-context";
import { WebMcpBridge, type WebMcpBridgeHandle, type WebMcpUiStatus } from "@/components/editor/webmcp/WebMcpBridge";
import { WebMcpDockSection } from "@/components/editor/webmcp/WebMcpDockSection";
import type { WebMcpHistoryEntry } from "@/components/editor/webmcp/webmcp-history";
import type { SigmaDocument } from "@/features/document";
import { blockToReferenceText } from "@/lib/ai/ai-edit-reference";
import { findBlock } from "@/lib/document-tree";
import { sampleDocument } from "@/lib/sample-document";
import { WEB_MCP_PROPOSAL_ID, type WebMcpToolDefinition } from "@/lib/webmcp-tools";

import {
  aiLockedTargetsForOrigin,
  EMPTY_AI_LOCKED_TARGETS,
  findAiLockedTargetsTouched,
  hasAiLockedTargetsTouched,
  withAiResultOnlyTargets,
} from "@/features/ai-edit";

import {
  buildWebMcpEditorExtensions,
  mergeEditorExtensionSets,
} from "./webmcp-editor-extensions";

describe("WebMCP editor extensions", () => {
  it("registers tools when Codex injects document.modelContext after the editor mounts", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Reflect.deleteProperty(window.document, "modelContext");
    const registeredTools: WebMcpToolDefinition[] = [];
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(WebMcpBridge, {
          enabled: true,
          instructionScopeId: "doc_delayed_webmcp_context",
          commitDocumentChange: () => {},
          getDocument: () => sampleDocument,
          getRevision: () => 0,
          getSelectedBlockId: () => null,
          getSelection: () => ({ blockId: null, textRange: null, inlineMath: null, overlayShapes: [] }),
          navigateToTarget: () => {},
          onPreviewGroupsChange: () => {},
          onHistoryChange: () => {},
        }));
        await Promise.resolve();
      });

      await act(async () => {
        Object.defineProperty(window.document, "modelContext", {
          configurable: true,
          value: {
            registerTool: async (tool: WebMcpToolDefinition) => { registeredTools.push(tool); },
          },
        });
        await vi.waitFor(() => expect(registeredTools).toHaveLength(28));
      });
      expect((window as typeof window & { __sigmaWebMcpStatus?: WebMcpUiStatus }).__sigmaWebMcpStatus)
        .toMatchObject({ state: "connected", registeredToolCount: 28 });
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      Reflect.deleteProperty(window.document, "modelContext");
    }
  });

  it("deduplicates pending targets and exposes real body and overlay locks", () => {
    const extensions = buildWebMcpEditorExtensions({
      blockIds: ["p_1", "p_1", "p_2"],
      shapeIds: ["shape_1", "shape_1", "shape_2"],
    }, "Review the proposal first");

    expect(extensions.textFlowEditPolicy?.guards.map((guard) => guard.blockId)).toEqual(["p_1", "p_2"]);
    expect(extensions.textFlowEditPolicy?.guards[0]).toMatchObject({
      blockedMessage: "Review the proposal first",
      highlight: true,
    });
    expect([...extensions.overlayEditPolicy!.lockedShapeIds]).toEqual(["shape_1", "shape_2"]);
    expect(extensions.overlayShapeDecorations?.get("shape_1")?.className).toBe("webmcp-edit-target-shape");
  });

  it("keeps a block whole-guarded when a later set reserves only a fragment of it", () => {
    const presentation = { highlightedBlockClassName: "a", readOnlyBlockClassName: "b", characterClassName: "c", atomClassName: "d" };
    const whole = { blockId: "x", guardId: "result-only-x", isPrimaryActionTarget: false, blockedMessage: "隠している", presentation, highlight: false };
    const partial = { ...whole, guardId: "run-x", blockedMessage: "AI編集中", contentReservations: [{ baselineText: "x", ranges: [{ from: 0, to: 1 }], inlineMathIds: [] }] };

    const merged = mergeEditorExtensionSets({ textFlowEditPolicy: { guards: [whole] } }, { textFlowEditPolicy: { guards: [partial] } });

    const [guard] = merged!.textFlowEditPolicy!.guards;
    expect(guard).toMatchObject({ guardId: "run-x" });
    expect(guard.contentReservations).toBeUndefined();
  });

  it("unions WebMCP locks with desktop AI editor extensions", () => {
    const aiExtensions: EditorExtensionContextValue = {
      textFlowEditPolicy: {
        guards: [{
          blockId: "p_ai",
          guardId: "ai",
          isPrimaryActionTarget: true,
          blockedMessage: "AI lock",
          presentation: {
            highlightedBlockClassName: "ai-highlight",
            readOnlyBlockClassName: "ai-readonly",
            characterClassName: "ai-character",
            atomClassName: "ai-atom",
          },
          highlight: true,
        }],
      },
      overlayEditPolicy: { lockedShapeIds: new Set(["shape_ai"]) },
      overlayShapeDecorations: new Map([["shape_shared", { className: "ai-shape" }]]),
    };
    const webExtensions = buildWebMcpEditorExtensions({
      blockIds: ["p_web"],
      shapeIds: ["shape_web", "shape_shared"],
    }, "WebMCP lock");

    const merged = mergeEditorExtensionSets(aiExtensions, webExtensions)!;

    expect(merged.textFlowEditPolicy?.guards.map((guard) => guard.blockId)).toEqual(["p_ai", "p_web"]);
    expect([...merged.overlayEditPolicy!.lockedShapeIds]).toEqual(["shape_ai", "shape_web", "shape_shared"]);
    expect(merged.overlayShapeDecorations?.get("shape_shared")?.className).toBe(
      "ai-shape webmcp-edit-target-shape",
    );
  });

  it("keeps the first set's frame drawing, body policy and decorations when the second only locks shapes", () => {
    const problemFrameDrawing = { renderPanel: () => null };
    const textFlowEditPolicy = { guards: [] };
    const overlayShapeDecorations = new Map([["shape_ai", { className: "ai-shape" }]]);
    const first: EditorExtensionContextValue = {
      textFlowEditPolicy,
      overlayEditPolicy: { lockedShapeIds: new Set(["shape_ai"]) },
      overlayShapeDecorations,
      problemFrameDrawing,
    };
    const shapeOnly: EditorExtensionContextValue = {
      overlayEditPolicy: { lockedShapeIds: new Set(["hidden"]), unselectableShapeIds: new Set(["hidden"]) },
    };

    const merged = mergeEditorExtensionSets(first, shapeOnly)!;

    // 枠の AI タブ (問題設定の枠エディタ) が消えない。
    expect(merged.problemFrameDrawing).toBe(problemFrameDrawing);
    // 本文の編集面の方針と図形の飾りは同じオブジェクトのまま (本文ユニットを描き直させない)。
    expect(merged.textFlowEditPolicy).toBe(textFlowEditPolicy);
    expect(merged.overlayShapeDecorations).toBe(overlayShapeDecorations);
    expect([...merged.overlayEditPolicy!.unselectableShapeIds!]).toEqual(["hidden"]);
    // 2 つ目が飾りを持つなら、2 つ目の frame drawing より 1 つ目のものも引き継ぐ。
    expect(mergeEditorExtensionSets(shapeOnly, first)!.problemFrameDrawing).toBe(problemFrameDrawing);
  });

  it("publishes refresh conflicts, blocks apply, and recovers after the human edit is undone", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const original: SigmaDocument = {
      ...structuredClone(sampleDocument),
      docId: "doc_webmcp_bridge_test",
      content: [
        { type: "paragraph", id: "p_target", children: [{ type: "text", text: "Original" }] },
        { type: "paragraph", id: "p_other", children: [{ type: "text", text: "Other" }] },
      ],
    };
    let currentDocument = structuredClone(original);
    let revision = 0;
    let commitCount = 0;
    const registeredTools: WebMcpToolDefinition[] = [];
    Object.defineProperty(window.document, "modelContext", {
      configurable: true,
      value: {
        registerTool: async (tool: WebMcpToolDefinition) => { registeredTools.push(tool); },
        provideContext: () => {},
      },
    });
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    const bridgeRef = createRef<WebMcpBridgeHandle>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const getDocument = () => currentDocument;
    const getRevision = () => revision;
    const commitDocumentChange = (change: (document: SigmaDocument) => SigmaDocument) => {
      commitCount += 1;
      currentDocument = change(currentDocument);
      revision += 1;
    };
    const renderBridge = async () => {
      await act(async () => {
        root.render(createElement("div", null,
          createElement(WebMcpBridge, {
            ref: bridgeRef,
            enabled: true,
            instructionScopeId: "doc_webmcp_bridge_test",
            commitDocumentChange,
            getDocument,
            getRevision,
            getSelectedBlockId: () => "p_target",
            getSelection: () => ({ blockId: "p_target", textRange: null, inlineMath: null, overlayShapes: [] }),
            navigateToTarget: () => {},
            onPreviewGroupsChange: () => {},
            onHistoryChange: () => {},
          }),
          createElement(WebMcpDockSection, {
            instructionScopeId: "doc_webmcp_bridge_test",
            onDismissProposal: () => {},
          }),
        ));
        await Promise.resolve();
      });
    };

    try {
      await renderBridge();
      const updateTool = registeredTools.find((tool) => tool.name === "edit_text");
      if (!updateTool) throw new Error("edit_text was not registered");
      await act(async () => {
        await updateTool.execute({
          expectedRevision: 0,
          operations: [{
            op: "replace_text",
            target: { type: "block", blockId: "p_target" },
            replacement: "Agent edit",
          }],
        });
      });

      currentDocument = {
        ...currentDocument,
        content: [
          { type: "paragraph", id: "p_target", children: [{ type: "text", text: "検収用段落その一。競合後も内容を確認できます。" }] },
          currentDocument.content[1]!,
        ],
      };
      revision += 1;
      await renderBridge();
      const conflictedStatus = (window as typeof window & { __sigmaWebMcpStatus?: WebMcpUiStatus }).__sigmaWebMcpStatus;
      expect(conflictedStatus?.conflictTargetIds).toEqual(["p_target"]);
      expect(conflictedStatus?.conflictTargets).toBe("検収用段落その一。競合後も内容を確認でき…");
      const dockConflict = container.querySelector(".ai-task-dock-webmcp-conflict");
      expect(dockConflict?.textContent).toContain("検収用段落その一。競合後も内容を確認でき…");
      expect(dockConflict?.textContent).not.toContain("p_target");
      const bridgeStatus = container.querySelector(".webmcp-proposal-status");
      expect(bridgeStatus?.textContent).toContain("検収用段落その一。競合後も内容を確認でき…");
      expect(bridgeStatus?.textContent).not.toContain("p_target");
      expect(consoleError).not.toHaveBeenCalled();

      const blockedApply = await bridgeRef.current!.applyProposalIds([WEB_MCP_PROPOSAL_ID]);
      expect(blockedApply).toMatchObject({ ok: false, reason: expect.stringContaining("検収用段落その一。競合後も内容を確認でき…") });
      expect(blockedApply?.ok === false ? blockedApply.reason : "").not.toContain("p_target");
      expect(commitCount).toBe(0);

      currentDocument = structuredClone(original);
      revision += 1;
      await renderBridge();
      const recoveredStatus = (window as typeof window & { __sigmaWebMcpStatus?: WebMcpUiStatus }).__sigmaWebMcpStatus;
      expect(recoveredStatus?.conflictTargetIds).toEqual([]);

      const applied = await bridgeRef.current!.applyProposalIds([WEB_MCP_PROPOSAL_ID]);
      expect(applied).toEqual({ ok: true });
      expect(commitCount).toBe(1);
      expect(blockToReferenceText(findBlock(currentDocument, "p_target")!)).toBe("Agent edit");
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      consoleError.mockRestore();
      Reflect.deleteProperty(window.document, "modelContext");
    }
  });

  it("applies an approved proposal whose target is folded away to show only its result (the fold stops human edits only)", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let currentDocument: SigmaDocument = {
      ...structuredClone(sampleDocument),
      docId: "doc_webmcp_result_only_apply_test",
      content: [{ type: "paragraph", id: "p_target", children: [{ type: "text", text: "Original" }] }],
    };
    let revision = 0;
    const registeredTools: WebMcpToolDefinition[] = [];
    Object.defineProperty(window.document, "modelContext", {
      configurable: true,
      value: {
        registerTool: async (tool: WebMcpToolDefinition) => { registeredTools.push(tool); },
        provideContext: () => {},
      },
    });
    // EditorShell の変更口と同じ規則: 紙面のカードが「適用後だけ」で畳んだ p_target は、人の編集だけを断る。
    const held = withAiResultOnlyTargets(EMPTY_AI_LOCKED_TARGETS, { blockIds: new Set(["p_target"]), shapeIds: new Set() });
    const commitDocumentChange = (change: (document: SigmaDocument) => SigmaDocument, options?: { origin?: "ai-approval" }) => {
      const next = change(currentDocument);
      if (hasAiLockedTargetsTouched(findAiLockedTargetsTouched(currentDocument, next, aiLockedTargetsForOrigin(held, options?.origin ?? "human-edit")))) {
        return false;
      }
      currentDocument = next;
      revision += 1;
      return true;
    };
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    const bridgeRef = createRef<WebMcpBridgeHandle>();
    try {
      await act(async () => {
        root.render(createElement(WebMcpBridge, {
          ref: bridgeRef,
          enabled: true,
          instructionScopeId: "doc_webmcp_result_only_apply_test",
          commitDocumentChange,
          getDocument: () => currentDocument,
          getRevision: () => revision,
          getSelectedBlockId: () => "p_target",
          getSelection: () => ({ blockId: "p_target", textRange: null, inlineMath: null, overlayShapes: [] }),
          navigateToTarget: () => {},
          onPreviewGroupsChange: () => {},
          onHistoryChange: () => {},
        }));
        await Promise.resolve();
      });
      const updateTool = registeredTools.find((tool) => tool.name === "edit_text");
      if (!updateTool) throw new Error("edit_text was not registered");
      await act(async () => {
        await updateTool.execute({
          expectedRevision: 0,
          operations: [{ op: "replace_text", target: { type: "block", blockId: "p_target" }, replacement: "Agent edit" }],
        });
      });

      let applied: Awaited<ReturnType<WebMcpBridgeHandle["applyProposalIds"]>> = null;
      await act(async () => {
        applied = await bridgeRef.current!.applyProposalIds([WEB_MCP_PROPOSAL_ID]);
      });

      expect(applied).toEqual({ ok: true });
      expect(blockToReferenceText(findBlock(currentDocument, "p_target")!)).toBe("Agent edit");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      Reflect.deleteProperty(window.document, "modelContext");
    }
  });

  it("keeps a silently rejected proposal and its draft re-applicable", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let currentDocument: SigmaDocument = {
      ...structuredClone(sampleDocument),
      docId: "doc_webmcp_rejected_apply_test",
      content: [
        { type: "paragraph", id: "p_target", children: [{ type: "text", text: "Original" }] },
        { type: "paragraph", id: "p_other", children: [{ type: "text", text: "Other" }] },
      ],
    };
    let revision = 0;
    let rejectWrite = true;
    const registeredTools: WebMcpToolDefinition[] = [];
    Object.defineProperty(window.document, "modelContext", {
      configurable: true,
      value: {
        registerTool: async (tool: WebMcpToolDefinition) => { registeredTools.push(tool); },
        provideContext: () => {},
      },
    });
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    const bridgeRef = createRef<WebMcpBridgeHandle>();
    const historyUpdates: WebMcpHistoryEntry[][] = [];

    try {
      await act(async () => {
        root.render(createElement(WebMcpBridge, {
          ref: bridgeRef,
          enabled: true,
          instructionScopeId: "doc_webmcp_rejected_apply_test",
          commitDocumentChange: (change: (document: SigmaDocument) => SigmaDocument) => {
            const next = change(currentDocument);
            if (rejectWrite) return;
            currentDocument = next;
            revision += 1;
          },
          getDocument: () => currentDocument,
          getRevision: () => revision,
          getSelectedBlockId: () => "p_target",
          getSelection: () => ({ blockId: "p_target", textRange: null, inlineMath: null, overlayShapes: [] }),
          navigateToTarget: () => {},
          onPreviewGroupsChange: () => {},
          onHistoryChange: (entries) => { historyUpdates.push(entries); },
        }));
        await Promise.resolve();
      });
      const updateTool = registeredTools.find((tool) => tool.name === "edit_text");
      if (!updateTool) throw new Error("edit_text was not registered");
      await act(async () => {
        await updateTool.execute({
          expectedRevision: 0,
          operations: [{ op: "replace_text", target: { type: "block", blockId: "p_target" }, replacement: "Agent edit" }],
        });
      });

      let rejected: Awaited<ReturnType<WebMcpBridgeHandle["applyProposalIds"]>> = null;
      await act(async () => {
        rejected = await bridgeRef.current!.applyProposalIds([WEB_MCP_PROPOSAL_ID]);
      });
      expect(rejected).toMatchObject({ ok: false, reason: expect.any(String) });
      expect(blockToReferenceText(findBlock(currentDocument, "p_target")!)).toBe("Original");
      expect((window as typeof window & { __sigmaWebMcpStatus?: WebMcpUiStatus }).__sigmaWebMcpStatus?.operationCount).toBe(1);
      expect(historyUpdates.at(-1)).toEqual([]);

      await act(async () => {
        await updateTool.execute({
          expectedRevision: 0,
          operations: [{ op: "replace_text", target: { type: "block", blockId: "p_other" }, replacement: "Agent follow-up" }],
        });
      });
      expect((window as typeof window & { __sigmaWebMcpStatus?: WebMcpUiStatus }).__sigmaWebMcpStatus?.operationCount).toBe(2);

      rejectWrite = false;
      let applied: Awaited<ReturnType<WebMcpBridgeHandle["applyProposalIds"]>> = null;
      await act(async () => {
        applied = await bridgeRef.current!.applyProposalIds([WEB_MCP_PROPOSAL_ID]);
      });
      expect(applied).toEqual({ ok: true });
      expect(blockToReferenceText(findBlock(currentDocument, "p_target")!)).toBe("Agent edit");
      expect(blockToReferenceText(findBlock(currentDocument, "p_other")!)).toBe("Agent follow-up");
      expect(historyUpdates.at(-1)).toEqual([expect.objectContaining({ status: "applied", operationCount: 2 })]);

      await act(async () => {
        await updateTool.execute({
          expectedRevision: 1,
          operations: [{ op: "replace_text", target: { type: "block", blockId: "p_target" }, replacement: "Discarded edit" }],
        });
      });
      await act(async () => {
        expect(bridgeRef.current!.dismissProposalIds([WEB_MCP_PROPOSAL_ID])).toBe(true);
      });
      const settledHistory = historyUpdates.at(-1)!;
      expect(settledHistory).toHaveLength(2);
      expect(settledHistory.map((entry) => entry.id)).toEqual([
        WEB_MCP_PROPOSAL_ID,
        WEB_MCP_PROPOSAL_ID,
      ]);
      expect(new Set(settledHistory.map((entry) => entry.entryId)).size).toBe(2);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      Reflect.deleteProperty(window.document, "modelContext");
    }
  });
});
