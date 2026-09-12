import type { DesktopAPI } from "@/types/desktop";

export function getDesktopBridge(): DesktopAPI | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.desktopAPI ?? null;
}

export function isDesktop(): boolean {
  return Boolean(getDesktopBridge());
}
