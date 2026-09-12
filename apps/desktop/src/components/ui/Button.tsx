import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import styles from "./Button.module.css";
import { Tooltip } from "./Tooltip";
import type { TooltipContent } from "./Tooltip";

export type ButtonTone = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: ButtonSize;
  iconOnly?: boolean;
  children: ReactNode;
}

/**
 * 主要度と破壊性を一貫した見た目へ変換する共通ボタン。
 * 文言や実行確認などの業務判断は持たず、操作の視覚階層だけを担当する。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = "secondary", size = "md", iconOnly = false, className, type = "button", children, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={[styles.button, className].filter(Boolean).join(" ")}
      data-tone={tone}
      data-size={size}
      data-icon-only={iconOnly}
    >
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, "iconOnly" | "children"> {
  label: string;
  /** 曖昧な操作だけに付ける短い説明。すべてのアイコンへ自動適用しない。 */
  tooltip?: TooltipContent;
  children: ReactNode;
}

/**
 * アイコン中心の操作をAIチャットの送信操作と同じ真円へ揃え、共通ヒット領域と名前を必ず与える。
 * ラベルを常時表示しないツールバー、カード、ダイアログの操作に使い、テキストボタンの形状は変えない。
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, title, tooltip, "aria-label": ariaLabel, children, ...props },
  ref,
) {
  const button = (
    <Button
      {...props}
      ref={ref}
      iconOnly
      title={tooltip ? undefined : title ?? label}
      aria-label={ariaLabel ?? label}
    >
      {children}
    </Button>
  );
  return tooltip ? <Tooltip {...tooltip}>{button}</Tooltip> : button;
});
