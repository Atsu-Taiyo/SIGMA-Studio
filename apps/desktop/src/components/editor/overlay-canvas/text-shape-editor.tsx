"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor as TiptapEditor } from "@tiptap/core";

import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { dispatchTextFormatState } from "@/components/tiptap/text-format-controller";
import { DEFAULT_BODY_FONT_FAMILY, type OverlayTextBlock } from "@/features/document";
import { useMathEnvironment } from "@/features/rendering/adapters/react";
import {
  getShapeRotation,
  getTextShapeFontSizePt,
  getTextShapeRenderedLineHeightPx,
  MIN_TEXT_SHAPE_WIDTH,
} from "@/features/drawing";
import {
  overlayTextBlocksToTiptapDoc,
  tiptapDocToOverlayTextBlocks,
} from "@/components/editor/text-flow/overlay-tiptap-adapter";
import type { TiptapDoc, TiptapNode } from "@/lib/tiptap-adapter";

import { createTranslator, getAppLocale } from "@/lib/i18n";
import { OverlayTextBlockAttrs } from "./overlay-text-block-attrs";
import {
  measureOverlayTextContentHeight,
  OVERLAY_TEXT_HEIGHT_ATTRIBUTES,
  overlayTextBoxHeightForContent,
} from "./text-shape-measure";
import { createOverlayTextBlocks } from "./ids";
import type {
  OverlayShape,
  OverlayShapeId,
} from "./types";

/** 空のまま確定したテキスト図形に入る既定文字。**文書に焼き込まれる**ので、
 *  入力した時点の UI 言語で解決する (`chrome.insert.text.label` と同じ語)。 */
const DEFAULT_TEXT_SHAPE_TEXT_KEY = "insert.text.label" as const;
// Mirrors `TEXT_FORMAT_STATE_EVENT` in editor-shell/constants (kept local for the same reason
// `RichTextEditor` does: the overlay canvas must not depend on the shell module).
const TEXT_FORMAT_STATE_EVENT = "sigma-studio:text-format-state";

export function OverlayTextShapeEditor({
  shape,
  externalRevision,
  editing,
  onFocus,
  onCancel,
  onMeasuredHeight,
  onChange,
}: {
  shape: Extract<OverlayShape, { type: "text" | "callout" }>;
  externalRevision: number;
  editing: boolean;
  onFocus: (editor: TiptapEditor, shapeId: OverlayShapeId) => void;
  onCancel: (shapeId: OverlayShapeId) => void;
  onMeasuredHeight: (shapeId: OverlayShapeId, height: number) => void;
  onChange: (shapeId: OverlayShapeId, blocks: OverlayTextBlock[]) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef(shape.props.blocks);
  const previousExternalRevisionRef = useRef(externalRevision);
  const mathEnvironment = useMathEnvironment();
  const editor = useEditor({
    extensions: createRichTextEngineExtensions({
      // Block identity has to survive the round trip, or every keystroke renames every block.
      // The shape's variant keeps the id in the document and out of the DOM — see the extension.
      blockExtensions: [OverlayTextBlockAttrs],
      // The static twin of this editor (`OverlayTextShapeStaticView`) draws per-segment borders,
      // so drawing one rectangle per run here would change the box the moment the shape is
      // focused. See `BoxedTextRunHeightOptions.drawRunFrames`.
      drawBoxedRunFrames: false,
      enableMathDelimiters: true,
      // A shape saves quotes, code blocks and rules now, so the extensions that create them are
      // safe to load here: the gate exists to keep a surface from creating a block its converter
      // would drop on save, and this one's converter carries all three (`overlay-tiptap-adapter`).
      bodyBlocks: true,
      // Lists are saved and drawn now (the static twin renders `ul`/`ol`), so the two options that
      // were held back for "surfaces whose converter would silently drop a list" can be turned on:
      // the marker takes the typography of the item's first run, and `(1) ` starts an ordered list.
      listMarkerTypography: true,
      orderedListMarkerStyles: true,
      // Static overlay text reads the document environment from MathEnvironmentProvider through
      // MathPreview. Give the editing Tiptap surface the same preamble macros and typeset style so
      // focusing a shape cannot silently fall back to the process-wide defaults.
      mathEnvironment,
      textBlockStyle: true,
    }),
    content: overlayTextBlocksToTiptapDoc(shape.props.blocks),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "overlay-text-shape-content",
      },
      handleKeyDown: (_view, event) => {
        if (event.key !== "Escape") {
          return false;
        }

        event.preventDefault();
        onCancel(shape.id);
        return true;
      },
    },
    // 図中テキストも本文と同じツールバーボタンを使うので、B/I/U の点灯状態を
    // 同じイベントで流す。storedMarks だけが変わる折り返しキャレットの切り替えも
    // onTransaction なら拾える。
    onTransaction: ({ editor: activeEditor }) => {
      if (activeEditor.isFocused) {
        dispatchTextFormatState(
        activeEditor,
        TEXT_FORMAT_STATE_EVENT,
        "overlay",
        undefined,
        // 図中テキストは font-family を自分では指定せず本文と同じ既定を継承する
        // (`document-surface.css` の `.overlay-text-shape` に family 指定は無い)。
        { state: activeEditor.state, documentFontFamily: DEFAULT_BODY_FONT_FAMILY },
      );
      }
    },
    onFocus: ({ editor: activeEditor }) => {
      dispatchTextFormatState(
        activeEditor,
        TEXT_FORMAT_STATE_EVENT,
        "overlay",
        undefined,
        // 図中テキストは font-family を自分では指定せず本文と同じ既定を継承する
        // (`document-surface.css` の `.overlay-text-shape` に family 指定は無い)。
        { state: activeEditor.state, documentFontFamily: DEFAULT_BODY_FONT_FAMILY },
      );
      onFocus(activeEditor, shape.id);
    },
    onBlur: ({ editor: activeEditor }) => {
      const json = activeEditor.getJSON() as TiptapDoc;
      if (!isTiptapDocEmpty(json)) {
        return;
      }

      const fallback = createOverlayTextBlocks(createTranslator(getAppLocale(), "chrome")(DEFAULT_TEXT_SHAPE_TEXT_KEY));
      contentRef.current = fallback;
      activeEditor.commands.setContent(overlayTextBlocksToTiptapDoc(fallback), { emitUpdate: false });
      onChange(shape.id, fallback);
    },
    onUpdate: ({ editor: activeEditor }) => {
      dispatchTextFormatState(
        activeEditor,
        TEXT_FORMAT_STATE_EVENT,
        "overlay",
        undefined,
        // 図中テキストは font-family を自分では指定せず本文と同じ既定を継承する
        // (`document-surface.css` の `.overlay-text-shape` に family 指定は無い)。
        { state: activeEditor.state, documentFontFamily: DEFAULT_BODY_FONT_FAMILY },
      );
      const json = activeEditor.getJSON() as TiptapDoc;
      // Hand the previous blocks in so a keystroke keeps each block's identity: the editor JSON
      // carries no ids, and reissuing them every update would re-key everything downstream.
      const blocks = tiptapDocToOverlayTextBlocks(json, contentRef.current);
      contentRef.current = blocks;
      onChange(shape.id, blocks);
    },
  });

  useEffect(() => {
    if (!editor) {
      return;
    }

    const isExternalRestore = previousExternalRevisionRef.current !== externalRevision;
    previousExternalRevisionRef.current = externalRevision;
    if (editor.isFocused && !isExternalRestore) {
      return;
    }

    const serializedCurrent = JSON.stringify(contentRef.current);
    const serializedNext = JSON.stringify(shape.props.blocks);
    if (serializedCurrent !== serializedNext) {
      contentRef.current = shape.props.blocks;
      const nextContent = overlayTextBlocksToTiptapDoc(shape.props.blocks);
      const timeoutId = window.setTimeout(() => {
        if (!editor.isDestroyed && (!editor.isFocused || isExternalRestore)) {
          editor.commands.setContent(nextContent, { emitUpdate: false });
          if (isExternalRestore && editing) {
            editor.commands.focus("end");
          }
        }
      }, 0);

      return () => window.clearTimeout(timeoutId);
    }
  }, [editing, editor, externalRevision, shape.props.blocks]);

  useEffect(() => {
    if (editing && editor && !editor.isFocused) {
      window.setTimeout(() => editor.commands.focus("end"), 0);
    }
  }, [editing, editor]);

  const isCallout = shape.type === "callout";
  const lineHeightPx = getTextShapeRenderedLineHeightPx(shape);
  const rotation = getShapeRotation(shape);

  useLayoutEffect(() => {
    const measure = () => {
      const content = wrapperRef.current?.querySelector<HTMLElement>(".ProseMirror");
      if (!content) {
        return;
      }
      // The same reading the static twin takes (`text-shape-measure.ts`). One implementation is
      // the point: if focusing a shape measured its height differently from drawing it, the box
      // would jump at the moment the editor mounts and again when it unmounts.
      const contentHeight = measureOverlayTextContentHeight(content, { rotated: rotation !== 0 });
      onMeasuredHeight(shape.id, overlayTextBoxHeightForContent(shape, contentHeight));
    };

    measure();
    let frameId: number | null = null;
    const scheduleMeasure = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        measure();
      });
    };
    const content = wrapperRef.current?.querySelector<HTMLElement>(".ProseMirror");
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    const mutationObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(scheduleMeasure);
    if (content) {
      resizeObserver?.observe(content);
      mutationObserver?.observe(content, {
        attributes: true,
        attributeFilter: [...OVERLAY_TEXT_HEIGHT_ATTRIBUTES],
        childList: true,
        subtree: true,
      });
    }
    scheduleMeasure();
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
    // IMPORTANT: `shape.props.h` must stay out of this list. It is what `onMeasuredHeight` writes,
    // and it lands on the wrapper's `minHeight` below — so depending on it would let a written
    // height re-arm the effect that produced it. The measurement itself reads the *content*
    // element, one level inside that wrapper, which is what makes the write unable to grow its own
    // reading; the dependency list must not undo that.
  }, [editing, lineHeightPx, onMeasuredHeight, rotation, shape, shape.props.blocks, shape.props.w]);

  return (
    <div
      ref={wrapperRef}
      className={`overlay-text-shape ${isCallout ? "embedded-callout" : ""}`}
      style={{
        width: isCallout ? "100%" : shape.props.w,
        minWidth: isCallout ? 0 : MIN_TEXT_SHAPE_WIDTH,
        minHeight: isCallout ? lineHeightPx : Math.max(shape.props.h, lineHeightPx),
        color: shape.props.color,
        fontSize: `${getTextShapeFontSizePt(shape)}pt`,
        pointerEvents: editing ? "auto" : "none",
      }}
      onPointerDown={(event) => {
        if (editing) {
          event.stopPropagation();
        }
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
}
function isTiptapDocEmpty(doc: TiptapDoc): boolean {
  return !(doc.content ?? []).some(hasTiptapNodeContent);
}

function hasTiptapNodeContent(node: TiptapNode): boolean {
  if (node.type === "text") {
    return Boolean(node.text?.trim());
  }

  if (node.type !== "doc" && node.type !== "paragraph" && node.type !== "heading") {
    return true;
  }

  return (node.content ?? []).some(hasTiptapNodeContent);
}
