"use client";

// R2 / R6: in-body "AI is working here" widget. Every active AI run gets a small
// badge anchored to the actual block it targets, positioned in the same canvas
// coordinate space the overlay figures use (`blockTop` from the shared
// block-measurement pass, +offset). Because it lives inside the scrollable
// canvas, it moves with scroll for free; because its position is re-resolved
// from the same `blockRects` the page recomputes on every reflow, it follows
// the block through edits too.
//
// R6 (this revision): the badge inherits the pre-pill look — a shimmering
// provider AI-icon that, on hover, morphs into a floating activity card telling
// you what the run is doing, with a text field to steer/continue it. On
// completion the icon keeps a "done" badge and STAYS until the run's proposal is
// applied or discarded (it is no longer hidden the moment the proposal card
// appears, and no longer auto-hidden on a timer while a proposal is still
// pending), so the AI icon and its proposal resolve together.
//
// This module intentionally keeps the parts that don't need React/DOM (which
// sessions should be visible right now, and where a given anchor resolves to)
// as small pure functions so they're unit-testable without mounting anything.

import { Check, PanelRight, X } from "lucide-react";
import {
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { AiWorkingProviderIcon } from "@/components/branding/AiWorkingProviderIcon";
import { renderProviderMark } from "@/components/branding/provider-logos";
import { Shimmer } from "@/components/ui/Shimmer";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { formatAgentActivityLabel, summarizeRunningActivity } from "@/lib/ai/ai-agent-activity-label";
import type { AiProvider } from "@/lib/ai/ai-providers";
import { useAiChatRoomsForDocument, type AssistantTurn } from "@/lib/ai/ai-run-controller";
import type { AiRunAnchor, AiRunSession, AiRunStatus } from "@/lib/ai/ai-run-session-store";
import { isAiRunStatusActive, useAiRunSessions } from "@/lib/ai/ai-run-session-store";
import type { SigmaDocument } from "@/features/document";

import { AiRunCardComposer } from "./ai-run-card-composer";
import { AiStreamRenderer } from "@/features/ai-edit/view";
import { UserTurnView } from "./AiEditPanel";
import type { MeasuredBlock } from "./overlay-canvas/anchor";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** How long a completed/failed widget with NO pending proposal stays up before
 * it auto-hides. A completed run that DID leave a proposal card is exempt from
 * this window — it stays until the proposal is applied/discarded (see
 * `selectVisibleAiRunSessions`). */
export const AI_RUN_ANCHOR_TERMINAL_DISPLAY_MS = 4000;

const VISIBLE_STATUSES: readonly AiRunStatus[] = ["preparing", "waiting", "running", "applying", "completed", "failed"];
const AI_RUN_CARD_GAP_PX = 8;
const AI_RUN_CARD_VIEWPORT_MARGIN_PX = 8;
const AI_RUN_CARD_FALLBACK_WIDTH_PX = 320;
const AI_RUN_CARD_FALLBACK_HEIGHT_PX = 400;
const AI_RUN_CARD_MIN_HEIGHT_PX = 120;
const AI_RUN_CARD_CLOSE_DELAY_MS = 160;
const AI_RUN_REGION_HORIZONTAL_JOIN_TOLERANCE_PX = 8;
const AI_RUN_REGION_VERTICAL_JOIN_GAP_PX = 32;
const EMPTY_ROOM_IDS: ReadonlySet<string> = new Set();

/** Imperative open request emitted by a proposal's "続けて修正" action. The
 * trigger stays in the page/overlay layer while the shared conversation card
 * is portaled to body and positioned from its viewport rect. */
export interface AiRunCardOpenRequest {
  requestId: number;
  roomId: string;
  anchorElement: HTMLElement;
  provider: AiProvider;
  anchorBlockId: string | null;
}

/** Deliberately process-local: moving the compact room is a session preference,
 * not document content or a durable application setting. */
const aiRunCardPositions = new Map<string, { left: number; top: number }>();

export interface AiRunAnchorVisibleSession {
  roomId: string;
  session: AiRunSession;
  /** True when the run's target block currently shows an unresolved proposal
   * card — the widget then stays put (with a completion badge) instead of
   * auto-hiding, so the AI icon and its proposal clear together. */
  hasPendingProposal: boolean;
}

/**
 * Which sessions should show an in-body widget right now, given:
 * - only sessions belonging to the document currently on screen (a session's
 *   `anchor.documentId` may point at a different open document's background
 *   run, which has no meaningful position in this canvas);
 * - a completed/failed session whose target block still shows a proposal card
 *   stays visible until that card resolves (the "keep the AI icon until it's
 *   applied" rule) — instead of the pre-R6 behavior of hiding the moment a card
 *   appeared;
 * - a completed/failed session with NO pending proposal hides once its display
 *   window (`endedAt + AI_RUN_ANCHOR_TERMINAL_DISPLAY_MS`) has elapsed —
 *   computed straight from the session's own `endedAt`, so no separate timer
 *   bookkeeping state is needed, just a ticking `now`.
 *
 * Pure and DOM-free so it's directly unit-testable.
 */
export function selectVisibleAiRunSessions(
  sessions: ReadonlyMap<string, AiRunSession>,
  options: {
    documentId: string;
    now: number;
    blockIdsWithProposalCards: ReadonlySet<string>;
    roomIdsWithProposalCards?: ReadonlySet<string>;
  },
): AiRunAnchorVisibleSession[] {
  const visible: AiRunAnchorVisibleSession[] = [];
  for (const [roomId, session] of sessions) {
    if (!VISIBLE_STATUSES.includes(session.status)) {
      continue;
    }
    // A session started before this field existed (or one with no anchor at
    // all) has `documentId: undefined`; treat that as "this document" rather
    // than hiding it, since that's the only document it could belong to at
    // the time R2 shipped.
    const sessionDocumentId = session.anchor?.documentId;
    if (sessionDocumentId && sessionDocumentId !== options.documentId) {
      continue;
    }

    const blockId = session.anchor?.primaryBlockId;
    const hasPendingProposal = options.roomIdsWithProposalCards?.has(roomId)
      || (!!blockId && options.blockIdsWithProposalCards.has(blockId));

    if (session.status === "completed" || session.status === "failed") {
      // Keep the icon (with its "done" badge) alive as long as its proposal is
      // still waiting for the user — it only clears once the proposal is
      // applied/discarded. Only when there is no pending proposal does the
      // short grace window apply.
      if (!hasPendingProposal) {
        const expiresAt = (session.endedAt ?? options.now) + AI_RUN_ANCHOR_TERMINAL_DISPLAY_MS;
        if (options.now >= expiresAt) {
          continue;
        }
      }
    }

    visible.push({ roomId, session, hasPendingProposal });
  }
  return visible;
}

export interface AiRunAnchorPoint {
  left: number;
  top: number;
  /** Where the point came from — mostly useful for tests/debugging. */
  source: "block" | "canvas" | "page";
  blockWidth?: number;
  blockHeight?: number;
}

export interface AiRunAnchorRegion extends AiRunAnchorPoint {
  source: "block";
  blockIds: string[];
}

interface AiRunRegionBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  blockIds: Set<string>;
}

/**
 * Resolves every visibly separate body region owned by a run. Consecutive
 * selected blocks stay together, while an unselected block between them starts
 * a new island. Inside each consecutive run, measured line boxes split the
 * result again when CSS columns or page flow place the content in disconnected
 * areas. This keeps the indicator centered on what is actually shimmering,
 * rather than on one arbitrary primary block or in a column gutter.
 */
export function resolveAiRunAnchorRegions(
  anchor: AiRunAnchor | null | undefined,
  blockRects: ReadonlyMap<string, MeasuredBlock>,
): AiRunAnchorRegion[] {
  const targetBlockIds = new Set(anchor?.blockIds ?? []);
  if (targetBlockIds.size === 0 && anchor?.primaryBlockId) {
    targetBlockIds.add(anchor.primaryBlockId);
  }
  if (targetBlockIds.size === 0) {
    return [];
  }

  const contiguousRuns: MeasuredBlock[][] = [];
  let currentRun: MeasuredBlock[] = [];
  const flushCurrentRun = () => {
    if (currentRun.length > 0) {
      contiguousRuns.push(currentRun);
      currentRun = [];
    }
  };

  // `measureBlockTops` preserves DOM/document order in this map. Encountering
  // an unselected editable block therefore marks a genuine gap between two
  // separately referenced ranges.
  for (const block of blockRects.values()) {
    if (targetBlockIds.has(block.id)) {
      currentRun.push(block);
    } else {
      flushCurrentRun();
    }
  }
  flushCurrentRun();

  return contiguousRuns
    .flatMap(resolveMeasuredRunRegions)
    .sort((a, b) => a.top - b.top || a.left - b.left);
}

function resolveMeasuredRunRegions(blocks: readonly MeasuredBlock[]): AiRunAnchorRegion[] {
  const fragments = blocks
    .flatMap(measuredBlockFragments)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const regions: AiRunRegionBounds[] = [];

  for (const fragment of fragments) {
    const matchingIndexes: number[] = [];
    for (let index = 0; index < regions.length; index += 1) {
      if (regionTouchesFragment(regions[index], fragment)) {
        matchingIndexes.push(index);
      }
    }

    if (matchingIndexes.length === 0) {
      regions.push({ ...fragment, blockIds: new Set(fragment.blockIds) });
      continue;
    }

    const firstIndex = matchingIndexes[0];
    const merged = regions[firstIndex];
    mergeRegionBounds(merged, fragment);
    for (let index = matchingIndexes.length - 1; index >= 1; index -= 1) {
      const matchingIndex = matchingIndexes[index];
      mergeRegionBounds(merged, regions[matchingIndex]);
      regions.splice(matchingIndex, 1);
    }
  }

  return regions.map((region) => ({
    left: region.left,
    top: region.top,
    source: "block",
    blockWidth: Math.max(0, region.right - region.left),
    blockHeight: Math.max(0, region.bottom - region.top),
    blockIds: [...region.blockIds],
  }));
}

function measuredBlockFragments(block: MeasuredBlock): AiRunRegionBounds[] {
  const lineFragments = (block.lines ?? []).flatMap((line): AiRunRegionBounds[] => {
    if (
      typeof line.left !== "number" ||
      typeof line.width !== "number" ||
      !Number.isFinite(line.left) ||
      !Number.isFinite(line.top) ||
      !Number.isFinite(line.width) ||
      !Number.isFinite(line.height) ||
      line.width <= 0 ||
      line.height <= 0
    ) {
      return [];
    }
    return [{
      left: line.left,
      top: line.top,
      right: line.left + line.width,
      bottom: line.top + line.height,
      blockIds: new Set([block.id]),
    }];
  });
  if (lineFragments.length > 0) {
    return lineFragments;
  }

  if (
    typeof block.left !== "number" ||
    typeof block.width !== "number" ||
    typeof block.height !== "number" ||
    !Number.isFinite(block.left) ||
    !Number.isFinite(block.top) ||
    !Number.isFinite(block.width) ||
    !Number.isFinite(block.height) ||
    block.width <= 0 ||
    block.height <= 0
  ) {
    return [];
  }
  return [{
    left: block.left,
    top: block.top,
    right: block.left + block.width,
    bottom: block.top + block.height,
    blockIds: new Set([block.id]),
  }];
}

function regionTouchesFragment(region: AiRunRegionBounds, fragment: AiRunRegionBounds): boolean {
  const horizontalGap = Math.max(
    0,
    Math.max(region.left, fragment.left) - Math.min(region.right, fragment.right),
  );
  const verticalGap = Math.max(
    0,
    Math.max(region.top, fragment.top) - Math.min(region.bottom, fragment.bottom),
  );
  return horizontalGap <= AI_RUN_REGION_HORIZONTAL_JOIN_TOLERANCE_PX
    && verticalGap <= AI_RUN_REGION_VERTICAL_JOIN_GAP_PX;
}

function mergeRegionBounds(target: AiRunRegionBounds, source: AiRunRegionBounds): void {
  target.left = Math.min(target.left, source.left);
  target.top = Math.min(target.top, source.top);
  target.right = Math.max(target.right, source.right);
  target.bottom = Math.max(target.bottom, source.bottom);
  source.blockIds.forEach((blockId) => target.blockIds.add(blockId));
}

/**
 * Resolves an anchor to a canvas-coordinate point: the target block's
 * measured top (primary path — follows reflow/scroll for free since callers
 * re-run this against fresh `blockRects` on every recompute), falling back to
 * the run's captured canvas point, and finally the top of page 1.
 */
export function resolveAiRunAnchorPoint(
  anchor: AiRunAnchor | null | undefined,
  blockRects: ReadonlyMap<string, MeasuredBlock>,
  fallbackCanvasPoint: { left: number; top: number } | null,
): AiRunAnchorPoint {
  if (anchor?.preferredTarget === "canvas" && fallbackCanvasPoint) {
    return { left: fallbackCanvasPoint.left, top: fallbackCanvasPoint.top, source: "canvas" };
  }

  const blockId = anchor?.primaryBlockId;
  if (blockId) {
    const rect = blockRects.get(blockId);
    if (rect) {
      return {
        left: rect.left ?? 0,
        top: rect.top,
        source: "block",
        blockWidth: rect.width,
        blockHeight: rect.height,
      };
    }
  }

  if (fallbackCanvasPoint) {
    return { left: fallbackCanvasPoint.left, top: fallbackCanvasPoint.top, source: "canvas" };
  }

  return { left: 0, top: 0, source: "page" };
}

export function getAiRunAnchorBadgeStyle(point: AiRunAnchorPoint): CSSProperties {
  if (
    point.source === "block" &&
    typeof point.blockWidth === "number" &&
    typeof point.blockHeight === "number"
  ) {
    return {
      left: `${Math.max(0, point.left + point.blockWidth / 2)}px`,
      top: `${Math.max(0, point.top + point.blockHeight / 2)}px`,
      right: "auto",
      transform: "translate(-50%, -50%)",
    };
  }

  const style: CSSProperties = { top: `${Math.max(0, point.top + 2)}px` };
  if (point.source === "canvas") {
    style.left = `${Math.max(0, point.left)}px`;
    style.right = "auto";
  }
  return style;
}

export function shouldRenderAiRunAnchorBadge(session: AiRunSession): boolean {
  return (session.anchor?.shapeIds?.length ?? 0) === 0;
}

interface AiRunAnchorCardRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface AiRunAnchorCardSize {
  width: number;
  height: number;
}

interface AiRunAnchorCardViewport {
  width: number;
  height: number;
}

export interface AiRunAnchorCardPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  side: "top" | "bottom";
  transformOrigin: string;
}

export function clampAiRunCardPosition(
  position: { left: number; top: number },
  cardSize: AiRunAnchorCardSize,
  viewport: AiRunAnchorCardViewport,
  options: { topBoundary?: number; margin?: number } = {},
): { left: number; top: number } {
  const margin = options.margin ?? AI_RUN_CARD_VIEWPORT_MARGIN_PX;
  const minTop = Math.max(margin, options.topBoundary ?? margin);
  const width = Math.min(cardSize.width, Math.max(1, viewport.width - margin * 2));
  const height = Math.min(cardSize.height, Math.max(1, viewport.height - minTop - margin));
  return {
    left: Math.max(margin, Math.min(position.left, viewport.width - margin - width)),
    top: Math.max(minTop, Math.min(position.top, viewport.height - margin - height)),
  };
}

export function getAiRunAnchorCardPlacement(
  anchorRect: AiRunAnchorCardRect,
  cardSize: AiRunAnchorCardSize,
  viewport: AiRunAnchorCardViewport,
  problemAreaBounds?: { top: number; bottom: number; left: number; right: number },
  options: {
    topBoundary?: number;
    gap?: number;
    margin?: number;
    horizontalBounds?: { left: number; right: number };
  } = {},
): AiRunAnchorCardPlacement {
  const margin = options.margin ?? AI_RUN_CARD_VIEWPORT_MARGIN_PX;
  const gap = options.gap ?? AI_RUN_CARD_GAP_PX;
  const viewportLeft = margin;
  const viewportRight = Math.max(viewportLeft + 1, viewport.width - margin);
  const preferredLeft = Math.max(viewportLeft, options.horizontalBounds?.left ?? viewportLeft);
  const preferredRightCandidate = Math.min(viewportRight, options.horizontalBounds?.right ?? viewportRight);
  const preferredRight = Math.max(preferredLeft + 1, preferredRightCandidate);
  const cardWidth = Math.min(
    Math.max(1, cardSize.width || AI_RUN_CARD_FALLBACK_WIDTH_PX),
    Math.max(1, viewportRight - viewportLeft),
  );
  const cardHeight = Math.max(1, cardSize.height || AI_RUN_CARD_FALLBACK_HEIGHT_PX);
  const safeTop = Math.min(
    Math.max(margin, options.topBoundary ?? margin),
    Math.max(margin, viewport.height - margin),
  );
  const safeBottom = Math.max(safeTop, viewport.height - margin);
  const spaceBelow = Math.max(0, safeBottom - (anchorRect.bottom + gap));
  const spaceAbove = Math.max(0, anchorRect.top - gap - safeTop);
  const standardSide: AiRunAnchorCardPlacement["side"] =
    spaceBelow >= Math.min(cardHeight, spaceAbove) || spaceBelow >= spaceAbove ? "bottom" : "top";
  let side = standardSide;
  let placementTop = anchorRect.top;
  let placementBottom = anchorRect.bottom;

  if (problemAreaBounds) {
    const problemTop = Math.min(problemAreaBounds.top, problemAreaBounds.bottom);
    const problemBottom = Math.max(problemAreaBounds.top, problemAreaBounds.bottom);
    const problemLeft = Math.min(problemAreaBounds.left, problemAreaBounds.right);
    const problemRight = Math.max(problemAreaBounds.left, problemAreaBounds.right);
    const anchorCenterX = anchorRect.left + anchorRect.width / 2;
    const anchorCenterY = anchorRect.top + anchorRect.height / 2;
    const targetIsWithinProblemArea =
      anchorCenterX >= problemLeft && anchorCenterX <= problemRight &&
      anchorCenterY >= problemTop && anchorCenterY <= problemBottom;

    if (targetIsWithinProblemArea) {
      const outsideSpaceBelow = Math.max(0, safeBottom - (problemBottom + gap));
      const outsideSpaceAbove = Math.max(0, problemTop - gap - margin);
      const alternateSide: AiRunAnchorCardPlacement["side"] = standardSide === "bottom" ? "top" : "bottom";
      const preferredSpace = standardSide === "bottom" ? outsideSpaceBelow : outsideSpaceAbove;
      const alternateSpace = alternateSide === "bottom" ? outsideSpaceBelow : outsideSpaceAbove;

      if (preferredSpace >= cardHeight || alternateSpace >= cardHeight) {
        side = preferredSpace >= cardHeight ? standardSide : alternateSide;
        placementTop = problemTop;
        placementBottom = problemBottom;
      }
    }
  }

  const placementSafeTop = safeTop;
  const availableHeight = side === "bottom"
    ? Math.max(0, safeBottom - (placementBottom + gap))
    : Math.max(0, placementTop - gap - placementSafeTop);
  const maxHeight = Math.min(
    cardHeight,
    Math.max(Math.min(AI_RUN_CARD_MIN_HEIGHT_PX, safeBottom - safeTop), availableHeight),
  );
  const renderedHeight = Math.min(cardHeight, maxHeight);

  const rawTop = side === "bottom"
    ? placementBottom + gap
    : placementTop - gap - renderedHeight;
  const maxTop = Math.max(safeTop, safeBottom - renderedHeight);
  const top = Math.max(placementSafeTop, Math.min(rawTop, maxTop));
  const finalMaxHeight = Math.min(maxHeight, Math.max(1, safeBottom - top));

  const rawLeft = anchorRect.right - cardWidth;
  // The target column is a placement preference, not a sizing boundary. A
  // two-column body can be narrower than the standard chat card; shrinking the
  // card there made the same composer change width between one- and two-column
  // layouts. Keep its standard width and let it overlap the neighboring column
  // when necessary, while still clamping the whole card to the viewport.
  const preferredMaxLeft = Math.max(preferredLeft, preferredRight - cardWidth);
  const preferredPosition = Math.max(preferredLeft, Math.min(rawLeft, preferredMaxLeft));
  const maxViewportLeft = Math.max(viewportLeft, viewportRight - cardWidth);
  const left = Math.max(viewportLeft, Math.min(preferredPosition, maxViewportLeft));
  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const originX = Math.max(16, Math.min(anchorCenterX - left, Math.max(16, cardWidth - 16)));

  return {
    left,
    top,
    width: cardWidth,
    maxHeight: Math.max(1, finalMaxHeight),
    side,
    transformOrigin: `${Math.round(originX)}px ${side === "bottom" ? "top" : "bottom"}`,
  };
}

/**
 * `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く。
 * 固定ロケールにすると渡し忘れが静かに日本語で出るバグになるため (WI-7 で実測)。
 * `window` の無い環境では既定ロケール (日本語) に落ちるので既存の期待値は不変。
 */
const DEFAULT_AI_TRANSLATE = createCurrentLocaleTranslator("ai");

export function aiRunStatusLabel(
  session: AiRunSession,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): string {
  if (session.status === "completed") {
    return t("run.completed");
  }
  if (session.status === "failed") {
    return t("run.failedShort");
  }
  if (session.status === "waiting") {
    return t("run.waiting");
  }
  return summarizeRunningActivity(session.events, t);
}

function formatRunDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, "0")}` : `${seconds}s`;
}

interface AiRunAnchorLayerProps {
  documentIdentityKey: string;
  /** Current document — the hover card's embedded composer builds follow-up
   * run params (reference/target) against it. */
  document: SigmaDocument;
  /** The document's workspace id (fileId looked up against documentMetadatas),
   * so the embedded composer's skill candidates match buildRunContext's scope. */
  documentWorkspaceId?: string | null;
  blockRects: ReadonlyMap<string, MeasuredBlock>;
  /** Target block ids that already have a visible AI-edit proposal card. */
  blockIdsWithProposalCards: ReadonlySet<string>;
  /** Proposal rooms stay visible even when their change is overlay-only and
   * therefore has no body preview card/target id in the text flow. */
  roomIdsWithProposalCards?: ReadonlySet<string>;
  /** The `.page-canvas` element, used only to convert a run's captured
   * viewport anchor into canvas coordinates for the (rare) fallback path. */
  canvasElement: HTMLElement | null;
  openCardRequest?: AiRunCardOpenRequest | null;
  onFocusSession: (roomId: string) => void;
}

export function AiRunAnchorLayer({
  documentIdentityKey,
  document,
  documentWorkspaceId = null,
  blockRects,
  blockIdsWithProposalCards,
  roomIdsWithProposalCards = EMPTY_ROOM_IDS,
  canvasElement,
  openCardRequest = null,
  onFocusSession,
}: AiRunAnchorLayerProps) {
  const sessions = useAiRunSessions();
  const [now, setNow] = useState(() => Date.now());

  // The card shows a live "what it's doing" summary and elapsed timer while a
  // run is active, and a completed/failed session's display window is computed
  // straight from its own `endedAt` (see `selectVisibleAiRunSessions`), so the
  // only thing this component needs to own is a ticking clock — and only while
  // there is something whose window/timer could actually change.
  const hasTickingSession = useMemo(
    () =>
      Array.from(sessions.values()).some(
        (session) =>
          isAiRunStatusActive(session.status) ||
          session.status === "completed" ||
          session.status === "failed",
      ),
    [sessions],
  );
  useEffect(() => {
    if (!hasTickingSession) {
      return;
    }
    const intervalId = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(intervalId);
  }, [hasTickingSession]);

  const visibleSessions = useMemo(
    () => selectVisibleAiRunSessions(sessions, {
      documentId: documentIdentityKey,
      now,
      blockIdsWithProposalCards,
      roomIdsWithProposalCards,
    }),
    [sessions, documentIdentityKey, now, blockIdsWithProposalCards, roomIdsWithProposalCards],
  );

  const requestedFallbackSession = useMemo<AiRunSession | null>(() => {
    if (!openCardRequest || visibleSessions.some(({ roomId }) => roomId === openCardRequest.roomId)) {
      return null;
    }
    return {
      roomId: openCardRequest.roomId,
      runId: null,
      provider: openCardRequest.provider,
      status: "completed",
      events: [],
      streamText: "",
      planSteps: [],
      error: null,
      startedAt: null,
      endedAt: null,
      anchor: {
        primaryBlockId: openCardRequest.anchorBlockId,
        blockIds: openCardRequest.anchorBlockId ? [openCardRequest.anchorBlockId] : [],
        shapeIds: [],
        documentId: documentIdentityKey,
      },
      queuedMessages: [],
    };
  }, [documentIdentityKey, openCardRequest, visibleSessions]);

  if (visibleSessions.length === 0 && !requestedFallbackSession) {
    return null;
  }

  return (
    <div className="ai-run-anchor-layer" aria-hidden={false}>
      {visibleSessions.map(({ roomId, session }) => (
        <AiRunAnchorWidget
          key={roomId}
          roomId={roomId}
          session={session}
          clockNow={now}
          documentIdentityKey={documentIdentityKey}
          document={document}
          documentWorkspaceId={documentWorkspaceId}
          blockRects={blockRects}
          canvasElement={canvasElement}
          openCardRequest={openCardRequest?.roomId === roomId ? openCardRequest : null}
          onFocusSession={onFocusSession}
        />
      ))}
      {requestedFallbackSession && openCardRequest && (
        <AiRunAnchorWidget
          key={`requested:${openCardRequest.roomId}`}
          roomId={openCardRequest.roomId}
          session={requestedFallbackSession}
          clockNow={now}
          documentIdentityKey={documentIdentityKey}
          document={document}
          documentWorkspaceId={documentWorkspaceId}
          blockRects={blockRects}
          canvasElement={canvasElement}
          openCardRequest={openCardRequest}
          onFocusSession={onFocusSession}
        />
      )}
    </div>
  );
}

function AiRunAnchorWidget({
  roomId,
  session,
  clockNow,
  documentIdentityKey,
  document,
  documentWorkspaceId = null,
  blockRects,
  canvasElement,
  openCardRequest,
  onFocusSession,
}: {
  roomId: string;
  session: AiRunSession;
  clockNow: number;
  documentIdentityKey: string;
  document: SigmaDocument;
  documentWorkspaceId?: string | null;
  blockRects: ReadonlyMap<string, MeasuredBlock>;
  canvasElement: HTMLElement | null;
  openCardRequest: AiRunCardOpenRequest | null;
  onFocusSession: (roomId: string) => void;
}) {
  const t = useT("ai");
  const badgeElementsRef = useRef(new Map<string, HTMLDivElement>());
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeCardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardPinnedRef = useRef(false);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    width: number;
    height: number;
  } | null>(null);
  const [cardOpenState, setCardOpenState] = useState(false);
  const [cardPinnedState, setCardPinnedState] = useState(false);
  const [closedOpenRequestId, setClosedOpenRequestId] = useState<number | null>(null);
  const [cardPlacement, setCardPlacement] = useState<AiRunAnchorCardPlacement | null>(null);
  const [bodyAnchorElement, setBodyAnchorElement] = useState<HTMLElement | null>(null);
  const [shapeAnchorElement, setShapeAnchorElement] = useState<HTMLElement | null>(null);
  const requestedCardOpen = openCardRequest?.roomId === roomId
    && openCardRequest.requestId !== closedOpenRequestId;
  const requestedAnchorElement = requestedCardOpen ? openCardRequest.anchorElement : null;
  const cardOpen = cardOpenState || requestedCardOpen;
  const cardPinned = cardPinnedState || requestedCardOpen;
  const shapeIdsKey = session.anchor?.shapeIds.join("\u0000") ?? "";
  const shapeIds = useMemo(() => new Set(shapeIdsKey ? shapeIdsKey.split("\u0000") : []), [shapeIdsKey]);
  const renderAnchorBadge = shouldRenderAiRunAnchorBadge(session);
  const anchorBlockId = session.anchor?.primaryBlockId ?? null;
  const fallbackCanvasPoint = useMemo(
    () => viewportAnchorToCanvasPoint(session.anchor?.canvas ?? null, canvasElement),
    [session.anchor?.canvas, canvasElement],
  );
  const fallbackPoint = resolveAiRunAnchorPoint(session.anchor, blockRects, fallbackCanvasPoint);
  const measuredAnchorRegions = useMemo(
    () => resolveAiRunAnchorRegions(session.anchor, blockRects),
    [blockRects, session.anchor],
  );
  const anchorRegions = useMemo<AiRunAnchorRegion[]>(
    () => measuredAnchorRegions.length > 0
      ? measuredAnchorRegions
      : [{
          ...fallbackPoint,
          source: "block",
          blockIds: anchorBlockId ? [anchorBlockId] : [],
        }],
    [anchorBlockId, fallbackPoint, measuredAnchorRegions],
  );
  const anchorRegionsPlacementKey = anchorRegions
    .map((region) => [region.left, region.top, region.blockWidth, region.blockHeight].join(":"))
    .join("|");
  const provider = session.provider ?? "chatgpt";
  const isActive = isAiRunStatusActive(session.status);
  const isCompleted = session.status === "completed";
  const isFailed = session.status === "failed";
  const isTerminal = isCompleted || isFailed;
  const label = aiRunStatusLabel(session, t);
  // The badge shows a fixed short label even on failure; the full error text
  // (which can be long/technical) is still available via the tooltip.
  const title = isFailed ? (session.error?.trim() || label) : label;

  const setBadgeElement = useCallback((key: string, element: HTMLDivElement | null) => {
    if (element) {
      badgeElementsRef.current.set(key, element);
    } else {
      badgeElementsRef.current.delete(key);
    }
  }, []);
  const activateBodyAnchor = useCallback((element: HTMLElement) => {
    setBodyAnchorElement((current) => current === element ? current : element);
  }, []);
  const clearCloseCardTimer = useCallback(() => {
    if (closeCardTimerRef.current !== null) {
      clearTimeout(closeCardTimerRef.current);
      closeCardTimerRef.current = null;
    }
  }, []);
  const updateCardPlacement = useCallback(() => {
    const requestAnchor = requestedAnchorElement?.isConnected ? requestedAnchorElement : null;
    const activeBodyAnchor = bodyAnchorElement?.isConnected ? bodyAnchorElement : null;
    const firstBodyAnchor = Array.from(badgeElementsRef.current.values())
      .find((element) => element.isConnected) ?? null;
    const anchorElement = requestAnchor
      ?? (renderAnchorBadge ? activeBodyAnchor ?? firstBodyAnchor : shapeAnchorElement);
    if (!anchorElement || typeof window === "undefined") {
      return;
    }
    const card = cardRef.current;
    const cardRect = card?.getBoundingClientRect();
    const placementBlockId = requestAnchor
      ? anchorBlockId
      : anchorElement.dataset.anchorBlockId ?? anchorBlockId;
    const targetBlockRect = (renderAnchorBadge || requestedAnchorElement) && placementBlockId
      ? findAiRunTargetBlockElement(canvasElement, placementBlockId)?.getBoundingClientRect()
      : null;
    // Compute problem area bounds if the target block is inside a problem block
    let problemAreaBounds: { top: number; bottom: number; left: number; right: number } | undefined;
    if (placementBlockId && canvasElement) {
      const targetBlockElement = findAiRunTargetBlockElement(canvasElement, placementBlockId);
      if (targetBlockElement) {
        const problemContainer = targetBlockElement.closest('[data-problem-area][data-problem-id]');
        if (problemContainer) {
          const bounds = problemContainer.getBoundingClientRect();
          problemAreaBounds = {
            top: bounds.top,
            bottom: bounds.bottom,
            left: bounds.left,
            right: bounds.right,
          };
        }
      }
    }
    const placement = getAiRunAnchorCardPlacement(
      anchorElement.getBoundingClientRect(),
      {
        width: AI_RUN_CARD_FALLBACK_WIDTH_PX,
        height: cardRect?.height || AI_RUN_CARD_FALLBACK_HEIGHT_PX,
      },
      { width: window.innerWidth, height: window.innerHeight },
      problemAreaBounds,
      {
        topBoundary: getAiRunAnchorCardTopBoundary(),
        horizontalBounds: targetBlockRect
          ? { left: targetBlockRect.left, right: targetBlockRect.right }
          : undefined,
      },
    );
    const savedPosition = requestedAnchorElement ? undefined : aiRunCardPositions.get(roomId);
    if (savedPosition) {
      const clamped = clampAiRunCardPosition(
        savedPosition,
        {
          width: placement.width,
          height: cardRect?.height || AI_RUN_CARD_FALLBACK_HEIGHT_PX,
        },
        { width: window.innerWidth, height: window.innerHeight },
        { topBoundary: getAiRunAnchorCardTopBoundary() },
      );
      placement.left = clamped.left;
      placement.top = clamped.top;
      placement.maxHeight = Math.max(1, window.innerHeight - clamped.top - AI_RUN_CARD_VIEWPORT_MARGIN_PX);
      placement.transformOrigin = "center top";
      aiRunCardPositions.set(roomId, clamped);
    }
    setCardPlacement((current) =>
      current &&
      current.left === placement.left &&
      current.top === placement.top &&
      current.width === placement.width &&
      current.maxHeight === placement.maxHeight &&
      current.side === placement.side &&
      current.transformOrigin === placement.transformOrigin
        ? current
        : placement,
    );
  }, [
    anchorBlockId,
    bodyAnchorElement,
    canvasElement,
    renderAnchorBadge,
    requestedAnchorElement,
    roomId,
    shapeAnchorElement,
  ]);
  const openCard = useCallback(() => {
    clearCloseCardTimer();
    setCardOpenState(true);
  }, [clearCloseCardTimer]);
  const scheduleCloseCard = useCallback(() => {
    if (cardPinnedRef.current || dragStateRef.current) {
      return;
    }
    clearCloseCardTimer();
    closeCardTimerRef.current = setTimeout(() => {
      closeCardTimerRef.current = null;
      setCardOpenState(false);
    }, AI_RUN_CARD_CLOSE_DELAY_MS);
  }, [clearCloseCardTimer]);
  const pinCard = useCallback(() => {
    cardPinnedRef.current = true;
    setCardPinnedState(true);
    clearCloseCardTimer();
    setCardOpenState(true);
  }, [clearCloseCardTimer]);
  const closeCard = useCallback(() => {
    cardPinnedRef.current = false;
    setCardPinnedState(false);
    clearCloseCardTimer();
    setCardOpenState(false);
    if (openCardRequest?.roomId === roomId) {
      setClosedOpenRequestId(openCardRequest.requestId);
    }
  }, [clearCloseCardTimer, openCardRequest, roomId]);
  const handleCardDragStart = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button, input, textarea"))) {
      return;
    }
    const card = cardRef.current;
    if (!card) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = card.getBoundingClientRect();
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      width: rect.width,
      height: rect.height,
    };
    pinCard();
  }, [pinCard]);
  const handleCardDragMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const next = clampAiRunCardPosition(
      {
        left: drag.originLeft + event.clientX - drag.startX,
        top: drag.originTop + event.clientY - drag.startY,
      },
      { width: drag.width, height: drag.height },
      { width: window.innerWidth, height: window.innerHeight },
      { topBoundary: getAiRunAnchorCardTopBoundary() },
    );
    aiRunCardPositions.set(roomId, next);
    setCardPlacement((current) => ({
      left: next.left,
      top: next.top,
      width: drag.width,
      maxHeight: Math.max(1, window.innerHeight - next.top - AI_RUN_CARD_VIEWPORT_MARGIN_PX),
      side: current?.side ?? "bottom",
      transformOrigin: "center top",
    }));
  }, [roomId]);
  const handleCardDragEnd = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);
  const keepCardOpenForRelatedTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Node)) {
      return false;
    }
    return Boolean(
      Array.from(badgeElementsRef.current.values()).some((element) => element.contains(target)) ||
      shapeAnchorElement?.contains(target) ||
      cardRef.current?.contains(target),
    );
  }, [shapeAnchorElement]);
  const handleBlur = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    if (!keepCardOpenForRelatedTarget(event.relatedTarget)) {
      scheduleCloseCard();
    }
  }, [keepCardOpenForRelatedTarget, scheduleCloseCard]);

  useEffect(() => clearCloseCardTimer, [clearCloseCardTimer]);
  useEffect(() => {
    if (renderAnchorBadge || shapeIds.size === 0 || typeof window === "undefined") {
      return;
    }
    const domDocument = window.document;

    const findTargetShape = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) {
        return null;
      }
      const shape = target.closest<HTMLElement>(".overlay-shape[data-overlay-shape-id]");
      const shapeId = shape?.dataset.overlayShapeId;
      return shape && shapeId && shapeIds.has(shapeId) ? shape : null;
    };
    const enteredShape = (event: PointerEvent | FocusEvent) => {
      const shape = findTargetShape(event.target);
      if (!shape || (event.relatedTarget instanceof Node && shape.contains(event.relatedTarget))) {
        return;
      }
      setShapeAnchorElement(shape);
      openCard();
    };
    const leftShape = (event: PointerEvent | FocusEvent) => {
      const shape = findTargetShape(event.target);
      if (!shape || (event.relatedTarget instanceof Node && shape.contains(event.relatedTarget))) {
        return;
      }
      scheduleCloseCard();
    };

    domDocument.addEventListener("pointerover", enteredShape);
    domDocument.addEventListener("pointerout", leftShape);
    domDocument.addEventListener("focusin", enteredShape);
    domDocument.addEventListener("focusout", leftShape);
    return () => {
      domDocument.removeEventListener("pointerover", enteredShape);
      domDocument.removeEventListener("pointerout", leftShape);
      domDocument.removeEventListener("focusin", enteredShape);
      domDocument.removeEventListener("focusout", leftShape);
    };
  }, [openCard, renderAnchorBadge, scheduleCloseCard, shapeIds]);
  useIsomorphicLayoutEffect(() => {
    if (cardOpen) {
      updateCardPlacement();
    }
  }, [anchorRegionsPlacementKey, cardOpen, updateCardPlacement]);
  useEffect(() => {
    if (!cardOpen) {
      return;
    }
    window.addEventListener("scroll", updateCardPlacement, true);
    window.addEventListener("resize", updateCardPlacement);
    return () => {
      window.removeEventListener("scroll", updateCardPlacement, true);
      window.removeEventListener("resize", updateCardPlacement);
    };
  }, [cardOpen, updateCardPlacement]);

  const cardStyle = cardPlacement
    ? {
        left: `${cardPlacement.left}px`,
        top: `${cardPlacement.top}px`,
        width: `${cardPlacement.width}px`,
        maxHeight: `${cardPlacement.maxHeight}px`,
        transformOrigin: cardPlacement.transformOrigin,
      }
    : {
        left: "-9999px",
        top: "-9999px",
      };
  const cardPortal = cardOpen && typeof window !== "undefined"
    ? createPortal(
        <AiRunAnchorCard
          cardRef={cardRef}
          roomId={roomId}
          session={session}
          clockNow={clockNow}
          documentIdentityKey={documentIdentityKey}
          document={document}
          documentWorkspaceId={documentWorkspaceId}
          provider={provider}
          anchor={session.anchor ?? { primaryBlockId: null, blockIds: [], shapeIds: [] }}
          onFocusSession={onFocusSession}
          pinned={cardPinned}
          composerAutoFocus={requestedCardOpen}
          onClose={closeCard}
          onDragStart={handleCardDragStart}
          onDragMove={handleCardDragMove}
          onDragEnd={handleCardDragEnd}
          style={cardStyle}
          side={cardPlacement?.side ?? "bottom"}
          onMouseEnter={openCard}
          onMouseLeave={scheduleCloseCard}
          onFocus={openCard}
          onBlur={handleBlur}
        />,
        window.document.body,
      )
    : null;

  return (
    <>
      {renderAnchorBadge && anchorRegions.map((region, index) => {
        const regionKey = `${region.blockIds.join("\u0000")}:${index}`;
        const regionAnchorBlockId = anchorBlockId && region.blockIds.includes(anchorBlockId)
          ? anchorBlockId
          : region.blockIds[0] ?? anchorBlockId;
        const accessibleTitle = anchorRegions.length > 1
          ? t("run.anchorRegion", { replace: { title, index: index + 1, total: anchorRegions.length } })
          : title;
        return (
          <div
            key={regionKey}
            ref={(element) => setBadgeElement(regionKey, element)}
            className="ai-run-anchor-badge"
            data-status={session.status}
            data-anchor-source={region.source}
            data-anchor-block-id={regionAnchorBlockId ?? undefined}
            data-anchor-block-ids={region.blockIds.join(" ") || undefined}
            data-anchor-region-index={index}
            style={getAiRunAnchorBadgeStyle(region)}
            onMouseEnter={(event) => {
              activateBodyAnchor(event.currentTarget);
              openCard();
            }}
            onMouseLeave={scheduleCloseCard}
            onFocus={(event) => {
              activateBodyAnchor(event.currentTarget);
              openCard();
            }}
            onBlur={handleBlur}
            // The page canvas deselects the current block on mousedown/click (see
            // `.page-canvas`'s own handlers in PageCanvasEditor); this widget sits
            // on top of it but isn't part of block selection, so stop both from
            // bubbling.
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="ai-run-anchor-badge-logo"
              data-status={session.status}
              title={accessibleTitle}
              aria-label={accessibleTitle}
              aria-haspopup="dialog"
              aria-expanded={cardOpen}
              onClick={(event) => {
                event.stopPropagation();
                activateBodyAnchor(event.currentTarget.closest<HTMLElement>(".ai-run-anchor-badge") ?? event.currentTarget);
                pinCard();
              }}
            >
              {isActive ? (
                <AiWorkingProviderIcon provider={provider} className="ai-run-anchor-badge-mark" />
              ) : (
                <span className="ai-run-anchor-badge-mark">{renderProviderMark(provider, { size: 16 })}</span>
              )}
              {isTerminal && (
                <span
                  className={`ai-run-anchor-badge-status${isFailed ? " ai-run-anchor-badge-status--failed" : ""}`}
                  aria-hidden="true"
                >
                  {isFailed ? <X size={9} strokeWidth={3} /> : <Check size={9} strokeWidth={3} />}
                </span>
              )}
            </button>
          </div>
        );
      })}
      {cardPortal}
    </>
  );
}

/** Hover card: shows the run's live activity and a full follow-up composer
 * (attachments, @-mentions, /-slash, think-level) bound to the room's provider. */
function AiRunAnchorCard({
  cardRef,
  roomId,
  session,
  clockNow,
  documentIdentityKey,
  document,
  documentWorkspaceId = null,
  provider,
  anchor,
  onFocusSession,
  pinned,
  composerAutoFocus,
  onClose,
  onDragStart,
  onDragMove,
  onDragEnd,
  style,
  side,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
}: {
  cardRef: RefObject<HTMLDivElement | null>;
  roomId: string;
  session: AiRunSession;
  clockNow: number;
  documentIdentityKey: string;
  document: SigmaDocument;
  documentWorkspaceId?: string | null;
  provider: AiProvider;
  anchor: AiRunAnchor;
  onFocusSession: (roomId: string) => void;
  pinned: boolean;
  composerAutoFocus: boolean;
  onClose: () => void;
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragEnd: (event: ReactPointerEvent<HTMLElement>) => void;
  style: CSSProperties;
  side: AiRunAnchorCardPlacement["side"];
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: (event: ReactFocusEvent<HTMLElement>) => void;
}) {
  const t = useT("ai");
  const tCommon = useT("common");
  const isActive = isAiRunStatusActive(session.status);
  const isFailed = session.status === "failed";
  const headline = aiRunStatusLabel(session, t);
  const elapsedMs = Math.max(0, (session.endedAt ?? clockNow) - (session.startedAt ?? clockNow));
  const rooms = useAiChatRoomsForDocument(documentIdentityKey);
  const room = rooms.find((candidate) => candidate.id === roomId) ?? null;
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [room?.turns, session.events, session.streamText]);

  return (
    <div
      ref={cardRef}
      className="ai-run-anchor-card"
      role="dialog"
      aria-label={t("run.statusAria")}
      data-side={side}
      data-pinned={pinned ? "true" : "false"}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="ai-run-anchor-card-head"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <span className="ai-run-anchor-card-title">
          {room?.title?.trim() || t("run.cardTitle")}
        </span>
        <span className="ai-run-anchor-card-time" title={headline}>
          {isActive ? <Shimmer>{formatRunDuration(elapsedMs)}</Shimmer> : headline}
        </span>
        <button
          type="button"
          className="ai-inline-card-icon ai-activity-popover-sidebar-button"
          onClick={() => onFocusSession(roomId)}
          title={t("run.openInSideChat")}
          aria-label={t("run.openInSideChat")}
        >
          <PanelRight size={15} />
        </button>
        <button
          type="button"
          className="ai-inline-card-icon"
          onClick={onClose}
          title={tCommon("actions.close")}
          aria-label={tCommon("actions.close")}
        >
          <X size={15} />
        </button>
      </div>

      <div ref={transcriptRef} className="ai-run-anchor-card-transcript" aria-label={t("run.conversationHistory")}>
        {room?.turns.map((turn) => turn.role === "user" ? (
          <UserTurnView key={turn.id} turn={turn} />
        ) : (
          <CompactAssistantTurn key={turn.id} turn={turn} session={session} document={document} />
        ))}
        {!room?.turns.length && (
          <p className="ai-run-anchor-card-empty">
            {isActive ? t("run.starting") : t("run.noHistory")}
          </p>
        )}
        {isFailed && session.error?.trim() && (
          <p className="ai-run-anchor-card-error">{session.error.trim()}</p>
        )}
      </div>

      <AiRunCardComposer
        roomId={roomId}
        documentIdentityKey={documentIdentityKey}
        document={document}
        documentWorkspaceId={documentWorkspaceId}
        anchor={anchor}
        provider={provider}
        autoFocus={composerAutoFocus}
        onRequestClose={onClose}
      />
    </div>
  );
}

function CompactAssistantTurn({ turn, session, document }: { turn: AssistantTurn; session: AiRunSession; document: SigmaDocument }) {
  const t = useT("ai");
  const text = turn.result?.draft.summary?.trim()
    || turn.streamText.trim()
    || turn.reasoningText.trim()
    || turn.error?.trim()
    || "";
  const events = turn.events.filter((event) => event.kind !== "stream").slice(-4);
  const showEvents = turn.isRunning && events.length > 0;

  return (
    <div className="ai-chat-turn assistant ai-run-card-assistant-turn">
      {text ? (
        <AiStreamRenderer className={turn.error ? "ai-run-anchor-card-error" : "ai-chat-assistant-text"} text={text} mathFractionSizing={document.metadata.mathFractionSizing} />
      ) : turn.isRunning ? (
        <p className="ai-run-anchor-card-empty"><Shimmer>{aiRunStatusLabel(session, t)}</Shimmer></p>
      ) : null}
      {showEvents && (
        <ul className="ai-run-anchor-card-list">
          {events.map((event, index) => (
            <li key={`${event.timestamp}:${index}`} className="ai-run-anchor-card-item" data-kind={event.kind}>
              <span className="ai-run-anchor-card-item-icon">
                {event.kind === "error" ? <X size={11} /> : <Shimmer variant="marker">…</Shimmer>}
              </span>
              <span className="ai-run-anchor-card-item-text">{formatAgentActivityLabel(event, t)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Mirrors `EditorShell.syncInlineRunAnchorCanvas` / `viewportToCanvasAnchor`:
 * the anchor captured at run start is a viewport pixel point, so it needs the
 * page canvas element's rect (and current zoom) to land in the same
 * coordinate space as `blockRects`. */
function findAiRunTargetBlockElement(canvasElement: HTMLElement | null, blockId: string): HTMLElement | null {
  if (!canvasElement) {
    return null;
  }
  return Array.from(canvasElement.querySelectorAll<HTMLElement>("[data-sigma-doc-id]"))
    .find((element) => element.dataset.sigmaDocId === blockId) ?? null;
}

function viewportAnchorToCanvasPoint(
  viewportPoint: { left: number; top: number } | null,
  canvasElement: HTMLElement | null,
): { left: number; top: number } | null {
  if (!viewportPoint || !canvasElement) {
    return null;
  }
  const canvasRect = canvasElement.getBoundingClientRect();
  const pageStack = canvasElement.closest<HTMLElement>(".page-stack");
  const zoomScale = pageStack
    ? Number.parseFloat(getComputedStyle(pageStack).zoom || "1") || 1
    : 1;
  return {
    left: (viewportPoint.left - canvasRect.left) / zoomScale,
    top: (viewportPoint.top - canvasRect.top) / zoomScale,
  };
}

function getAiRunAnchorCardTopBoundary(): number {
  if (typeof window === "undefined") {
    return AI_RUN_CARD_VIEWPORT_MARGIN_PX;
  }
  const menubar = window.document.querySelector<HTMLElement>(".editor-menubar");
  const rect = menubar?.getBoundingClientRect();
  if (!rect || rect.bottom <= 0 || rect.top >= window.innerHeight) {
    return AI_RUN_CARD_VIEWPORT_MARGIN_PX;
  }
  return Math.min(
    Math.max(AI_RUN_CARD_VIEWPORT_MARGIN_PX, rect.bottom + AI_RUN_CARD_GAP_PX),
    Math.max(AI_RUN_CARD_VIEWPORT_MARGIN_PX, window.innerHeight - AI_RUN_CARD_VIEWPORT_MARGIN_PX),
  );
}
