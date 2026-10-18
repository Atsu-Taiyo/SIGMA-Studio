"use client";

import { Extension, type Editor } from "@tiptap/core";
import { useMathRenderEnvironment } from "@/features/rendering/adapters/react";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { pasteAsSingleBlockInlineContent } from "@/components/editor/text-flow/inline-block-paste";
import { requestInlineMathEdit } from "@/components/tiptap/inline-math-extension";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { LOCAL_EDIT_HISTORY_ATTRIBUTE } from "@/components/editor/editor-shell/command-shortcut-targets";
import { useT } from "@/lib/i18n/react";
import type {
  InlineNode,
  MathFractionSizing,
} from "@/features/document";
import { isInlineBodyEmpty } from "@/lib/comments";
import { createId } from "@/lib/id";
import {
  inlineNodesToTiptapDoc,
  tiptapDocToInlineNodes,
  type TiptapDoc,
} from "@/lib/tiptap-adapter";

import { CommentAgentMentionHighlight, CommentMentionMark, type LoadCommentMentionCandidates } from "./comment-mentions";
import { CommentMentionMenu } from "./CommentMentionMenu";

const INSERT_INLINE_MATH_EVENT = "sigma-studio:insert-inline-math";

interface CommentRichTextEditorProps {
  value: InlineNode[];
  loadMentionCandidates?: LoadCommentMentionCandidates;
  mathFractionSizing?: MathFractionSizing | null;
  placeholder?: string;
  /** 出した瞬間に打ち始められるよう、作った直後に焦点を入れる (浮かべる入力欄)。 */
  autoFocus?: boolean;
  onChange: (value: InlineNode[]) => void;
  /** Enter (⌘Enter も) で送る。改行は Shift+Enter。メンションの候補が開いている間の Enter は候補を選ぶ。 */
  onSubmit?: () => void;
  /** 入力欄の中の Esc。メンションの候補が開いている間は候補を閉じるだけで、ここへは来ない。 */
  onEscape?: () => void;
  /** 入力欄の枠の中、本文の下に置く操作 (送信ボタンなど)。エディタを触る操作のために editor を渡す。 */
  footer?: (editor: Editor | null) => ReactNode;
}

export function CommentRichTextEditor({
  value,
  loadMentionCandidates,
  mathFractionSizing,
  placeholder,
  autoFocus = false,
  onChange,
  onSubmit,
  onEscape,
  footer,
}: CommentRichTextEditorProps) {
  const t = useT("editor");
  // 既定値を引数に書くと翻訳前の文言が焼き付くので、本文側で解決する。
  const resolvedPlaceholder = placeholder ?? t("comment.placeholder");
  const valueRef = useRef(value);
  const previousSerializedRef = useRef(JSON.stringify(value));
  const initialContent = useMemo(() => inlineNodesToTiptapDoc(value), [value]);

  const onSubmitRef = useRef(onSubmit);
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    valueRef.current = value;
    onSubmitRef.current = onSubmit;
    onEscapeRef.current = onEscape;
  }, [value, onSubmit, onEscape]);

  const mathEnvironment = useMathRenderEnvironment(mathFractionSizing);
  const editor = useEditor({
    extensions: [
      CommentMentionMark,
      CommentAgentMentionHighlight,
      // 本文・図形テキスト・表セルと同じ共通エンジン (書式・色・下線・囲み・数式)。打った見た目と
      // 投稿後の表示 (`InlineContent`) が本文と同じ規則で揃う。
      // **履歴はこの欄の自前** (`localHistory`)。ここが編むのはコメントの下書きで、SigmaDoc には
      // 投稿するまで 1 文字も入らない (下書きの置き場は `EditorShell` の `pendingCommentDraft` /
      // editorStore の `commentReplyDrafts` / `CommentThreadsPanel` の `editDrafts` で、いずれも React 側の state)。
      // 文書の履歴へ渡すと、コメントを打ち間違えて取り消したときにコメントはそのままで無関係な
      // 本文編集が巻き戻り、ユーザーには何が起きたか分からない。
      ...createRichTextEngineExtensions({
        heading: false,
        localHistory: true,
        mathEnvironment,
        placeholder: resolvedPlaceholder,
      }),
      // 段落の分割より先に取る。IME の変換確定の Enter は ProseMirror がここへ渡さない。
      Extension.create({
        name: "commentComposerKeys",
        priority: 1000,
        addKeyboardShortcuts: () => {
          const submit = () => {
            if (!onSubmitRef.current) return false;
            onSubmitRef.current();
            return true;
          };
          return {
            Enter: submit,
            "Mod-Enter": submit,
            Escape: () => {
              if (!onEscapeRef.current) return false;
              onEscapeRef.current();
              return true;
            },
          };
        },
      }),
    ],
    content: initialContent,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "comment-rich-text-editor",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": resolvedPlaceholder,
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
    if (!editor || editor.isDestroyed) {
      return;
    }
    // 打っている最中 (焦点がある) は外から書き換えない。ただし送ったあとに空へ戻すのは入れる —
    // Enter で送ると焦点は欄に残るので、ここで止めると送った文が欄に残り、次の 1 文字で下書きへ戻る。
    if (editor.isFocused && !isInlineBodyEmpty(valueRef.current)) {
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

  const autoFocusRef = useRef(autoFocus);
  useEffect(() => {
    if (!editor || editor.isDestroyed || !autoFocusRef.current) {
      return;
    }
    // 最初の 1 回だけ。作り直し (表示言語の切り替え) のたびに焦点を奪わない。
    autoFocusRef.current = false;
    editor.commands.focus("end");
  }, [editor]);

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
      {footer?.(editor)}
      <CommentMentionMenu editor={editor} loadCandidates={loadMentionCandidates} />
    </div>
  );
}
