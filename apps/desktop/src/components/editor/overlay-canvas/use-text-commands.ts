"use client";
const INSERT_INLINE_MATH_EVENT = "sigma-studio:insert-inline-math";
const FORMAT_TEXT_EVENT = "sigma-studio:format-text";
import { requestInlineMathEdit } from "@/components/tiptap/inline-math-extension";
import { applyTextFormatCommand } from "@/components/tiptap/text-format-controller";
import {
  appendOverlayTextInline,
  fontSizeToOverlaySize,
  formatOverlayTextBlocks,
  normalizeLineHeight,
  type InlineNode,
  type OverlayTextCommand
} from "@/features/document";
import {
  getOnlySelectedTextShape
} from "@/features/drawing";
import { createId } from "@/lib/id";
import type { Editor as TiptapEditor } from "@tiptap/core";
import type { RefObject } from "react";
import {
  useCallback,
  useEffect
} from "react";
import {
  type OverlayChangeHistory
} from "../page-overlay-types";
import { normalizeBoxedVariant } from "./insertion-preview";
import {
  type OverlayInteractionMode
} from "./interaction-mode";
import type {
  OverlayShape,
  OverlayShapePatch
} from "./types";

export interface Dependencies {
  shapesRef: RefObject<OverlayShape[]>;
  selectedIdsRef: RefObject<string[]>;
  editingShapeId: string | null;
  updateShape: (patch: OverlayShapePatch, options?: { commit?: boolean; history?: OverlayChangeHistory; }) => void;
  activeTextEditorRef: RefObject<TiptapEditor | null>;
  modeRef: RefObject<OverlayInteractionMode>;
}

export function useOverlayTextCommands({ shapesRef, selectedIdsRef, editingShapeId, updateShape, activeTextEditorRef, modeRef }: Dependencies) {

  const insertContentIntoSelectedTextShape = useCallback((content: InlineNode): void => {
    const shape = getOnlySelectedTextShape(shapesRef.current, selectedIdsRef.current, editingShapeId);
    if (!shape) {
      return;
    }

    updateShape({
      id: shape.id,
      type: shape.type,
      props: {
        blocks: appendOverlayTextInline(shape.props.blocks, content, () => createId("p")),
      },
    }, { commit: true });
  }, [editingShapeId, selectedIdsRef, shapesRef, updateShape]);

  const formatSelectedTextShape = useCallback((command: OverlayTextCommand, value?: string): void => {
    const shape = getOnlySelectedTextShape(shapesRef.current, selectedIdsRef.current, editingShapeId);
    if (!shape) {
      return;
    }

    updateShape({
      id: shape.id,
      type: shape.type,
      props: {
        blocks: formatOverlayTextBlocks(shape.props.blocks, command, value),
      },
    }, { commit: true });
  }, [editingShapeId, selectedIdsRef, shapesRef, updateShape]);

  const resizeSelectedTextShapeFont = useCallback((fontSize: number): void => {
    const shape = getOnlySelectedTextShape(shapesRef.current, selectedIdsRef.current, editingShapeId);
    if (!shape || !Number.isFinite(fontSize)) {
      return;
    }

    updateShape({
      id: shape.id,
      type: shape.type,
      props: {
        fontSize,
        size: fontSizeToOverlaySize(fontSize),
        blocks: formatOverlayTextBlocks(shape.props.blocks, "fontSize", String(fontSize)),
      },
    }, { commit: true });
  }, [editingShapeId, selectedIdsRef, shapesRef, updateShape]);

  useEffect(() => {
    const insertInlineMath = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const tex = typeof detail?.tex === "string" ? detail.tex : "";
      const shouldEdit = detail?.edit === true;
      if (detail?.target !== "overlay" || (!tex && !shouldEdit)) {
        return;
      }

      const textEditor = activeTextEditorRef.current;
      if (textEditor?.isFocused) {
        const id = `overlay_math_${Date.now()}`;
        textEditor
          .chain()
          .focus()
          .insertMathInline({
            id,
            tex,
          })
          .run();
        if (shouldEdit) {
          requestInlineMathEdit(id);
        }
        return;
      }

      const id = `overlay_math_${Date.now()}`;
      insertContentIntoSelectedTextShape({
        type: "mathInline",
        id,
        tex,
        display: "inline",
        semanticRole: "expression",
      });
      if (shouldEdit) {
        requestInlineMathEdit(id);
      }
    };

    window.addEventListener(INSERT_INLINE_MATH_EVENT, insertInlineMath);
    return () => window.removeEventListener(INSERT_INLINE_MATH_EVENT, insertInlineMath);
  }, [activeTextEditorRef, insertContentIntoSelectedTextShape]);

  useEffect(() => {
    const formatText = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (detail?.target !== "overlay" || !detail?.command) {
        return;
      }

      const command = detail.command as OverlayTextCommand | "blockStyle" | "fontSize";
      const value = typeof detail.value === "string" ? detail.value : undefined;
      const textEditor = activeTextEditorRef.current;

      const textSession = modeRef.current.id === "overlay.textEditing" || modeRef.current.id === "overlay.tableEditing";
      if (textSession && textEditor && !textEditor.isDestroyed) {
        if (command === "fontSize" && value) {
          textEditor.chain().focus().setFontSize(Number(value)).run();
        } else if (command === "bold") {
          textEditor.chain().focus().toggleBold().run();
        } else if (command === "italic") {
          textEditor.chain().focus().toggleItalic().run();
        } else if (command === "underline") {
          textEditor.chain().focus().toggleUnderline().run();
        } else if (command === "boxed") {
          textEditor.chain().focus().toggleBoxedText().run();
        } else if (command === "boxedPaddingY" && value) {
          const paddingY = Number.parseFloat(value);
          if (Number.isFinite(paddingY) && paddingY >= 0) {
            textEditor.chain().focus().setBoxedTextPaddingY(paddingY).run();
          }
        } else if (command === "boxedVariant" && value) {
          const variant = normalizeBoxedVariant(value);
          if (variant) {
            textEditor.chain().focus().setBoxedTextVariant(variant).run();
          }
        } else if (command === "color" && value) {
          textEditor.chain().focus().setTextColor(value).run();
        } else if (command === "backgroundColor") {
          const chain = textEditor.chain().focus();
          if (value) {
            chain.setTextBackgroundColor(value).run();
          } else {
            chain.unsetTextBackgroundColor().run();
          }
        } else if (command === "fontFamily") {
          const chain = textEditor.chain().focus();
          if (value) {
            chain.setFontFamily(value).run();
          } else {
            chain.unsetFontFamily().run();
          }
        } else if (command === "lineHeight" && value) {
          const lineHeight = normalizeLineHeight(value);
          if (lineHeight) {
            textEditor.chain().focus().updateAttributes("paragraph", { lineHeight }).run();
          }
        } else if (command === "textAlign" && value) {
          textEditor.chain().focus().updateAttributes("paragraph", { textAlign: value }).run();
        } else if (command === "blockStyle" && value) {
          applyTextFormatCommand(textEditor, { command, value }, {
            selection: null,
            blockNodeType: "paragraph",
            allowBlockStyle: true,
          });
        }
      } else if (command !== "fontSize" && command !== "blockStyle") {
        formatSelectedTextShape(command, value);
      }

      if (!textSession && command === "fontSize" && value) {
        resizeSelectedTextShapeFont(Number(value));
      }
    };

    window.addEventListener(FORMAT_TEXT_EVENT, formatText);
    return () => window.removeEventListener(FORMAT_TEXT_EVENT, formatText);
  }, [activeTextEditorRef, formatSelectedTextShape, modeRef, resizeSelectedTextShapeFont]);
}
