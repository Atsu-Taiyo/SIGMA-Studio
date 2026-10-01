import { focusCaretAddress } from "@/components/editor/text-flow/caret-router";
import { scrollElementIntoCanvasView } from "@/components/editor/text-flow/caret-scroll";
import { type SigmaBlock } from "@/features/document";
import { caretAddressAtBlockEdge,findTopLevelBlock,isTextFlowBlock,type CaretAddress } from "@/features/text-editing";
import { type EditableBlock } from "@/lib/document-tree";
import type { Translate } from "@/lib/i18n";
import type { OverlayPoint } from "../overlay-canvas/types";
import { canvasLayoutScale } from "./pointer-targets";

export function shouldHandlePageImagePaste(
  target: EventTarget | null,
  canvas: HTMLDivElement | null,
  point: OverlayPoint | null,
): boolean {
  if (!canvas) {
    return false;
  }

  if (target instanceof Node && canvas.contains(target)) {
    return true;
  }

  const document = canvas.ownerDocument;
  if (target instanceof Element && target !== document.body && !canvas.contains(target)) {
    return false;
  }

  const activeElement = document.activeElement;
  if (activeElement instanceof Node && canvas.contains(activeElement)) {
    return true;
  }

  if (activeElement instanceof Element && activeElement !== document.body && !canvas.contains(activeElement)) {
    return false;
  }

  return point !== null;
}

/** ポインタの画面座標を、アフォーダンス層と同じ座標系へ移す。 */
export function toCanvasPoint(
  canvas: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const canvasRect = canvas.getBoundingClientRect();
  const scale = canvasLayoutScale(canvas);
  return {
    x: (clientX - canvasRect.left) / scale,
    y: (clientY - canvasRect.top) / scale,
  };
}

/**
 * Names the block in the delete item so the menu says what is about to disappear. A problem
 * normally reaches its own menu instead, but the label must still name it rather than fall
 * back to the generic wording.
 */
export function bodyBlockDeleteLabel(block: EditableBlock | null, t: Translate<"editor">): string {
  switch (block?.type) {
    case "problem":
      return t("pageMenu.deleteProblemBlock");
    case "paragraph":
      return t("pageMenu.deleteParagraph");
    case "heading":
    case "section":
      return t("pageMenu.deleteHeading");
    case "list":
      return t("pageMenu.deleteList");
    case "boxBlock":
      return t("pageMenu.deleteBox");
    case "layoutSection":
      return t("pageMenu.deleteColumns");
    default:
      return t("pageMenu.deleteBlock");
  }
}

/**
 * ブロックの端へキャレットを戻す。
 *
 * 以前は `document.querySelector` で**最初に見つかった**要素を掴んでいたので、ページを跨ぐ
 * ブロックでは常に見えない正本を掴み、そこへ `scrollIntoView` して紙面が飛んでいた。
 * 論理位置だけ決めてルーターに配らせる (見せている面はルーターが選ぶ)。
 */
export function scheduleTextBlockFocus(
  content: readonly SigmaBlock[],
  blockId: string,
  position: "start" | "end",
) {
  // `content` は**この結合/分割が反映される前**の並び。`position` はその並びに対する指定
  // なので、ここで住所に変換しておく (rAF の中で作り直すと、結合後の長さで末尾を取って
  // しまう)。
  const target = findTopLevelBlock(content, blockId);
  const address = target && isTextFlowBlock(target)
    ? caretAddressAtBlockEdge(target, position)
    : null;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (address && focusCaretAddress(address)) {
        return;
      }
      // 問題エリアの中など、トップレベルに無いブロック。住所を組み立てられないので
      // DOM から辿る (ページを跨ぐブロックはトップレベルにしか無いので、ここで
      // 見えない複製を掴む心配は無い)。
      focusBlockElementEdge(blockId, position);
    });
  });
}

/** 描き直しが落ち着いてから (2 rAF 後に) 論理位置へキャレットを配る。 */
export function scheduleCaretAddressFocus(address: CaretAddress) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      focusCaretAddress(address);
    });
  });
}

export function focusBlockElementEdge(blockId: string, position: "start" | "end"): void {
  const selector = `[data-sigma-doc-id="${CSS.escape(blockId)}"]`;
  const blockElement = window.document.querySelector<HTMLElement>(selector);
  const editorElement = blockElement?.closest<HTMLElement>("[contenteditable='true']");
  const selection = window.getSelection();
  if (!blockElement || !editorElement || !selection) {
    return;
  }
  editorElement.focus({ preventScroll: true });
  const range = window.document.createRange();
  range.selectNodeContents(blockElement);
  range.collapse(position === "start");
  selection.removeAllRanges();
  selection.addRange(range);
  scrollElementIntoCanvasView(blockElement);
}
