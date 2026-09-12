import {
  expandShapeIdsWithGraphOwnedLabels,
  shapeVisualBoundsIntersect,
  type MeasuredBlock,
} from "@/features/drawing";
import type { OverlayBounds } from "@/features/document";

import { getSelectableShapeId, getShapesInVisualStackOrder } from "./grouping";
import type { OverlayShape, OverlayShapeId } from "./types";

/** 縦に隣り合うブロックを 1 本の帯へ畳むときに許す隙間 (段落間マージン)。 */
const SELECTION_BAND_GAP_PX = 4;

/**
 * 本文の選択範囲と一緒に運ばれる図形の「選択単位」の id。
 *
 * 拾い方は 2 通りで、どちらかに当たれば運ぶ。
 *
 * 1. アンカー: 図形は本文の行送りに追従する先としてブロックを名指ししているので、その
 *    ブロックが選択に入ったのなら一緒に運ぶ。見た目が離れていても運ぶ。
 * 2. 見た目の重なり: 選んだ本文の矩形に描画が重なっている図形も運ぶ。ページ固定
 *    (`anchor.type === "page"`) やアンカー無しの図形 — 取り込み由来の教材はこれが並ぶ —
 *    は 1 では絶対に拾えず、「本文の上に載っているのにコピーされない」になるため。
 *
 * そこからさらに 2 つの所有関係へ広げる:
 * - 図形アンカー (`anchor.type === "shape"`) の子。グラフのラベルや、図形に貼った注記。
 * - グラフが id で所有するラベル。アンカーが外れていても持ち主と一緒に動く。
 * 最後に最外のグループへ畳む — 選択の単位はグループであって、その中身ではない。
 */
export function getShapeIdsAnchoredToBlocks(
  shapes: OverlayShape[],
  blockIds: Iterable<string>,
  blockRects?: ReadonlyMap<string, MeasuredBlock>,
): OverlayShapeId[] {
  const blocks = new Set(blockIds);
  if (blocks.size === 0) {
    return [];
  }

  const picked = new Set<OverlayShapeId>(shapes
    .filter((shape) => shape.anchor?.type === "block" && blocks.has(shape.anchor.blockId))
    .map((shape) => shape.id));

  for (const band of selectionBands(blocks, blockRects)) {
    for (const shape of shapes) {
      if (!picked.has(shape.id) && shapeVisualBoundsIntersect(shape, band)) {
        picked.add(shape.id);
      }
    }
  }
  if (picked.size === 0) {
    return [];
  }

  return toSelectableShapeIds(shapes, expandShapeIdsWithOwnedChildren(shapes, picked));
}

/**
 * この面の図形すべての「選択単位」の id。
 *
 * 本文を全選択したときの ⌘Shift+A が使う。全選択は「文書まるごと」の意味なので、本文に
 * ぶら下がってもいなければ本文の矩形に重なってもいない図形 (余白の注記など) も入れる —
 * アンカーと重なりで絞ると、見た目には全部選んだのに一部だけ取り残される。
 */
export function getAllSelectableShapeIds(shapes: OverlayShape[]): OverlayShapeId[] {
  return toSelectableShapeIds(shapes, shapes.map((shape) => shape.id));
}

/** 選択の単位は最外のグループであって、その中身ではない。重ね順は描画順に揃える。 */
function toSelectableShapeIds(shapes: OverlayShape[], ids: Iterable<OverlayShapeId>): OverlayShapeId[] {
  const selectable = new Set([...ids].map((id) => getSelectableShapeId(shapes, id, null)));
  return getShapesInVisualStackOrder(shapes)
    .filter((shape) => selectable.has(shape.id))
    .map((shape) => shape.id);
}

/**
 * 選択されたブロックの矩形を、段ごとに縦へ畳んだ帯の列。
 *
 * 畳むのは当たり判定の回数を「図形 × 帯」に抑えるため (30 ページの教材では選択ブロックが
 * 千件を超える)。左端と幅が同じものだけを畳むので、多段組の左右の段が 1 つの帯に混ざって
 * 段間の余白まで巻き込むことはない。
 */
function selectionBands(
  blockIds: ReadonlySet<string>,
  blockRects: ReadonlyMap<string, MeasuredBlock> | undefined,
): OverlayBounds[] {
  if (!blockRects) {
    return [];
  }

  const byColumn = new Map<string, OverlayBounds[]>();
  for (const blockId of blockIds) {
    const rect = blockRects.get(blockId);
    if (!rect || rect.left === undefined || !rect.width || !rect.height) {
      continue;
    }
    const column = `${Math.round(rect.left)}:${Math.round(rect.width)}`;
    const bounds: OverlayBounds = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    const existing = byColumn.get(column);
    if (existing) {
      existing.push(bounds);
    } else {
      byColumn.set(column, [bounds]);
    }
  }

  const bands: OverlayBounds[] = [];
  for (const column of byColumn.values()) {
    column.sort((left, right) => left.y - right.y);
    for (const bounds of column) {
      const open = bands.at(-1);
      const contiguous = open
        && open.x === bounds.x
        && open.w === bounds.w
        && bounds.y <= open.y + open.h + SELECTION_BAND_GAP_PX;
      if (contiguous) {
        open.h = Math.max(open.h, bounds.y + bounds.h - open.y);
      } else {
        bands.push({ ...bounds });
      }
    }
  }
  return bands;
}

/**
 * 図形アンカーの子とグラフ所有ラベルを、増えなくなるまで交互に足す。
 * 順を固定すると「グループ化されたグラフのラベル」のようにお互いを跨ぐ関係を取りこぼす
 * (`expandShapeIdsWithAiLockOwnership` と同じ理由)。
 */
function expandShapeIdsWithOwnedChildren(
  shapes: OverlayShape[],
  ids: Iterable<OverlayShapeId>,
): OverlayShapeId[] {
  let expanded = [...new Set(ids)];
  for (let round = 0; round < 4; round += 1) {
    const next = expandShapeIdsWithShapeAnchoredChildren(
      shapes,
      expandShapeIdsWithGraphOwnedLabels(shapes, expanded),
    );
    if (next.length === expanded.length) {
      return next;
    }
    expanded = next;
  }
  return expanded;
}

function expandShapeIdsWithShapeAnchoredChildren(
  shapes: OverlayShape[],
  ids: Iterable<OverlayShapeId>,
): OverlayShapeId[] {
  const expanded = new Set(ids);
  for (let round = 0; round < 4; round += 1) {
    const before = expanded.size;
    for (const shape of shapes) {
      if (shape.anchor?.type === "shape" && expanded.has(shape.anchor.shapeId)) {
        expanded.add(shape.id);
      }
    }
    if (expanded.size === before) {
      break;
    }
  }
  return [...expanded];
}
