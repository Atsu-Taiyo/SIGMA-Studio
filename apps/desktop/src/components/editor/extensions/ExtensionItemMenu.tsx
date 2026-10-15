"use client";

import { MoreHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { IconButton } from "@/components/ui/Button";

import { ToolbarPopover } from "../ToolbarPopover";
import styles from "./ExtensionsDialog.module.css";

export interface ExtensionItemDetail {
  label: string;
  value: string;
  /** ファイル名のように、等幅で見せたい値。 */
  mono?: boolean;
}

export interface ExtensionItemAction {
  key: string;
  label: string;
  icon?: ReactNode;
  tone?: "danger";
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * 一覧の項目に添える3点メニュー。タイル本体には名前と見た目だけを残し、ファイル名などの副次情報
 * (`details`) と項目への操作 (`actions`) をここへ収める。操作の実行や状態の保存は呼び出し側が持つ。
 */
export function ExtensionItemMenu({ label, details = [], actions, disabled = false, onOpenChange }: {
  /** トリガーのアクセシブル名。どの項目のメニューかが分かる文にする。 */
  label: string;
  details?: readonly ExtensionItemDetail[];
  actions: readonly ExtensionItemAction[];
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  return (
    <>
      <IconButton
        ref={triggerRef}
        label={label}
        tone="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </IconButton>
      <ToolbarPopover
        open={open}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        align="right"
        gap={4}
        className={styles.menu}
        role="menu"
        ariaLabel={label}
      >
        {details.length > 0 && (
          <div className={styles.menuDetails} role="presentation">
            {details.map((detail) => (
              <div key={detail.label} role="presentation">
                <div className={styles.menuDetailLabel}>{detail.label}</div>
                <div className={styles.menuDetailValue} data-mono={detail.mono ? "true" : undefined}>{detail.value}</div>
              </div>
            ))}
          </div>
        )}
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            role="menuitem"
            className={styles.menuItem}
            data-tone={action.tone}
            disabled={action.disabled}
            onClick={() => {
              setOpen(false);
              action.onSelect();
            }}
          >
            <span aria-hidden="true">{action.icon}</span>
            <span>{action.label}</span>
          </button>
        ))}
      </ToolbarPopover>
    </>
  );
}
