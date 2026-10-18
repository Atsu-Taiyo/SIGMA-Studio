import type { CollaborationProfile, CollaborationProfileRecord } from "./bridge";

/**
 * アカウントのアイコンを描く画像の URL。本人が決めたアイコンがあればそれ (共有サーバーから、版ごとに
 * 別の URL)、なければ Google のアイコン。どちらも main が取りに行く (画面は CSP で外へ出られない)。
 */
export function collaborationAvatarSource(profile: Pick<CollaborationProfile, "actorId" | "avatarUrl" | "avatarVersion">): string | undefined {
  if (profile.avatarVersion && profile.avatarVersion > 0) {
    return `sigma-collaboration-profile://avatar?user=${encodeURIComponent(profile.actorId)}&v=${profile.avatarVersion}`;
  }
  return profile.avatarUrl
    ? `sigma-collaboration-profile://avatar?url=${encodeURIComponent(profile.avatarUrl)}`
    : undefined;
}

/** 共有サーバーの 1 人ぶんを、画面で使うプロフィールの形にする。名前は本人が決めたもの → Google の名前。 */
export function collaborationProfileFromRecord(record: CollaborationProfileRecord, email?: string): CollaborationProfile {
  const displayName = record.displayName ?? record.providerDisplayName;
  return {
    actorId: record.userId,
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
    ...(record.providerAvatarUrl ? { avatarUrl: record.providerAvatarUrl } : {}),
    ...(record.avatarVersion > 0 ? { avatarVersion: record.avatarVersion } : {}),
  };
}
