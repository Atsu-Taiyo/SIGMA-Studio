"use client";

import { Button } from "@/components/ui/Button";
import { Stack } from "@/components/ui/layout";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { useT } from "@/lib/i18n/react";
import type { DocumentConversionIssue } from "@/lib/document-conversion-contracts";

export function ConversionImportNotice({ issues, onClose }: { issues: DocumentConversionIssue[]; onClose(): void }) {
  const t = useT("editor");
  const fonts = issues.filter((issue) => issue.code === "font-substitution");
  const missing = issues.some((issue) => issue.code !== "font-substitution");
  return <ModalFrame open onDismiss={onClose} size="md" ariaLabel={t("conversion.noticeTitle")}>
    <ModalHeader title={t("conversion.noticeTitle")} onClose={onClose} />
    <ModalBody padding="xl"><Stack gap="md">
      <p data-testid="conversion-editable-notice">{t("conversion.editableElements")}</p>
      <p>{t("conversion.compareLayout")}</p>
      {missing && <p role="alert">{t("conversion.incomplete")}</p>}
      {fonts.length > 0 && <>
        <p>{t("conversion.substitutedFonts")}</p>
        <ul>{fonts.map((issue) => <li key={issue.detail}>{issue.detail}</li>)}</ul>
      </>}
      <Button tone="primary" onClick={onClose}>{t("common.close")}</Button>
    </Stack></ModalBody>
  </ModalFrame>;
}
