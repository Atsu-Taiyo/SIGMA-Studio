"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";

import type { EditorStore } from "./store";
import type { EditorState } from "./types";

const EditorStoreContext = createContext<EditorStore | null>(null);

export function EditorStoreProvider({
  store,
  children,
}: {
  store: EditorStore;
  children: ReactNode;
}) {
  return (
    <EditorStoreContext.Provider value={store}>
      {children}
    </EditorStoreContext.Provider>
  );
}

/** ストア本体。`getState()` で同期読み、`setState` 相当のアクション呼び出しに使う。 */
export function useEditorStoreApi(): EditorStore {
  const store = useContext(EditorStoreContext);
  if (!store) {
    throw new Error("EditorStoreProvider の外で useEditorStoreApi が呼ばれました");
  }
  return store;
}

/**
 * 必要な値だけを購読する。selector が同じ値を返す限り再描画されないので、
 * 「親が描画されたから子も描画」を断つ最小単位になる。
 */
export function useEditorStore<T>(selector: (state: EditorState) => T): T {
  return useStore(useEditorStoreApi(), selector);
}
