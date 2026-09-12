import type { HTMLAttributes, ReactNode } from "react";

import styles from "./Settings.module.css";

/** SettingsRowの表示内容と操作スロット。値の保存方法は表現しない。 */
export interface SettingsRowProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  control?: ReactNode;
  align?: "center" | "start";
}

/**
 * 設定名・補足と、その値を変える操作を対応付ける標準行。
 * 入力値の検証や永続化は行わず、狭い画面での積み替えまでを担当する。
 */
export function SettingsRow({ label, description, icon, control, align = "center", className, ...props }: SettingsRowProps) {
  return (
    <div
      {...props}
      className={[styles.row, className].filter(Boolean).join(" ")}
      data-align={align}
      data-has-control={control != null}
    >
      <div className={styles.rowInfo}>
        <div className={styles.rowLabel}>{icon}{label}</div>
        {description != null ? <p className={styles.rowDescription}>{description}</p> : null}
      </div>
      {control != null ? <div className={styles.rowControl}>{control}</div> : null}
    </div>
  );
}
