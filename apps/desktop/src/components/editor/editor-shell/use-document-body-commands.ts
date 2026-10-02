"use client";

import type { DocumentChange,DocumentChangeOptions } from "@/components/editor/editor-shell/types";
import { requestCaret } from "@/components/editor/text-flow/caret-router";
import type { TextFlowChangeContext } from "@/components/editor/text-flow/types";
import { insertTopLevelDocumentBlocks,insertTopLevelDocumentBlocksBefore,type RichBlock,type SigmaBlock,type SigmaDocument } from "@/features/document";
import { getLayoutSectionColumns,getLayoutSectionColumnWidths,removeLeadingEmptyPageBreaks,setBlockSpaceAfter,setLayoutSectionColumns,type TextFlowSelectionBookmark } from "@/features/text-editing";
import { moveBlocksByDrag,moveUnitsByStep,type BlockDragMoveRequest } from "@/lib/block-drag-move";
import { createBlock,deleteBlocksFromDocument,ensureBodyBlockAfterProblem,ensureEditableBody,findBlock,findContainingLayoutSection,insertBlockAtSelection,isEmptyTopLevelTextFlowBlock,removeBlockFromDocument,unwrapLayoutSection,updateBlockInDocument,wrapTextFlowBlocksInLayoutSection,type EditableBlock } from "@/lib/document-tree";
import { cloneDocumentBlocksForPaste,createDocumentBlocksClipboardPayload,getLocalEditorClipboardPayload,writeEditorPayloadToSystemClipboard } from "@/lib/editor-clipboard";
import { applyRememberedBoxFrame } from "@/lib/remembered-box-style";
import type { SetStateAction } from "react";
import { useCallback,useEffect,useRef } from "react";
import { scheduleEditorBlockFocus as scheduleFocus,type EditorBlockFocusOptions } from "./editor-focus";

import { DOCUMENT_BLOCK_OPERATION_PORTS } from "./document-operation-ports";
import { tEditor } from "./editor-translations";

import { useEditorOwnerLifetime } from "./use-editor-owner-lifetime";

interface BodyCommandPorts {
  getDocument: () => SigmaDocument;
  selectedId: string | null;
  getSelectedId: () => string | null;
  setSelectedId: (value: SetStateAction<string | null>) => void;
  setSelectedInlineMath: (value: null) => void;
  getSelectionBookmark: () => TextFlowSelectionBookmark | null;
  commitDocumentChange: (change: DocumentChange, options?: DocumentChangeOptions) => void;
  setCanPasteProblem: (value: boolean) => void;
  setStatusMessage: (value: string) => void;
}
export function useDocumentBodyCommands({ getDocument, selectedId, getSelectedId, setSelectedId, setSelectedInlineMath, getSelectionBookmark, commitDocumentChange, setCanPasteProblem, setStatusMessage }: BodyCommandPorts) {
  const captureLifetime = useEditorOwnerLifetime();
  const insertionTimersRef = useRef(new Set<number>());
  useEffect(() => {
    const timers = insertionTimersRef.current;
    return () => { for (const timer of timers) window.clearTimeout(timer); timers.clear(); };
  }, []);
  const scheduleEditorBlockFocus = useCallback((id: string, options: EditorBlockFocusOptions = {}) => {
    const alive = captureLifetime();
    const docId = getDocument().docId;
    scheduleFocus(id, { ...options, isCurrent: () => alive() && getDocument().docId === docId });
  }, [captureLifetime, getDocument]);
  const addBlock = (type: SigmaBlock["type"]) => {
    // 箱は「前に決めた見た目」で入る (設定ダイアログで変えた色や罫がそのまま次にも効く)。
    const block = applyRememberedBoxFrame(createBlock(type, tEditor));
    let insertedBodyBlockId: string | null = null;
    commitDocumentChange((current) => {
      const next = insertBlockAtSelection(current, block, selectedId, { replaceEmpty: block.type === "problem" });
      if (block.type !== "problem") {
        return next;
      }

      const result = ensureBodyBlockAfterProblem(next, block.id);
      insertedBodyBlockId = result.bodyBlock?.id ?? null;
      return result.document;
    });
    setSelectedInlineMath(null);
    const nextSelectedId = insertedBodyBlockId ?? block.id;
    setSelectedId(nextSelectedId);
    if (insertedBodyBlockId) {
      scheduleEditorBlockFocus(insertedBodyBlockId);
      return;
    }
    if (block.type === "heading" || block.type === "paragraph" || block.type === "section") {
      scheduleEditorBlockFocus(block.id);
    }
  };

  // 本文の /problem コマンドから問題を差し込む。memo 済みユニットへ渡るコールバックの
  // 依存に入るので、識別子を安定させる (中身は documentRef / 安定コールバックしか読まない)。
  const insertProblemFromTextFlowCommand = useCallback((triggerBlockId: string): boolean => {
    if (!findBlock(getDocument(), triggerBlockId)) {
      return false;
    }

    const problem = createBlock("problem", tEditor);
    const alive = captureLifetime();
    const docId = getDocument().docId;
    const timer = window.setTimeout(() => {
      insertionTimersRef.current.delete(timer);
      if (!alive() || getDocument().docId !== docId) return;
      let insertedBodyBlockId: string | null = null;
      commitDocumentChange((current) => {
        if (!findBlock(current, triggerBlockId)) {
          return current;
        }
        const next = insertBlockAtSelection(current, problem, triggerBlockId, { replaceEmpty: true });
        const result = ensureBodyBlockAfterProblem(next, problem.id);
        insertedBodyBlockId = result.bodyBlock?.id ?? null;
        return result.document;
      });
      setSelectedInlineMath(null);
      const nextSelectedId = insertedBodyBlockId ?? problem.id;
      setSelectedId(nextSelectedId);
      if (insertedBodyBlockId) {
        scheduleEditorBlockFocus(insertedBodyBlockId);
      }
      setStatusMessage(tEditor("status.problemInserted"));
    }, 0);
    insertionTimersRef.current.add(timer);
    return true;
  }, [captureLifetime, commitDocumentChange, getDocument, scheduleEditorBlockFocus, setSelectedId, setSelectedInlineMath, setStatusMessage]);

  const wrapBlockInColumns = (blockIds: string[], columnCount: number) => {
    const focusBlockId = blockIds[0] ?? null;
    if (!focusBlockId) {
      return;
    }
    commitDocumentChange((current) => wrapTextFlowBlocksInLayoutSection(current, blockIds, columnCount));
    setSelectedInlineMath(null);
    setSelectedId(focusBlockId);
    scheduleEditorBlockFocus(focusBlockId);
  };

  const unwrapColumns = (sectionId: string) => {
    const section = findContainingLayoutSection(getDocument(), sectionId);
    const focusBlockId = section?.children[0]?.id ?? getSelectedId();
    commitDocumentChange((current) => unwrapLayoutSection(current, sectionId));
    setSelectedInlineMath(null);
    setSelectedId(focusBlockId);
    if (focusBlockId) {
      scheduleEditorBlockFocus(focusBlockId);
    }
  };

  const resizeLayoutColumns = (sectionId: string, dividerIndex: number, leftWidth: number, rightWidth: number) => {
    commitDocumentChange((current) => {
      let shouldUnwrap = false;
      const updated = updateBlockInDocument(current, sectionId, (block) => {
        if (block.type !== "layoutSection") return block;
        const columns = getLayoutSectionColumns(block);
        const widths = getLayoutSectionColumnWidths(block, columns.length);
        if (!columns[dividerIndex] || !columns[dividerIndex + 1]) return block;
        if (leftWidth <= 0 || rightWidth <= 0) {
          const merged = [...columns[dividerIndex], ...columns[dividerIndex + 1]];
          const nextColumns = [...columns.slice(0, dividerIndex), merged, ...columns.slice(dividerIndex + 2)];
          const nextWidths = [...widths.slice(0, dividerIndex), widths[dividerIndex] + widths[dividerIndex + 1], ...widths.slice(dividerIndex + 2)];
          shouldUnwrap = nextColumns.length === 1;
          return setLayoutSectionColumns(block, nextColumns, nextWidths);
        }
        const pairTotal = widths[dividerIndex] + widths[dividerIndex + 1];
        const pixelTotal = leftWidth + rightWidth;
        const nextWidths = [...widths];
        nextWidths[dividerIndex] = Math.round(pairTotal * leftWidth / pixelTotal);
        nextWidths[dividerIndex + 1] = pairTotal - nextWidths[dividerIndex];
        return setLayoutSectionColumns(block, columns, nextWidths);
      });
      return shouldUnwrap ? unwrapLayoutSection(updated, sectionId) : updated;
    });
  };

  const updateBlock = useCallback((
    blockId: string,
    updater: (block: SigmaBlock | RichBlock) => SigmaBlock | RichBlock,
    context?: TextFlowChangeContext,
  ) => {
    commitDocumentChange(
      (current) => updateBlockInDocument(
        current,
        blockId,
        (block: EditableBlock) => block.type === "listItem" ? block : updater(block),
      ),
      context?.historyGroup ? { historyGroup: context.historyGroup } : undefined,
    );
  }, [commitDocumentChange]);

  const updateBlockSpaceAfter = useCallback((blockId: string, spaceAfterPx: number) => {
    commitDocumentChange((current) => updateBlockInDocument(
      current,
      blockId,
      (block) => setBlockSpaceAfter(block, spaceAfterPx),
    ));
  }, [commitDocumentChange]);

  /**
   * 本文を空にした削除は、補われた空段落へキャレットを連れて行く。空段落があっても焦点が
   * 無ければ「消したら打っても何も出ない」ままなので、削除の続きにそのまま書ける Word と
   * 同じ手触りにする。書き込みが AI ロックで弾かれたときは補いも起きないので、実際に文書へ
   * 入ったことを確かめてから焦点を移す。
   */
  const focusBodyFallback = (fallbackBlockId: string | null) => {
    if (!fallbackBlockId || !findBlock(getDocument(), fallbackBlockId)) {
      return;
    }
    setSelectedId(fallbackBlockId);
    scheduleEditorBlockFocus(fallbackBlockId);
  };

  const removeBlock = (blockId: string) => {
    let fallbackBlockId: string | null = null;
    commitDocumentChange((current) => {
      const ensured = ensureEditableBody(removeBlockFromDocument(current, blockId));
      fallbackBlockId = ensured.bodyBlock?.id ?? null;
      return { ...ensured.document, content: removeLeadingEmptyPageBreaks(ensured.document.content) };
    });
    setSelectedId((current) => (current === blockId ? null : current));
    focusBodyFallback(fallbackBlockId);
  };

  /**
   * Deletes body blocks outright, without first emptying their text. Anything the user can
   * point at is fair game — top-level blocks, blocks inside a column section or a box, and
   * the blocks of a problem area — so the caller does not have to know where a block lives.
   */
  const removeBlocks = (blockIds: string[]) => {
    const removableIds = blockIds.filter((id) => !!findBlock(getDocument(), id));
    if (removableIds.length === 0) {
      return;
    }

    let fallbackBlockId: string | null = null;
    commitDocumentChange((current) => {
      // リストの項目はブロック単位の一括削除が受け付けない (項目はリストの一部)。1 つずつ落とす —
      // 項目が全部消えたリストは `removeBlockFromDocument` が一緒に落とす。
      const itemIds = removableIds.filter((id) => findBlock(current, id)?.type === "listItem");
      const blockOnlyIds = removableIds.filter((id) => !itemIds.includes(id));
      let next = blockOnlyIds.length > 0 ? deleteBlocksFromDocument(current, blockOnlyIds) : current;
      for (const itemId of itemIds) {
        if (findBlock(next, itemId)) {
          next = removeBlockFromDocument(next, itemId);
        }
      }
      const ensured = ensureEditableBody(next);
      fallbackBlockId = ensured.bodyBlock?.id ?? null;
      return { ...ensured.document, content: removeLeadingEmptyPageBreaks(ensured.document.content) };
    });
    setSelectedInlineMath(null);
    setSelectedId((current) => (current && removableIds.includes(current) ? null : current));
    focusBodyFallback(fallbackBlockId);
    setStatusMessage(removableIds.length > 1 ? tEditor("status.bodyDeleted") : tEditor("status.blockDeleted"));
  };

  /**
   * グリップのドラッグで落とした結果を 1 手で書く。動かした先頭のブロックへ焦点を移す
   * (段組化・リストの分割でも、掴んだブロックの id は変わらない)。
   */
  const moveBlocksByDragRequest = (request: BlockDragMoveRequest) => {
    const before = getDocument();
    commitDocumentChange((current) => moveBlocksByDrag(current, request));
    if (getDocument() === before) {
      return;
    }
    const focusBlockId = request.unitIds[0] ?? null;
    setSelectedInlineMath(null);
    if (focusBlockId && findBlock(getDocument(), focusBlockId)) {
      setSelectedId(focusBlockId);
      scheduleEditorBlockFocus(focusBlockId);
    }
    setStatusMessage(tEditor("status.blockMoved"));
  };

  /** ⌥⇧↑/↓。キャレットは同じブロック・同じ位置に留める (ブロックごと動くので id は同じ)。 */
  const moveBlocksByStepRequest = (unitIds: string[], direction: "up" | "down") => {
    const before = getDocument();
    const caret = getSelectionBookmark();
    commitDocumentChange((current) => moveUnitsByStep(current, unitIds, direction));
    if (getDocument() === before) {
      return;
    }
    setSelectedInlineMath(null);
    if (caret && unitIds.includes(caret.anchor.blockId)) {
      requestCaret(caret);
      return;
    }
    const focusBlockId = unitIds[0] ?? null;
    if (focusBlockId && findBlock(getDocument(), focusBlockId)) {
      const hasFocus = window.document.activeElement instanceof HTMLElement
        && window.document.activeElement.isContentEditable;
      if (hasFocus) {
        setSelectedId(focusBlockId);
        scheduleEditorBlockFocus(focusBlockId);
      }
    }
  };

  /** Adds an empty paragraph next to `anchorBlockId`, or at the end when it is null. */
  const insertBodyBlockAt = (anchorBlockId: string | null, position: "before" | "after") => {
    // Clicking the blank strip under the text repeatedly must not stack empty paragraphs:
    // if the document already ends in one, that is the spot the user is asking for.
    if (anchorBlockId === null && position === "after") {
      const lastBlock = getDocument().content.at(-1);
      if (lastBlock && isEmptyTopLevelTextFlowBlock(lastBlock)) {
        setSelectedId(lastBlock.id);
        scheduleEditorBlockFocus(lastBlock.id);
        return;
      }
    }

    const block = createBlock("paragraph", tEditor);
    commitDocumentChange((current) => (
      position === "before"
        ? insertTopLevelDocumentBlocksBefore(current, anchorBlockId, [block], DOCUMENT_BLOCK_OPERATION_PORTS)
        : insertTopLevelDocumentBlocks(current, anchorBlockId, [block], DOCUMENT_BLOCK_OPERATION_PORTS)
    ));
    setSelectedInlineMath(null);
    setSelectedId(block.id);
    scheduleEditorBlockFocus(block.id);
  };

  const copyBlockToClipboard = (blockId: string) => {
    const block = findBlock(getDocument(), blockId);
    if (!block || block.type === "listItem") {
      return;
    }

    const alive = captureLifetime();
    void writeEditorPayloadToSystemClipboard(createDocumentBlocksClipboardPayload([block])).then((copied) => {
      if (!alive()) return;
      setCanPasteProblem(copied && block.type === "problem");
      setStatusMessage(copied
        ? block.type === "problem"
          ? tEditor("status.problemCopied")
          : block.type === "boxBlock" ? tEditor("status.boxCopied") : tEditor("status.blockCopied")
        : tEditor("status.copyFailed"));
    });
  };

  const pasteBlockFromClipboard = useCallback((blockId: string, position: "before" | "after") => {
    const payload = getLocalEditorClipboardPayload();
    if (payload?.kind !== "documentBlocks") {
      setStatusMessage(tEditor("status.nothingToPaste"));
      return;
    }

    const pastedBlocks = cloneDocumentBlocksForPaste(payload.blocks);
    if (pastedBlocks.length === 0) {
      setStatusMessage(tEditor("status.nothingToPaste"));
      return;
    }

    commitDocumentChange((current) => (
      position === "before"
        ? insertTopLevelDocumentBlocksBefore(
            current,
            blockId,
            pastedBlocks,
            DOCUMENT_BLOCK_OPERATION_PORTS,
          )
        : insertTopLevelDocumentBlocks(
            current,
            blockId,
            pastedBlocks,
            DOCUMENT_BLOCK_OPERATION_PORTS,
          )
    ));
    const nextSelectedId = pastedBlocks[pastedBlocks.length - 1]?.id ?? null;
    setSelectedId(nextSelectedId);
    setSelectedInlineMath(null);
    setStatusMessage(pastedBlocks.length === 1 && pastedBlocks[0]?.type === "problem"
      ? tEditor("status.problemPasted")
      : tEditor("status.blockPasted"));
  }, [commitDocumentChange, setSelectedId, setSelectedInlineMath, setStatusMessage]);

  return { addBlock, insertProblemFromTextFlowCommand, wrapBlockInColumns, unwrapColumns, resizeLayoutColumns, updateBlock, updateBlockSpaceAfter, removeBlock, removeBlocks, moveBlocksByDragRequest, moveBlocksByStepRequest, insertBodyBlockAt, copyBlockToClipboard, pasteBlockFromClipboard };
}
