"use client";

import { useMemo, useState } from "react";

import { AiWorkingProviderIcon } from "@/components/branding/AiWorkingProviderIcon";
import type { OverlayShapeDecoration } from "@/components/editor/overlay-canvas/editor-extension";
import type { EditorExtensionContextValue } from "@/components/editor/editor-extension-context";
import {
  getTextFlowEditGuardsSyncKey,
  handleEditGuardAction,
  type EditGuardActionState,
} from "@/components/tiptap/edit-guard-extension";
import {
  derivePendingAiProposalLockTargets,
  type AiEditPreviewState,
} from "@/features/ai-edit/model/preview";
import type { OverlayShape } from "@/features/document";
import { expandShapeIdsWithGroupMembers, getShapeBounds } from "@/features/drawing";
import {
  requestAiEditLockStop,
  useAiEditingBlockLocks,
  useAiEditingShapeLocks,
  type AiEditingShapeLockWithLabel,
} from "@/lib/ai/ai-editing-block-locks";

import { buildAiTextFlowEditPolicy } from "./adapters/tiptap/edit-lock-adapter";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { expandShapeIdsWithAiLockOwnership } from "./application/shape-lock-ownership";

/** `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く (解決器は言語ごとに使い回す)。 */
const DEFAULT_AI_TRANSLATE = createCurrentLocaleTranslator("ai");

/**
 * 図形がロックされているときの案内。**定数ではなく関数**なのは、モジュール読み込み時の
 * 言語で焼き付けないため。既定が日本語なのは既存の呼び出しとテストを変えないため。
 */
function shapeBlockedMessage(t: Translate<"ai"> = DEFAULT_AI_TRANSLATE): string {
  return t("lock.shape");
}

export interface AiEditorExtensionOptions {
  documentIdentityKey: string | null | undefined;
  previewGroups: readonly AiEditPreviewState[];
  /** True only while an approval/dismissal IPC is replacing the whole document. */
  documentWriteInProgress?: boolean;
  shapes: readonly OverlayShape[];
}

export type AiEditorExtensions = EditorExtensionContextValue;
export type AiOverlayEditorExtensions = Required<Pick<
  EditorExtensionContextValue,
  "overlayEditPolicy" | "overlayShapeDecorations"
>>;

export function buildAiOverlayEditorExtensions({
  liveShapeLocks,
  reservedShapeIds,
  shapes = [],
  t,
}: {
  liveShapeLocks: readonly AiEditingShapeLockWithLabel[];
  reservedShapeIds: ReadonlySet<string> | readonly string[];
  /** Current overlay snapshot, read only to follow graph label and group ownership. */
  shapes?: readonly OverlayShape[];
  /** 案内文の言語。描画中に決まるので hook ではなく引数で受ける。 */
  t?: Translate<"ai">;
}): AiOverlayEditorExtensions {
  const lockedShapeIds = new Set<string>();
  const decorations = new Map<string, OverlayShapeDecoration>();
  /** A group is filtered out of every render pass, so a decoration on one is never seen. */
  const canShowDecoration = (shapeId: string) => (
    shapes.find((shape) => shape.id === shapeId)?.type !== "group"
  );

  for (const lock of liveShapeLocks) {
    if (lockedShapeIds.has(lock.shapeId)) {
      continue;
    }
    lockedShapeIds.add(lock.shapeId);
    // A locked group puts its stop button on its largest member -- the one with room for it --
    // because the group itself never reaches the canvas.
    const hostId = getGuardOverlayHostShapeId(shapes, lock.shapeId);
    if (hostId && !decorations.has(hostId)) {
      decorations.set(hostId, {
        className: "ai-edit-locked-shape",
        content: <AiShapeEditGuardOverlay lock={lock} />,
      });
    }
  }

  // A locked graph's labels are separate sibling shapes, and a locked group's members are the
  // only part of it that is ever drawn; both get the same veil so the whole figure reads as busy,
  // but not another stop button -- one per owning shape is enough, and a label is far too small
  // to hold it.
  for (const ownedId of expandShapeIdsWithAiLockOwnership(shapes, [...lockedShapeIds])) {
    lockedShapeIds.add(ownedId);
    if (decorations.has(ownedId) || !canShowDecoration(ownedId)) {
      continue;
    }
    decorations.set(ownedId, {
      className: "ai-edit-locked-shape",
      content: <AiShapeEditGuardVeil />,
    });
  }

  for (const shapeId of expandShapeIdsWithAiLockOwnership(shapes, reservedShapeIds)) {
    lockedShapeIds.add(shapeId);
    if (!decorations.has(shapeId) && canShowDecoration(shapeId)) {
      decorations.set(shapeId, { className: "ai-edit-locked-shape" });
    }
  }

  return {
    overlayEditPolicy: {
      lockedShapeIds,
      blockedMessage: shapeBlockedMessage(t),
      blockedNoticeClassName: "overlay-ai-lock-notice",
    },
    overlayShapeDecorations: decorations,
  };
}

/**
 * Desktop composition adapter from AI run/proposal state to the generic
 * editor-extension contracts. Drawing and text-flow modules never subscribe
 * to AI stores and never know how cancellation is implemented.
 */
export function useAiEditorExtensions({
  documentIdentityKey,
  previewGroups,
  documentWriteInProgress = false,
  shapes,
}: AiEditorExtensionOptions): AiEditorExtensions {
  const t = useT("ai");
  const liveBlockLocks = useAiEditingBlockLocks(documentIdentityKey);
  const liveShapeLocks = useAiEditingShapeLocks(documentIdentityKey);
  const pendingTargets = useMemo(
    () => derivePendingAiProposalLockTargets([...previewGroups]),
    [previewGroups],
  );

  const builtTextFlowEditPolicy = useMemo(() => buildAiTextFlowEditPolicy({
    liveLocks: liveBlockLocks,
    pendingBlockIds: pendingTargets.blockIds,
    documentWriteInProgress,
    onRequestStop: requestAiEditLockStop,
  }), [documentWriteInProgress, liveBlockLocks, pendingTargets.blockIds]);
  // 上の memo の入力は保存のたびに作り直される (提案プレビューが台帳 revision を見るため)。
  // ロックの中身が同じなら同じオブジェクトを配る — この値は本文ユニットの props なので、
  // ここが動くと打鍵のたびに全ユニットが描き直される。鍵は装飾の再 dispatch 判定と同じ
  // 「見た目を決める値」で作る (`lockAll` は全ブロック共通のガードなので同じ関数に通す)。
  const textFlowEditPolicyKey = useMemo(() => {
    const guards = new Map(builtTextFlowEditPolicy.guards.map((guard) => [guard.blockId, guard]));
    const lockAll = builtTextFlowEditPolicy.lockAll;
    if (lockAll) {
      guards.set("__lockAll__", { ...lockAll, blockId: "__lockAll__", isPrimaryActionTarget: false });
    }
    return getTextFlowEditGuardsSyncKey(guards);
  }, [builtTextFlowEditPolicy]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const textFlowEditPolicy = useMemo(() => builtTextFlowEditPolicy, [textFlowEditPolicyKey]);

  // Only the apply write window reserves every shape; a live run reserves just
  // the shapes its own anchor handed to the AI (`liveShapeLocks`).
  const { overlayEditPolicy, overlayShapeDecorations } = useMemo(() => {
    return buildAiOverlayEditorExtensions({
      liveShapeLocks,
      reservedShapeIds: documentWriteInProgress
        ? shapes.map((shape) => shape.id)
        : [...pendingTargets.shapeIds],
      shapes,
      t,
    });
  }, [documentWriteInProgress, liveShapeLocks, pendingTargets.shapeIds, shapes, t]);

  const auxiliarySurfaceExtensions = useMemo(() => {
    const liveGuards = textFlowEditPolicy.guards.filter((guard) => guard.action);
    const liveShapeDecorations = new Map(
      [...overlayShapeDecorations].filter(([, decoration]) => decoration.content !== undefined),
    );
    return {
      textFlowEditPolicy: { guards: liveGuards },
      overlayEditPolicy: {
        lockedShapeIds: new Set(liveShapeDecorations.keys()),
        blockedMessage: shapeBlockedMessage(t),
        blockedNoticeClassName: "overlay-ai-lock-notice",
      },
      overlayShapeDecorations: liveShapeDecorations,
    };
  }, [overlayShapeDecorations, t, textFlowEditPolicy.guards]);

  // 戻り値のオブジェクトも memo する。ここで毎回新しいオブジェクトを返すと、
  // `EditorExtensionProvider` の value が打鍵のたびに変わり、本文ユニットの `editPolicy`
  // (context 経由) も一緒に変わって memo が全部無効になる。
  return useMemo(
    () => ({ textFlowEditPolicy, overlayEditPolicy, overlayShapeDecorations, auxiliarySurfaceExtensions }),
    [auxiliarySurfaceExtensions, overlayEditPolicy, overlayShapeDecorations, textFlowEditPolicy],
  );
}

/**
 * Which shape carries the veil *and* the stop button for a lock on `shapeId`.
 *
 * For an ordinary shape that is the shape itself. A group is never drawn, so the button moves to
 * its largest drawn member: big enough to hold the label, and the one the reader is most likely
 * to be pointing at when they try to edit the busy figure. Returns null for an empty group, which
 * has nowhere to put it.
 */
function getGuardOverlayHostShapeId(
  shapes: readonly OverlayShape[],
  shapeId: string,
): string | null {
  const shape = shapes.find((candidate) => candidate.id === shapeId);
  if (!shape) {
    return shapeId;
  }
  if (shape.type !== "group") {
    return shapeId;
  }

  const memberIds = new Set(expandShapeIdsWithGroupMembers(shapes, [shapeId]));
  const drawnMembers = shapes.filter((candidate) => (
    candidate.id !== shapeId && candidate.type !== "group" && memberIds.has(candidate.id)
  ));
  if (drawnMembers.length === 0) {
    return null;
  }

  return drawnMembers.reduce((largest, candidate) => (
    getShapeGuardArea(candidate) > getShapeGuardArea(largest) ? candidate : largest
  )).id;
}

function getShapeGuardArea(shape: OverlayShape): number {
  const bounds = getShapeBounds(shape);
  return Math.max(0, bounds.w) * Math.max(0, bounds.h);
}

/** The "AI is working here" shimmer, with no stop affordance of its own. */
export function AiShapeEditGuardVeil() {
  return <div className="ai-edit-lock-shape-veil" aria-hidden="true" />;
}

export function AiShapeEditGuardOverlay({ lock }: { lock: AiEditingShapeLockWithLabel }) {
  const t = useT("ai");
  const [state, setState] = useState<EditGuardActionState>({ status: "idle" });
  const busy = state.status === "busy";
  const label = busy ? t("lock.stopping") : t("lock.stopAndEdit");
  const title = state.status === "error"
    ? t("lock.stopFailed")
    : lock.sessionLabel
      ? `${label}(${lock.sessionLabel})`
      : label;
  const action = { request: () => requestAiEditLockStop(lock) };

  return (
    <>
      <AiShapeEditGuardVeil />
      {lock.provider && (
        <span className="ai-edit-lock-shape-provider-logo" aria-hidden="true">
          <AiWorkingProviderIcon provider={lock.provider} />
        </span>
      )}
      <button
        type="button"
        className="ai-edit-lock-shape-stop-button"
        disabled={busy}
        title={title}
        aria-label={title}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void handleEditGuardAction(state, action).then(setState);
        }}
      >
        <span>{label}</span>
        <span className="ai-edit-lock-stop-icon" aria-hidden="true" />
      </button>
    </>
  );
}
