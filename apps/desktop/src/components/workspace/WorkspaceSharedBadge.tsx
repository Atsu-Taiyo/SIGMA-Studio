"use client";
import { Users } from "lucide-react";
import { useT } from "@/lib/i18n/react";
export function WorkspaceSharedBadge() {
  const t = useT("chrome");
  return <span className="workspace-shared-badge" title={t("collaboration.sharedBadge")} aria-label={t("collaboration.sharedBadge")} role="img"><Users size={14} aria-hidden="true" /></span>;
}
