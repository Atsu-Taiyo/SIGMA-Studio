"use client";
import { useT } from "@/lib/i18n/react";

/** 編集画面のタブで開いている教材の印。 */
export function WorkspaceOpenInEditorBadge() {
  const t = useT("workspace");
  return <span className="workspace-open-in-editor-badge">{t("label.openInEditor")}</span>;
}
