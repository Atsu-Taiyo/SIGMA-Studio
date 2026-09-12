export interface TextRunEditorRangeInput {
  docSize: number;
  unitId: string;
}

export interface TextRunCaretPoint {
  pos: number;
  unitId: string;
}

export interface TextRunEditorRange {
  from: number;
  to: number;
  unitId: string;
}

export interface TextRunEditorRect {
  rect: { bottom: number; left: number; right: number; top: number };
  unitId: string;
}

/**
 * アンカーとヘッドから、連なり内の各エディタが覆う範囲を文書順で返す。
 *
 * 1 ユニットに収まる選択は要素 1 件。跨ぐときは中間ユニットを 0..docSize で埋める。
 */
export function resolveRunSelectionRanges(
  editors: readonly TextRunEditorRangeInput[],
  anchor: TextRunCaretPoint,
  head: TextRunCaretPoint,
): TextRunEditorRange[] {
  const anchorIndex = editors.findIndex((editor) => editor.unitId === anchor.unitId);
  const headIndex = editors.findIndex((editor) => editor.unitId === head.unitId);
  if (anchorIndex < 0 || headIndex < 0) {
    return [];
  }

  const anchorIsEarlier = anchorIndex < headIndex
    || (anchorIndex === headIndex && anchor.pos <= head.pos);
  const earlier = anchorIsEarlier
    ? { index: anchorIndex, pos: clampPos(anchor.pos, editors[anchorIndex].docSize) }
    : { index: headIndex, pos: clampPos(head.pos, editors[headIndex].docSize) };
  const later = anchorIsEarlier
    ? { index: headIndex, pos: clampPos(head.pos, editors[headIndex].docSize) }
    : { index: anchorIndex, pos: clampPos(anchor.pos, editors[anchorIndex].docSize) };

  const ranges: TextRunEditorRange[] = [];
  for (let index = earlier.index; index <= later.index; index += 1) {
    const editor = editors[index];
    const from = index === earlier.index ? earlier.pos : 0;
    const to = index === later.index ? later.pos : editor.docSize;
    if (to > from) {
      ranges.push({ unitId: editor.unitId, from, to });
    }
  }
  return ranges;
}

export function isMultiEditorRunSelection(ranges: readonly TextRunEditorRange[]): boolean {
  return ranges.length > 1;
}

/**
 * ポインタ位置がどのユニットか。矩形の中ならそのユニット、ユニット間の隙間なら近い方、
 * 連なりの外なら端のユニット。
 */
export function resolveRunEditorAtPoint(
  editors: readonly TextRunEditorRect[],
  x: number,
  y: number,
): string | null {
  if (editors.length === 0) {
    return null;
  }

  // 左右の余白も段間も、実際に近い編集面へ寄せる。縦方向の隙間だけを検査すると、
  // 本文と同じ高さの余白がどこにも該当せず、末尾の編集面へ飛んでしまう。
  let nearest = editors[0].unitId;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const editor of editors) {
    const { left, right, top, bottom } = editor.rect;
    const dx = Math.max(left - x, 0, x - right);
    const dy = Math.max(top - y, 0, y - bottom);
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearest = editor.unitId;
      nearestDistance = distance;
    }
    if (distance === 0) return nearest;
  }
  return nearest;
}

function clampPos(pos: number, docSize: number): number {
  if (!Number.isFinite(pos) || docSize <= 0) {
    return 0;
  }
  return Math.min(Math.max(pos, 0), docSize);
}
