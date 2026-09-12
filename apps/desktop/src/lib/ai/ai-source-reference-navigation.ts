import { resolveOverlayShapeAnchorBlockId } from "@/features/ai-edit";
import { findBlock, findContainingProblem } from "@/lib/document-tree";
import type { SigmaDocument } from "@/features/document";

export type SourceReferenceHighlightKind = "block" | "problem" | "overlayShape";

export interface SourceReferenceNavigationTarget {
  /** Block id for `setSelectedId` (overlay shapes resolve to their anchor block). */
  selectionId: string | null;
  /** DOM lookup id for the cited location's transient highlight pulse. */
  highlightId: string | null;
  highlightKind: SourceReferenceHighlightKind;
}

const HIGHLIGHT_PULSE_CLASS = "source-reference-focus-pulse";
const HIGHLIGHT_MAX_ATTEMPTS = 12;
const HIGHLIGHT_RETRY_MS = 50;
const HIGHLIGHT_DURATION_MS = 1400;

function shapeExistsInOverlay(document: SigmaDocument, shapeId: string): boolean {
  const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes;
  return !!shapes?.some((shape) => shape.id === shapeId);
}

/** Resolves where to select and what to pulse when the user opens a cited
 * `sourceReferences` document entry. */
export function resolveSourceReferenceNavigationTarget(
  document: SigmaDocument,
  blockId?: string,
): SourceReferenceNavigationTarget {
  const trimmed = blockId?.trim();
  if (!trimmed || trimmed === "__title__") {
    return { selectionId: null, highlightId: null, highlightKind: "block" };
  }

  if (shapeExistsInOverlay(document, trimmed)) {
    return {
      selectionId: resolveOverlayShapeAnchorBlockId(document, trimmed) ?? null,
      highlightId: trimmed,
      highlightKind: "overlayShape",
    };
  }

  const topLevelProblem = document.content.find(
    (block): block is Extract<typeof block, { type: "problem" }> => block.type === "problem" && block.id === trimmed,
  );
  if (topLevelProblem) {
    return { selectionId: trimmed, highlightId: trimmed, highlightKind: "problem" };
  }

  if (findBlock(document, trimmed) || findContainingProblem(document, trimmed)) {
    return { selectionId: trimmed, highlightId: trimmed, highlightKind: "block" };
  }

  const anchorBlockId = resolveOverlayShapeAnchorBlockId(document, trimmed);
  if (anchorBlockId) {
    return { selectionId: anchorBlockId, highlightId: anchorBlockId, highlightKind: "block" };
  }

  return { selectionId: null, highlightId: null, highlightKind: "block" };
}

/** @deprecated Prefer `resolveSourceReferenceNavigationTarget`. Kept for callers
 * that only need a selection id. */
export function resolveSourceReferenceBlockId(document: SigmaDocument, blockId?: string): string | null {
  return resolveSourceReferenceNavigationTarget(document, blockId).selectionId;
}

function findHighlightElement(highlightId: string, kind: SourceReferenceHighlightKind): HTMLElement | null {
  if (typeof document === "undefined") {
    return null;
  }

  const escaped = CSS.escape(highlightId);
  if (kind === "overlayShape") {
    return document.querySelector<HTMLElement>(`[data-overlay-shape-id="${escaped}"]`);
  }
  if (kind === "problem") {
    return document.getElementById(highlightId)
      ?? document.querySelector<HTMLElement>(`[data-problem-id="${escaped}"]`);
  }
  return document.querySelector<HTMLElement>(`[data-sigma-doc-id="${escaped}"]`)
    ?? document.getElementById(highlightId);
}

/** Scrolls to the cited location and plays a short highlight pulse. Retries
 * until the target element mounts (e.g. right after switching documents). */
export function scheduleSourceReferenceHighlight(
  highlightId: string,
  kind: SourceReferenceHighlightKind,
  attempt = 0,
): void {
  if (typeof window === "undefined") {
    return;
  }

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const element = findHighlightElement(highlightId, kind);
      if (!element) {
        if (attempt < HIGHLIGHT_MAX_ATTEMPTS) {
          window.setTimeout(
            () => scheduleSourceReferenceHighlight(highlightId, kind, attempt + 1),
            HIGHLIGHT_RETRY_MS,
          );
        }
        return;
      }

      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      element.classList.add(HIGHLIGHT_PULSE_CLASS);
      window.setTimeout(() => element.classList.remove(HIGHLIGHT_PULSE_CLASS), HIGHLIGHT_DURATION_MS);
    });
  });
}

export function focusSourceReferenceInDocument(
  document: SigmaDocument,
  blockId: string | undefined,
  actions: {
    selectBlock: (blockId: string) => void;
    focusEditableBlock?: (blockId: string) => void;
  },
): void {
  const target = resolveSourceReferenceNavigationTarget(document, blockId);
  if (target.selectionId) {
    actions.selectBlock(target.selectionId);
    actions.focusEditableBlock?.(target.selectionId);
  }
  if (target.highlightId) {
    scheduleSourceReferenceHighlight(target.highlightId, target.highlightKind);
  }
}
