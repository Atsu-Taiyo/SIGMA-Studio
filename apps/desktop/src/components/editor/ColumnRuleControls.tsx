"use client";

import { useRef, useState } from "react";
import { DEFAULT_COLUMN_RULE, normalizeColumnRule, type ColumnRule } from "@/features/document";
import { useT } from "@/lib/i18n/react";
import { ColorPalette } from "./ColorPalette";
import { ToolbarPopover } from "./ToolbarPopover";
import {
  OverlayLineDashMenuButton,
  OverlayLineWidthMenuButton,
  type OverlayLineDashOption,
} from "./overlay-line-style-menus";

const widths = [
  { value: "s", strokeWidth: 1 },
  { value: "m", strokeWidth: 2 },
  { value: "l", strokeWidth: 3 },
  { value: "xl", strokeWidth: 4 },
] as const;

export function ColumnRuleControls({ value, onChange, columnCount }: {
  value?: ColumnRule;
  onChange: (rule: ColumnRule) => void;
  columnCount: number;
}) {
  const t = useT("settings");
  const chrome = useT("chrome");
  const rule = normalizeColumnRule(value) ?? DEFAULT_COLUMN_RULE;
  const [open, setOpen] = useState<"style" | "width" | "color" | null>(null);
  const styleRef = useRef<HTMLButtonElement>(null);
  const widthRef = useRef<HTMLButtonElement>(null);
  const colorRef = useRef<HTMLButtonElement>(null);
  const options: OverlayLineDashOption<ColumnRule["style"]>[] = [
    { value: "none", label: chrome("format.lineDash.none"), hidden: true },
    { value: "solid", label: chrome("format.lineDash.solid") },
    { value: "dashed", label: chrome("format.lineDash.dashed"), dasharray: "8 5" },
    { value: "dotted", label: chrome("format.lineDash.dotted"), dasharray: "1 5" },
    { value: "double", label: chrome("format.lineDash.double"), double: true },
  ];
  const selectedWidth = widths.reduce((best, item) =>
    Math.abs(item.strokeWidth - rule.widthPx) < Math.abs(best.strokeWidth - rule.widthPx) ? item : best, widths[0] as typeof widths[number]);
  const change = (patch: Partial<ColumnRule>) => {
    onChange(normalizeColumnRule({ ...rule, ...patch })!);
    setOpen(null);
  };

  return <div className="column-rule-controls">
    <div className="column-rule-fields">
      <div className="column-rule-field">
        <span className="field-label">{chrome("format.lineDash.label")}</span>
        <OverlayLineDashMenuButton buttonRef={styleRef} options={options} currentValue={rule.style}
          open={open === "style"} onToggle={() => setOpen(open === "style" ? null : "style")}
          onSelect={style => change({ style })} popoverZIndex="var(--z-modal-nested)" />
      </div>
      <div className="column-rule-field">
        <span className="field-label">{chrome("format.lineWidth.label")}</span>
        <OverlayLineWidthMenuButton buttonRef={widthRef}
          options={widths.map(item => ({ ...item, label: chrome(`format.lineWidth.${item.value}`) }))}
          currentValue={selectedWidth.value} open={open === "width"}
          onToggle={() => setOpen(open === "width" ? null : "width")}
          onSelect={size => change({ widthPx: widths.find(item => item.value === size)!.strokeWidth })}
          popoverZIndex="var(--z-modal-nested)" />
      </div>
      <div className="column-rule-field">
        <span className="field-label">{t("columnRule.color")}</span>
        <button type="button" ref={colorRef} className="column-rule-color button secondary"
          aria-label={t("columnRule.color")} aria-haspopup="dialog" aria-expanded={open === "color"}
          onClick={() => setOpen(open === "color" ? null : "color")}>
          <span aria-hidden="true" style={{ backgroundColor: rule.color }} />
          {rule.color}
        </button>
        <ToolbarPopover open={open === "color"} anchorRef={colorRef} onClose={() => setOpen(null)}
          className="color-popover" ariaLabel={t("columnRule.color")} zIndex="var(--z-modal-nested)">
          <ColorPalette value={rule.color} onChange={color => { if (color) change({ color }); }} />
        </ToolbarPopover>
      </div>
    </div>
    <div className="column-rule-preview" aria-label={t("columnRule.preview")} style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}>
      {Array.from({ length: columnCount }, (_, index) => <div key={index}>
        {index > 0 && <span className="column-rule-preview-line" style={{ borderLeft: `${rule.widthPx}px ${rule.style} ${rule.color}` }} />}
        <i /><i /><i />
      </div>)}
    </div>
  </div>;
}
