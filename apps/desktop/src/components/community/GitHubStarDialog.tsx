"use client";

import { Star } from "lucide-react";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { useT } from "@/lib/i18n/react";
import { GITHUB_REPOSITORY_URL } from "@/lib/project-links";
import buttonStyles from "@/components/ui/Button.module.css";
import styles from "./GitHubStarDialog.module.css";
import { useIdleInvitation } from "./use-idle-invitation";

export const STAR_PROMPT_DELAY_MS = 60_000;
export { INVITATION_IDLE_MS as STAR_PROMPT_IDLE_MS } from "./use-idle-invitation";

/** Standalone app only: mounted by the home route, never by the embedded Editor. */
export function GitHubStarDialog() {
  const t = useT("workspace");
  const { open, dismiss } = useIdleInvitation("github-star", STAR_PROMPT_DELAY_MS);

  return (
    <ModalFrame open={open} onDismiss={dismiss} size="sm" className={styles.backdrop}>
      <ModalHeader title={t("githubStar.title")} description={t("githubStar.description")} onClose={dismiss} />
      <ModalBody>
        <a className={`${buttonStyles.button} ${styles.link}`} data-tone="primary" data-size="lg" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" onClick={dismiss}>
          <Star size={16} aria-hidden="true" />
          {t("githubStar.openGitHub")}
        </a>
      </ModalBody>
    </ModalFrame>
  );
}
