import { describe, expect, it } from "vitest";

import type { AiEditReference } from "@/lib/ai/ai-edit-reference";
import type { AiProvider } from "@/lib/ai/ai-providers";
import type { SigmaDocument } from "@/types/sigma-doc";

import {
  buildCommentAiRunRequestPlan,
  deriveAiReferenceRequestPlan,
  deriveAiRunStartTransition,
  deriveCommentAiRunEligibility,
} from "./run-request-model";

const connectedProviders: Record<AiProvider, boolean> = {
  chatgpt: true,
  claude: true,
  antigravity: true,
};

const document = {
  version: "2.0",
  docId: "run-request-test",
  metadata: { title: "AI実行" },
  content: [{
    id: "paragraph-1",
    type: "paragraph",
    children: [{ type: "text", text: "固定した本文" }],
  }],
  outputProfiles: {},
} as SigmaDocument;

function blockReference(targetId = "paragraph-1"): AiEditReference {
  return {
    kind: "block",
    targetId,
    targetType: "paragraph",
    excerpt: "固定した本文",
  };
}

function textSelectionReference(): AiEditReference {
  return {
    kind: "textSelection",
    targetId: "paragraph-1",
    targetType: "paragraph",
    excerpt: "固定した本文",
    selectedText: "固定した本文",
    mathTex: [],
  };
}

describe("comment AI run request planning", () => {
  it("ignores comments without a supported AI mention", () => {
    expect(deriveCommentAiRunEligibility({
      body: [{ type: "text", text: "ここを直して" }],
      threadAlreadyRunning: false,
      connectedProviders,
    })).toEqual({
      kind: "ignore",
      reason: "noMention",
    });
  });

  it("prioritizes an already-running thread before connection errors", () => {
    expect(deriveCommentAiRunEligibility({
      body: [{ type: "text", text: "@claude 直して" }],
      threadAlreadyRunning: true,
      connectedProviders: { ...connectedProviders, claude: false },
    })).toEqual({
      kind: "ignore",
      reason: "alreadyRunning",
    });
  });

  it("returns the provider-specific disconnected reply", () => {
    expect(deriveCommentAiRunEligibility({
      body: [{ type: "text", text: "@antigravity 直して" }],
      threadAlreadyRunning: false,
      connectedProviders: { ...connectedProviders, antigravity: false },
    })).toEqual({
      kind: "disconnected",
      match: {
        provider: "antigravity",
        authorName: "Antigravity",
        token: "@antigravity",
      },
      message: "Antigravityに接続されていません。サイドバーのAIパネルからログインしてください。",
    });
  });

  it("builds a text-range request with its target block and reference", () => {
    const eligibility = deriveCommentAiRunEligibility({
      body: [{ type: "text", text: "@claude 式を整理して" }],
      threadAlreadyRunning: false,
      connectedProviders,
    });
    expect(eligibility.kind).toBe("ready");
    if (eligibility.kind !== "ready") {
      return;
    }

    const plan = buildCommentAiRunRequestPlan({
      document,
      body: [{ type: "text", text: "@claude 式を整理して" }],
      anchor: {
        type: "textRange",
        start: { blockId: "paragraph-1", offset: 0 },
        end: { blockId: "paragraph-1", offset: 6 },
        quote: "固定した本文",
      },
      match: eligibility.match,
      models: {
        chatgpt: "gpt-model",
        claude: "claude-model",
        antigravity: "gemini-model",
      },
      reasoningEffort: "high",
    });

    expect(plan).toMatchObject({
      provider: "claude",
      model: "claude-model",
      reasoningEffort: "high",
      selectedId: "paragraph-1",
      references: [{
        kind: "textSelection",
        targetId: "paragraph-1",
        selectedText: "固定した本文",
      }],
    });
    expect(plan.instruction).toBe(
      "対象箇所: 固定した本文\n\n指示: 式を整理して",
    );
    expect(plan.document).toBe(document);
  });

  it("does not invent a block target for an overlay-only comment anchor", () => {
    const plan = buildCommentAiRunRequestPlan({
      document,
      body: [{ type: "text", text: "@codex 確認して" }],
      anchor: { type: "overlayShape", shapeIds: ["shape-1"] },
      match: {
        provider: "chatgpt",
        authorName: "ChatGPT",
        token: "@codex",
      },
      models: {
        chatgpt: "gpt-model",
        claude: "claude-model",
        antigravity: "gemini-model",
      },
      reasoningEffort: "medium",
    });

    expect(plan.selectedId).toBeNull();
    expect(plan.references).toEqual([]);
  });
});

describe("AI reference request routing", () => {
  it("keeps an active sidebar room instead of reopening inline", () => {
    expect(deriveAiReferenceRequestPlan({
      reference: textSelectionReference(),
      pinOutcome: "added",
      displayMode: "sidebar",
      inlineOpen: false,
      sidebarOpen: true,
      anchor: { left: 120, top: 240 },
      selectedId: "paragraph-1",
    })).toMatchObject({
      surfaceAction: "keepActiveSurface",
      inlineAnchor: { left: 120, top: 240 },
      selectionAction: {
        type: "selectBlock",
        targetId: "paragraph-1",
      },
    });
  });

  it("preserves the existing block selection for an overlay reference", () => {
    const overlayReference: AiEditReference = {
      ...blockReference("overlay-anchor"),
      overlaySelection: {
        selectedShapeIds: ["shape-1"],
        shapes: [],
        assets: {},
      },
    };

    expect(deriveAiReferenceRequestPlan({
      reference: overlayReference,
      pinOutcome: "duplicate",
      displayMode: "inline",
      inlineOpen: true,
      sidebarOpen: false,
      selectedId: "existing-block",
    })).toMatchObject({
      surfaceAction: "keepActiveSurface",
      selectionAction: {
        type: "preserve",
        selectedId: "existing-block",
      },
      statusMessage: "AI編集の参照対象をセットしました",
    });
  });

  it("opens inline only when no active surface exists and keeps the limit message", () => {
    expect(deriveAiReferenceRequestPlan({
      reference: blockReference(),
      pinOutcome: "limit",
      displayMode: "inline",
      inlineOpen: false,
      sidebarOpen: false,
      anchor: null,
      selectedId: null,
    })).toMatchObject({
      surfaceAction: "openInline",
      inlineAnchor: null,
      statusMessage: "参照は最大8件までです",
    });
  });
});

describe("AI run start routing", () => {
  const isActive = (status: string) => (
    status === "preparing"
    || status === "waiting"
    || status === "running"
    || status === "applying"
  );

  it("seeds already-active runs without clearing the current selection", () => {
    const result = deriveAiRunStartTransition({
      sessions: [{
        runId: "run-existing",
        status: "running",
        anchor: { documentId: "file-1" },
      }],
      activeDocumentId: "file-1",
      seenRunIds: new Set(),
      initialized: false,
      isRunActive: isActive,
    });

    expect(result.seenRunIds).toEqual(new Set(["run-existing"]));
    expect(result.newlySeenRunIds).toEqual(["run-existing"]);
    expect(result.activeDocumentRunIds).toEqual([]);
    expect(result.shouldClearActiveDocumentReference).toBe(false);
  });

  it("records background runs but prioritizes a newly started active-document run", () => {
    const result = deriveAiRunStartTransition({
      sessions: [
        {
          runId: "run-seen",
          status: "running",
          anchor: { documentId: "file-1" },
        },
        {
          runId: "run-background",
          status: "waiting",
          anchor: { documentId: "file-2" },
        },
        {
          runId: "run-active",
          status: "preparing",
          anchor: { documentId: "file-1" },
        },
        {
          runId: "run-completed",
          status: "completed",
          anchor: { documentId: "file-1" },
        },
      ],
      activeDocumentId: "file-1",
      seenRunIds: new Set(["run-seen"]),
      initialized: true,
      isRunActive: isActive,
    });

    expect(result.seenRunIds).toEqual(new Set([
      "run-seen",
      "run-background",
      "run-active",
    ]));
    expect(result.newlySeenRunIds).toEqual([
      "run-background",
      "run-active",
    ]);
    expect(result.activeDocumentRunIds).toEqual(["run-active"]);
    expect(result.shouldClearActiveDocumentReference).toBe(true);
  });

  it("does not clear after switching to a document whose run was already seen", () => {
    const result = deriveAiRunStartTransition({
      sessions: [{
        runId: "run-background",
        status: "running",
        anchor: { documentId: "file-2" },
      }],
      activeDocumentId: "file-2",
      seenRunIds: new Set(["run-background"]),
      initialized: true,
      isRunActive: isActive,
    });

    expect(result.newlySeenRunIds).toEqual([]);
    expect(result.shouldClearActiveDocumentReference).toBe(false);
  });
});
