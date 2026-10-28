"use client";

import { useState } from "react";
import type { ProblemAreaKind, ProblemAreaLayout, ProblemNode, ProblemNumbering } from "@/features/document";
import { PROBLEM_AREA_ORDER } from "@/features/document";
import { Select } from "@/components/ui/Select";
import { SettingsField, SettingsRow, Switch } from "@/components/ui/settings";
import { getProblemFrameChromePaddingPx, getProblemFrameStyleId } from "@/lib/problem-frame";
import { useT } from "@/lib/i18n/react";
import { SettingsNumberField } from "./SettingsNumberField";
import styles from "./ProblemSettingsDialog.module.css";

type Props = { problem: ProblemNode; onChange: (updater: (problem: ProblemNode) => ProblemNode) => void };

// 単位の表記は訳さない (mm と同じく、どの言語でも同じ記号で書く)。
const PX = "px";

/** 空にできる寸法の欄。空は「自動」(問題の既定の寸法) を表す。 */
function Dimension({ id, label, testId, value, min = 0, max = 256, unit = PX, onChange }: {
  id: string; label: string; testId: string; value?: number; min?: number; max?: number; unit?: string;
  onChange: (value: number | undefined) => void;
}) {
  const t = useT("settings");
  return (
    <SettingsNumberField
      optional
      id={id}
      testId={testId}
      label={label}
      value={value}
      emptyValue={Math.max(min, 0)}
      min={min}
      max={max}
      decimals={2}
      unit={unit}
      placeholder={t("problem.autoPlaceholder")}
      onChange={onChange}
    />
  );
}

const NUMBER_DIMENSIONS = [
  "widthPx", "heightPx", "gapPx", "borderWidthPx", "borderRadiusPx",
  "outlineWidthPx", "outlineOffsetPx", "offsetXPx", "offsetYPx", "textOffsetXPx", "textOffsetYPx",
] as const;

function numberDimensionRange(key: (typeof NUMBER_DIMENSIONS)[number]): { min: number; max: number } {
  if (key.startsWith("textOffset")) return { min: -128, max: 128 };
  if (key.startsWith("offset")) return { min: -256, max: 256 };
  if (key === "widthPx" || key === "heightPx") return { min: 0.01, max: 256 };
  if (key === "borderWidthPx" || key === "outlineWidthPx") return { min: 0, max: 24 };
  if (key === "borderRadiusPx" || key === "outlineOffsetPx") return { min: 0, max: 128 };
  return { min: 0, max: 256 };
}

/** 番号の形と位置 (太さ・枠の寸法・ずらし)。ふだんは畳んでおく詳細設定。 */
export function ProblemNumberLayoutSettings({ problem, onChange }: Props) {
  const t = useT("settings"), n = problem.numbering;
  function set<K extends keyof ProblemNumbering>(key: K, value: ProblemNumbering[K]) {
    onChange(p => { const numbering = { ...p.numbering }; if (value === undefined) delete numbering[key]; else numbering[key] = value; return { ...p, numbering }; });
  }
  return (
    <div className={styles.fieldGrid} data-columns="2">
      <Dimension id="problem-number-font-weight" label={t("problem.numberWeight")} testId="problem-number-font-weight" min={100} max={900} unit=""
        value={n?.fontWeight} onChange={v => set("fontWeight", v === undefined ? undefined : Math.round(v))} />
      <SettingsField label={t("problem.numberBorderStyle")} htmlFor="problem-number-border-style">
        <Select
          id="problem-number-border-style"
          data-testid="problem-number-border-style"
          className={styles.select}
          value={n?.borderStyle ?? "solid"}
          options={[
            { value: "solid", label: t("problem.borderSolid") },
            { value: "double", label: t("problem.borderDouble") },
            { value: "none", label: t("problem.frameNone") },
          ]}
          onChange={value => set("borderStyle", value as ProblemNumbering["borderStyle"])}
        />
      </SettingsField>
      {NUMBER_DIMENSIONS.map(key => (
        <Dimension key={key} id={`problem-number-${key}`} label={t(`problem.dimensions.${key}`)} testId={`problem-number-${key}`}
          value={n?.[key]} {...numberDimensionRange(key)} onChange={value => set(key, value)} />
      ))}
    </div>
  );
}

/** エリア (導入文・問題文・コメント・解答) ごとの寸法と余白。 */
export function ProblemAreaLayoutSettings({ problem, onChange, area: controlledArea, onAreaChange }: Props & {
  area?: ProblemAreaKind;
  onAreaChange?: (area: ProblemAreaKind) => void;
}) {
  const t = useT("settings");
  const [ownArea, setOwnArea] = useState<ProblemAreaKind>("prompt");
  const area = controlledArea ?? ownArea;
  const setArea = (next: ProblemAreaKind) => { setOwnArea(next); onAreaChange?.(next); };
  const layout = problem.areaLayout?.[area];
  const framed = area === "prompt" && problem.frame?.enabled;
  const custom = framed && getProblemFrameStyleId(problem) === "custom" ? problem.frame?.custom : undefined;
  const chrome = framed ? getProblemFrameChromePaddingPx(getProblemFrameStyleId(problem), custom) : { x: 0, y: 0 };
  const x = custom && framed ? custom.paddingPx : chrome.x, y = custom && framed ? custom.paddingPx : chrome.y;
  const padding = layout?.paddingPx ?? { top: y, right: x, bottom: y, left: x };
  function set<K extends keyof ProblemAreaLayout>(key: K, value: ProblemAreaLayout[K]) {
    onChange(p => { const next = { ...p.areaLayout?.[area] }; if (value === undefined) delete next[key]; else next[key] = value; return { ...p, areaLayout: { ...p.areaLayout, [area]: next } }; });
  }
  return (
    <>
      <SettingsField label={t("problem.targetArea")} htmlFor="problem-layout-area">
        <Select
          id="problem-layout-area"
          data-testid="problem-layout-area"
          className={styles.select}
          value={area}
          options={PROBLEM_AREA_ORDER.map(a => ({ value: a, label: t(`problem.areas.${a}`) }))}
          onChange={value => setArea(value as ProblemAreaKind)}
        />
      </SettingsField>
      <div className={styles.fieldGrid} data-columns="2">
        <Dimension id="problem-area-min-height" label={t("problem.minHeightMm")} testId="problem-area-min-height" max={1000} unit="mm" value={layout?.minHeightMm} onChange={v => set("minHeightMm", v)} />
        <Dimension id="problem-area-width" label={t("problem.widthMm")} testId="problem-area-width" min={0.01} max={1000} unit="mm" value={layout?.widthMm} onChange={v => set("widthMm", v)} />
        <Dimension id="problem-area-margin-top" label={t("problem.marginTopPx")} testId="problem-area-margin-top" max={400} value={layout?.marginTopPx} onChange={v => set("marginTopPx", v)} />
        <Dimension id="problem-area-margin-bottom" label={t("problem.marginBottomPx")} testId="problem-area-margin-bottom" max={400} value={layout?.marginBottomPx} onChange={v => set("marginBottomPx", v)} />
        <Dimension id="problem-area-offset-x" label={t("problem.dimensions.offsetXPx")} testId="problem-area-offset-x" min={-256} value={layout?.offsetXPx} onChange={v => set("offsetXPx", v)} />
      </div>
      <SettingsRow
        label={t("problem.customPadding")}
        control={(
          <Switch
            data-testid="problem-area-padding-enabled"
            checked={Boolean(layout?.paddingPx)}
            label={t("problem.customPadding")}
            onCheckedChange={checked => set("paddingPx", checked ? padding : undefined)}
          />
        )}
      />
      {layout?.paddingPx && (
        <div className={styles.fieldGrid} data-columns="4">
          {(["top", "right", "bottom", "left"] as const).map(side => (
            <SettingsNumberField key={side} id={`problem-area-padding-${side}`} testId={`problem-area-padding-${side}`}
              label={t(`problem.paddingSides.${side}`)} value={padding[side]} max={256} decimals={2} unit={PX}
              onChange={v => set("paddingPx", { ...padding, [side]: v })} />
          ))}
        </div>
      )}
    </>
  );
}

/** 枠線の太さと角の丸み (枠を付けているときだけ)。 */
export function ProblemBorderLayoutSettings({ problem, onChange }: Props) {
  const t = useT("settings");
  return (
    <div className={styles.fieldGrid} data-columns="2">
      {(["borderWidthPx", "borderRadiusPx"] as const).map(key => (
        <Dimension key={key} id={`problem-frame-${key}`} label={t(`problem.dimensions.${key}`)} testId={`problem-frame-${key}`}
          value={problem.frame?.[key]} max={key === "borderWidthPx" ? 24 : 128}
          onChange={value => onChange(p => { const frame = { ...p.frame }; if (value === undefined) delete frame[key]; else frame[key] = value; return { ...p, frame }; })} />
      ))}
    </div>
  );
}
