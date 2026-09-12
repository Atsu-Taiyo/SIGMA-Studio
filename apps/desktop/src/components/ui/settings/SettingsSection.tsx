import type { HTMLAttributes, ReactNode } from "react";

import styles from "./Settings.module.css";

/** SettingsSectionへ渡す見出し・補足・右上操作。業務状態は含めない。 */
export interface SettingsSectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

/**
 * 関連する設定を一つの見出し階層と一定の縦リズムでまとめる。
 * ダイアログ外枠、保存処理、設定値の所有は担当しない。
 */
export function SettingsSection({ title, description, actions, className, children, ...props }: SettingsSectionProps) {
  return (
    <section {...props} className={[styles.section, className].filter(Boolean).join(" ")}>
      {title != null || description != null || actions != null ? (
        <header className={styles.sectionHeader}>
          <div className={styles.sectionHeading}>
            {title != null ? <h3 className={styles.sectionTitle}>{title}</h3> : null}
            {description != null ? <p className={styles.sectionDescription}>{description}</p> : null}
          </div>
          {actions != null ? <div className={styles.sectionActions}>{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
