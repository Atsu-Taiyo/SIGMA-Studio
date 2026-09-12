import type { StateCreator } from "zustand";

import { resolveEditorStateUpdate } from "../resolve-update";

import type { EditorSelectionSlice, EditorState, EditorStateInitializer } from "../types";

export function createSelectionSlice(
  initializer: EditorStateInitializer,
): StateCreator<EditorState, [], [], EditorSelectionSlice> {
  return (set, get) => ({
    selectedId: initializer.selectedId ?? null,
    selectedInlineMath: null,
    setSelectedId: (update) => {
      const selectedId = resolveEditorStateUpdate(update, get().selectedId);
      if (get().selectedId === selectedId) {
        return;
      }
      set({ selectedId });
    },
    setSelectedInlineMath: (update) => {
      const selectedInlineMath = resolveEditorStateUpdate(update, get().selectedInlineMath);
      if (get().selectedInlineMath === selectedInlineMath) {
        return;
      }
      set({ selectedInlineMath });
    },
  });
}
