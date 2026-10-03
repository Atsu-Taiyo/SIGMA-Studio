import type { SigmaCommentAgent, SigmaCommentThread } from "@/features/document";

/** コメントのスレッドで発言した人 (AI を含む)。 */
export interface CommentParticipant {
  /** 同じ人を1人にまとめる鍵。人は名前、AI は名前と提供元。 */
  key: string;
  name: string;
  avatarUrl?: string | null;
  agent?: SigmaCommentAgent | null;
}

/** 重ねて見せるとき、濃く描く人数。これを超えた人は薄れていく。 */
export const COMMENT_PARTICIPANT_SOLID_LIMIT = 2;
/** 薄れた形で顔を見せる人数 (濃い人数のすぐ後ろ)。これを超えたぶんは「+N」にまとめる。 */
export const COMMENT_PARTICIPANT_FADED_LIMIT = 1;

export interface CommentParticipantStackLayout {
  solid: CommentParticipant[];
  /** 3人目。薄れて、まだいることだけ伝える。 */
  faded: CommentParticipant[];
  /** 顔を出さない残りの人数。 */
  hiddenCount: number;
}

/**
 * スレッドの発言者を、最初に発言した順に重複なく並べる。差出人名の無いメッセージは
 * 現在のユーザーの発言として扱う (保存側と同じ約束)。AI の差出人にユーザーの画像は貸さない。
 */
export function getCommentThreadParticipants(
  thread: Pick<SigmaCommentThread, "messages">,
  currentAuthor: { name: string; avatarUrl?: string | null },
): CommentParticipant[] {
  const seen = new Set<string>();
  const participants: CommentParticipant[] = [];
  for (const message of thread.messages) {
    const name = message.authorName || currentAuthor.name;
    const key = `${name}:${message.agent?.vendor ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    participants.push({
      key,
      name,
      avatarUrl: !message.agent && name === currentAuthor.name ? currentAuthor.avatarUrl ?? null : null,
      agent: message.agent ?? null,
    });
  }
  return participants;
}

/**
 * 2人までは濃く、3人目から薄れさせ、4人目以降は「+N」にまとめる。
 * 人数が増えてもカードの見出しの幅を食わないための折りたたみ。
 */
export function layoutCommentParticipants(participants: readonly CommentParticipant[]): CommentParticipantStackLayout {
  const solid = participants.slice(0, COMMENT_PARTICIPANT_SOLID_LIMIT);
  const faded = participants.slice(COMMENT_PARTICIPANT_SOLID_LIMIT, COMMENT_PARTICIPANT_SOLID_LIMIT + COMMENT_PARTICIPANT_FADED_LIMIT);
  const hiddenCount = Math.max(0, participants.length - solid.length - faded.length);
  return { solid, faded, hiddenCount };
}
