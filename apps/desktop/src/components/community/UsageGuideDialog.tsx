"use client";

import { BookOpen } from "lucide-react";
import { useEffect } from "react";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Stack } from "@/components/ui/layout";
import { useT } from "@/lib/i18n/react";
import { USAGE_GUIDE_URL } from "@/lib/project-links";
import { useIdleInvitation } from "./use-idle-invitation";
import buttonStyles from "@/components/ui/Button.module.css";
import styles from "./GitHubStarDialog.module.css";

export const USAGE_GUIDE_DISMISSED_KEY = "sigma-studio:usage-guide-dismissed:v1";
export const USAGE_GUIDE_FIRST_SEEN_KEY = "sigma-studio:usage-guide-first-seen:v1";
export const USAGE_GUIDE_INTRO_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

// There is no reliable install-age counter. Offer a seven-day introduction
// starting with this feature's first eligible invitation, including existing users.
function shouldInvite() {
  try {
    if (localStorage.getItem(USAGE_GUIDE_DISMISSED_KEY) === "1") return false;
    const stored = localStorage.getItem(USAGE_GUIDE_FIRST_SEEN_KEY);
    const firstSeen = stored === null ? NaN : Number(stored);
    if (!Number.isFinite(firstSeen) || firstSeen < 0) {
      localStorage.setItem(USAGE_GUIDE_FIRST_SEEN_KEY, String(Date.now()));
      return true;
    }
    return Date.now() - firstSeen < USAGE_GUIDE_INTRO_PERIOD_MS;
  } catch {
    // Keep the editor usable when profile storage is unavailable.
    return false;
  }
}

export function UsageGuideDialog() {
  const t = useT("workspace");
  const { open, dismiss } = useIdleInvitation("usage-guide", 30_000, shouldInvite);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === USAGE_GUIDE_DISMISSED_KEY && event.newValue === "1") dismiss();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [dismiss]);

  const neverShow = () => {
    try { localStorage.setItem(USAGE_GUIDE_DISMISSED_KEY, "1"); } catch { /* Session dismissal still works. */ }
    dismiss();
  };

  return (
    <ModalFrame open={open} onDismiss={dismiss} size="sm" className={styles.backdrop}>
      <ModalHeader title={t("usageGuide.title")} description={t("usageGuide.description")} onClose={dismiss} />
      <ModalBody>
        <Stack gap="sm">
          <a className={`${buttonStyles.button} ${styles.link}`} data-tone="primary" data-size="lg" data-modal-initial-focus href={USAGE_GUIDE_URL} target="_blank" rel="noopener noreferrer" onClick={dismiss}>
            <BookOpen size={16} aria-hidden="true" />
            {t("usageGuide.view")}
          </a>
          <Button tone="ghost" onClick={neverShow}>{t("usageGuide.neverShow")}</Button>
        </Stack>
      </ModalBody>
    </ModalFrame>
  );
}
