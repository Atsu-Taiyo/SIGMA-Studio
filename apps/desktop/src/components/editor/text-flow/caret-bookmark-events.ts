import type { TextFlowSelectionBookmark } from "@/features/text-editing";

export const TEXT_FLOW_SELECTION_BOOKMARK_EVENT = "sigma:text-flow-selection-bookmark";
export const TEXT_FLOW_CHANGE_START_EVENT = "sigma:text-flow-change-start";

export function publishTextFlowSelectionBookmark(
  selection: TextFlowSelectionBookmark,
): void {
  window.dispatchEvent(new CustomEvent(TEXT_FLOW_SELECTION_BOOKMARK_EVENT, {
    detail: selection,
  }));
}

export function beginTextFlowDocumentChange(
  selection: TextFlowSelectionBookmark | null,
): void {
  window.dispatchEvent(new CustomEvent(TEXT_FLOW_CHANGE_START_EVENT, {
    detail: selection,
  }));
}
