"use client";
import { createContext, useContext } from "react";

/** Global keyboard/clipboard events belong to the focused document, even with several mounted editors. */
export const EditorInputContext = createContext<() => boolean>(() => true);
export function useOwnsEditorInput() { return useContext(EditorInputContext); }
