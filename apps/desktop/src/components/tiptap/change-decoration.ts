/** Host-owned before/applying/after visual states for text-flow blocks. */
export interface TextFlowChangeDecorationState {
  removedIds?: string[];
  removingIds?: string[];
  addedIds?: string[];
}
