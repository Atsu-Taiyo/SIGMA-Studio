"use client";

import { useEffect, useState } from "react";

export type InlineMathInputMode = "mathlive" | "tex";

const STORAGE_KEY = "sigma-studio:inline-math-input-mode";
const CHANGE_EVENT = "sigma-studio:inline-math-input-mode-change";
const VALID_MODES: ReadonlySet<InlineMathInputMode> = new Set(["mathlive", "tex"]);

export function getInlineMathInputMode(): InlineMathInputMode {
  if (typeof window === "undefined") {
    return "mathlive";
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw && VALID_MODES.has(raw as InlineMathInputMode) ? (raw as InlineMathInputMode) : "mathlive";
}

export function setInlineMathInputMode(mode: InlineMathInputMode): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent<InlineMathInputMode>(CHANGE_EVENT, { detail: mode }));
}

export function useInlineMathInputMode(): [InlineMathInputMode, (mode: InlineMathInputMode) => void] {
  const [mode, setMode] = useState<InlineMathInputMode>(() => getInlineMathInputMode());

  useEffect(() => {
    const handleChange = (event: Event) => {
      const detail = (event as CustomEvent<InlineMathInputMode>).detail;
      if (detail && VALID_MODES.has(detail)) {
        setMode(detail);
      } else {
        setMode(getInlineMathInputMode());
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        setMode(getInlineMathInputMode());
      }
    };
    window.addEventListener(CHANGE_EVENT, handleChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handleChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  return [mode, (next: InlineMathInputMode) => setInlineMathInputMode(next)];
}
