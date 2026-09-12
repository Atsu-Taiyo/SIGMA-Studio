"use client";

import { useId, useMemo, useRef, useState } from "react";
import { ChartColumn, ChartLine, ChartPie, ChartScatter } from "lucide-react";

import { ColorPalette } from "@/components/editor/ColorPalette";
import type { SelectedOverlayChart } from "@/components/editor/EditorSettings";
import { GRAPH_SETTINGS_POPOVER_Z_INDEX } from "@/components/editor/EditorSettings";
import { GraphSettingsPanelFrame } from "@/components/editor/GraphSettingsPanel";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { Inline, Stack } from "@/components/ui/layout";
import { resolveChartSeriesColor, type SigmaChartKind, type SigmaChartSpec } from "@/features/document";
import { getChartColorTargets } from "@/features/drawing";
import { useT } from "@/lib/i18n/react";

/**
 * The chart's floating settings panel.
 *
 * It reuses `GraphSettingsPanelFrame` — the same non-modal, draggable frame the graph inspector
 * uses — so charts and graphs behave identically: the panel avoids covering its own shape, and it
 * never becomes a modal that blocks the canvas underneath.
 */
export function ChartSettingsPanel({
  chart,
  onSpecChange,
  onClose,
}: {
  chart: SelectedOverlayChart;
  onSpecChange: (shapeId: string, spec: SigmaChartSpec) => void;
  onClose: () => void;
}) {
  const tShape = useT("shape");
  const kindLabelId = useId();
  const [openColorSeriesId, setOpenColorSeriesId] = useState<string | null>(null);
  const spec = chart.spec;

  const patch = (next: Partial<SigmaChartSpec>) => {
    onSpecChange(chart.shapeId, { ...spec, ...next });
  };

  // The shape of the chart is the thing being chosen, so each option carries the shape itself.
  // A dropdown hid exactly that behind a closed menu.
  const kindOptions = useMemo(() => ([
    { value: "bar" as const, label: tShape("chartPanel.kindBar"), icon: ChartColumn },
    { value: "line" as const, label: tShape("chartPanel.kindLine"), icon: ChartLine },
    { value: "pie" as const, label: tShape("chartPanel.kindPie"), icon: ChartPie },
    { value: "scatter" as const, label: tShape("chartPanel.kindScatter"), icon: ChartScatter },
  ]), [tShape]);

  // The renderer's own list, not a second derivation of it: keys and palette indices must match
  // exactly, or a swatch colours something nothing draws.
  const colorTargets = getChartColorTargets(chart.data, spec);

  const legendDisabled = colorTargets.length < 2;

  return (
    <GraphSettingsPanelFrame
      ariaLabel={tShape("chartPanel.title")}
      onClose={onClose}
      shapeId={chart.shapeId}
      title={tShape("chartPanel.title")}
    >
      <Stack className="editor-settings-section chart-settings-panel" gap="md">
        <div
          className={chart.linked ? "chart-settings-source" : "chart-settings-source broken"}
          data-testid="chart-settings-source"
        >
          {chart.linked ? tShape("chartPanel.sourceLinked") : (
            <>
              <strong>{tShape("chartPanel.sourceMissing")}</strong>
              <span>{tShape("chartPanel.sourceMissingHint")}</span>
            </>
          )}
        </div>

        <Stack gap="xs">
          {/* A `radiogroup` cannot be named by a `<label for>`, so the caption is associated
              through `aria-labelledby` instead — the words stay in one place rather than being
              written once for the eye and again for the screen reader. */}
          <span className="field-label" id={kindLabelId}>{tShape("chartPanel.kind")}</span>
          <ChoiceGroup
            aria-labelledby={kindLabelId}
            columns={4}
            data-testid="chart-kind-picker"
            onChange={(kind: SigmaChartKind) => patch({ kind })}
            options={kindOptions}
            value={spec.kind}
          />
        </Stack>

        <Stack gap="xs">
          <label className="field-label" htmlFor="chart-title">{tShape("chartPanel.chartTitle")}</label>
          <input
            className="chart-settings-text-input"
            id="chart-title"
            onChange={(event) => patch({ title: event.target.value })}
            placeholder={tShape("chartPanel.chartTitlePlaceholder")}
            type="text"
            value={spec.title ?? ""}
          />
        </Stack>

        <Stack gap="xs">
          <label className="checkbox-field">
            <input
              checked={spec.orientation === "rows"}
              onChange={(event) => patch({ orientation: event.target.checked ? "rows" : "columns" })}
              type="checkbox"
            />
            <span>{tShape("chartPanel.orientation")}</span>
          </label>
          <label className="checkbox-field">
            <input
              checked={spec.headerRow}
              onChange={(event) => patch({ headerRow: event.target.checked })}
              type="checkbox"
            />
            <span>{tShape("chartPanel.headerRow")}</span>
          </label>
          <label className="checkbox-field">
            <input
              checked={spec.labelColumn}
              onChange={(event) => patch({ labelColumn: event.target.checked })}
              type="checkbox"
            />
            <span>{tShape("chartPanel.labelColumn")}</span>
          </label>
          <label className="checkbox-field">
            <input
              checked={spec.legend && !legendDisabled}
              disabled={legendDisabled}
              onChange={(event) => patch({ legend: event.target.checked })}
              type="checkbox"
            />
            <span>{tShape("chartPanel.legend")}</span>
          </label>
          {legendDisabled && (
            <span className="chart-settings-hint">{tShape("chartPanel.legendSingleSeriesHint")}</span>
          )}
        </Stack>

        {colorTargets.length > 0 ? (
          <Stack gap="xs">
            <label className="field-label">{tShape("chartPanel.seriesColors")}</label>
            {colorTargets.map((target) => (
              <ChartSeriesColorRow
                color={resolveChartSeriesColor(spec, target.key, target.index)}
                key={target.key}
                label={tShape("chartPanel.seriesColors")}
                name={target.name}
                onChange={(color) => {
                  patch({ seriesColors: { ...spec.seriesColors, [target.key]: color } });
                  setOpenColorSeriesId(null);
                }}
                onOpenChange={(open) => setOpenColorSeriesId(open ? target.key : null)}
                open={openColorSeriesId === target.key}
              />
            ))}
          </Stack>
        ) : (
          <span className="chart-settings-hint">{tShape("chartPanel.noData")}</span>
        )}
      </Stack>
    </GraphSettingsPanelFrame>
  );
}

/** One series/slice colour row. Split out so the popover can hold its own anchor ref. */
function ChartSeriesColorRow({
  name,
  label,
  color,
  open,
  onOpenChange,
  onChange,
}: {
  name: string;
  label: string;
  color: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (color: string) => void;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Inline gap="sm" justify="between">
      <span className="chart-settings-series-name">{name}</span>
      <button
        aria-label={label}
        className="graph-color-button-swatch"
        onClick={() => onOpenChange(!open)}
        ref={anchorRef}
        style={{ background: color }}
        type="button"
      />
      <ToolbarPopover
        anchorRef={anchorRef}
        onClose={() => onOpenChange(false)}
        open={open}
        // The panel sits on the modal layer, so a body-portalled popover needs to sit above it.
        zIndex={GRAPH_SETTINGS_POPOVER_Z_INDEX}
      >
        <ColorPalette
          onChange={(next) => {
            if (next) {
              onChange(next);
            }
          }}
          value={color}
        />
      </ToolbarPopover>
    </Inline>
  );
}
