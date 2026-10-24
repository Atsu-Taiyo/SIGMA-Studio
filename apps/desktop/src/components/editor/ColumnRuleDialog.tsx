"use client";

import type { ColumnRule, LayoutSectionNode } from "@/features/document";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { useT } from "@/lib/i18n/react";
import { ColumnRuleControls } from "./ColumnRuleControls";

export function ColumnRuleDialog({ section, value, columnCount, pageNumber, documentScope, onClose, onApply }: {
  section?: LayoutSectionNode;
  value?: ColumnRule;
  columnCount?: number;
  pageNumber?: number;
  documentScope?: boolean;
  onClose: () => void;
  onApply: (rule: ColumnRule | undefined) => void;
}) {
  const t = useT("settings");
  return <ModalFrame open onDismiss={onClose} size="sm" ariaLabel={t("columnRule.title")}>
    <ModalHeader title={t("columnRule.title")} onClose={onClose} />
    <ModalBody>
      <p className="field-label">{pageNumber ? t("columnRule.singlePageScope", { page: pageNumber }) : t(documentScope ? "columnRule.pageScope" : "columnRule.localScope")}</p>
      <ColumnRuleControls value={section?.layout.columnRule ?? value} onChange={onApply} columnCount={section?.layout.columnCount ?? columnCount ?? 2} />
    </ModalBody>
  </ModalFrame>;
}
