import type { TextFormatStateContext } from "@/components/tiptap/text-format-controller";
import { getOverlayTextFormatState, type OverlayTextBlock, type OverlayTextFormatState } from "@/features/document";
import type { OverlaySelectionSummary } from "../page-overlay-types";

export type TextToolbarLockReason = "aiLocked" | "readOnly" | "sessionOpening" | "previewBusy";
export type TextToolbarDisabledReason = TextToolbarLockReason | "tableCellRequired" | "textShapeRequired" | "noTextSelection" | "unsupportedBlock";

/** The same reason gates the controls and explains why they are disabled. */
export function resolveTextToolbarLockReason(context: {
  writable: boolean; awaitingSession: boolean; previewBusy: boolean; aiLocked: boolean;
}): TextToolbarLockReason | null {
  if (!context.writable) return context.awaitingSession ? "sessionOpening" : "readOnly";
  if (context.previewBusy) return "previewBusy";
  return context.aiLocked ? "aiLocked" : null;
}

interface TextToolbarContext {
  selectedBlock: { id: string; type: string } | null;
  documentTextTarget: TextFormatStateContext | null;
  hasTextRunSpan: boolean;
  runningRegionEditing: boolean;
  overlayEditing: boolean;
  overlaySelection: Pick<OverlaySelectionSummary, "selectedShapes" | "textEditing">;
  bodyLockReason: TextToolbarLockReason | null;
  overlayLockReason: TextToolbarLockReason | null;
}

/**
 * 文字を持つ図形の選択と、図形内の文字編集中を区別する。
 * 表セルは表全体の選択だけでは書式対象にならない。ツールバーへフォーカスが移っても、
 * 編集セッションが続く間は同じ文字を対象にする。可否とイベントの宛先を別々に決めない。
 */
export function resolveTextToolbarTarget(context: TextToolbarContext) {
  const { selectedBlock, documentTextTarget, overlaySelection } = context;
  const isBoxTitle = selectedBlock?.type === "boxBlock"
    && documentTextTarget?.enabled === true
    && documentTextTarget.nodeType === "boxBlockTitle"
    && documentTextTarget.blockId === selectedBlock.id;
  const isCodeBlock = selectedBlock?.type === "codeBlock";
  const canFormatSelectedText = isBoxTitle || isCodeBlock || context.hasTextRunSpan
    || ["section", "paragraph", "heading", "listItem"].includes(selectedBlock?.type ?? "");
  const documentReason: TextToolbarDisabledReason | null = context.bodyLockReason
    ?? (canFormatSelectedText || context.runningRegionEditing ? null
      : selectedBlock ? "unsupportedBlock" : "noTextSelection");
  const documentEnabled = !context.overlayEditing && documentReason === null;
  const editing = overlaySelection.textEditing;
  const selectedShape = overlaySelection.selectedShapes.length === 1
    ? overlaySelection.selectedShapes[0] : null;
  const editingShape = editing
    ? overlaySelection.selectedShapes.find(shape => shape.id === editing.shapeId) : null;
  const isTableCell = editing?.kind === "table" && editingShape?.type === "tableShape";
  const isShapeText = editing?.kind === "text"
    && (editingShape?.type === "text" || editingShape?.type === "callout");
  const isWholeTextShape = !editing && (selectedShape?.type === "text" || selectedShape?.type === "callout");
  const overlayDisabledReason: TextToolbarDisabledReason | null = context.overlayLockReason
    ?? (isTableCell || isShapeText || isWholeTextShape ? null : overlaySelection.selectedShapes.some(shape => shape.type === "tableShape")
      ? "tableCellRequired" : "textShapeRequired");
  const overlayEnabled = context.overlayEditing && overlayDisabledReason === null;
  return {
    disabledReason: context.overlayEditing ? overlayDisabledReason : documentReason,
    target: context.overlayEditing ? "overlay" as const : "document" as const,
    isBoxTitle,
    isCodeBlock,
    canFormatSelectedText,
    documentEnabled,
    overlayEnabled,
    enabled: documentEnabled || overlayEnabled,
    canUseLineHeight: (overlayEnabled && !isTableCell) || (documentEnabled && !isBoxTitle && !isCodeBlock),
    canUseTextBlockStyle: documentEnabled && !isBoxTitle,
    canUseOverlayBlockStructure: overlayEnabled && !isTableCell,
    canUseTextAlign: overlayEnabled || (documentEnabled && !isBoxTitle && !isCodeBlock),
    wholeTextShape: overlayEnabled && isWholeTextShape ? selectedShape : null,
  };
}

/** The on/off marks and box style the text buttons show. */
export type TextToolbarMarkState = OverlayTextFormatState;

/**
 * Where the text buttons read their state from.
 *
 * A text session (body, shape text, table cell) reports its caret's marks by event. A shape
 * selected as a whole has no session and reports nothing, so its state comes from the shape's
 * own runs — the same runs `formatOverlayTextBlocks` changes when a button is pressed, under the
 * same "every run that can carry it" rule. Reading the last reported value there instead made the
 * box button, which picks "add" or "remove" from what it shows, add forever (issue #210).
 */
export function resolveTextToolbarMarkState(
  wholeTextShape: { props: { blocks: readonly OverlayTextBlock[] } } | null,
  reported: TextToolbarMarkState,
): TextToolbarMarkState {
  return wholeTextShape ? getOverlayTextFormatState(wholeTextShape.props.blocks) : reported;
}
