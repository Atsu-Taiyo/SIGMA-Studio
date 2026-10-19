"use client";

import { Building2, ChevronRight, Folder, Share2 } from "lucide-react";
import { Fragment } from "react";

import { DocumentTitleText } from "@/features/rendering/adapters/react";
import { useT } from "@/lib/i18n/react";
import type { CreatedMaterialNotice } from "./editor-shell/new-material-destination";
import { ModalBody, ModalFrame, ModalHeader } from "../ui/Modal";
import { Stack } from "../ui/layout";
import styles from "./NewMaterialCreatedDialog.module.css";

interface NewMaterialCreatedDialogProps {
  notice: CreatedMaterialNotice | null;
  onClose: () => void;
}

/**
 * 新規教材を作ったあと、どのワークスペースのどのフォルダに作ったかを示す (Issue #211)。
 * 教材の複製が複製元と違う場所・保存先になったときも同じ形で示す (Issue #250)。
 * フォルダ名だけでは場所が曖昧になるので、ワークスペース名と、そこからのフォルダの階層を並べる。
 * 直下に作ったときもそう書く。閉じる操作は右上の X だけ (Esc でも閉じる)。
 */
export function NewMaterialCreatedDialog({ notice, onClose }: NewMaterialCreatedDialogProps) {
  const t = useT("workspace");
  if (!notice) return null;
  const workspaceName = notice.sharedItems ? t("sharedItems") : notice.workspaceName;
  const cloud = notice.storage === "cloud";
  const storage = cloud ? t("createdDialog.cloud") : notice.storage === "browser" ? t("createdDialog.thisBrowser") : t("createdDialog.thisPc");
  return (
    <ModalFrame open size="sm" onDismiss={onClose}>
      <ModalHeader
        title={t(notice.kind === "whiteboard" ? "createdDialog.whiteboardTitle" : notice.kind === "duplicate" ? "createdDialog.duplicateTitle" : "createdDialog.title")}
        description={t("createdDialog.description")}
        onClose={onClose}
      />
      <ModalBody padding="lg">
        <Stack gap="md">
          <dl className={styles.location} data-new-material-location="">
            <div className={styles.row}>
              <dt>{t("createdDialog.material")}</dt>
              <dd><DocumentTitleText title={notice.title} /></dd>
            </div>
            <div className={styles.row}>
              <dt>{t("createdDialog.workspace")}</dt>
              <dd data-new-material-workspace="">
                <Building2 size={15} aria-hidden="true" />
                <span>{workspaceName ?? t("createdDialog.unknown")}</span>
                {cloud && <Share2 size={13} aria-hidden="true" className={styles.muted} />}
              </dd>
            </div>
            <div className={styles.row}>
              <dt>{t("createdDialog.folder")}</dt>
              <dd data-new-material-folder="">
                {notice.folderPath === null
                  ? <span className={styles.muted}>{t("createdDialog.unknown")}</span>
                  : notice.folderPath.length === 0
                    ? <span>{t("createdDialog.root")}</span>
                    : notice.folderPath.map((name, index) => (
                      <Fragment key={`${index}:${name}`}>
                        {index > 0 && <>
                          <ChevronRight size={13} aria-hidden="true" className={styles.muted} />
                          <span className="visually-hidden"> / </span>
                        </>}
                        <Folder size={14} aria-hidden="true" />
                        <span>{name}</span>
                      </Fragment>
                    ))}
              </dd>
            </div>
            <div className={styles.row}>
              <dt>{t("createdDialog.storage")}</dt>
              <dd data-new-material-storage="">{storage}</dd>
            </div>
          </dl>
          {notice.kind === "duplicate"
            ? <p className={styles.note}>{t(notice.origin === "fallback" ? "createdDialog.duplicateFallbackNote" : "createdDialog.duplicatePrivateNote")}</p>
            : notice.origin === "fallback" && <p className={styles.note}>{t("createdDialog.fallbackNote")}</p>}
        </Stack>
      </ModalBody>
    </ModalFrame>
  );
}
