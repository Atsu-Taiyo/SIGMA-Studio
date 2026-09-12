"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";

import { useT } from "@/lib/i18n/react";

import styles from "./Disclosure.module.css";

export interface DisclosureProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  contentClassName?: string;
}

/**
 * 補助設定を必要な時だけ開示する共通コントロール。
 * 主要操作は隠さず、詳細値だけをレイアウトシフトの小さい領域へ収める。
 */
export function Disclosure({
  label,
  summary,
  defaultOpen = false,
  children,
  className,
  contentClassName,
  ...props
}: DisclosureProps) {
  const t = useT("common");
  const [open, setOpen] = useState(defaultOpen);
  // 既定値を引数のデフォルトに書けないのは、hook を呼べる場所がここしか無いため。
  const resolvedSummary = summary ?? t("actions.details");
  const contentId = useId();

  return (
    <div {...props} className={[styles.root, className].filter(Boolean).join(" ")} data-open={open}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={contentId}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        <span>{resolvedSummary}</span>
      </button>
      {open ? (
        <div className={[styles.content, contentClassName].filter(Boolean).join(" ")} id={contentId}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
