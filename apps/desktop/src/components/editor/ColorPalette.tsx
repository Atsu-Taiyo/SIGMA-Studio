"use client";

import { Plus, Ban } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatHex6, parseHexColor } from "@/lib/color";
import { fillOpacityToPercent, percentToFillOpacity } from "@/lib/fill-opacity";
import { useT } from "@/lib/i18n/react";

import {
  COLOR_PICKER_DIALOG_GAP,
  COLOR_PICKER_DIALOG_WIDTH,
  ColorPickerDialog,
} from "./ColorPickerDialog";

type ColorPaletteProps = {
  value: string | null;
  /**
   * 0..1 の不透明度。**渡したときだけ**カスタムパネルに透明度 UI が出る。
   * 省略した呼び出し (表・設定・文字色) の見た目と挙動は変わらない。
   */
  opacity?: number;
  /** 確定。透明度 UI を出していない呼び出しには `opacity` が来ない。 */
  onChange: (color: string | null, opacity?: number) => void;
  /**
   * 操作中の即時プレビュー。ドラッグのたびに呼ばれるので、**履歴に残さない**経路へ配線すること。
   * `null` は「プレビューをやめて元に戻す」。
   */
  onPreview?: (preview: { color: string; opacity: number } | null) => void;
  /** 複数選択で値が食い違っている。単一の誤った値を見せないための表示。 */
  mixed?: boolean;
  allowTransparent?: boolean;
  transparentLabel?: string;
  /** 先頭の「シンプル」段を用途別の推奨色で差し替える (例: グラフの白黒基調パレット)。 */
  presetColors?: readonly string[];
  presetLabel?: string;
  className?: string;
};

const DEFAULT_SIMPLE_COLORS = [
  "#000000",
  "#ffffff",
  "#d0d0d0",
  "#3f3f3f",
  "#1c2748",
  "#3b6ef7",
  "#f08c2b",
  "#1f7e7d",
  "#a5cf3a",
  "#dde640",
] as const;

const PALETTE_GRID: readonly (readonly string[])[] = [
  ["#000000", "#1f1f1f", "#3a3a3a", "#555555", "#737373", "#969696", "#bfbfbf", "#d9d9d9", "#ededed", "#ffffff"],
  ["#e60000", "#ff6a00", "#ffc400", "#ffeb00", "#abe322", "#00b853", "#00b3a4", "#00a3ff", "#3b48ff", "#7a3bff"],
  ["#fcd5d5", "#ffe2c2", "#fff3c2", "#fffac2", "#e7f5c8", "#c8efd6", "#c8eee9", "#cae7fb", "#d4d7fb", "#e1d3fb"],
  ["#f6a5a5", "#ffc391", "#ffe487", "#fff58c", "#cfeb91", "#92dcaf", "#92d9d2", "#94c8f5", "#a4abf5", "#bea0f1"],
  ["#ec7a7a", "#ffa358", "#ffd44c", "#fff05c", "#b7d863", "#5cc683", "#5cc1b8", "#5da3e8", "#6c75ee", "#9963e3"],
  ["#c40000", "#d95800", "#d9a300", "#d9c400", "#88b020", "#069041", "#008f82", "#0083d5", "#2935d5", "#5b27d2"],
  ["#a30000", "#b04600", "#b08000", "#b09f00", "#6c8d18", "#03722f", "#006e64", "#006ab1", "#1f27ad", "#481ea7"],
  ["#7a0000", "#823300", "#825e00", "#827700", "#536c12", "#02551f", "#004e47", "#005086", "#171c83", "#341776"],
  ["#4d0000", "#532100", "#533c00", "#534c00", "#374608", "#013717", "#003330", "#003459", "#0d1156", "#22104b"],
];

const CUSTOM_STORAGE_KEY = "sigma-studio:color-palette.custom";
const CUSTOM_MAX = 18;

/**
 * Three- and six-digit hex only, on purpose.
 *
 * Swatches — including the saved custom ones — are colours, and this app stores a colour and its
 * opacity in separate fields. Accepting `#rrggbbaa` here would let an alpha ride back into
 * `fillColor` through a swatch click and quietly undo that split.
 */
function normalizeColor(input: string): string | null {
  const value = input.trim();
  if (!/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return null;
  const parsed = parseHexColor(value);
  return parsed ? formatHex6(parsed.rgb) : null;
}

/** `#rrggbb` plus an alpha, so a chip can show its colour over a checkerboard instead of fading it. */
function withAlpha(color: string, alpha: number): string {
  const normalized = normalizeColor(color);
  const parsed = normalized ? parseHexColor(normalized) : null;
  if (!parsed) {
    return color;
  }
  return `rgba(${parsed.rgb.r}, ${parsed.rgb.g}, ${parsed.rgb.b}, ${alpha})`;
}

function readCustomColors(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string") continue;
      const normalized = normalizeColor(entry);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= CUSTOM_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

function writeCustomColors(colors: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(colors));
  } catch {
    // ignore quota / serialization failures
  }
}

export function ColorPalette({
  value,
  opacity,
  onChange,
  onPreview,
  mixed = false,
  allowTransparent = false,
  transparentLabel,
  presetColors = DEFAULT_SIMPLE_COLORS,
  presetLabel,
  className,
}: ColorPaletteProps) {
  const t = useT("common");
  const normalizedValue = value ? normalizeColor(value) : null;
  const [customColors, setCustomColors] = useState<string[]>([]);
  const supportsOpacity = opacity !== undefined;
  const [creating, setCreating] = useState<{ side: "left" | "right" } | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const hadDialogRef = useRef(false);
  const onPreviewRef = useRef(onPreview);
  useEffect(() => {
    onPreviewRef.current = onPreview;
  }, [onPreview]);

  // A preview is additive over the document, so dropping it *is* the restore. Tying that to the
  // component's lifetime covers every way this palette can disappear — the popover unmounts its
  // children whenever it closes, and the toolbar has many buttons that close it without going
  // through `onClose`.
  useEffect(() => () => onPreviewRef.current?.(null), []);

  useEffect(() => {
    // Hydrate from localStorage after mount to avoid SSR/CSR markup divergence.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCustomColors(readCustomColors());
  }, []);

  // The dialog takes the keyboard when it opens, so closing it has to hand the keyboard back. Left
  // on `<body>`, the palette stops answering Escape (the popover ignores keys from outside itself)
  // and Tab restarts from the top of the page. It has to happen after the re-render, because the
  // "+" is still inert at the moment the close handler runs.
  useEffect(() => {
    if (creating !== null) {
      hadDialogRef.current = true;
      return;
    }
    if (!hadDialogRef.current) return;
    hadDialogRef.current = false;
    createButtonRef.current?.focus({ preventScroll: true });
  }, [creating]);

  const persistCustom = useCallback((colors: string[]) => {
    setCustomColors(colors);
    writeCustomColors(colors);
  }, []);

  const closeDialog = () => {
    setCreating(null);
    onPreview?.(null);
  };

  /**
   * The dialog opens beside the palette, to its left by default. The side is picked here, when it
   * opens, so the card is mounted already on the side that fits instead of jumping after a frame.
   */
  const openDialog = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.closest(".color-palette")?.getBoundingClientRect();
    const roomOnTheLeft = rect === undefined
      || rect.left >= COLOR_PICKER_DIALOG_WIDTH + COLOR_PICKER_DIALOG_GAP;
    setCreating({ side: roomOnTheLeft ? "left" : "right" });
  };

  const selectedSwatch = mixed ? null : normalizedValue;
  const createLabel = supportsOpacity ? t("color.createWithOpacity") : t("color.create");
  // 既定値は hook を呼べるここで解決する (引数のデフォルトには書けない)。
  const resolvedTransparentLabel = transparentLabel ?? t("color.transparent");
  const resolvedPresetLabel = presetLabel ?? t("color.presetSimpleLight");

  return (
    <div className={`color-palette ${className ?? ""}`.trim()} role="group" aria-label={t("color.paletteAria")}>
      {/*
        The dialog is a sibling of this body rather than a child of it: `inert` has to reach the
        swatches without reaching the dialog that suspended them.
      */}
      <div className="color-palette-body" inert={creating !== null}>
        <div className="color-palette-section">
          <div className="color-palette-section-head">
            <span>{resolvedPresetLabel}</span>
          </div>
          <div className="color-palette-row" role="listbox" aria-label={resolvedPresetLabel}>
            {presetColors.map((color) => (
              <ColorSwatch
                key={`simple-${color}`}
                color={color}
                selected={selectedSwatch === color}
                onSelect={() => onChange(color)}
              />
            ))}
          </div>
        </div>

        <div className="color-palette-section">
          <div className="color-palette-section-head">
            <span>{t("color.custom")}</span>
            <div className="color-palette-section-tools">
              <button
                ref={createButtonRef}
                type="button"
                className="color-palette-section-action"
                title={createLabel}
                aria-label={createLabel}
                aria-haspopup="dialog"
                aria-expanded={creating !== null}
                onMouseDown={(event) => event.preventDefault()}
                onClick={openDialog}
              >
                <Plus size={13} />
              </button>
            </div>
          </div>
          <div className="color-palette-row" role="listbox" aria-label={t("color.custom")}>
            {customColors.length === 0 ? (
              <span className="color-palette-empty">{t("color.customEmpty")}</span>
            ) : (
              customColors.map((color) => (
                <ColorSwatch
                  key={`custom-${color}`}
                  color={color}
                  selected={selectedSwatch === color}
                  onSelect={() => onChange(color)}
                />
              ))
            )}
          </div>
        </div>

        <div className="color-palette-grid" role="listbox" aria-label={t("color.standard")}>
          {PALETTE_GRID.map((row, rowIndex) =>
            row.map((color) => (
              <ColorSwatch
                key={`grid-${rowIndex}-${color}`}
                color={color}
                selected={selectedSwatch === color}
                onSelect={() => onChange(color)}
              />
            ))
          )}
        </div>

        {supportsOpacity && (
          <div className="color-palette-fill-summary">
            <span
              className={`color-palette-fill-chip ${mixed ? "mixed" : ""} ${!mixed && value === null ? "empty" : ""}`}
              aria-hidden="true"
              style={mixed || value === null
                ? undefined
                // A stored colour this palette cannot parse (`red`, `rgb(...)`) is still a colour:
                // show it as it is rather than reporting "no fill" over a visibly filled shape.
                : { ["--fill-chip-color" as string]: normalizedValue === null
                  ? value
                  : withAlpha(normalizedValue, percentToFillOpacity(fillOpacityToPercent(opacity))) }}
            />
            <span className="color-palette-fill-value">
              {mixed ? t("color.mixed") : value === null ? t("color.noFill") : t("color.opacityPercent", { percent: fillOpacityToPercent(opacity) })}
            </span>
          </div>
        )}

        {allowTransparent && (
          <button
            type="button"
            className={`color-palette-transparent ${!mixed && value === null ? "active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(null)}
          >
            <Ban size={14} />
            <span>{resolvedTransparentLabel}</span>
          </button>
        )}
      </div>

      {creating !== null && (
        <ColorPickerDialog
          color={mixed ? null : value}
          opacity={opacity}
          side={creating.side}
          onDraftChange={(next) => onPreview?.(next)}
          onCancel={closeDialog}
          onSubmit={(color, nextOpacity) => {
            // Drop the preview before the change lands: the other order lets the restore overwrite
            // the value that was just confirmed.
            onPreview?.(null);
            persistCustom([color, ...customColors.filter((entry) => entry !== color)].slice(0, CUSTOM_MAX));
            setCreating(null);
            onChange(color, nextOpacity);
          }}
        />
      )}
    </div>
  );
}

type ColorSwatchProps = {
  color: string;
  selected: boolean;
  onSelect: () => void;
};

function ColorSwatch({ color, selected, onSelect }: ColorSwatchProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`color-palette-swatch ${selected ? "selected" : ""}`}
      title={color}
      style={{ backgroundColor: color }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
    />
  );
}
