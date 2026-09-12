"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { OverlayEditPolicy, OverlayShapeDecoration } from "./overlay-canvas/editor-extension";
import type { TextFlowEditPolicy } from "../tiptap/edit-guard-extension";

export interface EditorExtensionSet {
  textFlowEditPolicy?: TextFlowEditPolicy;
  overlayEditPolicy?: OverlayEditPolicy;
  overlayShapeDecorations?: ReadonlyMap<string, OverlayShapeDecoration>;
}

export interface EditorExtensionContextValue extends EditorExtensionSet {
  /** Policies for nested/auxiliary editing surfaces that are not part of the main body revision boundary. */
  auxiliarySurfaceExtensions?: EditorExtensionSet;
}

const EditorExtensionContext = createContext<EditorExtensionContextValue>({});

export function EditorExtensionProvider({
  value,
  children,
}: {
  value?: EditorExtensionContextValue;
  children: ReactNode;
}) {
  return (
    <EditorExtensionContext.Provider value={value ?? {}}>
      {children}
    </EditorExtensionContext.Provider>
  );
}

export function useEditorExtensions(): EditorExtensionContextValue {
  return useContext(EditorExtensionContext);
}
