import { createOverlayPayloadFromClipboard } from "@/components/editor/overlay-canvas/clipboard-overlay-payload";
import type { SigmaBlock } from "@/features/document";
import {
  cloneDocumentBlocksForPaste,
  cloneTextFlowBlocksForPaste,
  createDocumentBlocksClipboardPayload,
  createInlineMathClipboardPayload,
  createTextFlowClipboardPayload,
  EDITOR_CLIPBOARD_MIME,
  EDITOR_TEXT_SLICE_MIME,
  getLocalEditorClipboardPayload,
  isTextFlowClipboardBlock,
  readEditorClipboardPayload,
  toOverlayShapesClipboardPayload,
  writeEditorClipboardData,
  type ClipboardTextFlowBlock,
  type EditorClipboardPayload,
} from "@/lib/editor-clipboard";
import type { Translate } from "@/lib/i18n";
import { readSpreadsheetClipboard } from "@/lib/spreadsheet-clipboard";
import { readFlowPageShift } from "../page-canvas/page-arrangement-dom";
import { viewportToCanvasAnchor } from "../page-canvas/popover-anchors";

import { isMultiEditorTextRunSpan, replaceActiveTextRunSpan } from "../text-flow/text-run-span";
import { INSERT_INLINE_MATH_EVENT } from "./constants";

type BlockPaste =
  | { kind: "documentBlocks"; blocks: SigmaBlock[] }
  | { kind: "textFlowBlocks"; blocks: ClipboardTextFlowBlock[] };

interface EditorClipboardPorts {
  ownsInput?: () => boolean;
  overlayEditing: boolean;
  pasteTikz?: (text: string) => boolean;
  selectedInlineMath: { tex: string; getCanonicalTex?: () => string } | null;
  getSelectedBlock: () => SigmaBlock | null;
  isMaterialEditing: () => boolean;
  insertBlocks: (paste: BlockPaste) => void;
  pasteShapes: (
    payload: Extract<EditorClipboardPayload, { kind: "overlayShapes" }>,
    options?: { centerAt?: { x: number; y: number }; unbounded?: boolean; pointerClient?: { x: number; y: number } },
  ) => void;
  /**
   * ⌘V の瞬間にマウスポインタがいる点 (client 座標)。文書の編集領域の上にいないとき・位置が
   * 分からないときは null で、その場合の図形は従来どおり元の位置から少しずらして貼られる。
   */
  getPointerPastePoint?: () => { x: number; y: number } | null;
  /**
   * 本文を持たない紙面 (ホワイトボード) か。本文のコピー (問題・文章・数式) は貼る場所が無いので、
   * テキスト部分だけを文章の図形にして貼る。
   */
  bodyless?: boolean;
  /** 本文を持たない紙面で、貼った文章の図形の中心にする場所 (見えている範囲の中央)。 */
  getBodylessPasteCenter?: () => { x: number; y: number } | null;
  setCanPasteProblem: (canPaste: boolean) => void;
  setStatusMessage: (message: string) => void;
  translate: Translate<"editor">;
}

/**
 * ブラウザの copy/paste を、その内容を受け取れる編集面へ振り分ける。
 * 文書の書き換え・選択・履歴は shell の port が所有し、この境界は payload と
 * DOM の所有権、イベント伝播、跨ぎ選択の削除後に挿入する順序を所有する。
 */
export function registerEditorClipboardEvents(ports: EditorClipboardPorts): () => void {
  const { overlayEditing, selectedInlineMath, setStatusMessage, translate: t } = ports;
  let literalPasteRequested = false;
  const handleKeyDown = (event: KeyboardEvent) => {
    if (ports.ownsInput && !ports.ownsInput()) return;
    literalPasteRequested = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "v";
  };

  const handleCopy = (event: ClipboardEvent) => {
    if (ports.ownsInput && !ports.ownsInput()) return;
    if (
      !overlayEditing && selectedInlineMath && event.clipboardData
      && isInlineMathClipboardTarget(event.target) && !isNativeClipboardTarget(event.target)
    ) {
      event.preventDefault();
      writeEditorClipboardData(event.clipboardData, createInlineMathClipboardPayload(selectedInlineMath.getCanonicalTex?.() ?? selectedInlineMath.tex));
      setStatusMessage(t("status.mathCopied"));
      return;
    }

    if (overlayEditing || isNativeClipboardTarget(event.target) || hasActiveDomSelection()) {
      return;
    }
    const block = ports.getSelectedBlock();
    if (!block || !event.clipboardData) {
      return;
    }

    // 問題のように本文の連なりに入らないブロックは、問題メニューと同じ payload で運ぶ。
    event.preventDefault();
    writeEditorClipboardData(
      event.clipboardData,
      isTextFlowClipboardBlock(block)
        ? createTextFlowClipboardPayload([block])
        : createDocumentBlocksClipboardPayload([block]),
    );
    ports.setCanPasteProblem(block.type === "problem");
    setStatusMessage(block.type === "problem" ? t("status.problemCopied") : t("status.bodyBlockCopied"));
  };

  /**
   * ホワイトボードへの本文のコピーの貼り付け。問題・本文ブロック・数式は、番号や枠は持たせず、
   * 含んでいる文章だけを文章の図形 (オーバーレイ) にして、見えている範囲の中央へ置く。
   * 編集中の入力欄・本文・ダイアログへの貼り付けは、そちらに任せる。
   */
  const pasteBodyTextAsShape = (event: ClipboardEvent): boolean => {
    const data = event.clipboardData;
    if (
      !ports.bodyless || !data || ports.isMaterialEditing()
      || isNativeClipboardTarget(event.target) || isPlainTextClipboardTarget(event.target)
      || (event.target instanceof Element && event.target.closest('[role="dialog"]'))
    ) {
      return false;
    }
    const payload = readEditorClipboardPayload(data);
    if (payload?.kind !== "textFlowBlocks" && payload?.kind !== "documentBlocks" && payload?.kind !== "inlineMath") {
      return false;
    }
    const overlayPayload = createOverlayPayloadFromClipboard({
      [EDITOR_CLIPBOARD_MIME]: data.getData(EDITOR_CLIPBOARD_MIME),
      [EDITOR_TEXT_SLICE_MIME]: data.getData(EDITOR_TEXT_SLICE_MIME),
      "text/html": data.getData("text/html"),
      "text/plain": data.getData("text/plain"),
    });
    if (!overlayPayload) {
      return false;
    }
    const centerAt = ports.getBodylessPasteCenter?.() ?? undefined;
    event.preventDefault();
    event.stopPropagation();
    // ホワイトボードは、パンで原点より左上も見えるので、見えている中央へ置くときは紙の範囲へ押し戻さない。
    ports.pasteShapes(overlayPayload, centerAt ? { centerAt, unbounded: true } : undefined);
    setStatusMessage(t("status.bodyPastedAsTextShape"));
    return true;
  };

  /**
   * 図形の ⌘V。ポインタが文書の編集領域の上にいるときだけ、その位置を添える
   * (外にいる・位置不明なら従来どおり、元の位置から少しずらして貼られる)。
   */
  const pasteShapesAtPointer = (payload: Extract<EditorClipboardPayload, { kind: "overlayShapes" }>) => {
    const pointerClient = ports.getPointerPastePoint?.();
    if (pointerClient) {
      ports.pasteShapes(payload, { pointerClient });
    } else {
      ports.pasteShapes(payload);
    }
  };

  const handlePaste = (event: ClipboardEvent) => {
    if (ports.ownsInput && !ports.ownsInput()) return;
    const literalPaste = literalPasteRequested;
    literalPasteRequested = false;
    if (event.defaultPrevented) return;
    // Text-only surfaces own their paste, including document-block payloads.
    // The shell must not insert into the paper behind a title, dialog, or header.
    if (literalPaste || ports.isMaterialEditing() || isPlainTextClipboardTarget(event.target)
      || (event.target instanceof Element && event.target.closest('[role="dialog"], pre, .running-region-editor'))) {
      return;
    }
    if (event.clipboardData && !readEditorClipboardPayload(event.clipboardData)) {
      const spreadsheet = readSpreadsheetClipboard(event.clipboardData);
      if (spreadsheet) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const shape = spreadsheet.shapes[0];
        const centerAt = ports.bodyless ? ports.getBodylessPasteCenter?.() ?? undefined
          : shape.type === "tableShape" ? tablePasteCenter(event.target, shape.props.w, shape.props.h, ports.getSelectedBlock()?.id) : undefined;
        ports.pasteShapes(spreadsheet, centerAt ? { centerAt, unbounded: ports.bodyless === true } : undefined);
        setStatusMessage(t("status.shapesPasted"));
        return;
      }
    }
    if (event.clipboardData && !readEditorClipboardPayload(event.clipboardData)
      && ports.pasteTikz?.(event.clipboardData.getData("text/plain"))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (pasteBodyTextAsShape(event)) {
      return;
    }
    if (overlayEditing || !event.clipboardData) {
      return;
    }

    const eventPayload = readEditorClipboardPayload(event.clipboardData);
    // An actual clipboard item supersedes the last in-app copy, even if it has
    // no Sigma payload. Keep the menu fallback only when no clipboard item exists.
    const payload = eventPayload ?? (event.clipboardData.types.length === 0 ? getLocalEditorClipboardPayload() : null);
    const nativeClipboardTarget = isNativeClipboardTarget(event.target);

    // 図形だけはイベントの payload を使う。最後の Sigma コピーを保持する fallback を
    // 使うと、他アプリから後でコピーした普通のテキストまで過去の図形に化けてしまう。
    if (eventPayload?.kind === "overlayShapes") {
      // 素材ダイアログの canvas は独自の受け手を持つ。本文の caret は図形を受け取れるが、
      // タイトル・検索・下書き・数式欄はテキストだけを受け取る。
      if (ports.isMaterialEditing() || isPlainTextClipboardTarget(event.target) || eventPayload.shapes.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      pasteShapesAtPointer(eventPayload);
      setStatusMessage(eventPayload.shapes.length === 1
        ? t("status.shapesPasted")
        : t("status.shapesPastedCount", { shapes: eventPayload.shapes.length }));
      return;
    }

    if (eventPayload?.kind === "textAndShapes") {
      if (ports.isMaterialEditing() || isPlainTextClipboardTarget(event.target)) {
        return;
      }
      // 本文では TextFlowEditor がテキストを入れ、図形は要求イベントで戻す。
      if (nativeClipboardTarget || eventPayload.shapes.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      pasteShapesAtPointer(toOverlayShapesClipboardPayload(eventPayload));
      setStatusMessage(t("status.shapesPastedBodyHint"));
      return;
    }

    if (payload?.kind === "inlineMath") {
      if (nativeClipboardTarget) {
        return;
      }
      event.preventDefault();
      window.dispatchEvent(new CustomEvent(INSERT_INLINE_MATH_EVENT, { detail: { tex: payload.tex, target: "document" } }));
      setStatusMessage(t("status.mathPasted"));
      return;
    }

    if (payload?.kind === "documentBlocks") {
      event.preventDefault();
      event.stopPropagation();
      const blocks = cloneDocumentBlocksForPaste(payload.blocks);
      if (blocks.length === 0) {
        return;
      }
      const insertPastedBlocks = () => {
        ports.insertBlocks({ kind: "documentBlocks", blocks });
        setStatusMessage(blocks.length === 1 && blocks[0]?.type === "problem"
          ? t("status.problemPasted") : t("status.blockPasted"));
      };
      if (isMultiEditorTextRunSpan()) {
        // 文書ブロックは PM の doc へ入れられない。削除の onChange が文書へ到着した後で、
        // 最新の文書・選択に挿入する（ports は React render の文書 snapshot を捕まえない）。
        replaceActiveTextRunSpan([]);
        window.setTimeout(insertPastedBlocks, 0);
        return;
      }
      insertPastedBlocks();
      return;
    }

    if (nativeClipboardTarget || payload?.kind !== "textFlowBlocks") {
      return;
    }
    const blocks = cloneTextFlowBlocksForPaste(payload.blocks);
    if (blocks.length === 0) {
      return;
    }
    event.preventDefault();
    ports.insertBlocks({ kind: "textFlowBlocks", blocks });
    setStatusMessage(t("status.bodyBlockPasted"));
  };

  window.addEventListener("copy", handleCopy);
  window.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("paste", handlePaste, true);
  return () => {
    window.removeEventListener("copy", handleCopy);
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("paste", handlePaste, true);
  };
}

function tablePasteCenter(target: EventTarget | null, width: number, height: number, selectedId?: string) {
  if (!(target instanceof Element)) return undefined;
  const anchor = window.getSelection()?.anchorNode;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  const block = element?.closest<HTMLElement>("[data-sigma-doc-id]")
    ?? (selectedId ? document.getElementById(selectedId) : null);
  const canvas = block?.closest<HTMLElement>(".page-canvas") ?? target.closest<HTMLElement>(".page-canvas");
  if (!canvas) return undefined;
  if (!block || !canvas.contains(block)) return undefined;
  const rect = block.getBoundingClientRect();
  const point = viewportToCanvasAnchor({ left: rect.left, top: rect.bottom }, canvas);
  // 図形の座標は紙面 (モデル) 座標。2 ページ並びではブロックはそのページのずらしで描かれている。
  const shift = readFlowPageShift(block);
  return { x: point.left - shift.x + width / 2, y: point.top - shift.y + 8 + height / 2 };
}

/** 本文の contenteditable は図形も受け取れるので、通常の入力欄とは区別する。 */
function isPlainTextClipboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  if (tagName === "input" || tagName === "textarea" || tagName === "select" || target.closest("math-field")) {
    return true;
  }
  const editable = target.closest("[contenteditable='true']");
  return editable !== null && editable.closest(".page-flow, .text-flow-editor") === null;
}

function isNativeClipboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select"
    || target.closest("[contenteditable='true'], math-field") !== null;
}

function isInlineMathClipboardTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".inline-math-node, .inline-math-tex-field, math-field.inline-math-field") !== null;
}

function hasActiveDomSelection(): boolean {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString());
}
