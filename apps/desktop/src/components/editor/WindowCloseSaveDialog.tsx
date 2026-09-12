"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/lib/i18n/react";

const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface WindowCloseSaveDialogProps {
  error: string;
  saving: boolean;
  onRetry: () => void;
  onCloseWithoutSaving: () => void;
  onCancel: () => void;
}

export function WindowCloseSaveDialog({
  error,
  saving,
  onRetry,
  onCloseWithoutSaving,
  onCancel,
}: WindowCloseSaveDialogProps) {
  const t = useT("editor");
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const backgroundShells = Array.from(document.querySelectorAll<HTMLElement>(".app-shell"))
      .map((element) => ({
        element,
        hadInert: element.hasAttribute("inert"),
        inertValue: element.getAttribute("inert"),
      }));
    for (const { element } of backgroundShells) element.setAttribute("inert", "");
    retryButtonRef.current?.focus({ preventScroll: true });

    const containDialogFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR));
      const first = focusable[0];
      const last = focusable.at(-1);
      const activeElement = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
      } else if (!dialog.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (event.shiftKey && (activeElement === first || activeElement === dialog)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", containDialogFocus, true);
    return () => {
      document.removeEventListener("keydown", containDialogFocus, true);
      for (const { element, hadInert, inertValue } of backgroundShells) {
        if (!hadInert) element.removeAttribute("inert");
        else element.setAttribute("inert", inertValue ?? "");
      }
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      className="workspace-create-backdrop window-close-save-backdrop"
      data-modal-backdrop=""
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className="workspace-create-dialog window-close-save-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-create-header">
          <div>
            <h2 id={titleId}>{t("windowCloseSave.title")}</h2>
          </div>
        </header>
        <div className="workspace-create-form">
          <p id={descriptionId} className="workspace-delete-warning">
            {t("windowCloseSave.description")}
          </p>
          <p className="workspace-delete-warning" role="alert">{error}</p>
          <footer>
            <button type="button" className="button secondary" disabled={saving} onClick={onCancel}>
              {t("windowCloseSave.cancel")}
            </button>
            <button type="button" className="button secondary" disabled={saving} onClick={onCloseWithoutSaving}>
              {t("windowCloseSave.closeWithoutSaving")}
            </button>
            <button ref={retryButtonRef} type="button" className="button primary" disabled={saving} onClick={onRetry}>
              {t("windowCloseSave.retry")}
            </button>
          </footer>
        </div>
      </section>
    </div>,
    window.document.body,
  );
}
