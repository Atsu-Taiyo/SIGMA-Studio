"use client";

import { Extension } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";

import { startExpandedTextSelection } from "@/components/editor/expanded-text-selection";
import { pasteAsSingleBlockInlineContent } from "@/components/editor/text-flow/inline-block-paste";
import { requestInlineMathEdit } from "@/components/tiptap/inline-math-extension";
import { DEFAULT_FONT_FAMILY_VALUE } from "@/components/editor/editor-shell/constants";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { useT } from "@/lib/i18n/react";
import {
  applyTextFormatCommand,
  dispatchTextFormatState,
  isCaretScopedTextFormatCommand,
  isValidTextFormatSelection,
  normalizeTextFormatAlign,
  type TextFormatSelectionRange,
} from "@/components/tiptap/text-format-controller";
import { createId } from "@/lib/id";
import {
  fromTiptap,
  inlineNodesToTiptapDoc,
  tiptapDocToInlineNodes,
  toTiptap,
  type TiptapDoc,
} from "@/lib/tiptap-adapter";
import type { HeadingNode, InlineNode, ParagraphNode } from "@/features/document";
import { textCaretAddress, type TextFlowSelectionBookmark } from "@/features/text-editing";
import { registerCaretSurface } from "@/components/editor/text-flow/caret-router";
import {
  beginTextFlowDocumentChange,
  publishTextFlowSelectionBookmark,
} from "@/components/editor/text-flow/caret-bookmark-events";

const TextAlignAttrs = Extension.create({
  name: "textAlignAttrs",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (element) => element.style.textAlign || null,
            renderHTML: (attributes) => {
              const align = normalizeTextFormatAlign(attributes.textAlign);
              return align ? { style: `text-align: ${align}` } : {};
            },
          },
        },
      },
    ];
  },
});

const FORMAT_TEXT_EVENT = "sigma-studio:format-text";
const INSERT_INLINE_MATH_EVENT = "sigma-studio:insert-inline-math";
const TEXT_FORMAT_STATE_EVENT = "sigma-studio:text-format-state";
interface RichTextEditorProps {
  block: ParagraphNode | HeadingNode;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  selected?: boolean;
  formatTarget?: string;
  historyRevision: number;
  onChange: (children: InlineNode[], level?: HeadingNode["level"]) => void;
}

export function RichTextEditor({ block, placeholder, className, style, selected = false, formatTarget = "document", historyRevision, onChange }: RichTextEditorProps) {
  const t = useT("editor");
  const resolvedPlaceholder = placeholder ?? t("body.inputPlaceholder");
  const blockRef = useRef(block);
  const lastTextSelectionRef = useRef<{ from: number; to: number } | null>(null);
  const selectionBeforeTransactionRef = useRef<TextFlowSelectionBookmark | null>(null);
  const previousHistoryRevisionRef = useRef(historyRevision);
  const initialContent = useMemo(() => {
    return block.type === "heading" ? toTiptap(block) : inlineNodesToTiptapDoc(block.children, block.align, block.lineHeight);
  }, [block]);

  useEffect(() => {
    blockRef.current = block;
  }, [block]);

  const editor = useEditor({
    extensions: createRichTextEngineExtensions({
      blockExtensions: [TextAlignAttrs],
      lineHeight: true,
      placeholder: resolvedPlaceholder,
      searchHighlight: true,
    }),
    content: initialContent,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: className ?? "rich-text",
      },
      // 保存できるのは 1 ブロックぶんの inline だけ。段落のまま貼らせると画面には出るのに
      // 保存で 2 行目以降が消えるので、貼るものを畳んでこのブロックの中へ入れる。
      handlePaste: (view, event, slice) => pasteAsSingleBlockInlineContent(view, event, slice),
    },
    // Toolbar state rides on onTransaction, not on selection/doc updates: toggling a
    // mark at a collapsed caret only sets storedMarks, which changes neither the
    // selection nor the doc, so B/I/U would otherwise stay stale until the next
    // keystroke. The isFocused guard keeps a background editor's programmatic
    // transactions from clobbering the focused editor's toolbar state.
    onTransaction: ({ editor: activeEditor, transaction }) => {
      if (transaction.docChanged) {
        selectionBeforeTransactionRef.current = getRichTextSelectionBeforeTransaction(
          transaction,
          blockRef.current.id,
        );
      }
      if (activeEditor.isFocused) {
        dispatchTextFormatState(
          activeEditor,
          TEXT_FORMAT_STATE_EVENT,
          "document",
          undefined,
          { state: activeEditor.state, documentFontFamily: DEFAULT_FONT_FAMILY_VALUE },
        );
      }
    },
    onSelectionUpdate: ({ editor: activeEditor }) => {
      const { from, to, empty } = activeEditor.state.selection;
      if (activeEditor.isFocused) {
        publishTextFlowSelectionBookmark(
          getRichTextSelectionBookmark(activeEditor.state.selection, blockRef.current.id),
        );
      }
      if (!empty) {
        lastTextSelectionRef.current = { from, to };
      }
    },
    onFocus: ({ editor: activeEditor }) => {
      dispatchTextFormatState(
          activeEditor,
          TEXT_FORMAT_STATE_EVENT,
          "document",
          undefined,
          { state: activeEditor.state, documentFontFamily: DEFAULT_FONT_FAMILY_VALUE },
        );
      publishTextFlowSelectionBookmark(
        getRichTextSelectionBookmark(activeEditor.state.selection, blockRef.current.id),
      );
    },
    onUpdate: ({ editor: activeEditor }) => {
      beginTextFlowDocumentChange(selectionBeforeTransactionRef.current);
      publishTextFlowSelectionBookmark(
        getRichTextSelectionBookmark(activeEditor.state.selection, blockRef.current.id),
      );
      const json = activeEditor.getJSON() as TiptapDoc;

      if (block.type === "heading") {
        const next = fromTiptap(json, block) as HeadingNode;
        onChange(next.children, next.level);
        return;
      }

      onChange(tiptapDocToInlineNodes(json));
    },
    // プレースホルダが変わったらエディタを作り直す。文言が変わるのは表示言語を
    // 切り替えたときだけなので、入力中に作り直されることはない。
  }, [resolvedPlaceholder]);

  const serializedBlock = JSON.stringify(block);
  useEffect(() => {
    if (!editor) {
      return;
    }

    const isHistoryRestore = previousHistoryRevisionRef.current !== historyRevision;
    previousHistoryRevisionRef.current = historyRevision;

    if (editor.isFocused && !isHistoryRestore) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const currentBlock = blockRef.current;
      const nextContent = currentBlock.type === "heading"
        ? toTiptap(currentBlock)
        : inlineNodesToTiptapDoc(currentBlock.children, currentBlock.align, currentBlock.lineHeight);
      if (!editor.isDestroyed && (!editor.isFocused || isHistoryRestore)) {
        const selection = getRichTextSelectionBookmark(editor.state.selection, currentBlock.id);
        const wasFocused = editor.isFocused;
        editor.commands.setContent(nextContent, { emitUpdate: false });
        restoreRichTextSelectionBookmark(editor, selection, wasFocused);
      }
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [editor, historyRevision, serializedBlock]);

  /**
   * この面もキャレットの registry に載せる。ブロードキャストではなくルーターが宛先を 1 つ
   * 選ぶので、素材ダイアログのような本文の外の面が本文のキャレットを攫うことはない。
   * `order` は空 = 文書順を持たない面 (上下移動の行き先にしない)。
   */
  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    return registerCaretSurface({
      editor,
      boxIds: [],
      fragmentBlockIdFor: () => null,
      order: [],
      surface: { kind: "richText", blockId: blockRef.current.id },
      ownsBlock: (blockId) => blockRef.current.id === blockId,
      addressAt: () => null,
      posFor: () => null,
      localYFor: () => null,
      caretLineAdvance: () => null,
      focusCaretAtLocalY: () => false,
      focusCaretAtEdge: () => false,
      focusCaretAfterBlock: () => false,
      adjacentTextblockAddress: () => null,
      docEdgeAddress: () => null,
      ensureCaretVisible: () => {},
      applyCaret: (selection) => {
        if (editor.isDestroyed || selection.head.blockId !== blockRef.current.id) {
          return false;
        }
        restoreRichTextSelectionBookmark(editor, selection, true);
        return true;
      },
      textRun: null,
    });
  }, [editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const insertInlineMath = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const tex = typeof detail?.tex === "string" ? detail.tex : "";
      const shouldEdit = detail?.edit === true;
      const eventTarget = typeof detail?.target === "string" ? detail.target : "document";
      if (eventTarget !== formatTarget) {
        return;
      }

      if ((!tex && !shouldEdit) || (!editor.isFocused && !selected)) {
        return;
      }

      const id = createId("m_inline");
      editor
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
    };

    window.addEventListener(INSERT_INLINE_MATH_EVENT, insertInlineMath);
    return () => window.removeEventListener(INSERT_INLINE_MATH_EVENT, insertInlineMath);
  }, [editor, formatTarget, selected]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const formatText = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const eventTarget = typeof detail?.target === "string" ? detail.target : "document";
      if (eventTarget !== formatTarget) {
        return;
      }
      if ((!editor.isFocused && !selected) || !detail?.command) {
        return;
      }

      const resolveFormatSelection = (): TextFormatSelectionRange | null => {
        const currentSelection = editor.state.selection;
        if (!currentSelection.empty && isValidTextFormatSelection(currentSelection, editor.state.doc.content.size)) {
          return { from: currentSelection.from, to: currentSelection.to };
        }

        // Caret with nothing selected: format from here on, Word/Docs style. See the
        // same guard in TextFlowEditor -- null routes the command to storedMarks so the
        // surrounding block keeps its formatting.
        if (editor.isFocused && isCaretScopedTextFormatCommand(detail.command)) {
          return null;
        }

        const lastSelection = lastTextSelectionRef.current;
        if (lastSelection && isValidTextFormatSelection(lastSelection, editor.state.doc.content.size)) {
          return lastSelection;
        }

        return selected ? { from: 1, to: Math.max(1, editor.state.doc.content.size - 1) } : null;
      };

      applyTextFormatCommand(editor, {
        command: detail.command as string,
        value: detail.value,
      }, {
        selection: resolveFormatSelection(),
        blockNodeType: block.type === "heading" ? "heading" : "paragraph",
      });
    };

    window.addEventListener(FORMAT_TEXT_EVENT, formatText);
    return () => window.removeEventListener(FORMAT_TEXT_EVENT, formatText);
  }, [block.type, editor, formatTarget, selected]);

  return (
    <div
      className="rich-text-shell"
      style={style}
      onMouseDown={(event) => {
        event.stopPropagation();
        startExpandedTextSelection(event, editor);
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
}

function getRichTextSelectionBookmark(
  selection: { anchor: number; head: number },
  blockId: string,
): TextFlowSelectionBookmark {
  return {
    anchor: textCaretAddress(blockId, Math.max(0, selection.anchor - 1)),
    head: textCaretAddress(blockId, Math.max(0, selection.head - 1)),
    preferredX: null,
  };
}

function getRichTextSelectionBeforeTransaction(
  transaction: Transaction,
  blockId: string,
): TextFlowSelectionBookmark {
  const invertedMapping = transaction.mapping.invert();
  return getRichTextSelectionBookmark({
    anchor: invertedMapping.map(transaction.selection.anchor, -1),
    head: invertedMapping.map(transaction.selection.head, 1),
  }, blockId);
}

function restoreRichTextSelectionBookmark(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  selection: TextFlowSelectionBookmark,
  focus: boolean,
): void {
  const maxPosition = Math.max(1, editor.state.doc.content.size - 1);
  const anchor = Math.min(maxPosition, 1 + Math.max(0, selection.anchor.offset));
  const head = Math.min(maxPosition, 1 + Math.max(0, selection.head.offset));
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)),
  );
  if (focus) {
    editor.view.focus();
  }
}
