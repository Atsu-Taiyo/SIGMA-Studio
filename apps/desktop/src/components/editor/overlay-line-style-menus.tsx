"use client";

import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import type { CSSProperties, RefObject } from "react";

import { EditorToolbarMenuButton } from "@/components/editor/EditorToolbar";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { useT } from "@/lib/i18n/react";
import type { OverlayDash, OverlayTextSize } from "@/components/editor/overlay-canvas/types";

export type OverlayLineDashOption<T extends string> = {
  value: T;
  label: string;
  dasharray?: string;
  /** 線を描画しない選択肢。 */
  hidden?: boolean;
  /** CSS の二重線のように2本の平行線で表現するスタイル。 */
  double?: boolean;
};

/**
 * 既定の線種。**文言は持たない。**
 *
 * 表示名は `chrome.format.lineDash.*` が唯一の出典で、下のメニューが引き当てる
 * (実際、以前ここにあった日本語は常に上書きされて一度も画面に出ていなかった)。
 * ここに label を置くと同じ語の出典が 2 つになり、必ずドリフトする。
 */
export const OVERLAY_LINE_DASH_VALUES = [
  { value: "solid" },
  { value: "dashed", dasharray: "8 5" },
  { value: "dotted", dasharray: "1 5" },
] as const satisfies readonly (Omit<OverlayLineDashOption<OverlayDash>, "label">)[];

export type OverlayLineWidthOption<T extends string> = {
  value: T;
  label: string;
  strokeWidth: number;
};

/** 既定の線幅。文言を持たない理由は {@link OVERLAY_LINE_DASH_VALUES} と同じ。 */
export const OVERLAY_LINE_WIDTH_VALUES = [
  { value: "s", strokeWidth: 1.25 },
  { value: "m", strokeWidth: 2 },
  { value: "l", strokeWidth: 3 },
  { value: "xl", strokeWidth: 5 },
] as const satisfies readonly (Omit<OverlayLineWidthOption<OverlayTextSize>, "label">)[];

function DashSample({ option, y, selected }: { option: OverlayLineDashOption<string>; y: number; selected: boolean }) {
  const className = `line-dash-sample ${selected ? "selected" : ""}`;
  if (option.hidden) {
    return <line className={className} x1="8" y1={y + 3} x2="30" y2={y - 3} />;
  }
  if (option.double) {
    return (
      <>
        <line className={className} x1="5" y1={y - 1.4} x2="33" y2={y - 1.4} />
        <line className={className} x1="5" y1={y + 1.4} x2="33" y2={y + 1.4} />
      </>
    );
  }
  return <line className={className} x1="5" y1={y} x2="33" y2={y} strokeDasharray={option.dasharray} />;
}

function LineDashButtonPreview<T extends string>({
  options,
  value,
  mixed,
}: {
  options: OverlayLineDashOption<T>[];
  value: T | null;
  mixed: boolean;
}) {
  return (
    <svg className={`line-dash-preview line-dash-preview-button ${mixed ? "mixed" : ""}`} viewBox="0 0 38 24" aria-hidden="true">
      {options.map((option, index) => (
        <DashSample
          key={option.value}
          option={option}
          y={options.length === 1 ? 12 : 4 + index * (16 / (options.length - 1))}
          selected={value === option.value && !mixed}
        />
      ))}
    </svg>
  );
}

function LineDashMenuPreview({ option }: { option: OverlayLineDashOption<string> }) {
  return (
    <svg className="line-dash-preview" viewBox="0 0 38 18" aria-hidden="true">
      <DashSample option={option} y={9} selected={false} />
    </svg>
  );
}

export function LineWidthPreview<T extends string = OverlayTextSize>({
  size,
  mixed = false,
  variant = "menu",
  options,
}: {
  size: T;
  mixed?: boolean;
  variant?: "button" | "menu";
  options?: OverlayLineWidthOption<T>[];
}) {
  const resolvedOptions = options ?? (OVERLAY_LINE_WIDTH_VALUES.map((item) => ({
    ...item,
    label: "",
  })) as unknown as OverlayLineWidthOption<T>[]);
  const option = resolvedOptions.find((item) => item.value === size) ?? { value: size, label: "", strokeWidth: 2 };

  if (variant === "button") {
    return (
      <svg className={`line-width-preview line-width-preview-button ${mixed ? "mixed" : ""}`} viewBox="0 0 38 24" aria-hidden="true">
        {resolvedOptions.map((item, index) => (
          <line
            key={item.value}
            className={`line-width-sample ${size === item.value && !mixed ? "selected" : ""}`}
            x1="5"
            y1={5 + index * 5}
            x2="33"
            y2={5 + index * 5}
            strokeWidth={item.strokeWidth}
          />
        ))}
      </svg>
    );
  }

  return (
    <svg className={`line-width-preview ${mixed ? "mixed" : ""}`} viewBox="0 0 36 18" aria-hidden="true">
      <line
        x1="5"
        y1="9"
        x2="31"
        y2="9"
        strokeWidth={option.strokeWidth}
        strokeDasharray={mixed ? "3 3" : undefined}
      />
    </svg>
  );
}

export function OverlayLineDashMenuButton<T extends string = OverlayDash>({
  buttonRef,
  options,
  currentValue,
  open,
  disabled = false,
  onToggle,
  onSelect,
  popoverZIndex,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  options?: OverlayLineDashOption<T>[];
  currentValue: T | null;
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onSelect: (value: T) => void;
  /** body へ portal されたときに手前へ出すための重なり順。既定はツールバー用。 */
  popoverZIndex?: CSSProperties["zIndex"];
}) {
  const t = useT("chrome");
  // 呼び出し側が選択肢を渡さないときは既定の3種。ラベルは chrome namespace から引くので、
  // 共有先 (表の枠線エディタ) でも英語ロケールで英語になる。
  const resolvedOptions = options ?? (OVERLAY_LINE_DASH_VALUES.map((option) => ({
    ...option,
    label: t(`format.lineDash.${option.value}`),
  })) as unknown as OverlayLineDashOption<T>[]);
  const currentOption = resolvedOptions.find((option) => option.value === currentValue);
  const currentLabel = currentOption?.label ?? t("format.mixed");
  const buttonLabel = t("format.currentValue", { label: t("format.lineDash.label"), value: currentLabel });

  return (
    <div className="shape-menu-anchor">
      <EditorToolbarMenuButton
        buttonRef={buttonRef}
        variant="lineDash"
        active={open}
        tooltip={{ label: t("format.lineDash.tooltip", { value: currentLabel }) }}
        aria-label={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={onToggle}
      >
        <LineDashButtonPreview options={resolvedOptions} value={currentValue} mixed={!currentValue} />
      </EditorToolbarMenuButton>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={onToggle}
        className="shape-menu line-dash-menu"
        role="menu"
        ariaLabel={t("format.lineDash.label")}
        zIndex={popoverZIndex}
      >
        {resolvedOptions.map((option) => {
          const selected = currentValue === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-label={option.label}
              aria-checked={selected}
              className={selected ? "selected" : ""}
              onClick={() => onSelect(option.value)}
            >
              <span className="line-dash-menu-check" aria-hidden="true">{selected ? <Check size={14} /> : null}</span>
              <LineDashMenuPreview option={option} />
              <span>{option.label}</span>
            </button>
          );
        })}
      </ToolbarPopover>
    </div>
  );
}

export function OverlayLineWidthMenuButton<T extends string = OverlayTextSize>({
  buttonRef,
  options,
  currentValue,
  open,
  disabled = false,
  onToggle,
  onSelect,
  popoverZIndex,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  options?: OverlayLineWidthOption<T>[];
  currentValue: T | null;
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onSelect: (value: T) => void;
  /** body へ portal されたときに手前へ出すための重なり順。既定はツールバー用。 */
  popoverZIndex?: CSSProperties["zIndex"];
}) {
  const t = useT("chrome");
  const resolvedOptions = options ?? (OVERLAY_LINE_WIDTH_VALUES.map((option) => ({
    ...option,
    label: t(`format.lineWidth.${option.value}`),
  })) as unknown as OverlayLineWidthOption<T>[]);
  const currentOption = resolvedOptions.find((option) => option.value === currentValue);
  const currentLabel = currentOption?.label ?? t("format.mixed");
  const buttonLabel = t("format.currentValue", { label: t("format.lineWidth.label"), value: currentLabel });
  const previewValue = currentValue
    ?? resolvedOptions[Math.min(1, resolvedOptions.length - 1)]?.value
    ?? resolvedOptions[0].value;

  return (
    <div className="shape-menu-anchor">
      <EditorToolbarMenuButton
        buttonRef={buttonRef}
        variant="lineWidth"
        active={open}
        tooltip={{ label: t("format.lineWidth.tooltip", { value: currentLabel }) }}
        aria-label={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={onToggle}
      >
        <LineWidthPreview size={previewValue} mixed={!currentValue} variant="button" options={options} />
      </EditorToolbarMenuButton>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={onToggle}
        className="shape-menu line-width-menu"
        role="menu"
        ariaLabel={t("format.lineWidth.label")}
        zIndex={popoverZIndex}
      >
        {resolvedOptions.map((option) => {
          const selected = currentValue === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-label={option.label}
              aria-checked={selected}
              className={selected ? "selected" : ""}
              onClick={() => onSelect(option.value)}
            >
              <span className="line-width-menu-check" aria-hidden="true">{selected ? <Check size={14} /> : null}</span>
              <LineWidthPreview size={option.value} options={options} />
              <span>{option.label}</span>
            </button>
          );
        })}
      </ToolbarPopover>
    </div>
  );
}

export type OverlayTextAlignOption<T extends string> = {
  value: T;
  label: string;
  icon: LucideIcon;
};

export function OverlayTextAlignMenuButton<T extends string>({
  buttonRef,
  options,
  currentValue,
  open,
  disabled = false,
  onToggle,
  onSelect,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  options: OverlayTextAlignOption<T>[];
  currentValue: T | null;
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onSelect: (value: T) => void;
}) {
  // このファイルはクロームと共用なので、`chrome` の `t` と名前を分ける
  // (`chrome-i18n.test.ts` は `t("…")` を全てクロームのキーとして走査する)。
  const tShape = useT("shape");
  const activeOption = options.find((option) => option.value === currentValue) ?? options[0];
  const ActiveIcon = activeOption.icon;
  const buttonLabel = tShape("textAlign.currentAria", { align: activeOption.label });

  return (
    <div className="shape-menu-anchor">
      <EditorToolbarMenuButton
        buttonRef={buttonRef}
        variant="textAlign"
        active={open}
        tooltip={{ label: tShape("textAlign.tooltip", { align: activeOption.label }) }}
        aria-label={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={onToggle}
      >
        <ActiveIcon size={16} />
        <ChevronDown size={12} />
      </EditorToolbarMenuButton>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={onToggle}
        className="shape-menu text-align-menu"
        role="menu"
        ariaLabel={tShape("textAlign.menuAria")}
      >
        {options.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={currentValue === value}
            aria-label={label}
            title={label}
            className={currentValue === value ? "selected" : ""}
            onClick={() => onSelect(value)}
          >
            <Icon size={18} />
          </button>
        ))}
      </ToolbarPopover>
    </div>
  );
}
