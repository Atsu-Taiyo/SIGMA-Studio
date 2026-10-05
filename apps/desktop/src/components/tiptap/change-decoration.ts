/** Host-owned before/applying/after visual states for text-flow blocks. */
export interface TextFlowChangeDecorationState {
  removedIds?: string[];
  removingIds?: string[];
  addedIds?: string[];
  /**
   * Blocks folded out of the flow (`display: none`): the host shows what replaces them elsewhere
   * (a proposal's result in place of its before state). A folded block has no rendered box, so
   * pagination and block measurement skip it; the host also guards it against editing.
   */
  collapsedIds?: string[];
}
