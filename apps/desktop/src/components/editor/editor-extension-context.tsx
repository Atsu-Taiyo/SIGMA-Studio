"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { OverlayEditPolicy, OverlayShapeDecoration } from "./overlay-canvas/editor-extension";
import type { TextFlowEditPolicy } from "../tiptap/edit-guard-extension";

/** A finished drawing a host feature hands back to the problem frame dialog. */
export interface ProblemFrameDrawing {
  svg: string;
  width: number;
  height: number;
  /** Corner size the drawing was made for, in SVG units. Omit to let the dialog choose. */
  slice?: number;
  /** The drawing is a new frame, not a redraw of the one being edited. */
  asNew?: boolean;
}

export interface ProblemFrameDrawingPanelProps {
  /** The problem whose frame is being drawn. A feature may keep its work per problem. */
  problemId: string;
  /** The frame's current SVG, or "" when there is none. A feature may redraw it instead of starting over. */
  currentSvg: string;
  onDrawn: (drawing: ProblemFrameDrawing) => void;
}

/**
 * Lets a host feature (AI) draw a problem frame from a written request. The dialog owns the frame
 * and how a drawing becomes one; the feature owns the provider, the request and the model, so the
 * generic editor never imports them.
 */
export interface ProblemFrameDrawingExtension {
  renderPanel: (props: ProblemFrameDrawingPanelProps) => ReactNode;
}

export interface EditorExtensionSet {
  textFlowEditPolicy?: TextFlowEditPolicy;
  overlayEditPolicy?: OverlayEditPolicy;
  overlayShapeDecorations?: ReadonlyMap<string, OverlayShapeDecoration>;
  problemFrameDrawing?: ProblemFrameDrawingExtension;
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
