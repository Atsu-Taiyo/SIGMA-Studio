"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { APP_READY_EVENT, SPLASH_MARKER_ATTRIBUTE } from "@/components/StartupSplash";

export const INVITATION_IDLE_MS = 10_000;
const dismissedInvitations = new Set<string>();
let activeInvitation: symbol | null = null;
const alwaysInvite = () => true;

/** Shared startup/idle guards and mutual exclusion for home-route invitations. */
export function useIdleInvitation(id: string, delayMs: number, shouldInvite = alwaysInvite) {
  const [open, setOpen] = useState(false);
  const owner = useRef<symbol | null>(null);
  useEffect(() => {
    if (dismissedInvitations.has(id)) return;
    const reservation = Symbol(id);
    owner.current = reservation;
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
      if (dismissedInvitations.has(id)) return;
      if (readyAt === null || Date.now() - readyAt < delayMs || Date.now() - lastActivityAt < INVITATION_IDLE_MS) return;
      if (document.visibilityState !== "visible" || !document.hasFocus() || composing || pointerDown || keysDown.size) return;
      if (document.querySelector(`[${SPLASH_MARKER_ATTRIBUTE}], [data-modal-backdrop], [role="dialog"], [role="alertdialog"], [role="menu"]`)) return;
      if (document.activeElement?.closest('input, textarea, select, [contenteditable="true"], math-field')) return;
      if (activeInvitation || !shouldInvite()) return;
      activeInvitation = reservation;
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
      if (activeInvitation === reservation) activeInvitation = null;
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
  }, [id, delayMs, shouldInvite]);

  const dismiss = useCallback(() => {
    dismissedInvitations.add(id);
    if (activeInvitation === owner.current) activeInvitation = null;
    setOpen(false);
  }, [id]);
  return { open, dismiss };
}
