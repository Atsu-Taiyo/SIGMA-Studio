"use client";

import type { Editor } from "@tiptap/core";
import { ArrowUp, Check } from "lucide-react";

import { CommentRichTextEditor } from "@/components/editor/CommentRichTextEditor";
import type { InlineNode, MathFractionSizing } from "@/features/document";
import { COMMENT_AI_MENTION_AGENTS, findCommentAiMentionAgent } from "@/lib/comment-agent-mentions";
import { isInlineBodyEmpty } from "@/lib/comments";
import { useT } from "@/lib/i18n/react";

import { prependCommentAgentMention, removeCommentAgentMentions, type LoadCommentMentionCandidates } from "./comment-mentions";

/** 「◯◯に送信」を入れたときに宛てる AI。本文に別の AI (@codex など) を書けば、そちらの名前に変わる。 */
const DEFAULT_COMMENT_AGENT = COMMENT_AI_MENTION_AGENTS[0];

export interface CommentComposerProps {
  value: InlineNode[];
  placeholder: string;
  /** 送信ボタンの名前 (追加・返信・保存)。ボタンは矢印のアイコンだけなので、読み上げとツールチップに使う。 */
  submitLabel: string;
  /** 「◯◯に送信」を出すか。AI が動かない画面 (埋め込みなど) と、書いたコメントの編集では出さない。 */
  showAgentToggle?: boolean;
  /** 送信の左に添える取り消し (キャンセル・閉じる)。浮かべた入力欄は Esc と外側のクリックで閉じるので持たない。 */
  cancelLabel?: string;
  /** 保存 (編集) はチェック、それ以外は上向きの矢印。 */
  submitIcon?: "send" | "save";
  loadMentionCandidates?: LoadCommentMentionCandidates;
  mathFractionSizing?: MathFractionSizing | null;
  autoFocus?: boolean;
  onChange: (value: InlineNode[]) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  onEscape?: () => void;
}

/**
 * コメントの入力欄 (新しいコメント・返信・編集で共通)。Figma や Claude のコメントと同じく、
 * 枠の中に本文を書き、下の段の右端の丸いボタン (Enter でも) で送る。AI へ頼むときは左下の
 * 「Claude に送信」を入れる — 本文の先頭に `@claude` を足すだけなので、AI を起動する判定も、
 * 投稿後のチップの見た目も、`@claude` と打ったときと同じになる。
 */
export function CommentComposer({
  value,
  placeholder,
  submitLabel,
  showAgentToggle = false,
  cancelLabel,
  submitIcon = "send",
  loadMentionCandidates,
  mathFractionSizing,
  autoFocus,
  onChange,
  onSubmit,
  onCancel,
  onEscape,
}: CommentComposerProps) {
  const empty = isInlineBodyEmpty(value);
  const submit = () => {
    if (!empty) onSubmit();
  };
  return (
    <div className="comment-composer">
      <CommentRichTextEditor
        loadMentionCandidates={loadMentionCandidates}
        value={value}
        mathFractionSizing={mathFractionSizing}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={onChange}
        onSubmit={submit}
        onEscape={onEscape}
        footer={(editor) => (
          <div className="comment-composer-toolbar">
            {showAgentToggle ? <CommentAgentToggle editor={editor} value={value} /> : <span />}
            <div className="comment-composer-buttons">
              {onCancel && cancelLabel && (
                <button
                  type="button"
                  className="comment-composer-cancel"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={onCancel}
                >
                  {cancelLabel}
                </button>
              )}
              <button
                type="button"
                className="comment-composer-send"
                aria-label={submitLabel}
                title={submitLabel}
                disabled={empty}
                onMouseDown={(event) => event.preventDefault()}
                onClick={submit}
              >
                {submitIcon === "save"
                  ? <Check size={15} strokeWidth={2.4} aria-hidden="true" />
                  : <ArrowUp size={15} strokeWidth={2.4} aria-hidden="true" />}
              </button>
            </div>
          </div>
        )}
      />
    </div>
  );
}

function CommentAgentToggle({ editor, value }: { editor: Editor | null; value: InlineNode[] }) {
  const t = useT("editor");
  const agent = findCommentAiMentionAgent(value);
  const name = agent?.name ?? DEFAULT_COMMENT_AGENT.name;
  const label = t("comment.sendToAgent", { name });
  return (
    <button
      type="button"
      role="checkbox"
      className="comment-composer-agent-toggle"
      aria-checked={Boolean(agent)}
      title={t("comment.sendToAgentHint", { name })}
      disabled={!editor}
      // 押しても入力欄の焦点とキャレットを動かさない。
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!editor) return;
        if (agent) removeCommentAgentMentions(editor);
        else prependCommentAgentMention(editor, DEFAULT_COMMENT_AGENT.keyword);
      }}
    >
      <span className="comment-composer-checkbox" aria-hidden="true">
        {agent && <Check size={11} strokeWidth={3} />}
      </span>
      <span>{label}</span>
    </button>
  );
}
