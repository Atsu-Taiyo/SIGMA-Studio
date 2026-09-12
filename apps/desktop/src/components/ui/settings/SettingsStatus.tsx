import type { HTMLAttributes, ReactNode } from "react";

import styles from "./Settings.module.css";

/** 設定結果の意味だけを表すtone。表示期間や再試行可否は表さない。 */
export type SettingsStatusTone = "info" | "success" | "error";

/** SettingsStatusの通知内容。メッセージ生成や寿命管理は含めない。 */
export interface SettingsStatusProps extends Omit<HTMLAttributes<HTMLParagraphElement>, "children"> {
  tone?: SettingsStatusTone;
  children: ReactNode;
}

/**
 * 保存結果や局所エラーを該当設定の近くで支援技術にも通知する。
 * Toastの寿命管理やメッセージ文言の決定は呼び出し側へ委ねる。
 */
export function SettingsStatus({ tone = "info", className, role, children, ...props }: SettingsStatusProps) {
  return (
    <p
      {...props}
      className={[styles.status, className].filter(Boolean).join(" ")}
      data-tone={tone}
      role={role ?? (tone === "error" ? "alert" : "status")}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      {children}
    </p>
  );
}
