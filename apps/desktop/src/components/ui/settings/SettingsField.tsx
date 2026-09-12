import type { HTMLAttributes, ReactNode } from "react";

import styles from "./Settings.module.css";

/** SettingsFieldのラベル関連付けと補助表示。入力値や検証結果は所有しない。 */
export interface SettingsFieldProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  meta?: ReactNode;
}

/**
 * ラベル、補助情報、入力コントロールを一つのフォーム項目として配置する。
 * 入力部品そのものの状態やバリデーション規則は持たない。
 */
export function SettingsField({ label, htmlFor, description, meta, className, children, ...props }: SettingsFieldProps) {
  const labelContent = htmlFor
    ? <label className={styles.fieldLabel} htmlFor={htmlFor}>{label}</label>
    : <span className={styles.fieldLabel}>{label}</span>;
  return (
    <div {...props} className={[styles.field, className].filter(Boolean).join(" ")}>
      <div className={styles.fieldHeader}>
        {labelContent}
        {meta != null ? <span className={styles.fieldMeta}>{meta}</span> : null}
      </div>
      {children}
      {description != null ? <p className={styles.fieldDescription}>{description}</p> : null}
    </div>
  );
}
