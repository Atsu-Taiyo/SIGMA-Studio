import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { OverlayAsset, OverlayShape } from "@/components/editor/overlay-canvas/types";
import type { OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import type { AiEditPreviewState } from "@/components/editor/ai-edit-preview-types";
import type { AiRunSession } from "@/lib/ai/ai-run-session-store";

import type { AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import { getAiEditReferenceKey, type AiEditReference } from "@/lib/ai/ai-edit-reference";
import { setAppLocale } from "@/lib/i18n";

import {
  AssistantActivity,
  AssistantPlanChecklist,
  AssistantTurnView,
  AttachmentPreview,
  createAiEditAttachmentFromFile,
  ChatHistoryRoomItem,
  ProviderSwitch,
  UserTurnView,
  buildSelectedOverlayShapePreview,
  buildStoredOverlaySelectionPreview,
  findActiveRoomPreview,
  getReferenceContextText,
  hasSelectedOverlayImageAttachments,
  removeActiveTriggerRange,
  removeMentionedDocumentByFileId,
  resolvePendingAssistantTurns,
  resolveQueuedRunAgentThreadId,
  toggleAiResourceSelection,
  upsertMentionedDocument,
  type ActiveMentionQuery,
  type AiEditChatRoom,
  type AssistantTurn,
  type ChatTurn,
  type UserTurn,
} from "./AiEditPanel";

describe("PDF file attachments", () => {
  it.each(["application/pdf", "", "application/octet-stream"])("preserves PDF bytes with MIME type %j", async (type) => {
    class Reader extends EventTarget {
      result = "";
      async readAsDataURL(file: File) {
        this.result = `data:${file.type || "application/octet-stream"};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
        this.dispatchEvent(new Event("load"));
      }
    }
    vi.stubGlobal("FileReader", Reader);
    try {
      const file = new File(["%PDF-1.7"], "worksheet.PDF", { type });
      const attachment = await createAiEditAttachmentFromFile(file, "file");
      expect(attachment.mimeType).toBe("application/pdf");
      expect(attachment.dataUrl).toBe(`data:application/pdf;base64,${Buffer.from("%PDF-1.7").toString("base64")}`);
      expect(attachment.name).toBe("worksheet.PDF");
      expect(attachment.fileSize).toBe(file.size);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("getReferenceContextText", () => {
  it("re-resolves an overlay reference after the display locale changes", () => {
    const reference: AiEditReference = {
      kind: "block",
      targetId: selectedRectangleShape.id,
      targetType: "overlayShape:geo",
      excerpt: "Selected shape count: 1",
      overlaySelection: {
        selectedShapeIds: [selectedRectangleShape.id],
        shapes: [selectedRectangleShape],
        assets: {},
      },
    };

    setAppLocale("en");
    setAppLocale("ja");
    expect(getReferenceContextText(reference)).toBe("図形1件\n選択図形: geo:shape_rectangle");
  });
});

describe("findActiveRoomPreview", () => {
  const makePreview = (roomId: string): AiEditPreviewState => ({
    targetId: "p1",
    roomId,
    proposalIds: [`proposal-${roomId}`],
    baseRevision: 1,
    providers: ["chatgpt"],
    createdAt: 0,
    draft: { summary: "編集案", plan: [], operations: [], warnings: [] },
  });

  it("サイドバーで開いている会話の提案だけを選ぶ", () => {
    const active = findActiveRoomPreview([makePreview("room-a"), makePreview("room-b")], "room-b");
    expect(active?.proposalIds).toEqual(["proposal-room-b"]);
  });

  it("会話未選択時は提案操作を出さない", () => {
    expect(findActiveRoomPreview([makePreview("room-a")], null)).toBeNull();
  });
});

function makeChatRoom(overrides: Partial<AiEditChatRoom> = {}): AiEditChatRoom {
  return {
    version: 1,
    id: "room1",
    documentIdentityKey: "doc1",
    title: "テスト",
    agentThreadId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    turns: [],
    ...overrides,
  };
}

function makeUserTurn(overrides: Partial<UserTurn> = {}): UserTurn {
  return {
    id: "u1",
    role: "user",
    documentIdentityKey: "doc1",
    instruction: "続けて編集して",
    references: [],
    attachments: [],
    mentionedDocuments: [],
    timestamp: 0,
    ...overrides,
  };
}

function makeAssistantTurn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    id: "a1",
    role: "assistant",
    documentIdentityKey: "doc1",
    references: [],
    events: [],
    streamText: "",
    reasoningText: "",
    planSteps: [],
    planExplanation: null,
    startedAt: 0,
    endedAt: null,
    isRunning: false,
    result: null,
    targetId: null,
    error: null,
    applied: false,
    dismissed: false,
    ...overrides,
  };
}

function makeRunSession(overrides: Partial<AiRunSession> = {}): AiRunSession {
  return {
    roomId: "room1",
    runId: "run1",
    provider: "claude",
    status: "running",
    events: [],
    streamText: "",
    planSteps: [],
    error: null,
    startedAt: 0,
    endedAt: null,
    anchor: null,
    queuedMessages: [],
    ...overrides,
  };
}

describe("ChatHistoryRoomItem", () => {
  it("keeps a running history row to a thinking orb plus a shimmering title", () => {
    const html = renderToStaticMarkup(
      <ChatHistoryRoomItem
        room={makeChatRoom({
          provider: "claude",
          title: "二次関数の例題を追加",
          turns: [makeUserTurn({ instruction: "履歴行には表示しない詳細" })],
        })}
        session={makeRunSession()}
        active
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('data-provider="claude"');
    expect(html).toContain('data-running="true"');
    expect(html).toContain("ai-thinking-orb");
    expect(html).toContain("ui-shimmer-text");
    expect(html).toContain("二次関数の例題を追加");
    expect(html).not.toContain("履歴行には表示しない詳細");
  });

  it("uses the room provider logo without shimmer after completion", () => {
    const html = renderToStaticMarkup(
      <ChatHistoryRoomItem
        room={makeChatRoom({ provider: "chatgpt", title: "完了した会話" })}
        session={makeRunSession({ provider: "chatgpt", status: "completed" })}
        active={false}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('data-provider="chatgpt"');
    expect(html).toContain('data-running="false"');
    expect(html).not.toContain("ui-shimmer-text");
  });
});

function makeOverlaySelection(
  selectedShapes: OverlayShape[],
  selectedAssets: Record<string, OverlayAsset> = {},
): OverlaySelectionSummary {
  return {
    selectedCount: selectedShapes.length,
    selectedShapeIds: selectedShapes.map((shape) => shape.id),
    selectedShapes,
    selectedAssets,
    locked: false,
    hidden: false,
    grouped: false,
    canAlign: false,
    canDistribute: false,
    canStyleStroke: false,
    canStyleFill: false,
    canStyleLine: false,
    canStyleLineEndpoints: false,
    arrowheadStart: null,
    arrowheadEnd: null,
    fill: { kind: "unavailable" },
  };
}

const selectedImageShape: Extract<OverlayShape, { type: "image" }> = {
  id: "shape_image",
  type: "image",
  x: 10,
  y: 20,
  props: {
    assetId: "asset_image",
    w: 120,
    h: 80,
  },
};

const selectedRectangleShape: Extract<OverlayShape, { type: "geo" }> = {
  id: "shape_rectangle",
  type: "geo",
  x: 32,
  y: 48,
  props: {
    w: 160,
    h: 96,
    geo: "rectangle",
    fill: "none",
    color: "#111111",
    fillColor: "#ffffff",
    labelColor: "#111111",
    dash: "solid",
    size: "m",
    label: "選択図形",
  },
};

function makeImageAsset(src: string): OverlayAsset {
  return {
    id: "asset_image",
    type: "image",
    props: {
      w: 240,
      h: 160,
      name: "photo.png",
      isAnimated: false,
      mimeType: "image/png",
      src,
      fileSize: 128,
    },
  };
}

describe("hasSelectedOverlayImageAttachments", () => {
  it("treats a selected data-url image shape as an AI input attachment", () => {
    const selection = makeOverlaySelection(
      [selectedImageShape],
      { asset_image: makeImageAsset("data:image/png;base64,AAAA") },
    );

    expect(hasSelectedOverlayImageAttachments(selection)).toBe(true);
  });

  it("does not count selected image shapes whose pixels are not available inline", () => {
    const selection = makeOverlaySelection(
      [selectedImageShape],
      { asset_image: makeImageAsset("sigma-doc-storage://asset_image") },
    );

    expect(hasSelectedOverlayImageAttachments(selection)).toBe(false);
  });
});

describe("buildSelectedOverlayShapePreview", () => {
  it("builds a cropped SVG preview for a selected native overlay shape", () => {
    const preview = buildSelectedOverlayShapePreview(makeOverlaySelection([selectedRectangleShape]));

    expect(preview).not.toBeNull();
    expect(preview?.svg).toContain("<svg");
    expect(preview?.svg).toContain("選択図形");
    expect(preview?.width).toBeGreaterThan(0);
    expect(preview?.height).toBeGreaterThan(0);
  });

  it("returns null when no overlay shape is selected", () => {
    expect(buildSelectedOverlayShapePreview(makeOverlaySelection([]))).toBeNull();
  });
});

describe("buildStoredOverlaySelectionPreview", () => {
  it("reconstructs a native-shape image for a historical turn without a PNG attachment", () => {
    const preview = buildStoredOverlaySelectionPreview({
      selectedShapeIds: [selectedRectangleShape.id],
      shapes: [selectedRectangleShape],
      assets: {},
    });

    expect(preview?.svg).toContain("選択図形");
  });
});

describe("AssistantPlanChecklist", () => {
  it("renders a shimmer marker for the in-progress step and never a spinner", () => {
    const html = renderToStaticMarkup(
      <AssistantPlanChecklist
        steps={[
          { step: "手順1", status: "completed" },
          { step: "手順2", status: "inProgress" },
          { step: "手順3", status: "pending" },
        ]}
        explanation={null}
      />,
    );

    expect(html).toContain("ui-shimmer-marker");
    expect(html).not.toContain("ai-spin");
  });

  it("returns null when there are no steps", () => {
    const html = renderToStaticMarkup(
      <AssistantPlanChecklist steps={[]} explanation={null} />,
    );

    expect(html).toBe("");
  });
});

describe("AssistantActivity", () => {
  it("renders the popover action beside the elapsed time in the forced header", () => {
    const html = renderToStaticMarkup(
      <AssistantActivity
        turn={makeAssistantTurn({ isRunning: true, startedAt: 0 })}
        clockNow={12_000}
        forceExpanded
        headerAction={<button type="button" aria-label="右サイドに表示">open</button>}
      />,
    );

    expect(html).toContain("ai-activity-time");
    expect(html).toContain("ai-thinking-orb");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("ai-activity-popover-action");
    expect(html).toContain("aria-label=\"右サイドに表示\"");
    expect(html.indexOf("ai-activity-time")).toBeLessThan(html.indexOf("ai-activity-popover-action"));
  });

  it("renders a clickable thumbnail for an activity event's MCP tool-result preview image", () => {
    const html = renderToStaticMarkup(
      <AssistantActivity
        turn={makeAssistantTurn({
          events: [
            {
              id: 1,
              kind: "activity",
              phase: "streaming",
              message: "ツール実行中... (render_visual_edit_session)",
              timestamp: 0,
              itemType: "mcpToolCall",
              itemStatus: "completed",
              itemId: "toolu_1",
              images: [{ dataUrl: "data:image/png;base64,AAAA" }],
            },
          ],
        })}
        clockNow={0}
        forceExpanded
      />,
    );

    expect(html).toContain("ai-activity-item-images");
    expect(html).toContain("ai-activity-item-image-thumb");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it("renders no image thumbnail block for an activity event without images", () => {
    const html = renderToStaticMarkup(
      <AssistantActivity
        turn={makeAssistantTurn({
          events: [
            {
              id: 1,
              kind: "activity",
              phase: "streaming",
              message: "ツール実行中... (insert_shape)",
              timestamp: 0,
              itemType: "mcpToolCall",
              itemStatus: "started",
              itemId: "toolu_2",
            },
          ],
        })}
        clockNow={0}
        forceExpanded
      />,
    );

    expect(html).not.toContain("ai-activity-item-images");
  });
});

describe("resolvePendingAssistantTurns", () => {
  it("marks a still-pending assistant turn applied when the canvas card was applied", () => {
    const turns: ChatTurn[] = [makeAssistantTurn({ id: "a1" })];

    const next = resolvePendingAssistantTurns(turns, "applied");

    const turn = next[0] as AssistantTurn;
    expect(turn.applied).toBe(true);
    expect(turn.dismissed).toBe(false);
  });

  it("marks a still-pending assistant turn dismissed when the canvas card was dismissed", () => {
    const turns: ChatTurn[] = [makeAssistantTurn({ id: "a1" })];

    const next = resolvePendingAssistantTurns(turns, "dismissed");

    const turn = next[0] as AssistantTurn;
    expect(turn.applied).toBe(false);
    expect(turn.dismissed).toBe(true);
  });

  it("does not override a turn that was already applied or dismissed", () => {
    const turns: ChatTurn[] = [
      makeAssistantTurn({ id: "applied-turn", applied: true }),
      makeAssistantTurn({ id: "dismissed-turn", dismissed: true }),
    ];

    const next = resolvePendingAssistantTurns(turns, "dismissed") as AssistantTurn[];

    expect(next.find((turn) => turn.id === "applied-turn")?.applied).toBe(true);
    expect(next.find((turn) => turn.id === "applied-turn")?.dismissed).toBe(false);
    expect(next.find((turn) => turn.id === "dismissed-turn")?.dismissed).toBe(true);
  });

  it("resolves only the proposal-owning turn when turn ids are specified", () => {
    const turns: ChatTurn[] = [
      makeAssistantTurn({ id: "proposal-turn" }),
      makeAssistantTurn({ id: "other-pending-turn" }),
    ];

    const next = resolvePendingAssistantTurns(turns, "applied", new Set(["proposal-turn"])) as AssistantTurn[];

    expect(next.find((turn) => turn.id === "proposal-turn")?.applied).toBe(true);
    expect(next.find((turn) => turn.id === "other-pending-turn")?.applied).toBe(false);
  });

  it("can mark only a restored dismissed turn applied without resolving another pending turn", () => {
    const turns: ChatTurn[] = [
      makeAssistantTurn({ id: "restored-turn", dismissed: true }),
      makeAssistantTurn({ id: "other-pending-turn" }),
    ];

    const next = resolvePendingAssistantTurns(
      turns,
      "applied",
      new Set(["restored-turn"]),
      { includeResolved: true },
    ) as AssistantTurn[];

    expect(next.find((turn) => turn.id === "restored-turn")?.applied).toBe(true);
    expect(next.find((turn) => turn.id === "restored-turn")?.dismissed).toBe(false);
    expect(next.find((turn) => turn.id === "other-pending-turn")?.applied).toBe(false);
  });
});

describe("resolveQueuedRunAgentThreadId (R3 follow-up-while-running)", () => {
  it("uses the room's current agentThreadId, not the stale compose-time snapshot", () => {
    // Reproduces the bug: a brand-new room's first run is composed while
    // agentThreadId is still null (snapshot = null), the run then completes
    // and assigns a fresh thread id onto the room, and only *then* does the
    // queued follow-up drain and dispatch. It must pick up the fresh id
    // instead of replaying the null snapshot, or the provider would start an
    // unrelated new thread and the follow-up would lose context.
    const rooms: AiEditChatRoom[] = [
      makeChatRoom({ id: "room1", agentThreadId: "thread-assigned-by-first-run" }),
    ];

    const resolved = resolveQueuedRunAgentThreadId(rooms, "room1", null);

    expect(resolved).toBe("thread-assigned-by-first-run");
  });

  it("also overrides a stale non-null snapshot when the thread id has since changed", () => {
    const rooms: AiEditChatRoom[] = [
      makeChatRoom({ id: "room1", agentThreadId: "thread-2" }),
    ];

    const resolved = resolveQueuedRunAgentThreadId(rooms, "room1", "thread-1");

    expect(resolved).toBe("thread-2");
  });

  it("falls back to the snapshot value when the room can no longer be found", () => {
    const rooms: AiEditChatRoom[] = [makeChatRoom({ id: "other-room" })];

    const resolved = resolveQueuedRunAgentThreadId(rooms, "room1", "thread-1");

    expect(resolved).toBe("thread-1");
  });
});

/** Returns the outer HTML of the first element carrying `className`, by walking
 * the element's own tag and tracking nesting depth. The unit test environment
 * has no DOM, and asserting only on substring order would still pass if a child
 * were moved out to be a sibling — which is exactly what would silently break
 * the `:has()`-based bubble rules in globals.css. */
function outerHtmlOf(html: string, className: string): string {
  const open = new RegExp(`<([a-z]+)[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`).exec(html);
  if (!open) {
    throw new Error(`no element with class ${className}`);
  }
  const tag = open[1];
  const tags = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}>`, "g");
  tags.lastIndex = open.index;
  let depth = 0;
  let match = tags.exec(html);
  while (match) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        return html.slice(open.index, match.index + match[0].length);
      }
    } else if (match[1] !== "/") {
      depth += 1;
    }
    match = tags.exec(html);
  }
  throw new Error(`unbalanced <${tag}> around .${className}`);
}

describe("UserTurnView (R3 follow-up-while-running affordances)", () => {
  it("renders a non-image attachment as a file row instead of a broken image", () => {
    const html = renderToStaticMarkup(
      <UserTurnView
        turn={makeUserTurn({
          attachments: [{
            id: "attachment_pdf",
            name: "worksheet.pdf",
            mimeType: "application/pdf",
            width: null,
            height: null,
            fileSize: 128,
            dataUrl: "data:application/pdf;base64,JVBERg==",
          }],
        })}
      />,
    );

    expect(html).toContain("worksheet.pdf");
    expect(html).toContain("lucide-file");
    expect(html).not.toContain("ai-chat-user-attachment-image");
  });

  it("renders a persisted selected-shape preview as a small chat image", () => {
    const html = renderToStaticMarkup(
      <UserTurnView
        turn={makeUserTurn({
          attachments: [{
            id: "overlay_preview_1",
            name: "選択図形プレビュー-1件.png",
            mimeType: "image/png",
            width: 320,
            height: 192,
            fileSize: 128,
            dataUrl: "data:image/png;base64,AAAA",
          }],
        })}
      />,
    );

    expect(html).toContain("ai-chat-user-attachment-image");
    expect(html).toContain("ai-chat-user-attachment--overlay");
    expect(html).toContain('class="ai-chat-shape-label-chip">図形1</figcaption>');
    expect(html).toContain("選択図形プレビュー-1件.png");
    expect(html).toContain("data:image/png;base64,AAAA");
  });

  it("renders a historical selected native shape as an image when the old turn has no PNG", () => {
    const html = renderToStaticMarkup(
      <UserTurnView
        turn={makeUserTurn({
          references: [{
            kind: "block",
            targetId: "block_1",
            targetType: "paragraph",
            excerpt: "本文",
            overlaySelection: {
              selectedShapeIds: [selectedRectangleShape.id],
              shapes: [selectedRectangleShape],
              assets: {},
            },
          }],
          attachments: [],
        })}
      />,
    );

    expect(html).toContain("ai-chat-user-attachment-image--svg");
    expect(html).toContain("選択図形プレビュー-1件");
    expect(html).toContain('class="ai-chat-shape-label-chip">図形1</figcaption>');
    expect(html).toContain("選択図形");
  });

  it("keeps each overlay preview when only one of two references has a keyed PNG", () => {
    const secondShape: Extract<OverlayShape, { type: "geo" }> = {
      ...selectedRectangleShape,
      id: "shape_rectangle_2",
      x: 240,
      props: { ...selectedRectangleShape.props, label: "第二図形" },
    };
    const firstReference: AiEditReference = {
      kind: "block",
      targetId: "block_1",
      targetType: "paragraph",
      excerpt: "第一の挿入先",
      overlaySelection: {
        selectedShapeIds: [selectedRectangleShape.id],
        shapes: [selectedRectangleShape],
        assets: {},
      },
    };
    const secondReference: AiEditReference = {
      kind: "block",
      targetId: "block_2",
      targetType: "paragraph",
      excerpt: "第二の挿入先",
      overlaySelection: {
        selectedShapeIds: [secondShape.id],
        shapes: [secondShape],
        assets: {},
      },
    };
    const html = renderToStaticMarkup(
      <UserTurnView
        turn={makeUserTurn({
          references: [firstReference, secondReference],
          attachments: [{
            id: "overlay_preview_1",
            name: "選択図形プレビュー-1件.png",
            mimeType: "image/png",
            width: 320,
            height: 192,
            fileSize: 128,
            dataUrl: "data:image/png;base64,AAAA",
            sourceReferenceKey: getAiEditReferenceKey(firstReference),
          }],
        })}
      />,
    );

    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("第二図形");
    expect(html.match(/ai-chat-user-attachment-image--svg/g)).toHaveLength(1);
  });

  it("shows a 送信待ち pill for a turn queued behind an in-flight run", () => {
    const html = renderToStaticMarkup(<UserTurnView turn={makeUserTurn({ queued: true })} />);

    expect(html).toContain("送信待ち");
    expect(html).not.toContain("未送信");
  });

  it("shows a 未送信 pill with a resend button when a queued turn's run failed", () => {
    const html = renderToStaticMarkup(
      <UserTurnView turn={makeUserTurn({ queueFailed: true })} onResend={() => {}} />,
    );

    expect(html).toContain("未送信");
    expect(html).toContain("再送信");
  });

  it("renders neither pill for a normal, already-sent turn", () => {
    const html = renderToStaticMarkup(<UserTurnView turn={makeUserTurn()} />);

    expect(html).not.toContain("送信待ち");
    expect(html).not.toContain("未送信");
  });

  // 吹き出しの見た目そのもの (背景・余白・角) は globals.css 側にあり、この環境には
  // DOM が無いので値は検証できない。代わりに、その CSS が依存している構造 —
  // 1発言 = 吹き出し要素1つ、本文と添付がその「中」にある — をここで固定する。
  // 兄弟に出てしまうと :has() ルールが効かず、添付ありの吹き出し移動が壊れる。
  it("wraps a plain user turn in exactly one bubble element that holds the text", () => {
    const html = renderToStaticMarkup(<UserTurnView turn={makeUserTurn()} />);

    expect(html.match(/ai-chat-user-bubble/g)).toHaveLength(1);
    const bubble = outerHtmlOf(html, "ai-chat-user-bubble");
    expect(bubble).toContain("ai-chat-user-text");
    expect(bubble).toContain("続けて編集して");
  });

  it("keeps attachments and the text inside the same bubble so the bubble can move onto the text", () => {
    const html = renderToStaticMarkup(
      <UserTurnView
        turn={makeUserTurn({
          attachments: [{
            id: "attachment_png",
            name: "figure.png",
            mimeType: "image/png",
            width: 320,
            height: 192,
            fileSize: 128,
            dataUrl: "data:image/png;base64,AAAA",
          }],
        })}
      />,
    );

    expect(html.match(/ai-chat-user-bubble/g)).toHaveLength(1);
    const bubble = outerHtmlOf(html, "ai-chat-user-bubble");
    const attachmentsIndex = bubble.indexOf("ai-chat-user-attachments");
    const textIndex = bubble.indexOf("ai-chat-user-text");
    expect(attachmentsIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThan(attachmentsIndex);
  });

  it("renders one meta chip per reference for a multi-reference turn", () => {
    const html = renderToStaticMarkup(
      <UserTurnView
        turn={makeUserTurn({
          references: [
            {
              kind: "textSelection",
              targetId: "p_1",
              targetType: "paragraph",
              excerpt: "二次関数の最大値を求めよ",
              selectedText: "二次関数の最大値を求めよ",
              mathTex: [],
            },
            {
              kind: "block",
              targetId: "p_2",
              targetType: "paragraph",
              excerpt: "別の段落の抜粋です",
            },
          ],
        })}
      />,
    );

    expect(html).toContain("@二次関...求めよ");
    expect(html).toContain("@別の段...粋です");
  });
});

describe("AttachmentPreview", () => {
  it("uses a compact removable file chip for non-image formats", () => {
    const html = renderToStaticMarkup(
      <AttachmentPreview
        attachment={{
          id: "attachment_docx",
          name: "lesson.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          dataUrl: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAAA",
          fileSize: 4,
        }}
        onRemove={() => {}}
      />,
    );

    expect(html).toContain("ai-chat-file-chip");
    expect(html).toContain("lesson.docx");
    expect(html).toContain('aria-label="添付を削除"');
    expect(html).not.toContain("ai-chat-attachment-thumb");
  });
});

describe("AssistantTurnView", () => {
  // Minimal stand-in for AiEditRunResult; only the fields AssistantTurnView reads
  // (draft.summary/plan/warnings, questions) matter for this render test.
  const minimalResult = {
    draft: { summary: "編集案の概要", plan: [], warnings: [], operations: [] },
    nextDocument: {},
    operationResults: [],
    logs: [],
    repaired: false,
    changedIds: [],
  } as unknown as AssistantTurn["result"];

  it("renders the pending decision immediately below the summary, with the same GitHub風 diff as an applied change and shared black ×/○ controls", () => {
    const proposal: AiEditPreviewState = {
      targetId: "p1",
      roomId: "room1",
      turnId: "a1",
      proposalIds: ["proposal-1"],
      baseRevision: 1,
      providers: ["chatgpt"],
      createdAt: 0,
      draft: {
        summary: "図形を追加します",
        plan: [],
        warnings: [],
        operations: [{
          operation: "insertOverlayShape",
          summary: "図形を追加",
          targetId: "p1",
          overlayShape: selectedRectangleShape,
          assets: {},
        }],
      },
    };
    const proposalDiff = { body: [], shapes: [{ change: "added" as const, shape: selectedRectangleShape }] };
    const html = renderToStaticMarkup(
      <AssistantTurnView
        turn={makeAssistantTurn({ result: minimalResult })}
        clockNow={0}
        proposal={proposal}
        proposalDiff={proposalDiff}
        shapePreview={{
          svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="120" height="80" /></svg>',
          width: 120,
          height: 80,
        }}
        onApplyProposal={async () => ({ ok: true })}
        onDismissProposal={() => {}}
      />,
    );

    expect(html.indexOf("ai-chat-assistant-text")).toBeLessThan(html.indexOf("ai-chat-result-proposal"));
    expect(html).toContain("提案された変更");
    expect(html).toContain("ai-chat-result-proposal-diff");
    expect(html).toContain("+1図形");
    expect(html).toContain("<rect");
    expect(html).toContain('aria-label="破棄"');
    expect(html).toContain('aria-label="適用"');
    expect(html).toContain("lucide-check");
    expect(html).not.toContain("ai-chat-shape-artifact");
  });

  it("omits the proposal diff heading when the pending proposal has no visible body/shape change (still shows apply/dismiss)", () => {
    const proposal: AiEditPreviewState = {
      targetId: "p1",
      roomId: "room1",
      turnId: "a1",
      proposalIds: ["proposal-1"],
      baseRevision: 1,
      providers: ["chatgpt"],
      createdAt: 0,
      draft: { summary: "移動のみ", plan: [], warnings: [], operations: [] },
    };
    const html = renderToStaticMarkup(
      <AssistantTurnView
        turn={makeAssistantTurn({ result: minimalResult })}
        clockNow={0}
        proposal={proposal}
        proposalDiff={{ body: [], shapes: [] }}
        onApplyProposal={async () => ({ ok: true })}
        onDismissProposal={() => {}}
      />,
    );

    expect(html).not.toContain("提案された変更");
    expect(html).toContain('aria-label="破棄"');
    expect(html).toContain('aria-label="適用"');
  });

  it("replaces the plain 適用済み badge without repeating summary copy inside the widget", () => {
    const html = renderToStaticMarkup(
      <AssistantTurnView
        turn={makeAssistantTurn({ result: minimalResult, applied: true })}
        clockNow={0}
      />,
    );

    expect(html).toContain("適用した変更");
    expect(html.match(/編集案の概要/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="ChatGPT"');
    expect(html).not.toContain("本文を更新");
    expect(html).not.toContain("破棄済み");
  });

  it("shows the rollback icon only for an applied proposal batch that is still current", () => {
    const html = renderToStaticMarkup(
      <AssistantTurnView
        turn={makeAssistantTurn({ result: minimalResult, applied: true })}
        clockNow={0}
        appliedChange={{
          proposalIds: ["proposal-1"],
          revertProposalIds: ["proposal-1", "proposal-2"],
          providers: ["claude"],
          diff: {
            body: [
              {
                change: "removed",
                block: { id: "p1", type: "paragraph", children: [{ type: "text", text: "変更前の問題文" }] },
              },
              {
                change: "added",
                block: { id: "p1", type: "paragraph", children: [{ type: "text", text: "変更後の問題文" }] },
              },
            ],
            shapes: [],
          },
          autoApplied: false,
          canRevert: true,
        }}
        onRevertAppliedChange={async () => ({ ok: true })}
      />,
    );

    // 単語単位の差分では"変更"と"の問題文"は共通contextとして残り、"前"→"後"だけが強調される。
    expect(html).toContain("変更");
    expect(html).toContain("の問題文");
    expect(html).toMatch(/<mark[^>]*>[\s\S]*?前[\s\S]*?<\/mark>/);
    expect(html).toMatch(/<mark[^>]*>[\s\S]*?後[\s\S]*?<\/mark>/);
    expect(html).toContain("−1行");
    expect(html).toContain("+1行");
    expect(html).not.toContain("本文を更新");
    expect(html).toContain('aria-label="適用を元に戻す"');
    expect(html).not.toContain("disabled");
  });

  it("keeps the rollback action visible with its reason when the applied change cannot be reverted", () => {
    const html = renderToStaticMarkup(
      <AssistantTurnView
        turn={makeAssistantTurn({ result: minimalResult, applied: true })}
        clockNow={0}
        appliedChange={{
          proposalIds: ["proposal-1"],
          revertProposalIds: [],
          providers: ["claude"],
          diff: { body: [], shapes: [] },
          autoApplied: false,
          canRevert: false,
          revertBlockedReason: "missingData",
        }}
        onRevertAppliedChange={async () => ({ ok: true })}
      />,
    );

    expect(html).toContain('aria-label="適用を元に戻す"');
    expect(html).toContain("disabled");
    expect(html).toContain("この適用には取り消しに必要な情報が記録されていないため、元に戻せません");
  });

  it("claims nothing about revert while the applied-change record has not loaded yet", () => {
    const html = renderToStaticMarkup(
      <AssistantTurnView
        turn={makeAssistantTurn({ result: minimalResult, applied: true })}
        clockNow={0}
        onRevertAppliedChange={async () => ({ ok: true })}
      />,
    );

    expect(html).toContain("適用した変更");
    expect(html).not.toContain('aria-label="適用を元に戻す"');
    expect(html).not.toContain("元に戻せません");
  });

  it("shows an inserted shape inside the actual diff instead of a duplicate chat artifact", () => {
    const insertedShape = {
      id: "shape_1",
      type: "geo" as const,
      x: 0,
      y: 0,
      rotation: 0,
      props: {
        w: 120,
        h: 80,
        geo: "rectangle" as const,
        fill: "none" as const,
        color: "#111111",
        fillColor: "#ffffff",
        labelColor: "#111111",
        dash: "solid" as const,
        size: "m" as const,
      },
    };
    const html = renderToStaticMarkup(
      <AssistantTurnView
        turn={makeAssistantTurn({ result: minimalResult, applied: true })}
        clockNow={0}
        appliedChange={{
          proposalIds: ["proposal-1"],
          revertProposalIds: [],
          providers: ["chatgpt"],
          diff: { body: [], shapes: [{ change: "added", shape: insertedShape }] },
          autoApplied: false,
          canRevert: false,
        }}
        shapePreview={{
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect width="120" height="80" /></svg>',
          width: 120,
          height: 80,
        }}
      />,
    );

    expect(html).not.toContain("ai-chat-shape-artifact");
    expect(html).toContain("+1図形");
    expect(html).toContain("<rect");
  });

  it("uses the full chat width without provider identity chrome", () => {
    const html = renderToStaticMarkup(
      <AssistantTurnView
        turn={makeAssistantTurn({ result: minimalResult })}
        clockNow={0}
      />,
    );

    expect(html).not.toContain("ai-chat-assistant-mark");
    expect(html).not.toContain("ai-chat-assistant-provider");
    expect(html).toContain("編集案の概要");
  });

  it("renders the 破棄済み badge when the turn was dismissed", () => {
    const html = renderToStaticMarkup(
      <AssistantTurnView turn={makeAssistantTurn({ result: minimalResult, dismissed: true })} clockNow={0} />,
    );

    expect(html).toContain("破棄済み");
    expect(html).not.toContain("適用済み");
  });

  it("shows a subtle 復元 button when the turn's proposal is restorable and a handler is provided", () => {
    const html = renderToStaticMarkup(
      <AssistantTurnView
        turn={makeAssistantTurn({ result: minimalResult, dismissed: true })}
        clockNow={0}
        restorable={{ proposalIds: ["p1"] }}
        onRestoreProposal={async () => ({ ok: true })}
      />,
    );

    expect(html).toContain("復元");
    expect(html).toContain("ai-chat-result-restore");
  });

  it("omits the 復元 button when the turn is not restorable (still pending or currently applied)", () => {
    const html = renderToStaticMarkup(
      <AssistantTurnView
        turn={makeAssistantTurn({ result: minimalResult, applied: true })}
        clockNow={0}
        onRestoreProposal={async () => ({ ok: true })}
      />,
    );

    expect(html).not.toContain("ai-chat-result-restore");
  });

  it("omits the 復元 button when restorable but no handler is wired up", () => {
    const html = renderToStaticMarkup(
      <AssistantTurnView
        turn={makeAssistantTurn({ result: minimalResult, dismissed: true })}
        clockNow={0}
        restorable={{ proposalIds: ["p1"] }}
      />,
    );

    expect(html).not.toContain("ai-chat-result-restore");
  });
});

// Phase 2 (統一コンテキストピッカー + @//テキスト挿入廃止): the picker's toggle-select
// and the @/-selection trigger-text removal both reduce to these small pure helpers, so
// they're unit-tested directly rather than through full component interaction (this
// codebase's AiEditPanel tests only exercise renderToStaticMarkup, no interactive DOM
// harness) — end-to-end behavior (popover open/close, chip rendering) is additionally
// verified live via the running app.
describe("toggleAiResourceSelection (統一ピッカーのスキルトグル)", () => {
  it("adds an id that is not yet selected", () => {
    expect(toggleAiResourceSelection(["a"], "b")).toEqual(["a", "b"]);
  });

  it("removes an id that is already selected (toggle off)", () => {
    expect(toggleAiResourceSelection(["a", "b"], "b")).toEqual(["a"]);
  });

  it("never removes when addOnly is set (the /-slash popover only ever adds)", () => {
    expect(toggleAiResourceSelection(["a", "b"], "b", { addOnly: true })).toEqual(["a", "b"]);
  });

  it("still adds under addOnly when not yet selected", () => {
    expect(toggleAiResourceSelection(["a"], "b", { addOnly: true })).toEqual(["a", "b"]);
  });
});

function makeMentionedDocument(fileId: string): AiEditMentionedDocumentContext {
  return {
    id: `sigma-doc-${fileId}`,
    fileId,
    title: `title-${fileId}`,
    documentPath: `/${fileId}`,
    revision: 1,
    excerpt: "",
    document: {} as AiEditMentionedDocumentContext["document"],
  };
}

describe("upsertMentionedDocument / removeMentionedDocumentByFileId (統一ピッカーのドキュメントトグル)", () => {
  it("adds a new document", () => {
    const next = upsertMentionedDocument([], makeMentionedDocument("doc1"), 4);
    expect(next.map((item) => item.fileId)).toEqual(["doc1"]);
  });

  it("is a no-op when the document is already mentioned (no duplicate)", () => {
    const current = [makeMentionedDocument("doc1")];
    const next = upsertMentionedDocument(current, makeMentionedDocument("doc1"), 4);
    expect(next).toBe(current);
  });

  it("clamps to the cap, dropping the newest once full", () => {
    const current = [makeMentionedDocument("doc1"), makeMentionedDocument("doc2")];
    const next = upsertMentionedDocument(current, makeMentionedDocument("doc3"), 2);
    expect(next.map((item) => item.fileId)).toEqual(["doc1", "doc2"]);
  });

  it("removes a mentioned document by fileId", () => {
    const current = [makeMentionedDocument("doc1"), makeMentionedDocument("doc2")];
    const next = removeMentionedDocumentByFileId(current, "doc1");
    expect(next.map((item) => item.fileId)).toEqual(["doc2"]);
  });

  it("round-trips as a toggle: add then remove returns to the original set", () => {
    const original: AiEditMentionedDocumentContext[] = [];
    const added = upsertMentionedDocument(original, makeMentionedDocument("doc1"), 4);
    const removed = removeMentionedDocumentByFileId(added, "doc1");
    expect(removed).toEqual(original);
  });
});

describe("removeActiveTriggerRange (@//のトリガーテキスト削除)", () => {
  it("removes a @mention trigger mid-sentence, collapsing the doubled space", () => {
    const value = "続きを @doc お願いします";
    const atIndex = value.indexOf("@");
    const query: ActiveMentionQuery = { start: atIndex, end: atIndex + "@doc".length, query: "doc" };

    expect(removeActiveTriggerRange(value, query)).toBe("続きを お願いします");
  });

  it("removes a /slash trigger mid-sentence", () => {
    const value = "これで /skill 実行して";
    const slashIndex = value.indexOf("/");
    const query = { start: slashIndex, end: slashIndex + "/skill".length };

    expect(removeActiveTriggerRange(value, query)).toBe("これで 実行して");
  });

  it("removes a trigger at the very start of the instruction", () => {
    const value = "@doc お願いします";
    const query = { start: 0, end: "@doc".length };

    expect(removeActiveTriggerRange(value, query)).toBe("お願いします");
  });

  it("removes a trigger at the very end of the instruction", () => {
    const value = "見て @doc";
    const atIndex = value.indexOf("@");
    const query = { start: atIndex, end: value.length };

    expect(removeActiveTriggerRange(value, query)).toBe("見て");
  });

  it("leaves no residual @ or query text behind, only the surrounding words", () => {
    const value = "abc@partial123def";
    const atIndex = value.indexOf("@");
    const query = { start: atIndex, end: atIndex + "@partial123".length };

    const result = removeActiveTriggerRange(value, query);
    expect(result).toBe("abcdef");
    expect(result).not.toContain("@");
  });


describe("ProviderSwitch", () => {
  it("renders icon-only provider radio buttons with aria-labels but no visible provider-name text", () => {
    const html = renderToStaticMarkup(
      <ProviderSwitch provider="chatgpt" onChange={() => {}} />,
    );

    // Verify all buttons have aria-labels for accessibility
    expect(html).toContain('aria-label="ChatGPT"');
    expect(html).toContain('aria-label="Claude"');
    expect(html).toContain('aria-label="Antigravity"');

    // Verify NO visible provider-name text nodes appear in the rendered output
    // (only aria-label should contain the provider names)
    expect(html).not.toContain('>ChatGPT<');
    expect(html).not.toContain('>Claude<');
    expect(html).not.toContain('>Antigravity<');
  });
});

});
