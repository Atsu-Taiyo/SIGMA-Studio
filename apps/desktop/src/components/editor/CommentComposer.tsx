"use client";

import { ArrowUp, Check } from "lucide-react";

import { CommentRichTextEditor } from "@/components/editor/CommentRichTextEditor";
import type { InlineNode, MathFractionSizing } from "@/features/document";
import { isInlineBodyEmpty } from "@/lib/comments";

import type { LoadCommentMentionCandidates } from "./comment-mentions";

export interface CommentComposerProps {
  value: InlineNode[];
  placeholder: string;
  /** 送信ボタンの名前 (追加・返信・保存)。ボタンは矢印のアイコンだけなので、読み上げとツールチップに使う。 */
  submitLabel: string;
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
 * 枠の中に本文を書き、下の段の右端の丸いボタン (Enter でも) で送る。AI へ頼むときは本文に
 * `@claude` などと書く。
 */
export function CommentComposer({
  value,
  placeholder,
  submitLabel,
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
        footer={() => (
          <div className="comment-composer-toolbar">
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
