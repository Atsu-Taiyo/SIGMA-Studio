import {
  normalizeOverlayGroups,
  type OverlayAsset,
  type OverlayPoint,
  type OverlayShape,
  type OverlayShapeId,
} from "@/features/document";
import { fitShapesWithinPage, getShapesSelectionBounds } from "@/features/drawing";
import { cloneOverlayShapesForPaste, type EditorClipboardPayload } from "@/lib/editor-clipboard";
import {
  clampPasteCenterToNearestPage,
  type ClientPoint,
  type PointerPastePlacement,
} from "./pointer-paste";

/** 図形の貼り付けを紙面へ適用するときの追加の指定。 */
export interface ApplyPastedOverlayShapesOptions {
  /** コピー元ブロック id → 貼り付けで生まれたブロック id。 */
  anchorBlockIdMap?: Record<string, string>;
  /** 本文と 1 つの undo エントリに畳むためのコアレスキー。 */
  historyGroup?: string;
  /**
   * 貼り付けた図形全体の中心をここへ置く (ポケットのドロップ・ホワイトボードへの挿入)。
   * 無いときは、元の位置から少しずらして重ねる (⌘V の貼り付け)。
   */
  centerAt?: OverlayPoint;
  /**
   * 紙のサイズへ押し戻さない。ホワイトボードは、パンで原点より左上 (負の座標) も見えるので、
   * 見えている場所へ置いた図形を 0 に押し戻すと、画面の外へ出てしまう。紙の上では使わない
   * (紙の外へ置かれた図形は、紙の中へ引き戻す)。
   */
  unbounded?: boolean;
  /**
   * ⌘V のとき、ポインタがいる画面上の点 (client 座標)。編集領域の上にあるときだけ呼び出し側が渡す。
   * 貼り付けた図形全体の中心をその点へ置き、いちばん近いページの内側へ押し戻す。`centerAt` が
   * あるときはそちらが優先で、ポインタは見ない。ページの並びを持たない面 (running region・
   * 素材編集) は無視して、従来どおり元の位置から少しずらす。
   */
  pointerClient?: ClientPoint;
}

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
  /** 貼り付けた図形全体の中心を置く場所。`offset` より優先する。 */
  centerAt?: OverlayPoint;
  /** 紙のサイズへ押し戻さない (ホワイトボード)。 */
  unbounded?: boolean;
  /**
   * ポインタの位置へ置く指定 (紙面の座標へ写した点とページの並び)。`centerAt` が無いときだけ効く。
   * 図形はブロックのアンカーを外して置かれ、保存のときに、置いた位置から新しい図形と同じように
   * 近い本文ブロックへ付け直される (ページ固定の図形は固定のまま)。
   */
  pointerPlacement?: PointerPastePlacement;
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
  centerAt,
  unbounded = false,
  pointerPlacement,
}: PrepareOverlayShapesForPasteInput): PreparedOverlayPaste {
  const isSameDocument = Boolean(targetDocId) && payload.sourceDocId === targetDocId;
  const bounds = centerAt || pointerPlacement ? getShapesSelectionBounds(payload.shapes) : null;
  // ポインタの位置は、いちばん近いページの内側へ押し戻した中心にする (灰色の隙間なら近い方のページへ)。
  const pointerCenter = !centerAt && pointerPlacement && bounds
    ? clampPasteCenterToNearestPage(pointerPlacement.point, bounds, pointerPlacement.layout)
    : null;
  const center = centerAt ?? pointerCenter;
  const placement = center && bounds
    ? { x: center.x - (bounds.x + bounds.w / 2), y: center.y - (bounds.y + bounds.h / 2) }
    : offset;
  const pasted = cloneOverlayShapesForPaste(payload, placement, {
    // 置き場所を指定したものは、元のブロックから切り離して置いた場所に留める
    // (ブロックに掛かったままだと、解決のときに元の相対位置へ引き戻される)。
    // ただしポインタに置いたものは「ページに固定」ではなく「アンカー無し」にする: 新しく描いた図形と
    // 同じく、保存のときに置いた位置から近い本文ブロックへ付け直され、本文に追従する。
    dropBlockAnchors: !isSameDocument || Boolean(center && bounds),
    droppedBlockAnchor: pointerCenter ? "unanchored" : "page",
    anchorBlockIdMap,
  });
  if (pasted.shapes.length === 0) {
    return { shapes: [], assets: pasted.assets, selectedIds: [] };
  }

  const unlocked = pasted.shapes.map(unlockPastedShape);
  const shapes = normalizeOverlayGroups(unbounded ? unlocked : fitShapesWithinPage(unlocked, canvasWidth, canvasHeight));
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
