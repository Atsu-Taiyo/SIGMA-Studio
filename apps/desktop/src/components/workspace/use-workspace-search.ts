import { useEffect, useState } from "react";
import { listWorkspaceSearchOverview, type WorkspaceOverview } from "@/lib/workspace-repository";

export interface WorkspaceLibrarySnapshot {
  source: WorkspaceOverview;
  overview: WorkspaceOverview | null;
  failed: boolean;
}

/**
 * A read-only snapshot across every workspace and shared item; reading it must never select or persist
 * another workspace. It is re-read whenever `source` changes while `active`.
 *
 * - `current` is the result for exactly this `source`, or null while it is being read (search shows a loading state).
 * - `latest` is the last overview that was read successfully, even when it belongs to an older `source`, so lists
 *   built from it (bookmarks, mentions) keep showing what they had instead of blinking empty on every refresh.
 */
export function useWorkspaceLibrary(active: boolean, source: WorkspaceOverview | null) {
  const [result, setResult] = useState<WorkspaceLibrarySnapshot | null>(null);
  const [latest, setLatest] = useState<WorkspaceOverview | null>(null);
  useEffect(() => {
    if (!active || !source) return;
    let disposed = false;
    const settle = (overview: WorkspaceOverview | null) => {
      if (disposed) return;
      setResult({ source, overview, failed: overview === null });
      if (overview) setLatest(overview);
    };
    void listWorkspaceSearchOverview()
      .then(value => settle(value.state === "ready" ? value.overview : null))
      .catch(() => settle(null));
    return () => { disposed = true; };
  }, [active, source]);
  return { latest, current: active && result?.source === source ? result : null };
}
