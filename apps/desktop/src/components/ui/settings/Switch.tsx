import type { ButtonHTMLAttributes } from "react";

import styles from "./Settings.module.css";

/** Switchの制御状態。永続化や失敗時ロールバックは呼び出し側が担う。 */
export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role"> {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * 二値設定の状態と操作可能性を色以外でも伝える共通スイッチ。
 * 値の楽観更新、保存、失敗時のロールバックは呼び出し側が管理する。
 */
export function Switch({ checked, label, onCheckedChange, className, disabled, type = "button", ...props }: SwitchProps) {
  return (
    <button
      {...props}
      type={type}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={[styles.switch, className].filter(Boolean).join(" ")}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className={styles.switchKnob} aria-hidden="true" />
    </button>
  );
}
