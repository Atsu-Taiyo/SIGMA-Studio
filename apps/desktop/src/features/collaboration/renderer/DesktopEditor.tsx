"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  EditorShell,
  type EditorShellProps,
} from "@/components/editor/EditorShell";
import { EditorHostProvider } from "@/components/editor/editor-shell/editor-host";
import { DESKTOP_EDITOR_HOST } from "@/components/editor/editor-shell/desktop-editor-host";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { RendererDocumentSession } from "./session";
import { SelectionLinkButton } from "./SelectionLinkButton";
import { SharingControls } from "./SharingControls";
import { CollaborationAccountControl } from "./CollaborationAccountControl";
import { collaborationAvatarSource, collaborationProfileFromRecord } from "../model/profile-avatar";
import type { CollaborationBridge, CollaborationInfo, SessionInfo } from "../model/bridge";

export async function readCollaborationInfo(
  bridge: CollaborationBridge,
  activeFileId: string | null,
  /** Schedule a new info read after the background network sync, outside the info queue. */
  afterView?: () => void,
): Promise<CollaborationInfo> {
  const info = await bridge.info();
  if (activeFileId && info.sessions.some((session) => session.binding.localFileId === activeFileId)) {
    // A slow view must never hold the queue that announces another file's session.
    void bridge.view(activeFileId).then(afterView, () => {});
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
  const attachSession = useRef<(fileId: string, shared: boolean) => Promise<void>>(async () => {});
  const refreshAfterView = useRef<() => void>(() => {});
  const [bootError, setBootError] = useState<Error | null>(null);
  const [info, setInfo] = useState<CollaborationInfo | null>(null);
  const refresh = useCallback(async (reassertView = true) => {
    const bridge = getDesktopBridge()?.collaboration;
    if (!bridge) {
      setInfo({ configured: false, user: null, sessions: [], restrictedFileIds: [] });
      return;
    }
    const apply = (value: CollaborationInfo) => {
      restrictedFileIds.current = new Set(value.restrictedFileIds);
      reconcileRendererSessions(sessions.current, value.sessions, bridge, activeFileId.current);
      authorityListeners.current.forEach((listener) => listener());
    };
    const next = await readCollaborationInfo(bridge, reassertView ? activeFileId.current : null, () => refreshAfterView.current());
    apply(next);
    setInfo(next);
  }, []);
  useEffect(() => {
    const bridge = getDesktopBridge()?.collaboration;
    let mounted = true;
    const queued: Parameters<RendererDocumentSession["receive"]>[0][] = [];
    let ready = false;
    let refreshTail = Promise.resolve();
    const reload = (reassertView = true) => {
      ready = false;
      refreshTail = refreshTail.then(() => refresh(reassertView)).then(() => {
        if (!mounted) return;
        ready = true;
        queued.splice(0).forEach((event) => sessions.current.get(event.fileId)?.receive(event));
      }).catch((error: unknown) => {
        if (mounted) setBootError(error instanceof Error ? error : new Error("SESSION_UNAVAILABLE"));
      });
    };
    refreshAfterView.current = () => { if (mounted) reload(false); };
    // Wait for the session of a shared file: main announces it ("reset") before answering
    // the read that opened it. If it is still missing once the reread under way is done
    // (a missed announcement), reread through the same queue.
    attachSession.current = (fileId, shared) => {
      if (!shared || sessions.current.has(fileId)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const finish = () => {
          authorityListeners.current.delete(check);
          resolve();
        };
        const check = () => {
          if (!mounted || sessions.current.has(fileId)) finish();
        };
        authorityListeners.current.add(check);
        void refreshTail.then(() => {
          if (!mounted || sessions.current.has(fileId)) return finish();
          reload();
          void refreshTail.then(finish);
        });
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
      refreshAfterView.current = () => {};
      attachSession.current = async () => {};
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
      attachSession: (fileId: string, shared: boolean) => attachSession.current(fileId, shared),
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
  const user = info?.user;
  // Google のアイコンは CSP (img-src) が直接は読ませないので、ヘッダーのアイコンと同じく main の経路から読む。
  const commentIdentity = useMemo(() => user ? {
    userId: user.actorId,
    name: user.displayName || user.email || user.actorId,
    avatarUrl: collaborationAvatarSource(user),
  } : undefined, [user]);
  // 名前とアイコンは、本人が決めたもの (共有サーバーに保存) → Google のもの → メールの順。
  const loadCommentPeople = useCallback(async (userIds: string[]) => {
    const bridge = getDesktopBridge()?.collaboration;
    if (!bridge?.profiles || !user || userIds.length === 0) return [];
    const records = await bridge.profiles(userIds);
    return records.flatMap((record) => {
      const profile = collaborationProfileFromRecord(record);
      return profile.displayName
        ? [{ userId: record.userId, name: profile.displayName, avatarUrl: collaborationAvatarSource(profile) }]
        : [];
    });
  }, [user]);
  const loadCommentMentionCandidates = useCallback(async (fileId: string) => {
    const bridge = getDesktopBridge()?.collaboration;
    if (!bridge || !user || !sessions.current.has(fileId)) return [];
    const members = (await bridge.members(fileId)).filter((member) => member.user_id !== user.actorId);
    const people = new Map((await loadCommentPeople(members.map((member) => member.user_id)).catch(() => []))
      .map((person) => [person.userId, person]));
    return members.map((member) => {
      const person = people.get(member.user_id);
      return {
        userId: member.user_id,
        name: person?.name || member.email || member.user_id,
        email: member.email || undefined,
        ...(person?.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
      };
    });
  }, [loadCommentPeople, user]);
  if (bootError) throw bootError;
  if (!info) return null;
  return (
    <EditorHostProvider services={DESKTOP_EDITOR_HOST}>
    <EditorShell
      sessionHost={host}
      commentIdentity={commentIdentity}
      loadCommentMentionCandidates={loadCommentMentionCandidates}
      loadCommentPeople={loadCommentPeople}
      renderDocumentActions={renderActions}
      renderSelectionActions={({ fileId, document, metadata, anchor }) => metadata?.sharing?.state === "active" && metadata.sharing.capabilities.read
        ? <SelectionLinkButton key={`${fileId}:${JSON.stringify(anchor)}`} target={metadata.sharing.target} anchor={anchor} title={document.metadata.title} /> : null}
      accountAction={<CollaborationAccountControl info={info} refresh={refresh} />}
    />
    </EditorHostProvider>
  );
}
