"use client";

import { LayoutGrid, List, type LucideIcon } from "lucide-react";

import type { WorkspaceViewMode } from "@/lib/workspace-view-preferences";
import { useT } from "@/lib/i18n/react";

/**
 * 文言ではなく**辞書キー**を持つ。module 直下のテーブルに訳文を入れると
 * 読み込み時の言語で焼き付き、言語を切り替えてもここだけ元の言語で残る。
 */
const WORKSPACE_VIEW_OPTIONS: Array<{ value: WorkspaceViewMode; labelKey: "view.grid" | "view.list"; Icon: LucideIcon }> = [
  { value: "grid", labelKey: "view.grid", Icon: LayoutGrid },
  { value: "list", labelKey: "view.list", Icon: List },
];

interface WorkspaceViewToggleProps {
  value: WorkspaceViewMode;
  onChange: (value: WorkspaceViewMode) => void;
}

export function WorkspaceViewToggle({ value, onChange }: WorkspaceViewToggleProps) {
  const t = useT("workspace");

  return (
    <div className="segmented workspace-view-toggle" aria-label={t("view.label")}>
      {WORKSPACE_VIEW_OPTIONS.map(({ value: optionValue, labelKey, Icon }) => {
        const label = t(labelKey);
        return (
          <button
            key={optionValue}
            type="button"
            className={value === optionValue ? "selected" : undefined}
            title={label}
            aria-label={label}
            aria-pressed={value === optionValue}
            onClick={() => onChange(optionValue)}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}
