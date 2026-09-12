"use client";

import Placeholder from "@tiptap/extension-placeholder";
import { useMathRenderEnvironment } from "@/features/rendering/adapters/react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef } from "react";

import { pasteAsSingleBlockInlineContent } from "@/components/editor/text-flow/inline-block-paste";
import { InlineMathExtension, requestInlineMathEdit } from "@/components/tiptap/inline-math-extension";
import { LOCAL_EDIT_HISTORY_ATTRIBUTE } from "@/components/editor/editor-shell/command-shortcut-targets";
import { NativeHistoryGuardExtension } from "@/components/tiptap/native-history-guard";
import { useT } from "@/lib/i18n/react";
import type {
  InlineNode,
  MathFractionSizing,
} from "@/features/document";
import { createId } from "@/lib/id";
import {
  inlineNodesToTiptapDoc,
  tiptapDocToInlineNodes,
  type TiptapDoc,
} from "@/lib/tiptap-adapter";

const INSERT_INLINE_MATH_EVENT = "sigma-studio:insert-inline-math";

interface CommentRichTextEditorProps {
  value: InlineNode[];
  mathFractionSizing?: MathFractionSizing | null;
  placeholder?: string;
  onChange: (value: InlineNode[]) => void;
}

export function CommentRichTextEditor({
  value,
  mathFractionSizing,
  placeholder,
  onChange,
}: CommentRichTextEditorProps) {
  const t = useT("editor");
  // 既定値を引数に書くと翻訳前の文言が焼き付くので、本文側で解決する。
  const resolvedPlaceholder = placeholder ?? t("comment.placeholder");
  const valueRef = useRef(value);
  const previousSerializedRef = useRef(JSON.stringify(value));
  const initialContent = useMemo(() => inlineNodesToTiptapDoc(value), [value]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const mathEnvironment = useMathRenderEnvironment(mathFractionSizing);
  const editor = useEditor({
    extensions: [
      // **`undoRedo` を落とさない。** ここが編むのはコメントの下書きで、
      // SigmaDoc には投稿するまで 1 文字も入らない (下書きの置き場は
      // `EditorShell` の `pendingCommentDraft` / editorStore の `commentReplyDrafts` /
      // `CommentThreadsPanel` の `editDrafts` で、いずれも React 側の state)。
      // 「SigmaDoc に入らない面は自前の履歴を持ち、そこへ戻す」— `BoxTitleEditor` と同じ扱い。
      StarterKit.configure({
        heading: false,
        underline: false,
      }),
      Placeholder.configure({ placeholder: resolvedPlaceholder }),
      // prop の組版設定と文書コンテキストを 1 つの環境に畳んでから渡す
      // (別々に読むと、片方だけ差し替わったときに静的と編集中が食い違う)。
      InlineMathExtension.configure({ mathEnvironment }),
      // 共通エンジンを通らないので個別に積む。既定の SigmaDoc への委譲は**使わない** —
      // それだとコメントを打ち間違えて取り消したときに、コメントはそのままで無関係な
      // 本文編集が巻き戻り、ユーザーには何が起きたか分からない。
      NativeHistoryGuardExtension.configure({
        onHistoryCommand: (direction, activeEditor) => (direction === "undo"
          ? activeEditor.commands.undo()
          : activeEditor.commands.redo()),
      }),
    ],
    content: initialContent,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "comment-rich-text-editor",
        // ⌘Z をこの欄自身の履歴へ届けるための目印
        // (`editor-shell/command-shortcut-targets.ts`)。無いと文書の undo が走り、
        // 打ったコメントは残ったまま無関係な本文が巻き戻る。
        [LOCAL_EDIT_HISTORY_ATTRIBUTE]: "true",
      },
      // 保存できるのは 1 ブロックぶんの inline だけ。段落のまま貼らせると画面には出るのに
      // 保存で 2 行目以降が消えるので、貼るものを畳んでこのブロックの中へ入れる。
      handlePaste: (view, event, slice) => pasteAsSingleBlockInlineContent(view, event, slice),
    },
    onUpdate: ({ editor: activeEditor }) => {
      const nextValue = tiptapDocToInlineNodes(activeEditor.getJSON() as TiptapDoc);
      previousSerializedRef.current = JSON.stringify(nextValue);
      onChange(nextValue);
    },
    // プレースホルダが変わったらエディタを作り直す (表示言語を切り替えたときだけ)。
  }, [resolvedPlaceholder]);

  const serializedValue = JSON.stringify(value);
  useEffect(() => {
    if (!editor || editor.isDestroyed || editor.isFocused) {
      return;
    }
    if (previousSerializedRef.current === serializedValue) {
      return;
    }

    previousSerializedRef.current = serializedValue;
    // **外から入れた内容は自分の履歴に載せない** (`addToHistory: false`)。
    // 載せると、投稿・確定でこの欄がクリアされたあとの undo で消えたはずの本文が復活し、
    // `onUpdate` がそれを呼び出し元へ書き戻す。`setContent` の options には無いので
    // 同じトランザクションに meta を置く。
    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent(inlineNodesToTiptapDoc(valueRef.current), { emitUpdate: false })
      .run();
  }, [editor, serializedValue]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const insertInlineMath = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (detail?.target !== "comment") {
        return;
      }

      const tex = typeof detail.tex === "string" ? detail.tex : "";
      const shouldEdit = detail.edit === true;
      if (!tex && !shouldEdit) {
        return;
      }

      const id = createId("m_comment");
      editor
        .chain()
        .focus()
        .insertMathInline({ id, tex })
        .run();

      if (shouldEdit) {
        requestInlineMathEdit(id);
      }
    };

    window.addEventListener(INSERT_INLINE_MATH_EVENT, insertInlineMath);
    return () => window.removeEventListener(INSERT_INLINE_MATH_EVENT, insertInlineMath);
  }, [editor]);

  return (
    <div className="comment-rich-text-shell">
      <EditorContent editor={editor} />
    </div>
  );
}
