"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { Button } from "@/components/ui/Button";
import { useT } from "@/lib/i18n/react";
import {
  type ColorChannel,
  type ColorDraft,
  createColorDraft,
  draftColor,
  draftOpacity,
  draftRgb,
  setDraftAlphaPercent,
  setDraftChannel,
  setDraftHexText,
  setDraftHue,
  setDraftSaturationValue,
} from "@/lib/color-picker-draft";

/**
 * Creates one colour, with its transparency when the caller edits one.
 *
 * Rendered as a panel beside the palette, *inside* its popover, rather than as a second popover or
 * a modal: a portalled panel would land outside the first popover's outside-click test and take the
 * palette down with it, and a modal backdrop would dim the very figure this dialog previews.
 *
 * Every state transition lives in `lib/color-picker-draft.ts`; this component is event plumbing.
 */

/** The card's width, so the palette can tell whether there is room for it on the left. */
export const COLOR_PICKER_DIALOG_WIDTH = 280;
/** The gap the stylesheet leaves between the palette and the card. */
export const COLOR_PICKER_DIALOG_GAP = 8;

interface ColorPickerDialogProps {
  /** The colour the palette opened on. `null` for no fill or a disagreeing selection. */
  color: string | null;
  /** 0..1. Omitted callers get no transparency controls at all. */
  opacity: number | undefined;
  /** Which side of the palette the card opens on. Decided by the palette when it opens. */
  side: "left" | "right";
  /** Live preview while the author works. `null` is never sent from here — see `ColorPalette`. */
  onDraftChange: (draft: { color: string; opacity: number }) => void;
  onCancel: () => void;
  /** Always a real colour: "no fill" belongs to the palette's own button, not to this dialog. */
  onSubmit: (color: string, opacity: number | undefined) => void;
}

/** チャンネル → `common.color.*` のキー。 */
const CHANNEL_KEYS: Readonly<Record<ColorChannel, "red" | "green" | "blue">> = {
  r: "red",
  g: "green",
  b: "blue",
};

// 表示ラベルは `common.color.<channel>` が持つ。ここは並びと短縮記号だけ。
const CHANNEL_LABELS: ReadonlyArray<{ channel: ColorChannel; short: string }> = [
  { channel: "r", short: "R" },
  { channel: "g", short: "G" },
  { channel: "b", short: "B" },
];

/** Whole percent per arrow key on the saturation/value square; Shift multiplies it. */
const AREA_KEY_STEP = 0.01;
const AREA_KEY_COARSE_MULTIPLIER = 10;

export function ColorPickerDialog({
  color,
  opacity,
  side,
  onDraftChange,
  onCancel,
  onSubmit,
}: ColorPickerDialogProps) {
  const t = useT("common");
  const [draft, setDraft] = useState<ColorDraft>(() => createColorDraft({ color, opacity }));
  const draftRef = useRef(draft);
  const areaRef = useRef<HTMLDivElement>(null);
  const areaPointerRef = useRef<number | null>(null);
  const onDraftChangeRef = useRef(onDraftChange);
  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  }, [onDraftChange]);

  useEffect(() => {
    // The palette's grid keeps the keyboard otherwise, and the square is this dialog's subject.
    areaRef.current?.focus({ preventScroll: true });
  }, []);

  const applyDraft = useCallback((transition: (current: ColorDraft) => ColorDraft) => {
    const current = draftRef.current;
    const next = transition(current);
    // Pointer moves arrive every frame; an unchanged draft is the same object, so a drag that
    // stands still neither re-renders the palette nor re-sends a preview.
    if (next === current) return;
    draftRef.current = next;
    setDraft(next);
    if (next.touched) {
      onDraftChangeRef.current({ color: draftColor(next), opacity: draftOpacity(next) });
    }
  }, []);

  const rgb = draftRgb(draft);
  // The swatch shows the colour this dialog would produce, never the raw stored string. A stored
  // colour it cannot parse (`red`, `rgb(...)`) is still visible in the hex box and on the palette's
  // own chip; painting it here would promise a colour that pressing OK does not write.
  const swatchColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${draft.alphaPercent / 100})`;

  const submit = () => onSubmit(draftColor(draft), draft.alphaEnabled ? draftOpacity(draft) : undefined);

  const commitFromPointer = useCallback((clientX: number, clientY: number) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const saturation = (clientX - rect.left) / rect.width;
    const value = 1 - (clientY - rect.top) / rect.height;
    applyDraft((current) => setDraftSaturationValue(current, saturation, value));
  }, [applyDraft]);

  const handleAreaPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    areaPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    // `preventDefault` here would stop the square from taking focus, so the focus is taken by hand.
    event.currentTarget.focus({ preventScroll: true });
    commitFromPointer(event.clientX, event.clientY);
  };

  const handleAreaPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (areaPointerRef.current !== event.pointerId) return;
    commitFromPointer(event.clientX, event.clientY);
  };

  const endAreaPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (areaPointerRef.current !== event.pointerId) return;
    areaPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleAreaKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = AREA_KEY_STEP * (event.shiftKey ? AREA_KEY_COARSE_MULTIPLIER : 1);
    const key = event.key;
    if (!["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Read the axes off the draft the transition is given, not off the render this handler closed
    // over, so a burst of repeats cannot all start from the same value.
    applyDraft((current) => {
      const saturation = key === "Home" ? 0
        : key === "End" ? 1
          : key === "ArrowLeft" ? current.hsv.s - step
            : key === "ArrowRight" ? current.hsv.s + step
              : current.hsv.s;
      const value = key === "ArrowDown" ? current.hsv.v - step
        : key === "ArrowUp" ? current.hsv.v + step
          : current.hsv.v;
      return setDraftSaturationValue(current, saturation, value);
    });
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // The popover closes on Escape from a document-level listener that ignores `defaultPrevented`,
      // so cancelling this dialog means stopping the event, not just consuming it.
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      // The popover moves focus between its controls on these keys, which would take the arrow keys
      // away from every slider and number box in here.
      event.stopPropagation();
      return;
    }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      // The fields are not in a form, so without this the only way to confirm is to reach OK.
      event.preventDefault();
      event.stopPropagation();
      submit();
    }
  };

  const areaStyle = {
    "--color-picker-hue": `${draft.hsv.h}`,
    "--color-picker-handle-x": `${draft.hsv.s * 100}%`,
    "--color-picker-handle-y": `${(1 - draft.hsv.v) * 100}%`,
  } as CSSProperties;

  return (
    <div
      className="color-picker-dialog"
      data-side={side}
      role="dialog"
      aria-label={t("color.create")}
      onKeyDown={handleDialogKeyDown}
    >
      <div
        ref={areaRef}
        className="color-picker-area"
        role="slider"
        tabIndex={0}
        aria-label={t("color.saturationValue")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(draft.hsv.s * 100)}
        aria-valuetext={t("color.saturationValueText", { saturation: Math.round(draft.hsv.s * 100), value: Math.round(draft.hsv.v * 100) })}
        style={areaStyle}
        onPointerDown={handleAreaPointerDown}
        onPointerMove={handleAreaPointerMove}
        onPointerUp={endAreaPointer}
        onPointerCancel={endAreaPointer}
        onKeyDown={handleAreaKeyDown}
      >
        <span className="color-picker-area-handle" aria-hidden="true" />
      </div>

      <div className="color-picker-controls">
        <span
          className="color-picker-preview"
          aria-hidden="true"
          style={{ ["--fill-chip-color" as string]: swatchColor }}
        />
        <div className="color-picker-sliders">
          <input
            type="range"
            className="color-picker-hue-slider"
            aria-label={t("color.hue")}
            min={0}
            max={360}
            step={1}
            value={Math.round(draft.hsv.h)}
            onChange={(event) => applyDraft((current) => setDraftHue(current, Number(event.target.value)))}
          />
          {draft.alphaEnabled && (
            <input
              type="range"
              className="color-picker-alpha-slider"
              aria-label={t("color.opacity")}
              min={0}
              max={100}
              step={1}
              value={draft.alphaPercent}
              style={{ ["--color-picker-alpha-color" as string]: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` }}
              onChange={(event) => applyDraft((current) => setDraftAlphaPercent(current, Number(event.target.value)))}
            />
          )}
        </div>
      </div>

      <div className="color-picker-fields">
        <label className="color-picker-field color-picker-field-hex">
          <span>HEX</span>
          <input
            type="text"
            className="color-picker-field-input"
            aria-label={t("color.hex")}
            spellCheck={false}
            autoComplete="off"
            value={draft.hexText}
            onChange={(event) => applyDraft((current) => setDraftHexText(current, event.target.value))}
          />
        </label>
        {CHANNEL_LABELS.map(({ channel, short }) => (
          <label key={channel} className="color-picker-field">
            <span>{short}</span>
            <input
              type="number"
              className="color-picker-field-input"
              aria-label={t(`color.${CHANNEL_KEYS[channel]}`)}
              min={0}
              max={255}
              step={1}
              value={rgb[channel]}
              onChange={(event) => {
                // `Number("")` is 0, which would make an emptied box mean "no red at all".
                if (event.target.value === "") return;
                applyDraft((current) => setDraftChannel(current, channel, Number(event.target.value)));
              }}
              // Rejecting the empty string leaves no state change and therefore no re-render, so
              // the box would keep showing "" while the draft still holds the old number.
              onBlur={(event) => { event.currentTarget.value = String(rgb[channel]); }}
            />
          </label>
        ))}
        {draft.alphaEnabled && (
          <label className="color-picker-field">
            <span>A</span>
            <input
              type="number"
              className="color-picker-field-input"
              aria-label={t("color.opacityInput")}
              min={0}
              max={100}
              step={1}
              value={draft.alphaPercent}
              onChange={(event) => {
                if (event.target.value === "") return;
                applyDraft((current) => setDraftAlphaPercent(current, Number(event.target.value)));
              }}
              onBlur={(event) => { event.currentTarget.value = String(draft.alphaPercent); }}
            />
          </label>
        )}
      </div>

      <div className="color-picker-actions">
        <Button
          tone="secondary"
          size="sm"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          {t("actions.cancel")}
        </Button>
        <Button
          tone="primary"
          size="sm"
          onMouseDown={(event) => event.preventDefault()}
          onClick={submit}
        >
          OK
        </Button>
      </div>
    </div>
  );
}
