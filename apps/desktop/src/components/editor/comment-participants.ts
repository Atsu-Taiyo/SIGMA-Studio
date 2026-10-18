import type { SigmaCommentAgent, SigmaCommentMessage, SigmaCommentThread } from "@/features/document";

/** コメントのスレッドで発言した人 (AI を含む)。 */
export interface CommentParticipant {
  /** 同じ人を1人にまとめる鍵。人は共有アカウントの ID (無ければ名前)、AI は名前と提供元。 */
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

/** 差出人を決めるための、画面側の手がかり。 */
export interface CommentAuthorContext {
  /** 今の自分 (名前とアイコンは画面が持つ最新のもの)。 */
  currentAuthor: { name: string; avatarUrl?: string | null };
  currentUserId?: string;
  /** 共有している相手の、今の名前とアイコン (`useCommentPeopleDirectory`)。 */
  people?: ReadonlyMap<string, { name: string; avatarUrl?: string | null }>;
}

/**
 * メッセージの差出人。共有アカウントの ID (`authorId`) を持つものは、今の名前とアイコンで描く
 * (名前やアイコンを変えたら過去のコメントにも出る)。引けない人は保存してある名前で、頭文字で描く。
 * ID を持たない古いメッセージは、差出人名の無いものを今のユーザーとして扱い (保存側と同じ約束)、
 * 名前が今のユーザーと同じときだけ今のアイコンを貸す。AI の差出人にユーザーの画像は貸さない。
 */
export function resolveCommentAuthor(
  message: Pick<SigmaCommentMessage, "authorId" | "authorName" | "agent">,
  context: CommentAuthorContext,
): CommentParticipant {
  const { currentAuthor, currentUserId, people } = context;
  if (message.agent) {
    const name = message.authorName || message.agent.vendor;
    return { key: `agent:${name}:${message.agent.vendor}`, name, avatarUrl: null, agent: message.agent };
  }
  if (message.authorId) {
    const person = message.authorId === currentUserId ? currentAuthor : people?.get(message.authorId);
    return {
      key: `user:${message.authorId}`,
      name: person?.name || message.authorName || currentAuthor.name,
      avatarUrl: person?.avatarUrl ?? null,
      agent: null,
    };
  }
  const name = message.authorName || currentAuthor.name;
  return {
    key: `name:${name}`,
    name,
    avatarUrl: name === currentAuthor.name ? currentAuthor.avatarUrl ?? null : null,
    agent: null,
  };
}

/** スレッドの発言者を、最初に発言した順に重複なく並べる。 */
export function getCommentThreadParticipants(
  thread: Pick<SigmaCommentThread, "messages">,
  context: CommentAuthorContext,
): CommentParticipant[] {
  const seen = new Set<string>();
  const participants: CommentParticipant[] = [];
  for (const message of thread.messages) {
    const participant = resolveCommentAuthor(message, context);
    if (seen.has(participant.key)) continue;
    seen.add(participant.key);
    participants.push(participant);
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
