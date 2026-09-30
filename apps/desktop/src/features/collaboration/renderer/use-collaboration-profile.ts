"use client";

import { useEffect, useState } from "react";

import { getDesktopBridge } from "@/lib/desktop-bridge";

import type { CollaborationProfile } from "../model/bridge";

/**
 * The signed-in account of the main-process auth authority, or null while signed out or when this build has
 * no collaboration bridge. It follows account changes announced by the shared catalog, so a sign-in or an
 * account switch in the account menu reaches screens that only read the profile.
 */
export function useCollaborationProfile(): CollaborationProfile | null {
  const desktop = getDesktopBridge();
  const bridge = desktop?.collaboration;
  const catalog = desktop?.sharedCatalog;
  const [profile, setProfile] = useState<CollaborationProfile | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    const load = () => {
      void bridge.info()
        .then((info) => { if (!disposed) setProfile(info.user); })
        .catch(() => { if (!disposed) setProfile(null); });
    };
    load();
    const unsubscribe = catalog?.onChange(load);
    return () => { disposed = true; unsubscribe?.(); };
  }, [bridge, catalog]);
  return profile;
}
