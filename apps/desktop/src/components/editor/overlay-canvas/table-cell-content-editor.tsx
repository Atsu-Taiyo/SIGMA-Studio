"use client";

import { useEffect, useMemo, useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor as TiptapEditor } from "@tiptap/core";

import {
  InlineContent,
  OverlayTableTrendCell,
} from "@/features/rendering/adapters/react";
import { pasteAsSingleBlockInlineContent } from "@/components/editor/text-flow/inline-block-paste";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { dispatchTextFormatState } from "@/components/tiptap/text-format-controller";
import { DEFAULT_BODY_FONT_FAMILY, getTableCellDisplayNodes, getTableCellFormulaResult } from "@/features/document";
import type {
  InlineNode,
  OverlayShapeId,
  SigmaTableCell,
  SigmaTableCellContent,
  SigmaTableSpec,
} from "@/features/document";
import {
  inlineNodesToTiptapDoc,
  tiptapDocToInlineNodes,
  type TiptapDoc,
} from "@/lib/tiptap-adapter";

import {
  getTableCellNavigationDirection,
  shouldNavigateTableCell,
  type TableCellNavigationDirection,
  type TableEditorViewLike,
} from "./shapes/table-editor-model";

export function OverlayTableCellContentEditor({
  shapeId,
  cell,
  cellId,
  content,
  editing,
  showFormulaSource,
  table,
  rowIndex,
  columnIndex,
  colSpan,
  onFocus,
  onChange,
  onNavigate,
  onRegisterEditor,
}: {
  shapeId: OverlayShapeId;
  cell: SigmaTableCell | undefined;
  cellId: string;
  content: SigmaTableCellContent;
  editing: boolean;
  /**
   * Show the formula as written rather than its value. True only for the cell the caret is in, so
   * the author edits `=SUM(A1:A2)` while every other cell keeps showing what it evaluates to.
   */
  showFormulaSource: boolean;
  table: SigmaTableSpec;
  rowIndex: number;
  columnIndex: number;
  /** Only a trend cell reads it: its arrow stretches across the columns the cell spans. */
  colSpan: number;
  onFocus: (editor: TiptapEditor, shapeId: OverlayShapeId, cellId: string) => void;
  onChange: (cellId: string, contentId: string, nextContent: SigmaTableCellContent) => void;
  onNavigate: (rowIndex: number, columnIndex: number, direction: TableCellNavigationDirection) => boolean;
  onRegisterEditor: (cellId: string, contentId: string, editor: TiptapEditor) => () => void;
}) {
  if (content.type === "trend") {
    // A trend cell has nothing to edit, so it is the static rendering — the same component the PDF,
    // the SVG export and the embedded viewer draw. It used to be a KaTeX arrow here instead, which
    // was a different glyph from the exported one and kept a `MathPreview` alive per trend cell.
    return <OverlayTableTrendCell colSpan={colSpan} content={content} />;
  }

  // A formula cell shows its value until the caret is actually in it. Swapping the *component*
  // rather than the editor's content is what keeps the value out of the document: a Tiptap editor
  // holding the evaluated text would fire `onUpdate` and write `6` over `=SUM(A1:A2)`.
  const showsValue = !editing ||
    (!showFormulaSource && getTableCellFormulaResult(table, cell, content) !== null);
  if (showsValue) {
    return <OverlayTableParagraphStaticView cell={cell} content={content} table={table} />;
  }

  return (
    <OverlayTableParagraphEditor
      shapeId={shapeId}
      cellId={cellId}
      content={content}
      editing={editing}
      rowIndex={rowIndex}
      columnIndex={columnIndex}
      onFocus={onFocus}
      onChange={onChange}
      onNavigate={onNavigate}
      onRegisterEditor={onRegisterEditor}
    />
  );
}

function OverlayTableParagraphStaticView({
  cell,
  content,
  table,
}: {
  cell: SigmaTableCell | undefined;
  content: Extract<SigmaTableCellContent, { type: "paragraph" }>;
  table: SigmaTableSpec;
}) {
  return (
    <div className="overlay-table-paragraph" style={{ pointerEvents: "none" }}>
      <div className="overlay-table-shape-content ProseMirror">
        {/*
          The Tiptap cell editor is a single `paragraph`, so the alignment sits on a `<p>` there and
          `.overlay-table-shape-content p { flex: 0 0 auto; margin: 0 }` applies to it. Rendering the
          run directly into the flex container instead made the cell's own line box a differently
          sized flex item, so the text moved the moment the cell took focus.
        */}
        <p style={{ textAlign: content.align ?? undefined }}>
          {renderSigmaInlineNodesPreview(getTableCellDisplayNodes(table, cell, content))}
        </p>
      </div>
    </div>
  );
}

function OverlayTableParagraphEditor({
  shapeId,
  cellId,
  content,
  editing,
  rowIndex,
  columnIndex,
  onFocus,
  onChange,
  onNavigate,
  onRegisterEditor,
}: {
  shapeId: OverlayShapeId;
  cellId: string;
  content: Extract<SigmaTableCellContent, { type: "paragraph" }>;
  editing: boolean;
  rowIndex: number;
  columnIndex: number;
  onFocus: (editor: TiptapEditor, shapeId: OverlayShapeId, cellId: string) => void;
  onChange: (cellId: string, contentId: string, nextContent: SigmaTableCellContent) => void;
  onNavigate: (rowIndex: number, columnIndex: number, direction: TableCellNavigationDirection) => boolean;
  onRegisterEditor: (cellId: string, contentId: string, editor: TiptapEditor) => () => void;
}) {
  const initialDoc = useMemo(() => inlineNodesToTiptapDoc(content.children, content.align), [content.align, content.children]);
  const contentRef = useRef(initialDoc);
  const editor = useEditor({
    extensions: createRichTextEngineExtensions({
      // Cells fall back to `OverlayTableParagraphStaticView` on blur, which paints per-segment
      // borders. See `BoxedTextRunHeightOptions.drawRunFrames`.
      drawBoxedRunFrames: false,
      enableMathDelimiters: true,
      heading: false,
      placeholder: "",
      textBlockStyle: true,
    }),
    content: initialDoc,
    editable: editing,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "overlay-table-shape-content",
      },
      // 保存できるのは 1 ブロックぶんの inline だけ。段落のまま貼らせると画面には出るのに
      // 保存で 2 行目以降が消えるので、貼るものを畳んでこのブロックの中へ入れる。
      handlePaste: (view, event, slice) => pasteAsSingleBlockInlineContent(view, event, slice),
    },
    onFocus: ({ editor: activeEditor }) => {
      onFocus(activeEditor, shapeId, cellId);
      dispatchTextFormatState(activeEditor, "sigma-studio:text-format-state", "overlay", undefined, {
        state: activeEditor.state, view: activeEditor.view, documentFontFamily: DEFAULT_BODY_FONT_FAMILY,
      });
    },
    onTransaction: ({ editor: activeEditor }) => {
      if (activeEditor.isFocused) {
        dispatchTextFormatState(activeEditor, "sigma-studio:text-format-state", "overlay", undefined, {
          state: activeEditor.state, view: activeEditor.view, documentFontFamily: DEFAULT_BODY_FONT_FAMILY,
        });
      }
    },
    onUpdate: ({ editor: activeEditor }) => {
      const json = activeEditor.getJSON() as TiptapDoc;
      contentRef.current = json;
      onChange(cellId, content.id, {
        ...content,
        align: activeEditor.getAttributes("paragraph").textAlign ?? content.align,
        children: tiptapDocToInlineNodes(json),
      });
    },
  });

  useEffect(() => {
    editor?.setEditable(editing);
  }, [editing, editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    return onRegisterEditor(cellId, content.id, editor);
  }, [cellId, content.id, editor, onRegisterEditor]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const textAlign = content.align ?? null;
    if (editor.getAttributes("paragraph").textAlign === textAlign) return;
    // A cell-toolbar change must reach the focused editor without replacing its text or caret.
    const tr = editor.state.tr;
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === "paragraph") {
        tr.setNodeMarkup(offset, undefined, { ...node.attrs, textAlign });
      }
    });
    editor.view.dispatch(tr.setMeta("preventUpdate", true).setMeta("addToHistory", false));
    contentRef.current = editor.getJSON() as TiptapDoc;
  }, [content.align, editor]);

  useEffect(() => {
    if (!editor || editor.isFocused) {
      return;
    }

    const nextContent = inlineNodesToTiptapDoc(content.children, content.align);
    const serializedCurrent = JSON.stringify(contentRef.current);
    const serializedNext = JSON.stringify(nextContent);
    if (serializedCurrent !== serializedNext) {
      contentRef.current = nextContent;
      const timeoutId = window.setTimeout(() => {
        if (!editor.isDestroyed && !editor.isFocused) {
          editor.commands.setContent(nextContent, { emitUpdate: false });
        }
      }, 0);

      return () => window.clearTimeout(timeoutId);
    }
  }, [content.align, content.children, editor]);

  const handleKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!editor) {
      return;
    }

    const direction = getTableCellNavigationDirection(event.nativeEvent);
    if (!direction || !shouldNavigateTableCell(editor.view as TableEditorViewLike, direction)) {
      return;
    }

    if (!onNavigate(rowIndex, columnIndex, direction)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className="overlay-table-paragraph"
      style={{ pointerEvents: editing ? "auto" : "none" }}
      onKeyDownCapture={handleKeyDownCapture}
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

function renderSigmaInlineNodesPreview(children: readonly InlineNode[]): ReactNode {
  return <InlineContent nodes={children} keyPrefix="sigma-inline-preview" />;
}
