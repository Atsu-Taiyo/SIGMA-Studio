import {
  moveShape
} from "@/features/drawing";
import {
  getIdsWithDescendants,
  isOverlayGroupShape,
  isShapeEditPolicyLockedInTree,
  isShapeLockedInTree
} from "./grouping";
import type {
  OverlayShape,
  OverlayShapeId
} from "./types";

/**
 * キャンバスのキーボード操作から除外する「backdrop の無い浮遊 UI」。
 *
 * `data-non-modal-surface` はグラフ設定パネル本体に付くが、その中から開く色・線種・
 * 太さ・塗り方のポップオーバーは `document.body` 直下へ portal されるので DOM 上は
 * パネルの外側になる。属性だけを見ると、そこにフォーカスがある間の Delete が
 * キャンバスに届いて選択中の図形を消す。
 */
export const NON_MODAL_KEYBOARD_SURFACE_SELECTOR = "[data-non-modal-surface], [data-toolbar-popover]";

export function isComposingKeyboardEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.key === "Process" || event.keyCode === 229;
}

export function applySelectionUnitTransforms(
  allShapes: OverlayShape[],
  fromUnits: OverlayShape[],
  toUnits: OverlayShape[],
): OverlayShape[] {
  const nextById = new Map(allShapes.map((shape) => [shape.id, shape]));
  for (let index = 0; index < fromUnits.length; index += 1) {
    const from = fromUnits[index];
    const to = toUnits[index];
    if (!from || !to) {
      continue;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx === 0 && dy === 0) {
      continue;
    }
    const ids = isOverlayGroupShape(from)
      ? getIdsWithDescendants(allShapes, [from.id], { includeGroups: true })
      : [from.id];
    for (const id of ids) {
      const shape = nextById.get(id);
      if (shape && !isShapeLockedInTree(allShapes, shape)) {
        nextById.set(id, moveShape(shape, dx, dy));
      }
    }
  }
  return allShapes.map((shape) => nextById.get(shape.id) ?? shape);
}

export function unlockVisibleShape(shape: OverlayShape): OverlayShape {
  const next = { ...shape };
  delete next.locked;
  delete next.hidden;
  return next;
}

/** ページ固定を「行き先未定」に戻した複製。`anchor` のキーごと落とす。 */
export function withoutPageAnchor(shape: OverlayShape): OverlayShape {
  if (shape.anchor?.type !== "page") {
    return shape;
  }
  const next = { ...shape };
  delete next.anchor;
  return next;
}

export function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  if (target instanceof HTMLInputElement && (target.type === "file" || target.type === "hidden")) {
    return false;
  }
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    target.closest("[contenteditable='true'], math-field") !== null
  );
}

/** Which shapes a style request may touch: the selection minus anything locked. */
export function getStyleTargetIds(
  shapes: OverlayShape[],
  selectedIds: OverlayShapeId[],
  editPolicyLockedShapeIds: ReadonlySet<OverlayShapeId>,
): Set<string> {
  const selected = new Set(getIdsWithDescendants(shapes, selectedIds, { includeGroups: false }));
  const targets = new Set<string>();
  for (const shape of shapes) {
    if (selected.has(shape.id)
      && !isShapeLockedInTree(shapes, shape)
      && !isShapeEditPolicyLockedInTree(shapes, shape, editPolicyLockedShapeIds)) {
      targets.add(shape.id);
    }
  }
  return targets;
}