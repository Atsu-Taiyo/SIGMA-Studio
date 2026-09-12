"use client";

// 通常のAIチャット入力欄(AiEditPanel / AiRunCardComposer)と見た目・挙動を揃えた、
// メンション/添付/モデル選択なしの最小構成テキストフィールド。AI設定ダイアログの
// スキル編集画面「AIに下書きさせる」用に切り出した。チャット側のコンポーザーは
// mentions/attachments/run-controllerと密結合な状態機械を抱えているため、それらを
// 再利用せず、共通のグローバルCSSクラス(`ai-chat-input-shell` / `ai-chat-input` /
// `ai-chat-send-button`)だけを再利用して見た目を一致させる(挙動は本コンポーネントが
// 単独で持つ制御コンポーネント)。
//
import { ArrowUp, Square } from "lucide-react";
import { forwardRef } from "react";
import type { KeyboardEvent } from "react";

import { useT } from "@/lib/i18n/react";
import { AiChatTextInput } from "./AiChatTextInput";

export interface ChatPromptFieldProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** 生成中に停止ボタンを押したときに呼ばれる。省略時、busy中は送信ボタンをdisabledのまま出す。 */
  onCancel?: () => void;
  /** 生成中かどうか。trueの間は送信ボタンが停止ボタンに切り替わる。 */
  busy?: boolean;
  /** フィールド全体(テキストエリア含む)を操作不能にする。 */
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * AIへ短い指示を送るための、入力欄と送信・停止操作だけを持つ最小コンポーザー。
 * メンション、添付、実行履歴は扱わず、それらが不要な設定内の生成導線で再利用する。
 */
export const ChatPromptField = forwardRef<HTMLTextAreaElement, ChatPromptFieldProps>(function ChatPromptField(
  { value, onChange, onSubmit, onCancel, busy = false, disabled = false, placeholder, ariaLabel, className },
  ref,
) {
  const t = useT("ai");
  const canSend = !disabled && !busy && value.trim().length > 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) {
        onSubmit();
      }
    }
  };

  return (
    <div className={`ai-chat-input-shell chat-prompt-field${className ? ` ${className}` : ""}`}>
      <AiChatTextInput
        ref={ref}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel ?? t("composer.instructionAria")}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="chat-prompt-field-actions">
        {busy ? (
          <button
            type="button"
            className="ai-chat-send-button"
            disabled={disabled || !onCancel}
            title={t("composer.stop")}
            aria-label={t("composer.stop")}
            onClick={onCancel}
          >
            <Square size={13} strokeWidth={2.5} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="ai-chat-send-button"
            disabled={!canSend}
            title={t("composer.send")}
            aria-label={t("composer.send")}
            onClick={onSubmit}
          >
            <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
});
