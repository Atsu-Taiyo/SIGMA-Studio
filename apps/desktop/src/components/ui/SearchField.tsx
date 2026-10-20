"use client";

import { Search, X } from "lucide-react";
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";

import { useT } from "@/lib/i18n/react";

import styles from "./SearchField.module.css";

/** `lg` はページ上部とパレット、`md` はダイアログの道具列、`sm` はメニュー・ポップオーバー・サイドバー。 */
export type SearchFieldSize = "lg" | "md" | "sm";

const ICON_SIZE: Record<SearchFieldSize, number> = { lg: 16, md: 15, sm: 14 };
const CLEAR_ICON_SIZE: Record<SearchFieldSize, number> = { lg: 14, md: 13, sm: 12 };

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "type" | "size" | "className"> {
  value: string;
  onChange: (value: string) => void;
  /** 入力欄の読み上げ名。placeholder だけに頼らず、必ず渡す。 */
  "aria-label": string;
  /** 消去ボタンの名前。省略すると共通語の「検索をクリア」。 */
  clearLabel?: string;
  /** 消去ボタンの動作。入力の変更と別の扱いが要るときだけ渡す (省略すると `onChange("")`)。 */
  onClear?: () => void;
  /** 入力が空でも右端のボタンを出す。欄そのものを閉じる操作と兼ねるときに使う (`clearLabel` / `onClear` を合わせて渡す)。 */
  alwaysShowClear?: boolean;
  /** 入力欄の後ろ、右端のボタンの前に置く補助表示 (一致件数など)。 */
  trailing?: ReactNode;
  size?: SearchFieldSize;
  /** 外側の面に付ける。幅・余白・固定位置などの配置だけを、画面側の CSS に置く。 */
  className?: string;
}

/**
 * ワークスペースの検索バーを正本にした検索入力。丸い灰色の面、虫眼鏡、入力があるときだけ出る消去ボタン、
 * フォーカスで白へ変わる状態までを持つ。何を絞るか、いつ検索するかは持たず、値は呼び出し側が所有する。
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onChange, clearLabel, onClear, alwaysShowClear = false, trailing, size = "md", className, ...inputProps },
  ref,
) {
  const t = useT("common");
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

  return (
    <label className={[styles.field, className].filter(Boolean).join(" ")} data-search-field="" data-size={size}>
      <Search className={styles.icon} size={ICON_SIZE[size]} aria-hidden="true" />
      <input
        {...inputProps}
        ref={inputRef}
        type="search"
        className={styles.input}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {trailing != null && <span className={styles.trailing}>{trailing}</span>}
      {(alwaysShowClear || value.trim().length > 0) && (
        <button
          type="button"
          className={styles.clear}
          aria-label={clearLabel ?? t("search.clear")}
          disabled={inputProps.disabled}
          // 押しても入力欄から焦点を奪わない (メニューの中では、焦点が動くとメニューや選択範囲の扱いが変わる)。
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (onClear) onClear();
            else onChange("");
            inputRef.current?.focus();
          }}
        >
          <X size={CLEAR_ICON_SIZE[size]} aria-hidden="true" />
        </button>
      )}
    </label>
  );
});
