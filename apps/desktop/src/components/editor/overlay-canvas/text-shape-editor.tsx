"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor as TiptapEditor } from "@tiptap/core";

import { usePreferredFontSeed } from "../text-flow/preferred-font-context";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { dispatchTextFormatState } from "@/components/tiptap/text-format-controller";
import { DEFAULT_BODY_FONT_FAMILY, type OverlayTextBlock } from "@/features/document";
import { useMathEnvironment } from "@/features/rendering/adapters/react";
import { overlayTextScale } from "@/features/rendering/core";
import {
  getShapeRotation,
  getTextShapeFontSizePt,
  getTextShapeRenderedLineHeightPx,
  MIN_TEXT_SHAPE_WIDTH,
} from "@/features/drawing";
import {
  copyEditorSelection,
  isLiteralPasteShortcut,
  pasteIntoEditorSurface,
  TextFlowClipboardSession,
} from "@/components/editor/text-flow/clipboard-transactions";
import {
  overlayTextBlocksToTiptapDoc,
  tiptapDocToOverlayTextBlocks,
} from "@/components/editor/text-flow/overlay-tiptap-adapter";
import type { TiptapDoc } from "@/lib/tiptap-adapter";

import { OverlayTextBlockAttrs } from "./overlay-text-block-attrs";
import { OverlayTextShapeSpaceHandle } from "./text-shape-space-after-handle";
import {
  measureOverlayTextContentHeight,
  OVERLAY_TEXT_HEIGHT_ATTRIBUTES,
  overlayTextBoxHeightForContent,
} from "./text-shape-measure";
import type {
  OverlayShape,
  OverlayShapeId,
} from "./types";

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
  /**
   * 測った箱の高さ。`preview` は文書へ保存しない仮の値 (段落の下余白をドラッグしている間: 箱は
   * 追従させるが、確定の 1 手に混ぜるため履歴にも保存にも積まない)。
   */
  onMeasuredHeight: (shapeId: OverlayShapeId, height: number, options?: { preview?: boolean }) => void;
  onChange: (shapeId: OverlayShapeId, blocks: OverlayTextBlock[]) => void;
}) {
  const { preferredFont, seedPreferredFont } = usePreferredFontSeed();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef(shape.props.blocks);
  const previousExternalRevisionRef = useRef(externalRevision);
  const mathEnvironment = useMathEnvironment();
  // 段落の下余白つまみを掴んでいる間は true。箱の高さの測り直しを「仮の値」として流す。
  const spaceAfterDraggingRef = useRef(false);
  // コピー・貼り付けは本文と同じ関数を通す。図中テキストだけの特別な経路は持たない。
  const [clipboardSession] = useState(() => new TextFlowClipboardSession());
  const editor = useEditor({
    extensions: createRichTextEngineExtensions({
      // Block identity has to survive the round trip, or every keystroke renames every block.
      // The shape's variant keeps the id in the document and out of the DOM — see the extension.
      blockExtensions: [OverlayTextBlockAttrs],
      // Both static and editing overlays measure the entire connected text/math run.
      drawBoxedRunFrames: shape.type === "text" && getShapeRotation(shape) === 0,
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
        if (isLiteralPasteShortcut(event)) {
          clipboardSession.requestLiteralPaste();
        }
        if (event.key !== "Escape") {
          return false;
        }

        event.preventDefault();
        onCancel(shape.id);
        return true;
      },
      handleDOMEvents: {
        copy: (view, event) => copyEditorSelection(view, event, contentRef.current),
      },
      handlePaste: (view, event, slice) => pasteIntoEditorSurface(clipboardSession, view, event, slice),
    },
    // 図中テキストも本文と同じツールバーボタンを使うので、B/I/U の点灯状態を
    // 同じイベントで流す。storedMarks だけが変わる折り返しキャレットの切り替えも
    // onTransaction なら拾える。
    onTransaction: ({ editor: activeEditor }) => {
      if (activeEditor.isFocused) {
        seedPreferredFont(activeEditor);
        dispatchTextFormatState(
        activeEditor,
        TEXT_FORMAT_STATE_EVENT,
        "overlay",
        undefined,
        // 図中テキストは font-family を自分では指定せず本文と同じ既定を継承する
        // (`document-surface.css` の `.overlay-text-shape` に family 指定は無い)。
        { state: activeEditor.state, view: activeEditor.view, documentFontFamily: DEFAULT_BODY_FONT_FAMILY },
      );
      }
    },
    onFocus: ({ editor: activeEditor }) => {
      seedPreferredFont(activeEditor);
      dispatchTextFormatState(
        activeEditor,
        TEXT_FORMAT_STATE_EVENT,
        "overlay",
        undefined,
        // 図中テキストは font-family を自分では指定せず本文と同じ既定を継承する
        // (`document-surface.css` の `.overlay-text-shape` に family 指定は無い)。
        { state: activeEditor.state, view: activeEditor.view, documentFontFamily: DEFAULT_BODY_FONT_FAMILY },
      );
      onFocus(activeEditor, shape.id);
    },
    // 空の blocks も正規の内容。切り取り後や再読込後の blur では初期文字を補わない。
    onUpdate: ({ editor: activeEditor }) => {
      dispatchTextFormatState(
        activeEditor,
        TEXT_FORMAT_STATE_EVENT,
        "overlay",
        undefined,
        // 図中テキストは font-family を自分では指定せず本文と同じ既定を継承する
        // (`document-surface.css` の `.overlay-text-shape` に family 指定は無い)。
        { state: activeEditor.state, view: activeEditor.view, documentFontFamily: DEFAULT_BODY_FONT_FAMILY },
      );
      commitEditorBlocks(activeEditor);
    },
  });

  /**
   * 編集面の内容を図形の blocks へ確定する。打鍵と、段落の下余白つまみの確定の両方がここを通る。
   *
   * Hand the previous blocks in so a keystroke keeps each block's identity: the editor JSON
   * carries no ids, and reissuing them every update would re-key everything downstream.
   */
  function commitEditorBlocks(activeEditor: TiptapEditor) {
    const json = activeEditor.getJSON() as TiptapDoc;
    const blocks = tiptapDocToOverlayTextBlocks(json, contentRef.current);
    contentRef.current = blocks;
    onChange(shape.id, blocks);
  }

  useEffect(() => {
    if (editor?.isFocused) seedPreferredFont(editor);
  }, [editor, preferredFont, seedPreferredFont]);

  useLayoutEffect(() => {
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
      // Apply before paint. Updating contentRef before a deferred timer let a rerender
      // cancel the DOM restore while marking that content as already synchronized.
      if (!editor.isDestroyed) {
        editor.commands.setContent(nextContent, { emitUpdate: false });
        if (isExternalRestore && editing) editor.commands.focus("end");
      }
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
  // 図形を選んだだけでは出さない (編集中のみ)。裏返した図形は縦軸の向きが逆になるので出さない。
  const showsSpaceHandle = editing && !shape.flipX && !shape.flipY;
  const measuredShapeRef = useRef(shape);
  useLayoutEffect(() => {
    measuredShapeRef.current = shape;
  }, [shape]);

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
      const currentShape = measuredShapeRef.current;
      const boxHeight = overlayTextBoxHeightForContent(currentShape, contentHeight);
      if (spaceAfterDraggingRef.current) {
        onMeasuredHeight(currentShape.id, boxHeight, { preview: true });
      } else {
        onMeasuredHeight(currentShape.id, boxHeight);
      }
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
  }, [editing, editor, lineHeightPx, onMeasuredHeight, rotation, shape.id, shape.type, shape.props.blocks, shape.props.w]);

  return (
    <div
      ref={wrapperRef}
      className={`overlay-text-shape ${isCallout ? "embedded-callout" : ""} ${shape.type === "text" && shape.props.textWrap === "none" ? "no-auto-wrap" : ""}`}
      style={{
        // 下余白つまみ (`OverlayTextShapeSpaceHandle`) を箱の座標系で置く。編集中だけ位置指定にする。
        ...(showsSpaceHandle ? { position: "relative" as const } : {}),
        width: isCallout ? "100%" : shape.props.w,
        ...(shape.type === "text" ? overlayTextScale(shape) : {}),
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
      {showsSpaceHandle && editor ? (
        <OverlayTextShapeSpaceHandle
          editor={editor}
          wrapperRef={wrapperRef}
          rotation={rotation}
          draggingRef={spaceAfterDraggingRef}
          onCommit={() => commitEditorBlocks(editor)}
        />
      ) : null}
    </div>
  );
}
