"use client";

import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Shimmer } from "@/components/ui/Shimmer";
import { useT } from "@/lib/i18n/react";
import styles from "./ExtensionImportLoading.module.css";

const keepOpen = () => {};

/** The host owns cancellation; keep the wait visible until import and opening settle. */
export function ExtensionImportLoading() {
  const t = useT("editor");
  return <ModalFrame open size="sm" onDismiss={keepOpen} closeOnEscape={false} ariaLabel={t("extensions.run.loadingTitle")}>
    <ModalHeader title={t("extensions.run.loadingTitle")} onClose={keepOpen} hideCloseButton />
    <ModalBody padding="xl">
      <div role="status" aria-live="polite">
        <div className={styles.page} aria-hidden="true">
          <Shimmer variant="surface" className={styles.title} />
          <Shimmer variant="surface" className={styles.line} />
          <Shimmer variant="surface" className={styles.line} />
          <Shimmer variant="surface" className={styles.figure} />
          <Shimmer variant="surface" className={styles.line} />
        </div>
        <p className={styles.description}>{t("extensions.run.loadingDescription")}</p>
      </div>
    </ModalBody>
  </ModalFrame>;
}
