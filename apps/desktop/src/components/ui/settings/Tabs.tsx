"use client";

import { useId, useRef } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

import styles from "./Settings.module.css";

/** Tabsが表示する選択肢。パネル内のデータ状態は持たない。 */
export interface SettingsTab<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

/** Tabsの選択状態とパネルスロット。業務上の遷移可否は呼び出し側が決める。 */
export interface TabsProps<T extends string> {
  label: string;
  items: readonly SettingsTab<T>[];
  value: T;
  onValueChange: (value: T) => void;
  children: ReactNode;
  className?: string;
}

/**
 * Tabsの矢印/Home/End入力から次にフォーカスする有効タブを求める純粋関数。
 * フォーカス移動や選択stateの更新自体は行わない。
 */
export function resolveTabsKeyboardIndex(
  disabledItems: readonly boolean[],
  currentIndex: number,
  key: string,
): number | null {
  const enabledIndexes = disabledItems.flatMap((disabled, index) => disabled ? [] : [index]);
  if (enabledIndexes.length === 0) {
    return null;
  }
  const currentEnabledIndex = enabledIndexes.indexOf(currentIndex);
  if (key === "ArrowRight" || key === "ArrowDown") {
    return enabledIndexes[(currentEnabledIndex + 1 + enabledIndexes.length) % enabledIndexes.length];
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return enabledIndexes[(currentEnabledIndex - 1 + enabledIndexes.length) % enabledIndexes.length];
  }
  if (key === "Home") {
    return enabledIndexes[0];
  }
  if (key === "End") {
    return enabledIndexes[enabledIndexes.length - 1];
  }
  return null;
}

/**
 * 同じ設定領域内の相互排他的なビューをARIA Tabsパターンで切り替える。
 * 各パネルの業務状態やデータ取得は持たず、関連付けと矢印キー移動だけを担当する。
 */
export function Tabs<T extends string>({ label, items, value, onValueChange, children, className }: TabsProps<T>) {
  const baseId = useId();
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(0, items.findIndex((item) => item.value === value));
  const activeItem = items[activeIndex];
  const panelId = `${baseId}-panel`;

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = resolveTabsKeyboardIndex(items.map((item) => Boolean(item.disabled)), index, event.key);
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    onValueChange(items[nextIndex].value);
    buttonRefs.current[nextIndex]?.focus();
  };

  return (
    <div className={[styles.tabs, className].filter(Boolean).join(" ")}>
      <div
        className={styles.tabList}
        role="tablist"
        aria-label={label}
        style={{ "--settings-tab-count": Math.max(1, items.length) } as CSSProperties}
      >
        {items.map((item, index) => {
          const selected = item.value === value;
          const tabId = `${baseId}-tab-${index}`;
          return (
            <button
              key={item.value}
              ref={(element) => { buttonRefs.current[index] = element; }}
              id={tabId}
              type="button"
              role="tab"
              className={styles.tab}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onValueChange(item.value)}
              onKeyDown={(event) => move(event, index)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        id={panelId}
        className={styles.tabPanel}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${activeIndex}`}
        tabIndex={0}
        data-value={activeItem?.value}
      >
        {children}
      </div>
    </div>
  );
}
