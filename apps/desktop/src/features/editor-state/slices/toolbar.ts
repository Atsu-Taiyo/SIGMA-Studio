import type { StateCreator } from "zustand";

import { resolveEditorStateUpdate } from "../resolve-update";

import type {
  EditorState,
  EditorStateInitializer,
  EditorToolbarSlice,
  EditorWhiteboardPan,
} from "../types";

function samePan(left: EditorWhiteboardPan, right: EditorWhiteboardPan): boolean {
  return left.panX === right.panX && left.panY === right.panY;
}

export function createToolbarSlice(
  initializer: EditorStateInitializer,
): StateCreator<EditorState, [], [], EditorToolbarSlice> {
  return (set, get) => ({
    zoom: initializer.zoom ?? 100,
    whiteboardPan: { panX: 0, panY: 0 },
    outlineOpen: initializer.outlineOpen ?? true,
    outlineWidth: initializer.outlineWidth ?? 0,
    setZoom: (update) => {
      const zoom = resolveEditorStateUpdate(update, get().zoom);
      if (get().zoom === zoom) {
        return;
      }
      set({ zoom });
    },
    setWhiteboardPan: (update) => {
      const current = get().whiteboardPan;
      const whiteboardPan = resolveEditorStateUpdate(update, current);
      if (samePan(current, whiteboardPan)) {
        return;
      }
      set({ whiteboardPan });
    },
    setWhiteboardCamera: (zoom, whiteboardPan) => {
      const current = get();
      if (current.zoom === zoom && samePan(current.whiteboardPan, whiteboardPan)) {
        return;
      }
      set({ zoom, whiteboardPan });
    },
    setOutlineOpen: (update) => {
      const outlineOpen = resolveEditorStateUpdate(update, get().outlineOpen);
      if (get().outlineOpen === outlineOpen) {
        return;
      }
      set({ outlineOpen });
    },
    setOutlineWidth: (update) => {
      const outlineWidth = resolveEditorStateUpdate(update, get().outlineWidth);
      if (get().outlineWidth === outlineWidth) {
        return;
      }
      set({ outlineWidth });
    },
  });
}
