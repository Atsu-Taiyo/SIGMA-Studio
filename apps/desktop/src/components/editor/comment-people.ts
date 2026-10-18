"use client";

import { useEffect, useMemo, useState } from "react";

import type { SigmaCommentThread } from "@/features/document";

import type { CommentMentionCandidate, LoadCommentMentionCandidates } from "./comment-mentions";

/**
 * コメントに出てくる人 (書いた人・宛先・リアクションを付けた人) の、今の名前とアイコンを ID から引く。
 * 見られるのは共有している相手だけで、見えない人は返らない (保存してある名前で出す)。
 */
export type LoadCommentPeople = (userIds: string[]) => Promise<CommentMentionCandidate[]>;

/** スレッドに出てくる人の ID (自分を含む)。 */
export function collectCommentPersonIds(threads: readonly SigmaCommentThread[]): string[] {
  const ids = new Set<string>();
  for (const thread of threads) {
    for (const reaction of thread.reactions ?? []) if (reaction.authorId) ids.add(reaction.authorId);
    for (const message of thread.messages) {
      if (message.authorId && !message.agent) ids.add(message.authorId);
      for (const reaction of message.reactions ?? []) if (reaction.authorId) ids.add(reaction.authorId);
      for (const node of message.body) if (node.type === "text" && node.mentionUserId) ids.add(node.mentionUserId);
    }
  }
  return [...ids].sort();
}

/**
 * ID → 名前・アイコン (・メール) の表。自分は画面が持っている自分のプロフィールで描く (変えた直後でも
 * すぐ出る)。宛先 (メンション) があるときは、共同編集者の一覧からメールも補う。
 */
export function useCommentPeopleDirectory({ threads, currentUserId, author, loadPeople, loadMembers }: {
  threads: readonly SigmaCommentThread[];
  currentUserId?: string;
  author: { name: string; avatarUrl?: string | null };
  loadPeople?: LoadCommentPeople;
  loadMembers?: LoadCommentMentionCandidates;
}): ReadonlyMap<string, CommentMentionCandidate> {
  const idsKey = useMemo(
    () => collectCommentPersonIds(threads).filter((id) => id !== currentUserId).join(","),
    [currentUserId, threads],
  );
  const hasMentions = useMemo(() => threads.some((thread) => thread.messages.some((message) => (
    message.body.some((node) => node.type === "text" && node.mentionUserId)
  ))), [threads]);
  const [people, setPeople] = useState<{ key: string; loader: LoadCommentPeople; entries: CommentMentionCandidate[] } | null>(null);
  const [members, setMembers] = useState<{ loader: LoadCommentMentionCandidates; entries: CommentMentionCandidate[] } | null>(null);

  useEffect(() => {
    if (!loadPeople || !idsKey) return;
    let cancelled = false;
    loadPeople(idsKey.split(","))
      .then((entries) => { if (!cancelled) setPeople({ key: idsKey, loader: loadPeople, entries }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [idsKey, loadPeople]);
  useEffect(() => {
    if (!hasMentions || !loadMembers) return;
    let cancelled = false;
    loadMembers()
      .then((entries) => { if (!cancelled) setMembers({ loader: loadMembers, entries }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [hasMentions, loadMembers]);

  return useMemo(() => {
    const directory = new Map<string, CommentMentionCandidate>();
    for (const member of members && members.loader === loadMembers ? members.entries : []) {
      directory.set(member.userId, member);
    }
    for (const person of people && people.loader === loadPeople && people.key === idsKey ? people.entries : []) {
      const member = directory.get(person.userId);
      directory.set(person.userId, { ...member, ...person, ...(member?.email && !person.email ? { email: member.email } : {}) });
    }
    if (currentUserId) {
      directory.set(currentUserId, { ...directory.get(currentUserId), userId: currentUserId, name: author.name, avatarUrl: author.avatarUrl });
    }
    return directory;
  }, [author.avatarUrl, author.name, currentUserId, idsKey, loadMembers, loadPeople, members, people]);
}
