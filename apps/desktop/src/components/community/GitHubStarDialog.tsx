"use client";

import { Star } from "lucide-react";
import { useEffect, useState } from "react";

import { APP_READY_EVENT, SPLASH_MARKER_ATTRIBUTE } from "@/components/StartupSplash";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { useT } from "@/lib/i18n/react";
import { GITHUB_REPOSITORY_URL } from "@/lib/project-links";
import buttonStyles from "@/components/ui/Button.module.css";
import styles from "./GitHubStarDialog.module.css";

export const STAR_PROMPT_DELAY_MS = 60_000;
export const STAR_PROMPT_IDLE_MS = 10_000;

// The invitation has no permanent opt-out: it returns on every app launch.
// Closing it only keeps it away for the rest of this session (including remounts).
let dismissedThisSession = false;

/** Standalone app only: mounted by the home route, never by the embedded Editor. */
export function GitHubStarDialog() {
  const t = useT("workspace");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (dismissedThisSession) return;
    let readyAt: number | null = null;
    let lastActivityAt = Date.now();
    let composing = false;
    let pointerDown = false;
    const keysDown = new Set<string>();
    const activity = () => { lastActivityAt = Date.now(); };
    const ready = () => { readyAt ??= Date.now(); activity(); };
    const beginComposition = () => { composing = true; activity(); };
    const endComposition = () => { composing = false; activity(); };
    const pressPointer = () => { pointerDown = true; activity(); };
    const releasePointer = () => { pointerDown = false; activity(); };
    const pressKey = (event: KeyboardEvent) => { keysDown.add(event.code); activity(); };
    const releaseKey = (event: KeyboardEvent) => { keysDown.delete(event.code); activity(); };
    const resetInput = () => { composing = false; pointerDown = false; keysDown.clear(); activity(); };
    const check = () => {
      if (readyAt === null || Date.now() - readyAt < STAR_PROMPT_DELAY_MS || Date.now() - lastActivityAt < STAR_PROMPT_IDLE_MS) return;
      if (document.visibilityState !== "visible" || !document.hasFocus() || composing || pointerDown || keysDown.size) return;
      if (document.querySelector(`[${SPLASH_MARKER_ATTRIBUTE}], [data-modal-backdrop], [role="dialog"], [role="alertdialog"], [role="menu"]`)) return;
      if (document.activeElement?.closest('input, textarea, select, [contenteditable="true"], math-field')) return;
      setOpen(true);
      window.clearInterval(timer);
    };
    const timer = window.setInterval(check, 1000);
    window.addEventListener(APP_READY_EVENT, ready);
    window.addEventListener("pointermove", activity, { passive: true });
    window.addEventListener("wheel", activity, { passive: true });
    window.addEventListener("pointerdown", pressPointer, true);
    window.addEventListener("pointerup", releasePointer, true);
    window.addEventListener("pointercancel", releasePointer, true);
    window.addEventListener("keydown", pressKey, true);
    window.addEventListener("keyup", releaseKey, true);
    window.addEventListener("compositionstart", beginComposition, true);
    window.addEventListener("compositionend", endComposition, true);
    window.addEventListener("blur", resetInput);
    window.addEventListener("focus", activity);
    document.addEventListener("visibilitychange", resetInput);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(APP_READY_EVENT, ready);
      window.removeEventListener("pointermove", activity);
      window.removeEventListener("wheel", activity);
      window.removeEventListener("pointerdown", pressPointer, true);
      window.removeEventListener("pointerup", releasePointer, true);
      window.removeEventListener("pointercancel", releasePointer, true);
      window.removeEventListener("keydown", pressKey, true);
      window.removeEventListener("keyup", releaseKey, true);
      window.removeEventListener("compositionstart", beginComposition, true);
      window.removeEventListener("compositionend", endComposition, true);
      window.removeEventListener("blur", resetInput);
      window.removeEventListener("focus", activity);
      document.removeEventListener("visibilitychange", resetInput);
    };
  }, []);

  const dismiss = () => {
    dismissedThisSession = true;
    setOpen(false);
  };

  return (
    <ModalFrame open={open} onDismiss={dismiss} size="sm" className={styles.backdrop}>
      <ModalHeader title={t("githubStar.title")} description={t("githubStar.description")} onClose={dismiss} />
      <ModalBody>
        <a className={`${buttonStyles.button} ${styles.link}`} data-tone="primary" data-size="lg" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" onClick={dismiss}>
          <Star size={16} aria-hidden="true" />
          {t("githubStar.openGitHub")}
        </a>
      </ModalBody>
    </ModalFrame>
  );
}
