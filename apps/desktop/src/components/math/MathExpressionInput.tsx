"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { InlineMathField } from "@/components/tiptap/inline-math-extension";
import { InlineMathPreview, MathPreview, useMathEnvironment } from "@/features/rendering/adapters/react";

export interface MathExpressionInputProps {
  /** 現在確定している TeX。 */
  tex: string;
  ariaLabel: string;
  /** 未入力時に薄く表示する TeX。 */
  placeholderTex?: string;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
  ariaDescribedBy?: string;
  "data-testid"?: string;
  /** Enter / フォーカス喪失で確定した TeX を受け取る。 */
  onCommit: (tex: string) => void;
  /** 入力中の TeX を逐次受け取る (ライブプレビュー用)。Escape 時は編集前の値で呼び戻す。 */
  onInputTex?: (tex: string) => void;
}

/**
 * 設定フォーム用の数式入力枠。編集時は本文数式と同じ `InlineMathField` を直接使い、
 * TeX / リアルタイム表示、キーボード操作、MathLive 設定を二重実装しない。
 */
export function MathExpressionInput({
  tex,
  ariaLabel,
  placeholderTex,
  invalid = false,
  disabled = false,
  className,
  ariaDescribedBy,
  "data-testid": dataTestId,
  onCommit,
  onInputTex,
}: MathExpressionInputProps) {
  const mathEnvironment = useMathEnvironment();
  const [editing, setEditing] = useState(false);
  const [draftTex, setDraftTex] = useState(tex);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const previousEditingRef = useRef(false);
  const initialTexRef = useRef(tex);
  const finishedRef = useRef(false);
  const onCommitRef = useRef(onCommit);
  const onInputRef = useRef(onInputTex);

  useEffect(() => {
    onCommitRef.current = onCommit;
    onInputRef.current = onInputTex;
  }, [onCommit, onInputTex]);

  useEffect(() => {
    if (previousEditingRef.current && !editing) {
      buttonRef.current?.focus({ preventScroll: true });
    }
    previousEditingRef.current = editing;
  }, [editing]);

  const finishEditing = useCallback((commit: boolean, nextTex: string) => {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    if (commit) {
      onCommitRef.current(nextTex);
    } else {
      onInputRef.current?.(initialTexRef.current);
    }
    setEditing(false);
  }, []);

  const updateDraft = useCallback((nextTex: string) => {
    setDraftTex(nextTex);
    onInputRef.current?.(nextTex);
  }, []);

  const shellClassName = [
    "math-expression-input",
    invalid ? "is-invalid" : null,
    editing ? "is-editing" : null,
    className ?? null,
  ].filter(Boolean).join(" ");

  if (editing) {
    return (
      <span className={shellClassName}>
        <InlineMathField
          ariaDescribedBy={ariaDescribedBy}
          ariaLabel={ariaLabel}
          className="math-expression-input-field"
          dataTestId={dataTestId ? `${dataTestId}-field` : undefined}
          invalid={invalid}
          locked={disabled}
          tex={draftTex}
          mathEnvironment={mathEnvironment}
          initialCursorPosition="end"
          initialLatexCommandTrigger={null}
          initialPlaceholderIndex={null}
          onInput={updateDraft}
          onCancel={() => finishEditing(false, initialTexRef.current)}
          onCommit={(nextTex) => finishEditing(true, nextTex)}
          onDeleteBackwardFromStart={(nextTex) => finishEditing(true, nextTex)}
          onReturnToTextAfter={(nextTex) => finishEditing(true, nextTex)}
          onReturnToTextBefore={(nextTex) => finishEditing(true, nextTex)}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </span>
    );
  }

  const trimmed = tex.trim();

  return (
    <span className={shellClassName}>
      <button
        ref={buttonRef}
        type="button"
        className="math-expression-input-button"
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        data-testid={dataTestId}
        disabled={disabled}
        onClick={() => {
          finishedRef.current = false;
          initialTexRef.current = tex;
          setDraftTex(tex);
          setEditing(true);
        }}
      >
        {trimmed ? (
          <InlineMathPreview tex={trimmed} className="math-expression-input-preview" />
        ) : (
          <span className="math-expression-input-placeholder">
            {placeholderTex ? <MathPreview tex={placeholderTex} /> : null}
          </span>
        )}
      </button>
    </span>
  );
}
