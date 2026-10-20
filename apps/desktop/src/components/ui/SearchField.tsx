"use client";

import { Search, X } from "lucide-react";
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { InputHTMLAttributes } from "react";

import { useT } from "@/lib/i18n/react";

import styles from "./SearchField.module.css";

export type SearchFieldSize = "md" | "sm";

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "type" | "size" | "className"> {
  value: string;
  onChange: (value: string) => void;
  /** 入力欄の読み上げ名。placeholder だけに頼らず、必ず渡す。 */
  "aria-label": string;
  /** 消去ボタンの名前。省略すると共通語の「検索をクリア」。 */
  clearLabel?: string;
  /** 消去ボタンの動作。入力の変更と別の扱いが要るときだけ渡す (省略すると `onChange("")`)。 */
  onClear?: () => void;
  /** `md` はページ上部の検索バー、`sm` はメニューやポップオーバーの中。 */
  size?: SearchFieldSize;
  /** 外側の面に付ける。幅や余白などの配置だけを、画面側の CSS に置く。 */
  className?: string;
}

/**
 * ワークスペースの検索バーを正本にした検索入力。丸い灰色の面、虫眼鏡、入力があるときだけ出る消去ボタン、
 * フォーカスで白へ変わる状態までを持つ。何を絞るか、いつ検索するかは持たず、値は呼び出し側が所有する。
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onChange, clearLabel, onClear, size = "md", className, ...inputProps },
  ref,
) {
  const t = useT("common");
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

  return (
    <label className={[styles.field, className].filter(Boolean).join(" ")} data-search-field="" data-size={size}>
      <Search className={styles.icon} size={size === "sm" ? 14 : 16} aria-hidden="true" />
      <input
        {...inputProps}
        ref={inputRef}
        type="search"
        className={styles.input}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value.trim().length > 0 && (
        <button
          type="button"
          className={styles.clear}
          aria-label={clearLabel ?? t("search.clear")}
          // 押しても入力欄から焦点を奪わない (メニューの中では、焦点が動くとメニューや選択範囲の扱いが変わる)。
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (onClear) onClear();
            else onChange("");
            inputRef.current?.focus();
          }}
        >
          <X size={size === "sm" ? 12 : 14} aria-hidden="true" />
        </button>
      )}
    </label>
  );
});
