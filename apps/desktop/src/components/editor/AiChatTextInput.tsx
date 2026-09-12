"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { ComponentPropsWithoutRef, InputEvent } from "react";

export type AiChatTextInputProps = ComponentPropsWithoutRef<"textarea"> & {
  /** 入力内容に合わせてCSSのmax-heightまで高さを追従させる。 */
  autoGrow?: boolean;
};

function resizeInput(element: HTMLTextAreaElement): void {
  element.style.height = "auto";
  const computedMaxHeight = Number.parseFloat(window.getComputedStyle(element).maxHeight);
  const nextHeight = Number.isFinite(computedMaxHeight)
    ? Math.min(element.scrollHeight, computedMaxHeight)
    : element.scrollHeight;
  element.style.height = `${nextHeight}px`;
  element.style.overflowY = Number.isFinite(computedMaxHeight) && element.scrollHeight > computedMaxHeight ? "auto" : "hidden";
}

/**
 * AIサイドバー、フローティングカード、設定画面で入力の高さ追従と基本クラスを揃える。
 * 送信、添付、モデル選択などのコンポーザー状態は持たず、各表示面へ委ねる。
 */
export const AiChatTextInput = forwardRef<HTMLTextAreaElement, AiChatTextInputProps>(
  function AiChatTextInput({ className, autoGrow = true, onInput, value, ...props }, ref) {
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    useImperativeHandle(ref, () => inputRef.current as HTMLTextAreaElement);

    useEffect(() => {
      if (autoGrow && inputRef.current) {
        resizeInput(inputRef.current);
      }
    }, [autoGrow, value]);

    const handleInput = (event: InputEvent<HTMLTextAreaElement>) => {
      if (autoGrow) {
        resizeInput(event.currentTarget);
      }
      onInput?.(event);
    };

    const resolvedClassName = ["ai-chat-input", className].filter(Boolean).join(" ");
    return (
      <textarea
        {...props}
        ref={inputRef}
        className={resolvedClassName}
        value={value}
        onInput={handleInput}
      />
    );
  },
);
