"use client";
import { useSyncExternalStore, type ReactNode } from "react";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { SharedWebApp } from "./SharedWebApp";
const subscribe = () => () => {};
const desktopSnapshot = () => Boolean(getDesktopBridge());
const serverSnapshot = () => false;
export function AppEntry({ desktop }: { desktop: ReactNode }) {
  const desktopRuntime = useSyncExternalStore(subscribe, desktopSnapshot, serverSnapshot);
  return process.env.NEXT_PUBLIC_SIGMA_WEB_SHARED_ONLY === "true" && !desktopRuntime ? <SharedWebApp /> : desktop;
}
