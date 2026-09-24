"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Check,
  Cloud,
  CloudOff,
  Copy,
  Share2,
  UserRound,
  RefreshCw,
  History,
  LogOut,
  X,
} from "lucide-react";
import { WorkspaceSharingDialog } from "@/components/workspace/WorkspaceSharingDialog";
import { useMemo } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { ModalFrame, ModalHeader, ModalBody } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Stack, Inline } from "@/components/ui/layout";
import { Shimmer } from "@/components/ui/Shimmer";
import { useT } from "@/lib/i18n/react";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import type { EditorShellProps } from "@/components/editor/EditorShell";
import type { CollaborationInfo, SharedBackup } from "../model/bridge";
import type { MemberRole, SaveState } from "../model/protocol";
import type { RendererDocumentSession } from "./session";
import styles from "./sharing.module.css";
import { CollaborationProfileAvatar, collaborationProfileLabel } from "./CollaborationProfileAvatar";

const EMPTY_ROSTER: ReturnType<RendererDocumentSession["roster"]> = [];

interface Props {
  context: Parameters<
    NonNullable<EditorShellProps["renderDocumentActions"]>
  >[0];
  info: CollaborationInfo;
  session?: RendererDocumentSession;
  refresh: () => Promise<void>;
}
export function SharingControls({ context, info, session, refresh }: Props) {
  const t = useT("chrome");
  const bridge = getDesktopBridge()?.collaboration;
  const catalog = getDesktopBridge()?.sharedCatalog;
  const [catalogOpen, setCatalogOpen] = useState(false);
  const target = useMemo(() => ({ source: "local" as const, local: { kind: "document" as const, fileId: context.fileId } }), [context.fileId]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [invite, setInvite] = useState("");
  const [inviteHash, setInviteHash] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [joined, setJoined] = useState(false);
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [members, setMembers] = useState<
    { user_id: string; role: MemberRole; email: string }[]
  >([]);
  const [backups, setBackups] = useState<SharedBackup[]>([]);
  const [removing, setRemoving] = useState<{
    user_id: string;
    email: string;
  } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [ending, setEnding] = useState<"stop" | "delete" | "leave" | null>(
    null,
  );
  const status = useSyncExternalStore<SaveState>(
    (listener) => session?.subscribeStatus(listener) ?? (() => {}),
    () => session?.status ?? "saved",
    () => "saved",
  );
  const roster = useSyncExternalStore(
    (listener) => session?.subscribePresence(listener) ?? (() => {}),
    () => session?.roster() ?? EMPTY_ROSTER,
    () => EMPTY_ROSTER,
  );
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(false);
    try {
      await action();
      await refresh();
    } catch (cause) {
      if (!(cause instanceof Error && cause.message.includes("AUTH_CANCELLED"))) setError(true);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => () => { void bridge?.cancelSignIn(); }, [bridge]);
  const readMembers = async () => {
    if (bridge && session) setMembers(await bridge.members(context.fileId));
  };
  useEffect(() => {
    if (open && session && bridge)
      void bridge
        .members(context.fileId)
        .then(setMembers)
        .catch(() => setError(true));
  }, [open, session, context.fileId, bridge]);
  if (!bridge) return null;
  const roleOptions = [
    { value: "editor", label: t("collaboration.editor") },
    { value: "viewer", label: t("collaboration.viewer") },
  ];
  const close = () => {
    if (!busy) {
      setOpen(false);
      setEnding(null);
      setRemoving(null);
      setRestoring(null);
    }
  };
  return (
    <>
      <Inline gap="sm">
        {roster.length > 0 && (
          <span className={styles.roster} role="group" aria-label={t("collaboration.viewers", { count: roster.length })}>
            {roster.slice(0, 3).map((participant) => {
              const name = collaborationProfileLabel(participant.profile, t("collaboration.googleAccount"));
              const label = t("collaboration.clientLabel", { name, client: participant.clientId.slice(0, 6) });
              return <CollaborationProfileAvatar key={participant.clientId} profile={participant.profile} label={label} size="sm" />;
            })}
            {roster.length > 3 && (
              <span className={`${styles.avatar} ${styles.avatar_sm} ${styles.rosterMore}`} title={t("collaboration.moreViewers", { count: roster.length - 3 })} aria-label={t("collaboration.moreViewers", { count: roster.length - 3 })}>
                +{roster.length - 3}
              </span>
            )}
          </span>
        )}
        {session && (
          <span
            className={styles.status}
            title={t(`collaboration.status.${status}`)}
            aria-label={t(`collaboration.status.${status}`)}
            role="status"
          >
            {status === "saved" ? (
              <Cloud size={16} />
            ) : status === "offline" ||
              status === "permission-error" ||
              status === "save-error" ||
              status === "epoch-error" ? (
              <CloudOff size={16} />
            ) : (
              <Shimmer>{<Cloud size={16} />}</Shimmer>
            )}
          </span>
        )}
        <Button size="sm" tone="ghost" onClick={() => catalog ? setCatalogOpen(true) : setOpen(true)}>
          <Share2 size={15} />
          {t("collaboration.share")}
        </Button>
      </Inline>
      {catalogOpen && catalog && <WorkspaceSharingDialog target={target} name={context.document.metadata.title}
        onClose={() => setCatalogOpen(false)} onChanged={() => void refresh()}
        onOpenDetails={session ? () => { setCatalogOpen(false); setOpen(true); } : undefined}
        startTarget={async () => {
          const saved = await context.flush();
          if (saved && typeof saved === "object" && "ok" in saved && saved.ok === false) throw new Error("SAVE_FAILED");
          const before = context.getDocument();
          await catalog.start(target.local);
          const current = context.getDocument();
          const snapshot = (await bridge.info()).sessions.find((item) => item.binding.localFileId === context.fileId);
          if (snapshot && current !== before) {
            const { RendererDocumentSession } = await import("./session");
            const pending = new RendererDocumentSession(snapshot, bridge);
            try { pending.change(pending.project(), current); await pending.flush(); } finally { pending.destroy(); }
          }
        }} />}
      <ModalFrame open={open} onDismiss={close} size="sm">
        <ModalHeader
          title={
            removing
              ? t("collaboration.confirmRemove")
              : restoring
                ? t("collaboration.confirmRestore")
                : ending
                  ? t("collaboration.confirmEnd")
                  : t(catalog ? "collaboration.details" : "collaboration.title")
          }
          onClose={close}
        />
        <ModalBody>
          <Stack gap="lg">
            {removing ? (
              <>
                <p>{removing.email}</p>
                <Inline gap="sm">
                  <Button disabled={busy} onClick={() => setRemoving(null)}>
                    {t("collaboration.cancel")}
                  </Button>
                  <Button
                    tone="danger"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await bridge.changeMember(
                          context.fileId,
                          removing.user_id,
                          null,
                        );
                        await readMembers();
                        setRemoving(null);
                      })
                    }
                  >
                    {t("collaboration.remove")}
                  </Button>
                </Inline>
              </>
            ) : restoring ? (
              <>
                <p>{t("collaboration.restoreDescription")}</p>
                <Inline gap="sm">
                  <Button disabled={busy} onClick={() => setRestoring(null)}>
                    {t("collaboration.cancel")}
                  </Button>
                  <Button
                    tone="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await bridge.restore(context.fileId, restoring);
                        setRestoring(null);
                      })
                    }
                  >
                    {t("collaboration.restore")}
                  </Button>
                </Inline>
              </>
            ) : ending ? (
              <>
                <p>{t("collaboration.endDescription")}</p>
                <Inline gap="sm">
                  <Button onClick={() => setEnding(null)} disabled={busy}>
                    {t("collaboration.cancel")}
                  </Button>
                  <Button
                    tone="danger"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await bridge.end(context.fileId, ending);
                        setEnding(null);
                      })
                    }
                  >
                    {t(`collaboration.${ending}`)}
                  </Button>
                </Inline>
              </>
            ) : !info.configured ? (
              <p>{t("collaboration.unconfigured")}</p>
            ) : !info.user ? (
              <>
                <Button
                  className={styles.googleButton}
                  disabled={busy}
                  onClick={() => {
                    setSigningIn(true);
                    void run(() => bridge.signInWithGoogle()).finally(() => setSigningIn(false));
                  }}
                >
                  <span className={styles.googleMark} aria-hidden="true" />
                  {signingIn ? t("collaboration.waitingForGoogle") : t("collaboration.signInWithGoogle")}
                </Button>
                {signingIn && (
                  <Button tone="ghost" onClick={() => void bridge.cancelSignIn()}>
                    {t("collaboration.cancel")}
                  </Button>
                )}
              </>
            ) : session ? (
              <>
                <Inline gap="sm">
                  <Cloud size={16} />
                  <span>{t(`collaboration.status.${status}`)}</span>
                  <IconButton
                    label={t("collaboration.retry")}
                    tone="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(() => bridge.flush(context.fileId, true))
                    }
                  >
                    <RefreshCw size={15} />
                  </IconButton>
                </Inline>
                {!catalog && <Stack gap="sm">
                  <span className={styles.caption}>
                    {t("collaboration.members")}
                  </span>
                  {members.map((member) => (
                    <Inline key={member.user_id} gap="sm">
                      <UserRound size={16} />
                      <span className={styles.member}>
                        {member.user_id === info.user?.actorId
                          ? t("collaboration.me")
                          : member.email}
                      </span>
                      {session.role === "owner" && member.role !== "owner" ? (
                        <Select
                          value={member.role}
                          disabled={busy}
                          aria-label={t("collaboration.members")}
                          options={[
                            ...roleOptions,
                            {
                              value: "remove",
                              label: t("collaboration.remove"),
                            },
                          ]}
                          onChange={(value) => {
                            if (value === "remove") {
                              setRemoving(member);
                              return;
                            }
                            void run(async () => {
                              await bridge.changeMember(
                                context.fileId,
                                member.user_id,
                                value as "editor" | "viewer",
                              );
                              await readMembers();
                            });
                          }}
                        />
                      ) : (
                        <span className={styles.caption}>
                          {t(`collaboration.${member.role}`)}
                        </span>
                      )}
                    </Inline>
                  ))}
                </Stack>}
                {!catalog && session.role === "owner" && (
                  <Stack gap="sm">
                    <Inline gap="sm">
                      <Select
                        aria-label={t("collaboration.invitation")}
                        value={role}
                        options={roleOptions}
                        onChange={(value) =>
                          setRole(value as "editor" | "viewer")
                        }
                      />
                      <Button
                        disabled={busy || status !== "saved"}
                        onClick={() =>
                          void run(async () => {
                            const result = await bridge.invite(
                              context.fileId,
                              role,
                            );
                            setInvite(result.token);
                            setInviteHash(result.tokenHash);
                            setCopied(false);
                          })
                        }
                      >
                        {t("collaboration.createInvitation")}
                      </Button>
                    </Inline>
                    {invite && (
                      <>
                        <Inline gap="sm">
                          <input
                            className={styles.code}
                            aria-label={t("collaboration.invitation")}
                            readOnly
                            value={invite}
                          />
                          <IconButton
                            label={t(
                              copied
                                ? "collaboration.copied"
                                : "collaboration.copyInvitation",
                            )}
                            onClick={() =>
                              void run(async () => {
                                await navigator.clipboard.writeText(invite);
                                setCopied(true);
                              })
                            }
                          >
                            {copied ? <Check size={16} /> : <Copy size={16} />}
                          </IconButton>
                        </Inline>
                        <Inline gap="sm">
                          <span className={styles.caption}>
                            {t("collaboration.expires")}
                          </span>
                          <IconButton
                            label={t("collaboration.revokeInvitation")}
                            tone="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await bridge.revokeInvitation(
                                  context.fileId,
                                  inviteHash,
                                );
                                setInvite("");
                              })
                            }
                          >
                            <X size={15} />
                          </IconButton>
                        </Inline>
                      </>
                    )}
                  </Stack>
                )}
                {status === "epoch-error" && (
                  <Stack gap="sm">
                    <p>{t("collaboration.epochDescription")}</p>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(() => bridge.reload(context.fileId))
                      }
                    >
                      {t("collaboration.reload")}
                    </Button>
                  </Stack>
                )}
                <details className={styles.details} open={Boolean(catalog)}>
                  <summary>{t("collaboration.details")}</summary>
                  <Stack gap="md">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(() => bridge.copy(context.fileId))
                      }
                    >
                      {t("collaboration.localCopy")}
                    </Button>
                    {session.role === "owner" && (
                      <>
                        <Inline gap="sm">
                          <Button
                            disabled={busy || status !== "saved"}
                            onClick={() =>
                              void run(async () => {
                                await bridge.backup(context.fileId);
                                setBackups(
                                  await bridge.backups(context.fileId),
                                );
                              })
                            }
                          >
                            <History size={15} />
                            {t("collaboration.backup")}
                          </Button>
                          <Button
                            tone="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run(async () =>
                                setBackups(
                                  await bridge.backups(context.fileId),
                                ),
                              )
                            }
                          >
                            {t("collaboration.backups")}
                          </Button>
                        </Inline>
                        {backups.map((backup) => (
                          <Inline key={backup.id} gap="sm">
                            <span className={styles.member}>
                              {new Date(backup.created_at).toLocaleString()}
                            </span>
                            <Button
                              size="sm"
                              tone="ghost"
                              disabled={busy}
                              onClick={() => setRestoring(backup.id)}
                            >
                              {t("collaboration.restore")}
                            </Button>
                          </Inline>
                        ))}
                      </>
                    )}
                    {!catalog && <Inline gap="sm">
                      {session.role === "owner" ? (
                        <>
                          <Button
                            tone="ghost"
                            disabled={busy}
                            onClick={() => setEnding("stop")}
                          >
                            {t("collaboration.stop")}
                          </Button>
                          <Button
                            tone="ghost"
                            disabled={busy}
                            onClick={() => setEnding("delete")}
                          >
                            {t("collaboration.delete")}
                          </Button>
                        </>
                      ) : (
                        <Button
                          tone="ghost"
                          disabled={busy}
                          onClick={() => setEnding("leave")}
                        >
                          {t("collaboration.leave")}
                        </Button>
                      )}
                    </Inline>}
                  </Stack>
                </details>
              </>
            ) : (
              <>
                <p>{t("collaboration.description")}</p>
                <Button
                  tone="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await context.flush();
                      const before = context.getDocument();
                      await bridge.start(context.fileId, before);
                      // Edits made while assets were uploading are committed after the one-time seed.
                      const current = context.getDocument();
                      const snapshot = (await bridge.info()).sessions.find(
                        (item) => item.binding.localFileId === context.fileId,
                      );
                      if (snapshot && current !== before) {
                        const { RendererDocumentSession } =
                          await import("./session");
                        const pending = new RendererDocumentSession(
                          snapshot,
                          bridge,
                        );
                        pending.change(pending.project(), current);
                        await pending.flush();
                        pending.destroy();
                      }
                    })
                  }
                >
                  {t("collaboration.start")}
                </Button>
                <label className={styles.field}>
                  {t("collaboration.invitation")}
                  <input
                    value={joinCode}
                    onChange={(event) => setJoinCode(event.target.value.trim())}
                  />
                </label>
                <Button
                  disabled={busy || !joinCode}
                  onClick={() =>
                    void run(async () => {
                      if (catalog) await catalog.join(joinCode); else await bridge.join(joinCode);
                      setJoined(true);
                    })
                  }
                >
                  {t("collaboration.join")}
                </Button>
                {joined && (
                  <span role="status">{t("collaboration.ready")}</span>
                )}
              </>
            )}
            {info.user && !ending && !restoring && (
              <Inline gap="sm">
                <span className={styles.member}>{collaborationProfileLabel(info.user, t("collaboration.googleAccount"))}</span>
                <IconButton
                  label={t("collaboration.signOut")}
                  tone="ghost"
                  disabled={busy}
                  onClick={() => void run(() => bridge.signOut())}
                >
                  <LogOut size={15} />
                </IconButton>
              </Inline>
            )}
            {busy && <Shimmer>{t("collaboration.working")}</Shimmer>}
            {error && (
              <p role="alert" className={styles.error}>
                {t("collaboration.error")}
              </p>
            )}
          </Stack>
        </ModalBody>
      </ModalFrame>
    </>
  );
}
