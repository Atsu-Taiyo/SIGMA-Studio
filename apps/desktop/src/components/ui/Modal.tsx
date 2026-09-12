"use client";

import { X } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef, useSyncExternalStore } from "react";
import type { HTMLAttributes, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "./Button";
import { useT } from "@/lib/i18n/react";

import styles from "./Modal.module.css";

interface ModalFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  open: boolean;
  onDismiss: () => void;
  size?: "sm" | "md" | "lg" | "xl";
  embedded?: boolean;
  layer?: "base" | "nested";
  /** 一時的なキー記録など、Escapeを内容側で処理する間だけfalseにする。 */
  closeOnEscape?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  surfaceClassName?: string;
  children: ReactNode;
}

const ModalTitleIdContext = createContext<string | null>(null);
interface OpenModalEntry {
  id: symbol;
  surface: HTMLDivElement;
  backdrop: HTMLDivElement;
}

interface IsolationSnapshot {
  hadInert: boolean;
  inertValue: string | null;
  ariaHidden: string | null;
}

const openModalStack: OpenModalEntry[] = [];
const isolatedBodyChildren = new Map<HTMLElement, IsolationSnapshot>();
let bodyChildrenObserver: MutationObserver | null = null;

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
].join(", ");

function isAvailableFocusTarget(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) {
    return false;
  }
  return element.getClientRects().length > 0;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && isAvailableFocusTarget(element));
}

function getTopModal(): OpenModalEntry | undefined {
  for (let index = openModalStack.length - 1; index >= 0; index -= 1) {
    const entry = openModalStack[index];
    if (entry.surface.isConnected && entry.backdrop.isConnected) {
      return entry;
    }
  }
  return undefined;
}

function restoreBodyChild(element: HTMLElement): void {
  const snapshot = isolatedBodyChildren.get(element);
  if (!snapshot) {
    return;
  }
  if (snapshot.hadInert) {
    element.setAttribute("inert", snapshot.inertValue ?? "");
  } else {
    element.removeAttribute("inert");
  }
  if (snapshot.ariaHidden === null) {
    element.removeAttribute("aria-hidden");
  } else {
    element.setAttribute("aria-hidden", snapshot.ariaHidden);
  }
  isolatedBodyChildren.delete(element);
}

function restoreAllBodyChildren(): void {
  for (const element of Array.from(isolatedBodyChildren.keys())) {
    restoreBodyChild(element);
  }
}

function updateModalSemantics(): void {
  const topModal = getTopModal();
  for (const entry of openModalStack) {
    if (entry.surface.isConnected) {
      entry.surface.setAttribute("aria-modal", entry === topModal ? "true" : "false");
    }
  }
}

function syncModalIsolation(): void {
  const topModal = getTopModal();
  updateModalSemantics();
  if (!topModal) {
    restoreAllBodyChildren();
    return;
  }

  const nextIsolated = new Set(
    Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== topModal.backdrop),
  );

  for (const element of Array.from(isolatedBodyChildren.keys())) {
    if (!nextIsolated.has(element)) {
      restoreBodyChild(element);
    }
  }
  for (const element of nextIsolated) {
    if (!isolatedBodyChildren.has(element)) {
      isolatedBodyChildren.set(element, {
        hadInert: element.hasAttribute("inert"),
        inertValue: element.getAttribute("inert"),
        ariaHidden: element.getAttribute("aria-hidden"),
      });
    }
    element.setAttribute("inert", "");
    element.setAttribute("aria-hidden", "true");
  }
}

function startBodyChildrenObserver(): void {
  if (bodyChildrenObserver) {
    return;
  }
  bodyChildrenObserver = new MutationObserver(() => syncModalIsolation());
  bodyChildrenObserver.observe(document.body, { childList: true });
}

function stopBodyChildrenObserver(): void {
  bodyChildrenObserver?.disconnect();
  bodyChildrenObserver = null;
}

function focusElement(element: HTMLElement | null): boolean {
  if (!element || !isAvailableFocusTarget(element)) {
    return false;
  }
  element.focus({ preventScroll: true });
  return document.activeElement === element;
}

function focusModal(entry: OpenModalEntry): boolean {
  const preferred = entry.surface.querySelector<HTMLElement>("[data-modal-initial-focus]");
  if (focusElement(preferred)) {
    return true;
  }
  for (const element of getFocusableElements(entry.surface)) {
    if (focusElement(element)) {
      return true;
    }
  }
  return focusElement(entry.surface);
}

function focusDocumentFallback(excludedRoot: HTMLElement): void {
  const fallback = getFocusableElements(document.body)
    .find((element) => !excludedRoot.contains(element));
  if (focusElement(fallback ?? null)) {
    return;
  }

  const previousTabIndex = document.body.getAttribute("tabindex");
  document.body.setAttribute("tabindex", "-1");
  document.body.focus({ preventScroll: true });
  if (previousTabIndex === null) {
    document.body.removeAttribute("tabindex");
  } else {
    document.body.setAttribute("tabindex", previousTabIndex);
  }
}

function subscribeToHydration(): () => void {
  return () => undefined;
}

function BodyPortal({ children }: { children: ReactNode }) {
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  return hydrated ? createPortal(children, document.body) : null;
}

/**
 * body portal、背面の操作隔離、フォーカス対象となる面、幅、影を統一する土台。
 * 見出しや本文構成はModalHeader / ModalBodyへ分け、業務フローは持たない。
 */
export function ModalFrame({
  open,
  onDismiss,
  size = "md",
  embedded = false,
  layer = "base",
  closeOnEscape = true,
  ariaLabel,
  ariaLabelledBy,
  surfaceClassName,
  className,
  children,
  onMouseDown,
  onPointerDown,
  ...props
}: ModalFrameProps) {
  if (!open) {
    return null;
  }

  const frame = (
    <OpenModalFrame
      onDismiss={onDismiss}
      size={size}
      embedded={embedded}
      layer={layer}
      closeOnEscape={closeOnEscape}
      ariaLabel={ariaLabel}
      ariaLabelledBy={ariaLabelledBy}
      surfaceClassName={surfaceClassName}
      className={className}
      onMouseDown={onMouseDown}
      onPointerDown={onPointerDown}
      {...props}
    >
      {children}
    </OpenModalFrame>
  );
  return embedded ? frame : <BodyPortal>{frame}</BodyPortal>;
}

function OpenModalFrame({
  onDismiss,
  size,
  embedded,
  layer,
  closeOnEscape,
  ariaLabel,
  ariaLabelledBy,
  surfaceClassName,
  className,
  children,
  onMouseDown,
  onPointerDown,
  ...props
}: Omit<ModalFrameProps, "open">) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const stackId = useRef(Symbol("modal"));
  const onDismissRef = useRef(onDismiss);
  const closeOnEscapeRef = useRef(closeOnEscape);

  useEffect(() => {
    onDismissRef.current = onDismiss;
    closeOnEscapeRef.current = closeOnEscape;
  }, [closeOnEscape, onDismiss]);

  useEffect(() => {
    if (embedded) {
      return;
    }

    const modalId = stackId.current;
    const surface = surfaceRef.current;
    const backdrop = backdropRef.current;
    if (!surface || !backdrop) {
      return;
    }
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry = { id: modalId, surface, backdrop };
    openModalStack.push(entry);
    restoreBodyChild(backdrop);
    updateModalSemantics();
    focusElement(surface);
    syncModalIsolation();
    startBodyChildrenObserver();

    const frame = window.requestAnimationFrame(() => {
      if (getTopModal()?.id === modalId) {
        focusModal(entry);
      }
    });

    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (getTopModal()?.id !== modalId) {
        return;
      }
      if (event.key === "Escape" && closeOnEscapeRef.current) {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-toolbar-popover], [data-toolbar-popover-anchor-open]")) {
          return;
        }
        // 数式入力中の Escape は編集の取り消しであり、モーダルを閉じない。
        if (target?.closest("math-field")) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onDismissRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      // Portalled controls owned by this modal are appended to its backdrop so
      // they can escape the surface's overflow without becoming inert. Include
      // those controls in the same focus scope as the dialog surface.
      const focusable = getFocusableElements(backdrop);
      const first = focusable[0];
      const last = focusable.at(-1);
      const activeElement = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        focusElement(surface);
      } else if (!backdrop.contains(activeElement)) {
        event.preventDefault();
        focusElement(event.shiftKey ? last : first);
      } else if (event.shiftKey && (activeElement === first || activeElement === surface)) {
        event.preventDefault();
        focusElement(last);
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        focusElement(first);
      }
    };
    const onDocumentFocusIn = (event: FocusEvent) => {
      if (getTopModal()?.id !== modalId || backdrop.contains(event.target as Node)) {
        return;
      }
      focusModal(entry);
    };
    document.addEventListener("keydown", onDocumentKeyDown, true);
    document.addEventListener("focusin", onDocumentFocusIn, true);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      document.removeEventListener("focusin", onDocumentFocusIn, true);
      const index = openModalStack.findIndex((entry) => entry.id === modalId);
      const wasTopModal = index === openModalStack.length - 1;
      if (index >= 0) {
        openModalStack.splice(index, 1);
      }
      const nextTopModal = getTopModal();
      if (nextTopModal) {
        restoreBodyChild(nextTopModal.backdrop);
      } else {
        restoreAllBodyChildren();
      }
      updateModalSemantics();

      if (wasTopModal) {
        const restoredPreviousFocus = focusElement(previouslyFocused);
        if (!restoredPreviousFocus && nextTopModal) {
          focusModal(nextTopModal);
        } else if (!restoredPreviousFocus && !nextTopModal) {
          focusDocumentFallback(backdrop);
        }
      }

      syncModalIsolation();
      if (openModalStack.length === 0) {
        stopBodyChildrenObserver();
      }
    };
  }, [embedded]);

  const surface = (
    <div
      ref={surfaceRef}
      className={[styles.surface, surfaceClassName].filter(Boolean).join(" ")}
      data-size={size}
      data-embedded={embedded}
      role={embedded ? undefined : "dialog"}
      aria-modal={embedded ? undefined : true}
      aria-label={embedded ? undefined : ariaLabel}
      aria-labelledby={embedded || ariaLabel ? undefined : ariaLabelledBy ?? titleId}
      tabIndex={embedded ? undefined : -1}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <ModalTitleIdContext.Provider value={titleId}>{children}</ModalTitleIdContext.Provider>
    </div>
  );

  if (embedded) {
    return surface;
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    onPointerDown?.(event);
    if (!event.defaultPrevented && event.target === event.currentTarget) {
      onDismiss();
    }
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    onMouseDown?.(event);
  };

  return (
    <div
      {...props}
      ref={backdropRef}
      className={[styles.backdrop, className].filter(Boolean).join(" ")}
      data-layer={layer}
      data-modal-backdrop=""
      role="presentation"
      onPointerDown={handlePointerDown}
      onMouseDown={handleMouseDown}
    >
      {surface}
    </div>
  );
}

interface ModalHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  hideCloseButton?: boolean;
  actions?: ReactNode;
  titleId?: string;
}

/**
 * ダイアログの見出し階層と、必要に応じた右上の閉じる操作を固定するヘッダー。
 * 閉じる操作を本文やフッターへ重複させないための共通境界でもある。
 */
export function ModalHeader({
  title,
  description,
  onClose,
  hideCloseButton = false,
  actions,
  titleId,
  className,
  ...props
}: ModalHeaderProps) {
  const t = useT("common");
  const contextTitleId = useContext(ModalTitleIdContext);
  const generatedTitleId = useId();
  return (
    <header {...props} className={[styles.header, className].filter(Boolean).join(" ")}>
      <div className={styles.heading}>
        <h2 className={styles.title} id={titleId ?? contextTitleId ?? generatedTitleId}>{title}</h2>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
      {actions || !hideCloseButton ? (
        <div className={styles.actions}>
          {actions}
          {!hideCloseButton ? (
            <IconButton label={t("actions.close")} tone="ghost" size="sm" onClick={onClose}>
              <X size={17} aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

/**
 * モーダル本文のスクロール領域と標準内側余白を管理する。
 * セクション間隔は本文内のStackなどへ委ねる。
 */
export function ModalBody({
  className,
  padding = "xl",
  scroll = "auto",
  ...props
}: HTMLAttributes<HTMLDivElement> & { padding?: "none" | "lg" | "xl"; scroll?: "auto" | "hidden" | "visible" }) {
  return (
    <div
      {...props}
      className={[styles.body, className].filter(Boolean).join(" ")}
      data-padding={padding}
      data-scroll={scroll}
    />
  );
}
