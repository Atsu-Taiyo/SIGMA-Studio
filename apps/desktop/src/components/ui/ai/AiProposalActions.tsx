"use client";

import { MessageSquarePlus, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import { Button, IconButton } from "@/components/ui/Button";
import { Shimmer } from "@/components/ui/Shimmer";
import { Inline } from "@/components/ui/layout";
import { useT } from "@/lib/i18n/react";

import { AiProposalDecisionButton } from "./AiProposalDecisionButton";

/** AI提案の判断フレームが必要とする操作と表示状態。 */
export interface AiProposalActionsProps {
  applying: boolean;
  onApply?: () => void;
  onDismiss?: (reason?: string) => void;
  onOpenConversation?: (anchorElement: HTMLElement) => void;
  dismissReasonPlaceholder?: string;
  className?: string;
  actionClassName?: string;
  showApply?: boolean;
  showDismiss?: boolean;
  /**
   * 破棄理由のポップオーバーが開いているか。渡すと持ち主の状態になる (描き直しや作り直しで
   * 閉じない)。渡さなければこの部品が自分で持つ。
   */
  dismissReasonOpen?: boolean;
  onDismissReasonOpenChange?: (open: boolean) => void;
  /** 入力中の破棄理由。渡すと持ち主の状態になる (作り直されても入力が残る)。 */
  dismissReason?: string;
  onDismissReasonChange?: (reason: string) => void;
  /** 見た目だけの複製。操作の結果 (ポップオーバー) を描かない。 */
  replica?: boolean;
}

function normalizeDismissReason(rawReason: string): string | undefined {
  const trimmed = rawReason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const POPOVER_GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 8;
const OFFSCREEN_STYLE: CSSProperties = { position: "fixed", top: -9999, left: -9999, visibility: "hidden" };
const FOCUSABLE_IN_POPOVER = "button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * 破棄理由のポップオーバーの位置。紙面のカードは改ページで切り取られ (clip-path)、パネルは
 * スクロールで切れるので、ポップオーバーは body に出して画面の座標で置く。破棄ボタンの下を
 * 優先し、入らなければ上に出す。右端はボタンに揃え、画面の内側へ寄せる。
 */
export function placeDismissReasonPopover(
  trigger: { top: number; bottom: number; right: number },
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const below = trigger.bottom + POPOVER_GAP_PX;
  const above = trigger.top - POPOVER_GAP_PX - popover.height;
  const fitsBelow = below + popover.height <= viewport.height - VIEWPORT_MARGIN_PX;
  const top = fitsBelow || above < VIEWPORT_MARGIN_PX
    ? Math.max(VIEWPORT_MARGIN_PX, Math.min(below, viewport.height - VIEWPORT_MARGIN_PX - popover.height))
    : above;
  const maxLeft = viewport.width - VIEWPORT_MARGIN_PX - popover.width;
  const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(trigger.right - popover.width, maxLeft));
  return { top, left };
}

/**
 * AI提案カードに共通する「破棄・続けて修正・適用」の順序と状態表現を固定する。
 * 提案内容や適用処理は持たず、各表示面から渡された操作だけを実行する。
 */
export function AiProposalActions({
  applying,
  onApply,
  onDismiss,
  onOpenConversation,
  dismissReasonPlaceholder,
  className,
  actionClassName = "ai-inline-preview-action",
  showApply = true,
  showDismiss = true,
  dismissReasonOpen,
  onDismissReasonOpenChange,
  dismissReason,
  onDismissReasonChange,
  replica = false,
}: AiProposalActionsProps) {
  const t = useT("ai");
  // 「閉じる」は汎用語 (`common.actions.*` が唯一の出典)。
  const tCommon = useT("common");
  const [ownReasonOpen, setOwnReasonOpen] = useState(false);
  const [ownReason, setOwnReason] = useState("");
  const [modalHost, setModalHost] = useState<HTMLElement | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);
  const dismissTriggerRef = useRef<HTMLButtonElement | null>(null);
  const reasonPopoverRef = useRef<HTMLDivElement | null>(null);
  // 入力欄へフォーカスを移すのは、利用者が破棄を押して開いた直後だけ。持ち主の状態で開いたまま
  // 作り直されたとき (カードの再生成・ページ割りの描き直し) は、別の場所の作業からフォーカスを奪わない。
  const focusOnOpenRef = useRef(false);
  const reasonPopoverId = useId();
  const reason = dismissReason ?? ownReason;
  const setReason = (next: string) => {
    onDismissReasonChange?.(next);
    if (dismissReason === undefined) {
      setOwnReason(next);
    }
  };
  const controlled = dismissReasonOpen !== undefined;
  const reasonOpen = (controlled ? dismissReasonOpen : ownReasonOpen) && !replica;
  // 開いている間は body (ダイアログの中ならその背景) へ出す。
  const portalHost = reasonOpen && typeof document !== "undefined" ? modalHost ?? document.body ?? null : null;

  const setReasonOpen = useCallback((open: boolean) => {
    if (onDismissReasonOpenChange) {
      onDismissReasonOpenChange(open);
    }
    if (!controlled) {
      setOwnReasonOpen(open);
    }
  }, [controlled, onDismissReasonOpenChange]);

  const closeReasonPopover = useCallback((restoreTriggerFocus: boolean) => {
    setReasonOpen(false);
    if (restoreTriggerFocus) {
      dismissTriggerRef.current?.focus();
    }
  }, [setReasonOpen]);

  useEffect(() => {
    if (!reasonOpen) {
      return;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closeReasonPopover(true);
    };
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node | null;
      if (!target
        || reasonPopoverRef.current?.contains(target)
        || dismissTriggerRef.current?.contains(target)) {
        return;
      }
      // 外側の操作先へ自然にフォーカスが移るよう、この経路ではtriggerへ戻さない。
      closeReasonPopover(false);
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [closeReasonPopover, reasonOpen]);

  useLayoutEffect(() => {
    if (!reasonOpen || !portalHost) {
      return;
    }
    const update = () => {
      const trigger = dismissTriggerRef.current;
      const popover = reasonPopoverRef.current;
      if (!trigger || !popover) {
        return;
      }
      const { top, left } = placeDismissReasonPopover(
        trigger.getBoundingClientRect(),
        { width: popover.offsetWidth, height: popover.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPopoverStyle((previous) => (
        previous?.top === top && previous?.left === left ? previous : { position: "fixed", top, left }
      ));
    };
    update();
    // 破棄ボタンはスクロールが無くても動く (測り直し・並んだ別のカードの出現・失敗の行・ズーム)。
    // 開いている間だけ毎フレーム位置を比べて追いかける。
    let frame = 0;
    let last = "";
    const follow = () => {
      const trigger = dismissTriggerRef.current;
      const popover = reasonPopoverRef.current;
      if (trigger && popover) {
        const rect = trigger.getBoundingClientRect();
        const signature = `${rect.top}:${rect.bottom}:${rect.right}:${popover.offsetWidth}:${popover.offsetHeight}`;
        if (signature !== last) {
          last = signature;
          update();
        }
      }
      frame = window.requestAnimationFrame(follow);
    };
    frame = window.requestAnimationFrame(follow);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [portalHost, reasonOpen]);

  // 置いてから入力欄へフォーカスする (仮の位置では見えないので focus が効かない)。
  const positioned = popoverStyle !== null;
  useLayoutEffect(() => {
    if (reasonOpen && positioned && focusOnOpenRef.current) {
      focusOnOpenRef.current = false;
      reasonPopoverRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    }
  }, [positioned, reasonOpen]);

  const confirmDismiss = () => {
    onDismiss?.(normalizeDismissReason(reason));
    setReasonOpen(false);
    setReason("");
    dismissTriggerRef.current?.focus();
  };

  // ポップオーバーは body の末尾にあるので、Tab で外 (紙面の続き) へ抜けないよう中で回す。
  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") {
      return;
    }
    const focusables = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_IN_POPOVER)];
    if (focusables.length === 0) {
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const requestDismiss = () => {
    if (dismissReasonPlaceholder) {
      if (reasonOpen) {
        closeReasonPopover(true);
      } else {
        setModalHost(dismissTriggerRef.current?.closest<HTMLElement>("[data-modal-backdrop]") ?? null);
        focusOnOpenRef.current = true;
        setReasonOpen(true);
      }
      return;
    }
    onDismiss?.();
  };

  const reasonPopover = reasonOpen && dismissReasonPlaceholder && portalHost
    ? createPortal(
      <div
        ref={reasonPopoverRef}
        id={reasonPopoverId}
        className="ai-inline-preview-reason-popover"
        role="group"
        aria-label={t("proposal.dismissReason")}
        style={popoverStyle ?? OFFSCREEN_STYLE}
        // 紙面やパネルの操作 (選択・ドラッグ) に拾わせない。
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={trapFocus}
      >
        <div className="ai-inline-preview-reason-head">
          <span>{t("proposal.dismissReasonOptional")}</span>
          <IconButton
            label={tCommon("actions.close")}
            tone="ghost"
            size="sm"
            className="ai-inline-preview-reason-close"
            onClick={() => closeReasonPopover(true)}
          >
            <X size={12} aria-hidden="true" />
          </IconButton>
        </div>
        <textarea
          className="ai-inline-preview-reason-textarea"
          value={reason}
          maxLength={200}
          placeholder={dismissReasonPlaceholder}
          aria-label={t("proposal.dismissReasonOptional")}
          onChange={(event) => setReason(event.target.value)}
        />
        <Inline className="ai-inline-preview-reason-actions" justify="end">
          <Button tone="primary" size="sm" className="ai-inline-preview-reason-submit" onClick={confirmDismiss}>
            {t("proposal.dismiss")}
          </Button>
        </Inline>
      </div>,
      portalHost,
    )
    : null;

  return (
    <Inline
      as="footer"
      className={["ai-proposal-actions", className].filter(Boolean).join(" ")}
      gap="xs"
      align="center"
      justify="end"
      role="group"
      aria-label={t("proposal.actionsAria")}
    >
      {applying && <Shimmer>{t("proposal.applying")}</Shimmer>}
      {showDismiss && (
        <div className="ai-inline-preview-discard-wrap">
          <AiProposalDecisionButton
            ref={dismissTriggerRef}
            decision="dismiss"
            className={[actionClassName, "discard"].filter(Boolean).join(" ")}
            disabled={applying}
            aria-expanded={dismissReasonPlaceholder ? reasonOpen : undefined}
            aria-controls={dismissReasonPlaceholder && reasonOpen ? reasonPopoverId : undefined}
            onClick={requestDismiss}
          />
          {reasonPopover}
        </div>
      )}
      {onOpenConversation && (
        <IconButton
          label={t("proposal.continue")}
          tooltip={{ label: t("proposal.continueTooltip") }}
          tone="secondary"
          size="sm"
          className={[actionClassName, "continue"].filter(Boolean).join(" ")}
          disabled={applying}
          onClick={(event) => onOpenConversation(event.currentTarget)}
        >
          <MessageSquarePlus size={16} strokeWidth={2.5} aria-hidden="true" />
        </IconButton>
      )}
      {showApply && (
        <AiProposalDecisionButton
          decision="apply"
          className={[actionClassName, "apply"].filter(Boolean).join(" ")}
          disabled={!onApply || applying}
          onClick={onApply}
        />
      )}
    </Inline>
  );
}
