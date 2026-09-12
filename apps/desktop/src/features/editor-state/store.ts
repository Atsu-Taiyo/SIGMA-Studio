import { createStore, type StoreApi } from "zustand/vanilla";

import { createCommentSlice } from "./slices/comment";
import { createSaveSlice } from "./slices/save";
import { createSelectionSlice } from "./slices/selection";
import { createToolbarSlice } from "./slices/toolbar";
import type { EditorState, EditorStateInitializer } from "./types";

export type EditorStore = StoreApi<EditorState>;

/**
 * 1 つのエディタ画面が持つ状態。
 *
 * **モジュール singleton にしない** — 複数の文書 (タブ) を同時に開けるので、ストアの寿命は
 * それを描くコンポーネントの寿命と一致させる。React の外から `store.getState()` で同期的に
 * 読めるのが `useState` との違いで、保存や CAS のように「今この瞬間の値」が要る経路が
 * ref の二重管理なしに書ける。
 */
export function createEditorStore(initializer: EditorStateInitializer): EditorStore {
  return createStore<EditorState>()((...args) => ({
    ...createSelectionSlice(initializer)(...args),
    ...createCommentSlice()(...args),
    ...createSaveSlice(initializer)(...args),
    ...createToolbarSlice(initializer)(...args),
  }));
}
