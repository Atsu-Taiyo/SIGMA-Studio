"use client";

import { CommentAuthorAvatar } from "@/components/editor/CommentAuthorAvatar";
import { layoutCommentParticipants, type CommentParticipant } from "@/components/editor/comment-participants";
import { useT } from "@/lib/i18n/react";
import styles from "./CommentParticipantStack.module.css";

/**
 * コメントのスレッドで発言した人 (AI を含む) を、顔を重ねて見せる。2人までは濃く、3人目は薄れ、
 * 4人目以降は「+N」にまとめる (`layoutCommentParticipants`)。誰が関わっているかを、
 * カードを開かずに読むための表示で、名前はまとめて title と読み上げに載せる。
 */
export function CommentParticipantStack({ participants }: { participants: readonly CommentParticipant[] }) {
  const t = useT("editor");
  if (participants.length === 0) return null;
  const { solid, faded, hiddenCount } = layoutCommentParticipants(participants);
  const names = participants.map((participant) => participant.name).join(t("comment.participantsSeparator"));
  return (
    <span
      className={styles.stack}
      role="group"
      aria-label={t("comment.participants", { names })}
      title={names}
      data-participant-count={participants.length}
    >
      {solid.map((participant) => (
        <span key={participant.key} className={styles.person} data-participant="solid">
          <CommentAuthorAvatar name={participant.name} avatarUrl={participant.avatarUrl} agent={participant.agent} />
        </span>
      ))}
      {faded.map((participant) => (
        <span key={participant.key} className={`${styles.person} ${styles.faded}`} data-participant="faded">
          <CommentAuthorAvatar name={participant.name} avatarUrl={participant.avatarUrl} agent={participant.agent} />
        </span>
      ))}
      {hiddenCount > 0 && (
        <span className={`${styles.person} ${styles.more}`} data-participant="more" aria-hidden="true">+{hiddenCount}</span>
      )}
    </span>
  );
}
