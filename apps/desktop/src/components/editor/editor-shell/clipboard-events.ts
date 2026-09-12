import type { SigmaBlock } from "@/features/document";
import {
  cloneDocumentBlocksForPaste,
  cloneTextFlowBlocksForPaste,
  createDocumentBlocksClipboardPayload,
  createInlineMathClipboardPayload,
  createTextFlowClipboardPayload,
  getLocalEditorClipboardPayload,
  isTextFlowClipboardBlock,
  readEditorClipboardPayload,
  toOverlayShapesClipboardPayload,
  writeEditorClipboardData,
  type ClipboardTextFlowBlock,
  type EditorClipboardPayload,
} from "@/lib/editor-clipboard";
import type { Translate } from "@/lib/i18n";

import { isMultiEditorTextRunSpan, replaceActiveTextRunSpan } from "../text-flow/text-run-span";
import { INSERT_INLINE_MATH_EVENT } from "./constants";

type BlockPaste =
  | { kind: "documentBlocks"; blocks: SigmaBlock[] }
  | { kind: "textFlowBlocks"; blocks: ClipboardTextFlowBlock[] };

interface EditorClipboardPorts {
  overlayEditing: boolean;
  selectedInlineMath: { tex: string } | null;
  getSelectedBlock: () => SigmaBlock | null;
  isMaterialEditing: () => boolean;
  insertBlocks: (paste: BlockPaste) => void;
  pasteShapes: (payload: Extract<EditorClipboardPayload, { kind: "overlayShapes" }>) => void;
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

  const handleCopy = (event: ClipboardEvent) => {
    if (
      !overlayEditing && selectedInlineMath && event.clipboardData
      && isInlineMathClipboardTarget(event.target) && !isNativeClipboardTarget(event.target)
    ) {
      event.preventDefault();
      writeEditorClipboardData(event.clipboardData, createInlineMathClipboardPayload(selectedInlineMath.tex));
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

  const handlePaste = (event: ClipboardEvent) => {
    if (overlayEditing || !event.clipboardData) {
      return;
    }

    const eventPayload = readEditorClipboardPayload(event.clipboardData);
    const payload = eventPayload ?? getLocalEditorClipboardPayload();
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
      ports.pasteShapes(eventPayload);
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
      ports.pasteShapes(toOverlayShapesClipboardPayload(eventPayload));
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
  window.addEventListener("paste", handlePaste, true);
  return () => {
    window.removeEventListener("copy", handleCopy);
    window.removeEventListener("paste", handlePaste, true);
  };
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
