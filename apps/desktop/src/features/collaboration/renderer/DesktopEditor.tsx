"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  EditorShell,
  type EditorShellProps,
} from "@/components/editor/EditorShell";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { RendererDocumentSession } from "./session";
import { SharingControls } from "./SharingControls";
import { CollaborationAccountControl } from "./CollaborationAccountControl";
import type { CollaborationBridge, CollaborationInfo, SessionInfo } from "../model/bridge";

export async function readCollaborationInfo(
  bridge: CollaborationBridge,
  activeFileId: string | null,
): Promise<CollaborationInfo> {
  let info = await bridge.info();
  if (activeFileId && info.sessions.some((session) => session.binding.localFileId === activeFileId)) {
    await bridge.view(activeFileId);
    info = await bridge.info();
  }
  return info;
}

export function reconcileRendererSessions(
  sessions: Map<string, RendererDocumentSession>,
  snapshots: SessionInfo[],
  bridge: CollaborationBridge,
  activeFileId: string | null,
  commitView: (notify: () => void) => void = flushSync,
): void {
  const present = new Set(snapshots.map((snapshot) => snapshot.binding.localFileId));
  for (const [fileId, session] of sessions) {
    if (!present.has(fileId)) {
      session.destroy();
      sessions.delete(fileId);
    }
  }
  for (const snapshot of snapshots) {
    const previous = sessions.get(snapshot.binding.localFileId);
    if (!previous || previous.info.binding.epoch !== snapshot.binding.epoch) {
      previous?.destroy();
      const created = new RendererDocumentSession(snapshot, bridge, commitView);
      created.setActive(activeFileId === snapshot.binding.localFileId);
      sessions.set(snapshot.binding.localFileId, created);
    }
  }
}

export function DesktopEditor() {
  const sessions = useRef(new Map<string, RendererDocumentSession>());
  const activeFileId = useRef<string | null>(null);
  const visibleFiles = useRef(new Map<string, number>());
  const restrictedFileIds = useRef(new Set<string>());
  const authorityListeners = useRef(new Set<() => void>());
  const [bootError, setBootError] = useState<Error | null>(null);
  const [info, setInfo] = useState<CollaborationInfo | null>(null);
  const refresh = useCallback(async () => {
    const bridge = getDesktopBridge()?.collaboration;
    if (!bridge) {
      setInfo({ configured: false, user: null, sessions: [], restrictedFileIds: [] });
      return;
    }
    const next = await readCollaborationInfo(bridge, activeFileId.current);
    restrictedFileIds.current = new Set(next.restrictedFileIds);
    reconcileRendererSessions(sessions.current, next.sessions, bridge, activeFileId.current);
    authorityListeners.current.forEach((listener) => listener());
    setInfo(next);
  }, []);
  useEffect(() => {
    const bridge = getDesktopBridge()?.collaboration;
    let mounted = true;
    const queued: Parameters<RendererDocumentSession["receive"]>[0][] = [];
    let ready = false;
    let refreshTail = Promise.resolve();
    const reload = () => {
      ready = false;
      refreshTail = refreshTail.then(refresh).then(() => {
        if (!mounted) return;
        ready = true;
        queued.splice(0).forEach((event) => sessions.current.get(event.fileId)?.receive(event));
      }).catch((error: unknown) => {
        if (mounted) setBootError(error instanceof Error ? error : new Error("SESSION_UNAVAILABLE"));
      });
    };
    const unsubscribe = bridge?.onEvent((event) => {
      if (event.type === "reset") {
        reload();
        return;
      }
      if (!ready) {
        queued.push(event);
        return;
      }
      sessions.current.get(event.fileId)?.receive(event);
    });
    reload();
    const compositionStart = () => {
      sessions.current.forEach((session) => session.composition(true));
    };
    const compositionEnd = () => {
      setTimeout(() => {
        if (mounted)
          sessions.current.forEach((session) => session.composition(false));
      }, 0);
    };
    window.addEventListener("compositionstart", compositionStart, true);
    window.addEventListener("compositionend", compositionEnd, true);
    const pageHide = () => {
      activeFileId.current = null;
      sessions.current.forEach((session) => session.setActive(false));
      visibleFiles.current.clear();
      void bridge?.visibleFiles?.([]);
      void bridge?.view(null);
    };
    window.addEventListener("pagehide", pageHide);
    const current = sessions.current;
    return () => {
      mounted = false;
      unsubscribe?.();
      window.removeEventListener("compositionstart", compositionStart, true);
      window.removeEventListener("compositionend", compositionEnd, true);
      window.removeEventListener("pagehide", pageHide);
      pageHide();
      current.forEach((session) => session.destroy());
      current.clear();
    };
  }, [refresh]);
  const host = useMemo(
    () => ({
      get: (fileId: string) => sessions.current.get(fileId),
      retainVisibleFile: (fileId: string) => {
        const retained = visibleFiles.current;
        retained.set(fileId, (retained.get(fileId) ?? 0) + 1);
        const publish = () => { void getDesktopBridge()?.collaboration?.visibleFiles?.([...retained.keys()]).catch(() => {}); };
        publish();
        return () => {
          const count = retained.get(fileId) ?? 0;
          if (count <= 1) retained.delete(fileId); else retained.set(fileId, count - 1);
          publish();
        };
      },
      setActiveFile: async (fileId: string | null) => {
        activeFileId.current = fileId;
        for (const [id, session] of sessions.current) session.setActive(id === fileId);
        await getDesktopBridge()?.collaboration?.view(fileId);
      },
      isReadOnly: (fileId: string) => restrictedFileIds.current.has(fileId) && !sessions.current.has(fileId),
      subscribeAuthority: (listener: () => void) => {
        authorityListeners.current.add(listener);
        return () => authorityListeners.current.delete(listener);
      },
    }),
    [],
  );
  const renderActions: NonNullable<
    EditorShellProps["renderDocumentActions"]
  > = (context) => (
    <SharingControls
      key={context.fileId}
      context={context}
      info={info!}
      session={sessions.current.get(context.fileId)}
      refresh={refresh}
    />
  );
  if (bootError) throw bootError;
  if (!info) return null;
  return (
    <EditorShell
      sessionHost={host}
      renderDocumentActions={renderActions}
      accountAction={<CollaborationAccountControl info={info} refresh={refresh} />}
    />
  );
}
