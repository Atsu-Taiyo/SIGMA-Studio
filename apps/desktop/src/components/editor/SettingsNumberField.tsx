"use client";

import { Minus, Plus } from "lucide-react";
import { useId, useState } from "react";

import { useT } from "@/lib/i18n/react";

import styles from "./SettingsNumberField.module.css";

/**
 * 設定ダイアログの数値欄。−/＋ で `step` ずつ、矢印キーでも動かせる。入力途中の空欄や「1.」は
 * そのまま打てるよう下書きの文字列で持ち、確かな数になったときだけ反映する。
 * `integer` は整数だけ (ページ番号など)。範囲を超えた入力は確定 (離れる・Enter) のときに範囲内へ寄せる。
 * 単位が無い欄は `unit` を省く。
 *
 * `optional` の欄は空にでき、空は「自動」(既定値に任せる) を表す。空の間は `placeholder` を見せ、
 * −/＋ は `emptyValue` から動かし始める。
 */
export function SettingsNumberField({
  id,
  label,
  value,
  min = 0,
  max,
  step = 1,
  decimals = 1,
  integer = false,
  unit,
  placeholder,
  emptyValue,
  testId,
  onChange,
  onFocus,
  onMouseEnter,
  ...rest
}: {
  id: string;
  label: string;
  min?: number;
  max?: number;
  /** −/＋ と矢印キーで動かす量。 */
  step?: number;
  /** 確定時に丸める小数の桁数。 */
  decimals?: number;
  integer?: boolean;
  unit?: string;
  placeholder?: string;
  testId?: string;
  onFocus?: () => void;
  onMouseEnter?: () => void;
} & (
  | { optional?: false; value: number; emptyValue?: undefined; onChange: (value: number) => void }
  | { optional: true; value: number | undefined; emptyValue: number; onChange: (value: number | undefined) => void }
)) {
  const t = useT("settings");
  const unitId = useId();
  const optional = rest.optional === true;
  const [text, setText] = useState<string | null>(null);
  const round = (next: number) => {
    if (integer) return Math.round(next);
    const factor = 10 ** decimals;
    return Math.round(next * factor) / factor;
  };
  const shown = text ?? (value === undefined ? "" : String(round(value)));
  const base = value ?? emptyValue ?? min;
  const inRange = (next: number) => next >= min && (max === undefined || next <= max);
  const emit = onChange as (value: number | undefined) => void;
  const commit = (next: number) => {
    setText(null);
    emit(Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, round(next))));
  };
  const stepBy = (direction: 1 | -1) => {
    const current = Number(shown);
    commit((shown.trim() !== "" && Number.isFinite(current) ? current : base) + direction * step);
  };
  return (
    <div className={styles.field} onMouseEnter={onMouseEnter}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <div className={styles.control} data-unitless={unit ? undefined : true}>
        <button
          type="button"
          className={styles.stepButton}
          aria-label={t("page.decrease", { label })}
          disabled={value !== undefined && value <= min}
          onClick={() => stepBy(-1)}
          onFocus={onFocus}
        >
          <Minus size={13} aria-hidden="true" />
        </button>
        <input
          id={id}
          type="number"
          inputMode={integer ? "numeric" : "decimal"}
          min={min}
          max={max}
          step={integer ? 1 : "any"}
          value={shown}
          placeholder={placeholder}
          data-testid={testId}
          aria-describedby={unit ? unitId : undefined}
          onFocus={(event) => {
            event.currentTarget.select();
            onFocus?.();
          }}
          onChange={(event) => {
            const raw = event.target.value;
            setText(raw);
            if (raw.trim() === "") {
              if (optional) emit(undefined);
              return;
            }
            const next = Number(raw);
            if (Number.isFinite(next) && inRange(next) && (!integer || Number.isInteger(next))) {
              emit(next);
            }
          }}
          onBlur={() => {
            const next = Number(shown);
            if (shown.trim() !== "" && Number.isFinite(next)) {
              commit(next);
            } else {
              setText(null);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              stepBy(event.key === "ArrowUp" ? 1 : -1);
            } else if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
        {unit ? <span className={styles.unit} id={unitId}>{unit}</span> : null}
        <button
          type="button"
          className={styles.stepButton}
          aria-label={t("page.increase", { label })}
          disabled={max !== undefined && value !== undefined && value >= max}
          onClick={() => stepBy(1)}
          onFocus={onFocus}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
