"use client";

import { Star } from "lucide-react";
import { useEffect, useState } from "react";

import { APP_READY_EVENT, SPLASH_MARKER_ATTRIBUTE } from "@/components/StartupSplash";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Stack } from "@/components/ui/layout";
import { useT } from "@/lib/i18n/react";
import { GITHUB_REPOSITORY_URL } from "@/lib/project-links";
import buttonStyles from "@/components/ui/Button.module.css";
import styles from "./GitHubStarDialog.module.css";

export const STAR_PROMPT_DELAY_MS = 60_000;
export const STAR_PROMPT_IDLE_MS = 10_000;
// Separate explicit opt-out from the legacy flag written by every close action.
export const STAR_PROMPT_DISABLED_KEY = "sigma-studio:github-star-disabled:v1";

// Keep dismissal across remounts, but invite again on the next app launch.
let dismissedThisSession = false;

/** Standalone app only: mounted by the home route, never by the embedded Editor. */
export function GitHubStarDialog() {
  const t = useT("workspace");
  const [open, setOpen] = useState(false);
  const [optOutFailed, setOptOutFailed] = useState(false);

  useEffect(() => {
    if (dismissedThisSession) return;
    try {
      if (window.localStorage.getItem(STAR_PROMPT_DISABLED_KEY) === "1") return;
    } catch {
      // Normal dismissal remains available without profile storage.
    }
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
    const storage = (event: StorageEvent) => {
      if (event.key === STAR_PROMPT_DISABLED_KEY && event.newValue === "1") {
        dismissedThisSession = true;
        setOpen(false);
        window.clearInterval(timer);
      }
    };
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
    window.addEventListener("storage", storage);
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
      window.removeEventListener("storage", storage);
      document.removeEventListener("visibilitychange", resetInput);
    };
  }, []);

  const dismiss = () => {
    dismissedThisSession = true;
    setOpen(false);
  };

  const disablePrompt = () => {
    try {
      window.localStorage.setItem(STAR_PROMPT_DISABLED_KEY, "1");
      dismiss();
    } catch {
      setOptOutFailed(true);
    }
  };

  return (
    <ModalFrame open={open} onDismiss={dismiss} size="sm" className={styles.backdrop}>
      <ModalHeader title={t("githubStar.title")} description={t("githubStar.description")} onClose={dismiss} />
      <ModalBody>
        <Stack gap="lg">
          <a className={`${buttonStyles.button} ${styles.link}`} data-tone="primary" data-size="lg" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" onClick={dismiss}>
            <Star size={16} aria-hidden="true" />
            {t("githubStar.openGitHub")}
          </a>
          <Button onClick={disablePrompt}>{t("githubStar.doNotShowAgain")}</Button>
          <span className={styles.note}>{t("githubStar.dismissNote")}</span>
          {optOutFailed ? <span className={styles.error} role="alert">{t("githubStar.optOutFailed")}</span> : null}
        </Stack>
      </ModalBody>
    </ModalFrame>
  );
}
