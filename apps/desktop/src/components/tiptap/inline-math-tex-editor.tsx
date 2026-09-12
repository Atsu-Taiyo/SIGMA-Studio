"use client";

import { MoreHorizontal } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent,
  TextareaHTMLAttributes,
} from "react";

import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { TexCommandReferenceDialog } from "@/components/editor/TexCommandReferenceDialog";
import { MathPreview } from "@/features/rendering/adapters/react";
import { AiProposalDecisionButton } from "@/components/ui/ai/AiProposalDecisionButton";
import { IconButton } from "@/components/ui/Button";

import styles from "./inline-math-tex-editor.module.css";
import { getInlineMathTexHighlightSegments } from "./inline-math-tex-highlight";
import { useT } from "@/lib/i18n/react";

const TEX_FIELD_MIN_HEIGHT_PX = 68;
const TEX_FIELD_VIEWPORT_CLEARANCE_PX = 48;

type InlineMathTexTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "aria-label" | "autoCapitalize" | "autoComplete" | "autoCorrect" | "className" | "inputMode" | "lang" | "ref" | "rows" | "spellCheck" | "value"
>;

interface InlineMathTexEditorProps {
  ariaDescribedBy?: string;
  ariaLabel?: string;
  dataTestId?: string;
  invalid?: boolean;
  locked: boolean;
  tex: string;
  onClose: () => void;
  onDone: () => void;
  onInteractionPointerDown: (event: PointerEvent) => void;
  onInteractionMouseDown: (event: ReactMouseEvent) => void;
  onInteractionKeyDown: (event: KeyboardEvent) => void;
  onCommandReferenceOpenChange: (open: boolean) => void;
  textareaProps: InlineMathTexTextareaProps;
}

/**
 * TeXコード、ライブプレビュー、確定操作をひとつの浮動エディタとして表示する。
 * TeXの正規化や確定後の文書更新は呼び出し元が持ち、このコンポーネントは
 * 入力面の構造・フォーカス・外側クリック・共通AI承認UIだけを担当する。
 */
export const InlineMathTexEditor = forwardRef<HTMLTextAreaElement, InlineMathTexEditorProps>(
  function InlineMathTexEditor({
    ariaDescribedBy,
    ariaLabel = "TeX",
    dataTestId,
    invalid = false,
    locked,
    tex,
    onClose,
    onDone,
    onInteractionPointerDown,
    onInteractionMouseDown,
    onInteractionKeyDown,
    onCommandReferenceOpenChange,
    textareaProps,
  }, forwardedRef) {
    const t = useT("editor");
    const [commandReferenceOpen, setCommandReferenceOpen] = useState(false);
    const previewRef = useRef<HTMLSpanElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const highlightRef = useRef<HTMLPreElement | null>(null);
    const highlightedSegments = useMemo(() => getInlineMathTexHighlightSegments(tex), [tex]);
    const { onScroll, ...restTextareaProps } = textareaProps;

    const resizeTexField = useCallback((textarea = textareaRef.current) => {
      if (!textarea) {
        return;
      }

      // 内容が収まる間は浮動エディタ自体を伸ばす。画面高を使い切る長さになった場合だけ
      // textarea 内をスクロールさせ、ポップオーバーの操作列を画面内に残す。
      textarea.style.height = "auto";
      const contentHeight = Math.ceil(textarea.scrollHeight);
      const maxHeight = Math.max(
        TEX_FIELD_MIN_HEIGHT_PX,
        window.innerHeight - TEX_FIELD_VIEWPORT_CLEARANCE_PX,
      );
      textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
      textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";

      if (highlightRef.current) {
        highlightRef.current.scrollTop = textarea.scrollTop;
        highlightRef.current.scrollLeft = textarea.scrollLeft;
      }
    }, []);

    const setTextareaElement = useCallback((element: HTMLTextAreaElement | null) => {
      textareaRef.current = element;
      if (element) {
        // ToolbarPopover は portal host の確定後に子をマウントする。既存の長い TeX を
        // 開いた初回にも、入力イベントを待たず DOM 接続時点で実寸へ合わせる。
        resizeTexField(element);
      }
    }, [resizeTexField]);

    useLayoutEffect(() => {
      resizeTexField();
    }, [resizeTexField, tex]);

    useEffect(() => {
      const handleWindowResize = () => resizeTexField();
      window.addEventListener("resize", handleWindowResize);
      return () => window.removeEventListener("resize", handleWindowResize);
    }, [resizeTexField]);

    useImperativeHandle(forwardedRef, () => textareaRef.current as HTMLTextAreaElement);

    return (
      <>
        <span
          ref={previewRef}
          className={`${styles.livePreview} inline-math-tex-live-preview`}
          aria-label={t("math.previewAria")}
          data-tex={tex}
          onPointerDown={onInteractionPointerDown}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            event.preventDefault();
            onInteractionMouseDown(event);
            textareaRef.current?.focus({ preventScroll: true });
          }}
        >
          <MathPreview tex={tex} />
        </span>
        <ToolbarPopover
          open
          anchorRef={previewRef}
          onClose={() => {
            if (!commandReferenceOpen) {
              onClose();
            }
          }}
          className={`${styles.popover} inline-math-tex-popover`}
          role="dialog"
          ariaLabel={t("math.editTex")}
          gap={8}
          zIndex="var(--z-modal-nested)"
        >
          <div
            className={`${styles.editorRow} inline-math-tex-editor-row`}
            onPointerDown={onInteractionPointerDown}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => {
              event.preventDefault();
              onInteractionMouseDown(event);
            }}
            onKeyDown={onInteractionKeyDown}
          >
            <div className={styles.texFieldShell} data-locked={locked ? "true" : undefined}>
              <pre
                ref={highlightRef}
                className={`${styles.highlight} inline-math-tex-highlight`}
                aria-hidden="true"
              >
                {highlightedSegments.map((segment, index) => segment.recognizedCommand ? (
                  <span
                    key={`${index}-${segment.text}`}
                    className={`${styles.recognizedCommand} inline-math-tex-command-recognized`}
                  >
                    {segment.text}
                  </span>
                ) : segment.text)}
                {tex.endsWith("\n") ? " " : null}
              </pre>
              <textarea
                {...restTextareaProps}
                ref={setTextareaElement}
                aria-label={ariaLabel}
                aria-describedby={ariaDescribedBy}
                aria-invalid={invalid || undefined}
                autoFocus={!locked}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                className={`${styles.texField} inline-math-field inline-math-tex-field`}
                data-testid={dataTestId}
                inputMode="text"
                lang="ja"
                rows={3}
                readOnly={locked}
                spellCheck={false}
                value={tex}
                onCopy={(event) => event.stopPropagation()}
                onCut={(event) => event.stopPropagation()}
                onScroll={(event) => {
                  if (highlightRef.current) {
                    highlightRef.current.scrollTop = event.currentTarget.scrollTop;
                    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
                  }
                  onScroll?.(event);
                }}
              />
            </div>
            <div className={styles.actionColumn}>
              <IconButton
                label={t("math.showCommands")}
                tone="ghost"
                size="sm"
                aria-haspopup="dialog"
                aria-expanded={commandReferenceOpen}
                onPointerDown={(event) => {
                  event.preventDefault();
                  onInteractionPointerDown(event);
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onInteractionMouseDown(event);
                }}
                onClick={() => {
                  onCommandReferenceOpenChange(true);
                  setCommandReferenceOpen(true);
                }}
              >
                <MoreHorizontal size={17} aria-hidden="true" />
              </IconButton>
              <AiProposalDecisionButton
                decision="apply"
                className={`${styles.doneButton} ai-inline-preview-action apply`}
                title={t("math.done")}
                aria-label={t("math.done")}
                disabled={locked}
                onPointerDown={(event) => {
                  event.preventDefault();
                  onInteractionPointerDown(event);
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onInteractionMouseDown(event);
                }}
                onClick={onDone}
              />
            </div>
          </div>
        </ToolbarPopover>
        {commandReferenceOpen ? (
          <TexCommandReferenceDialog
            onClose={() => {
              onCommandReferenceOpenChange(false);
              setCommandReferenceOpen(false);
              window.setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 0);
            }}
          />
        ) : null}
      </>
    );
  },
);
