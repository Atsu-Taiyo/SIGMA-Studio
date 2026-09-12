"use client";

import { FilePlus, FileText, X } from "lucide-react";
import { useT } from "@/lib/i18n/react";

export type WorkspaceEmptyVariant = "root" | "folder" | "search";

/** 文言ではなく辞書キー。module 直下に訳文を置くと読み込み時の言語で焼き付く。 */
const COPY_KEYS: Record<WorkspaceEmptyVariant, { message: "empty.rootMessage" | "empty.folderMessage" | "empty.searchMessage"; action: "action.createMaterial" | "search.clear" }> = {
  root: { message: "empty.rootMessage", action: "action.createMaterial" },
  folder: { message: "empty.folderMessage", action: "action.createMaterial" },
  search: { message: "empty.searchMessage", action: "search.clear" },
};

interface WorkspaceEmptyStateProps {
  variant: WorkspaceEmptyVariant;
  canCreate: boolean;
  onCreateDocument: () => void;
  onClearSearch: () => void;
}

/**
 * The three empty-state variants for the workspace listing (root, an empty
 * folder, and no search results), per docs/design-rules.md's "one icon, one
 * line, one action" empty-state rule. Shared by both WorkspaceItemGrid and
 * WorkspaceItemList so the copy and action can't drift between the two view
 * modes.
 */
export function WorkspaceEmptyState({
  variant,
  canCreate,
  onCreateDocument,
  onClearSearch,
}: WorkspaceEmptyStateProps) {
  const t = useT("workspace");
  const copy = COPY_KEYS[variant];
  const isSearch = variant === "search";

  return (
    <div className="workspace-empty-state" data-empty-variant={variant}>
      <FileText size={26} />
      <p>{t(copy.message)}</p>
      <button
        type="button"
        className="button secondary"
        disabled={!isSearch && !canCreate}
        onClick={isSearch ? onClearSearch : onCreateDocument}
      >
        {isSearch ? <X size={15} /> : <FilePlus size={15} />}
        {t(copy.action)}
      </button>
    </div>
  );
}
