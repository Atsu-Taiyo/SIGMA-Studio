import {
  normalizeOverlayGroups,
  type OverlayAsset,
  type OverlayPoint,
  type OverlayShape,
  type OverlayShapeId,
} from "@/features/document";
import { fitShapesWithinPage } from "@/features/drawing";
import { cloneOverlayShapesForPaste, type EditorClipboardPayload } from "@/lib/editor-clipboard";

export interface PrepareOverlayShapesForPasteInput {
  payload: Extract<EditorClipboardPayload, { kind: "overlayShapes" }>;
  /** Target page size, so a paste from a larger sheet lands on the paper. */
  canvasWidth: number;
  canvasHeight: number;
  offset?: OverlayPoint;
  /**
   * Document being pasted into. When it differs from the payload's `sourceDocId` — or either is
   * unknown — the copy is treated as coming from elsewhere and block anchors are dropped, because
   * the anchored block does not exist here.
   *
   * Surfaces without body text (the running region, the material editor) leave this unset. They
   * cannot hold block anchors in the first place, so the conservative "treat as cross-document"
   * default costs them nothing.
   */
  targetDocId?: string;
  /** コピー元ブロック id → 貼り付けで生まれたブロック id。 */
  anchorBlockIdMap?: Readonly<Record<string, string>>;
}

export interface PreparedOverlayPaste {
  shapes: OverlayShape[];
  assets: Record<string, OverlayAsset>;
  /** Only the top-level shapes: selecting a group's children too would tear the group apart. */
  selectedIds: OverlayShapeId[];
}

/**
 * Everything a paste of overlay shapes has to decide, with no React or DOM in sight.
 *
 * Shared by the in-canvas `paste` listener and the `pasteShapes` action the shell fires when the
 * overlay is not mounted yet (paste into another material tab), so both routes produce exactly the
 * same result.
 */
export function prepareOverlayShapesForPaste({
  payload,
  canvasWidth,
  canvasHeight,
  offset = { x: 20, y: 20 },
  targetDocId,
  anchorBlockIdMap,
}: PrepareOverlayShapesForPasteInput): PreparedOverlayPaste {
  const isSameDocument = Boolean(targetDocId) && payload.sourceDocId === targetDocId;
  const pasted = cloneOverlayShapesForPaste(payload, offset, {
    dropBlockAnchors: !isSameDocument,
    anchorBlockIdMap,
  });
  if (pasted.shapes.length === 0) {
    return { shapes: [], assets: pasted.assets, selectedIds: [] };
  }

  const shapes = normalizeOverlayGroups(fitShapesWithinPage(
    pasted.shapes.map(unlockPastedShape),
    canvasWidth,
    canvasHeight,
  ));
  const shapeIds = new Set(shapes.map((shape) => shape.id));
  const selectedIds = shapes
    .filter((shape) => !shape.parentId || !shapeIds.has(shape.parentId))
    .map((shape) => shape.id);

  return { shapes, assets: pasted.assets, selectedIds };
}

/** A pasted shape is a new object the author just placed: it must be movable straight away. */
function unlockPastedShape(shape: OverlayShape): OverlayShape {
  const next = { ...shape };
  delete next.locked;
  delete next.hidden;
  return next;
}
