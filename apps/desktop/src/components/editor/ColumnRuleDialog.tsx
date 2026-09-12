"use client";

import { useState } from "react";
import type { ColumnRule, LayoutSectionNode } from "@/features/document";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { useT } from "@/lib/i18n/react";
import { ColumnRuleControls } from "./ColumnRuleControls";

export function ColumnRuleDialog({ section, onClose, onApply }: {
  section: LayoutSectionNode;
  onClose: () => void;
  onApply: (rule: ColumnRule | undefined) => void;
}) {
  const t = useT("settings");
  const common = useT("common");
  const [draft, setDraft] = useState(section.layout.columnRule);
  return <ModalFrame open onDismiss={onClose} size="sm" ariaLabel={t("columnRule.title")}>
    <ModalHeader title={t("columnRule.title")} onClose={onClose} />
    <ModalBody>
      <p className="field-label">{t("columnRule.localScope")}</p>
      <ColumnRuleControls value={draft} onChange={setDraft} columnCount={section.layout.columnCount} />
    </ModalBody>
    <footer className="page-settings-footer">
      <button type="button" className="button secondary" onClick={onClose}>{common("actions.cancel")}</button>
      <button type="button" className="button primary" onClick={() => { onApply(draft); onClose(); }}>{t("page.apply")}</button>
    </footer>
  </ModalFrame>;
}
