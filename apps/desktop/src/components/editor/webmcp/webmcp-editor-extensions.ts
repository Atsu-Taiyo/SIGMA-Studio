import type { EditorExtensionContextValue } from "@/components/editor/editor-extension-context";
import type { OverlayShapeDecoration } from "@/components/editor/overlay-canvas/editor-extension";
import {
  combineTextFlowEditGuards,
  type TextFlowEditGuard,
  type TextFlowEditGuardPresentation,
} from "@/components/tiptap/edit-guard-extension";

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

  // 同じブロックに 2 つのガードがあれば 1 つの規則で合わせる (一部の予約が全体のガードを弱めない)。
  const guardsByBlockId = new Map<string, TextFlowEditGuard>();
  for (const guard of [...(first.textFlowEditPolicy?.guards ?? []), ...(second.textFlowEditPolicy?.guards ?? [])]) {
    const earlier = guardsByBlockId.get(guard.blockId);
    guardsByBlockId.set(guard.blockId, earlier ? combineTextFlowEditGuards(earlier, guard) : guard);
  }
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

  // 片方しか持たない部分は、持っている側のオブジェクトをそのまま渡す。本文の編集方針や図形の飾りを
  // 作り直すと、その props を読む本文ユニット・図形が全部描き直される。
  return {
    textFlowEditPolicy: !first.textFlowEditPolicy || !second.textFlowEditPolicy
      ? first.textFlowEditPolicy ?? second.textFlowEditPolicy
      : {
          guards: [...guardsByBlockId.values()],
          lockAll: second.textFlowEditPolicy.lockAll ?? first.textFlowEditPolicy.lockAll,
        },
    overlayEditPolicy: firstOverlay || secondOverlay
      ? {
          lockedShapeIds: new Set([
            ...(firstOverlay?.lockedShapeIds ?? []),
            ...(secondOverlay?.lockedShapeIds ?? []),
          ]),
          unselectableShapeIds: new Set([
            ...(firstOverlay?.unselectableShapeIds ?? []),
            ...(secondOverlay?.unselectableShapeIds ?? []),
          ]),
          blockedMessage: secondOverlay?.blockedMessage ?? firstOverlay?.blockedMessage,
          blockedNoticeClassName: secondOverlay?.blockedNoticeClassName ?? firstOverlay?.blockedNoticeClassName,
        }
      : undefined,
    overlayShapeDecorations: !first.overlayShapeDecorations || !second.overlayShapeDecorations
      ? first.overlayShapeDecorations ?? second.overlayShapeDecorations
      : decorations,
    // 問題の枠の描き直し (枠エディタの AI タブ) は 1 つの機能だけが差し込む。どちらかが持っていれば残す。
    problemFrameDrawing: second.problemFrameDrawing ?? first.problemFrameDrawing,
    auxiliarySurfaceExtensions: mergeEditorExtensionSets(
      first.auxiliarySurfaceExtensions,
      second.auxiliarySurfaceExtensions,
    ),
  };
}
