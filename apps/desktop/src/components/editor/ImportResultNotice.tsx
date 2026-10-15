"use client";

import { Button } from "@/components/ui/Button";
import { Stack } from "@/components/ui/layout";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import type { ExtensionImportIssue } from "@/lib/extension-contracts";
import { useT } from "@/lib/i18n/react";

/** 拡張機能が取り込みに添えた所見を、取り込んだあとに見せる。`font-substitution` は書体の代替として一覧にする。 */
export function ImportResultNotice({ issues, onClose }: { issues: ExtensionImportIssue[]; onClose(): void }) {
  const t = useT("editor");
  const fonts = issues.filter((issue) => issue.code === "font-substitution");
  const incomplete = issues.some((issue) => issue.code !== "font-substitution");
  return <ModalFrame open onDismiss={onClose} size="md" ariaLabel={t("importNotice.title")}>
    <ModalHeader title={t("importNotice.title")} onClose={onClose} />
    <ModalBody padding="xl"><Stack gap="md">
      <p data-testid="import-editable-notice">{t("importNotice.editableElements")}</p>
      <p>{t("importNotice.compareLayout")}</p>
      {incomplete && <p role="alert">{t("importNotice.incomplete")}</p>}
      {fonts.length > 0 && <>
        <p>{t("importNotice.substitutedFonts")}</p>
        <ul>{fonts.map((issue) => <li key={issue.detail}>{issue.detail}</li>)}</ul>
      </>}
      <Button tone="primary" onClick={onClose}>{t("common.close")}</Button>
    </Stack></ModalBody>
  </ModalFrame>;
}
