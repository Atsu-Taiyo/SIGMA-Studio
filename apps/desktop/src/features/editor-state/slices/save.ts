import type { StateCreator } from "zustand";

import { resolveEditorStateUpdate } from "../resolve-update";

import type { EditorSaveSlice, EditorState, EditorStateInitializer } from "../types";

export function createSaveSlice(
  initializer: EditorStateInitializer,
): StateCreator<EditorState, [], [], EditorSaveSlice> {
  return (set, get) => ({
    saveState: "idle",
    statusMessage: initializer.statusMessage ?? "",
    setSaveState: (update) => {
      const saveState = resolveEditorStateUpdate(update, get().saveState);
      if (get().saveState === saveState) {
        return;
      }
      set({ saveState });
    },
    setStatusMessage: (update) => {
      const statusMessage = resolveEditorStateUpdate(update, get().statusMessage);
      if (get().statusMessage === statusMessage) {
        return;
      }
      set({ statusMessage });
    },
  });
}
