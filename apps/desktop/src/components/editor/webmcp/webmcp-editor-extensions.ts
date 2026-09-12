import type { EditorExtensionContextValue } from "@/components/editor/editor-extension-context";
import type { OverlayShapeDecoration } from "@/components/editor/overlay-canvas/editor-extension";
import type { TextFlowEditGuardPresentation } from "@/components/tiptap/edit-guard-extension";

export interface WebMcpPendingTargets {
  blockIds: readonly string[];
  shapeIds: readonly string[];
}

const TEXT_GUARD_PRESENTATION: TextFlowEditGuardPresentation = {
  highlightedBlockClassName: "webmcp-edit-target",
  readOnlyBlockClassName: "webmcp-edit-target",
  characterClassName: "webmcp-edit-target-character",
  atomClassName: "webmcp-edit-target-atom",
};

export function buildWebMcpEditorExtensions(
  targets: WebMcpPendingTargets,
  blockedMessage: string,
): EditorExtensionContextValue {
  const blockIds = [...new Set(targets.blockIds)];
  const shapeIds = [...new Set(targets.shapeIds)];
  return {
    textFlowEditPolicy: {
      guards: blockIds.map((blockId, index) => ({
        blockId,
        guardId: "webmcp-pending-proposals",
        isPrimaryActionTarget: index === 0,
        blockedMessage,
        presentation: TEXT_GUARD_PRESENTATION,
        highlight: true,
        highlightScopes: [{ kind: "block", blockId }],
      })),
    },
    overlayEditPolicy: {
      lockedShapeIds: new Set(shapeIds),
      blockedMessage,
      blockedNoticeClassName: "webmcp-edit-lock-notice",
    },
    overlayShapeDecorations: new Map(shapeIds.map((shapeId) => [
      shapeId,
      { className: "webmcp-edit-target-shape" },
    ])),
  };
}

export function mergeEditorExtensionSets(
  first: EditorExtensionContextValue | undefined,
  second: EditorExtensionContextValue | undefined,
): EditorExtensionContextValue | undefined {
  if (!first) return second;
  if (!second) return first;

  const guardsByBlockId = new Map(
    [...(first.textFlowEditPolicy?.guards ?? []), ...(second.textFlowEditPolicy?.guards ?? [])]
      .map((guard) => [guard.blockId, guard]),
  );
  const firstOverlay = first.overlayEditPolicy;
  const secondOverlay = second.overlayEditPolicy;
  const decorations = new Map<string, OverlayShapeDecoration>(first.overlayShapeDecorations ?? []);
  for (const [shapeId, decoration] of second.overlayShapeDecorations ?? []) {
    const existing = decorations.get(shapeId);
    decorations.set(shapeId, existing
      ? {
          ...existing,
          ...decoration,
          className: [existing.className, decoration.className].filter(Boolean).join(" "),
          content: decoration.content ?? existing.content,
        }
      : decoration);
  }

  return {
    textFlowEditPolicy: {
      guards: [...guardsByBlockId.values()],
      lockAll: second.textFlowEditPolicy?.lockAll ?? first.textFlowEditPolicy?.lockAll,
    },
    overlayEditPolicy: firstOverlay || secondOverlay
      ? {
          lockedShapeIds: new Set([
            ...(firstOverlay?.lockedShapeIds ?? []),
            ...(secondOverlay?.lockedShapeIds ?? []),
          ]),
          blockedMessage: secondOverlay?.blockedMessage ?? firstOverlay?.blockedMessage,
          blockedNoticeClassName: secondOverlay?.blockedNoticeClassName ?? firstOverlay?.blockedNoticeClassName,
        }
      : undefined,
    overlayShapeDecorations: decorations,
    auxiliarySurfaceExtensions: mergeEditorExtensionSets(
      first.auxiliarySurfaceExtensions,
      second.auxiliarySurfaceExtensions,
    ),
  };
}
