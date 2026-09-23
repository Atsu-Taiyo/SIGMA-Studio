"use client";

import { UserRound } from "lucide-react";
import { useState } from "react";
import type { CollaborationProfile } from "../model/bridge";
import styles from "./sharing.module.css";

export function collaborationProfileLabel(profile: CollaborationProfile, fallback?: string): string {
  return profile.displayName || profile.email || fallback || profile.actorId;
}

export function collaborationAvatarSource(profile: CollaborationProfile): string | undefined {
  return profile.avatarUrl
    ? `sigma-collaboration-profile://avatar?url=${encodeURIComponent(profile.avatarUrl)}`
    : undefined;
}

export function CollaborationProfileAvatar({
  profile,
  label,
  size = "md",
}: {
  profile: CollaborationProfile;
  label?: string;
  size?: "sm" | "md";
}) {
  const source = collaborationAvatarSource(profile);
  const accessibleLabel = label ?? collaborationProfileLabel(profile);
  return (
    <span className={`${styles.avatar} ${styles[`avatar_${size}`]}`} title={accessibleLabel} aria-label={accessibleLabel}>
      {source ? <ProfileImage key={source} source={source} /> : <UserRound aria-hidden="true" />}
    </span>
  );
}

function ProfileImage({ source }: { source: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <UserRound aria-hidden="true" />;
  // Custom Electron protocol URLs are already bounded and cached by main; Next Image cannot load them.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={source} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
