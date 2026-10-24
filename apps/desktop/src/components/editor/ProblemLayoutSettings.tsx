"use client";

import { useState } from "react";
import type { ProblemAreaKind, ProblemAreaLayout, ProblemNode, ProblemNumbering } from "@/features/document";
import { isSafeCssFontFamily } from "@/features/document/css-safety";
import { getProblemFrameChromePaddingPx, getProblemFrameStyleId } from "@/lib/problem-frame";
import { useT } from "@/lib/i18n/react";
import styles from "./ProblemSettingsDialog.module.css";

type Props = { problem: ProblemNode; onChange: (updater: (problem: ProblemNode) => ProblemNode) => void };

function Dimension({ label, testId, value, min = 0, max = 256, onChange }: {
  label: string; testId: string; value?: number; min?: number; max?: number;
  onChange: (value: number | undefined) => void;
}) {
  const t = useT("settings");
  return <label className={styles.field}><span>{label}</span><input type="number" min={min} max={max} step="any"
    data-testid={testId} value={value ?? ""} placeholder={t("problem.autoPlaceholder")}
    onChange={event => {
      if (event.target.value === "") onChange(undefined);
      else if (Number.isFinite(event.target.valueAsNumber) && event.target.valueAsNumber >= min && event.target.valueAsNumber <= max) onChange(event.target.valueAsNumber);
    }} /></label>;
}

export function ProblemNumberLayoutSettings({ problem, onChange }: Props) {
  const t = useT("settings"), n = problem.numbering;
  function set<K extends keyof ProblemNumbering>(key: K, value: ProblemNumbering[K]) {
    onChange(p => { const numbering = { ...p.numbering }; if (value === undefined) delete numbering[key]; else numbering[key] = value; return { ...p, numbering }; });
  }
  return <details className={styles.layoutDetails}><summary>{t("problem.numberLayout")}</summary><div className={styles.numberingGrid}>
    <label className={styles.field}><span>{t("problem.numberFont")}</span><input data-testid="problem-number-font-family"
      value={n?.fontFamily ?? ""} placeholder={t("problem.inheritFont")}
      onChange={event => { const value = event.target.value; if (!value.trim() || isSafeCssFontFamily(value)) set("fontFamily", value.trim() ? value : undefined); }} /></label>
    <label className={styles.field}><span>{t("problem.numberFormat")}</span><select data-testid="problem-number-format" value={n?.format ?? "decimal"}
      onChange={event => set("format", event.target.value as ProblemNumbering["format"])}><option value="decimal">1, 2, 3</option><option value="fullwidth">１, ２, ３</option></select></label>
    <Dimension label={t("problem.numberWeight")} testId="problem-number-font-weight" min={100} max={900} value={n?.fontWeight} onChange={v => set("fontWeight", v === undefined ? undefined : Math.round(v))} />
    {(["widthPx", "heightPx", "gapPx", "borderWidthPx", "borderRadiusPx", "outlineWidthPx", "outlineOffsetPx", "offsetXPx", "offsetYPx", "textOffsetXPx", "textOffsetYPx"] as const).map(key => <Dimension
      key={key} label={t(`problem.dimensions.${key}`)} testId={`problem-number-${key}`} value={n?.[key]}
      min={key.startsWith("textOffset") ? -128 : key.startsWith("offset") ? -256 : key === "widthPx" || key === "heightPx" ? 0.01 : 0}
      max={key === "borderWidthPx" || key === "outlineWidthPx" ? 24 : key.startsWith("textOffset") || key === "borderRadiusPx" || key === "outlineOffsetPx" ? 128 : 256} onChange={value => set(key, value)} />)}
    <label className={styles.field}><span>{t("problem.numberBorderStyle")}</span><select data-testid="problem-number-border-style" value={n?.borderStyle ?? "solid"}
      onChange={event => set("borderStyle", event.target.value as ProblemNumbering["borderStyle"])}>
      <option value="solid">{t("problem.borderSolid")}</option><option value="double">{t("problem.borderDouble")}</option><option value="none">{t("problem.frameNone")}</option>
    </select></label>
  </div></details>;
}

export function ProblemAreaLayoutSettings({ problem, onChange }: Props) {
  const t = useT("settings"), [area, setArea] = useState<ProblemAreaKind>("prompt"), layout = problem.areaLayout?.[area];
  const framed = area === "prompt" && problem.frame?.enabled;
  const custom = framed && getProblemFrameStyleId(problem) === "custom" ? problem.frame?.custom : undefined;
  const chrome = framed ? getProblemFrameChromePaddingPx(getProblemFrameStyleId(problem), custom) : { x: 0, y: 0 };
  const x = custom && framed ? custom.paddingPx : chrome.x, y = custom && framed ? custom.paddingPx : chrome.y;
  const padding = layout?.paddingPx ?? { top: y, right: x, bottom: y, left: x };
  function set<K extends keyof ProblemAreaLayout>(key: K, value: ProblemAreaLayout[K]) {
    onChange(p => { const next = { ...p.areaLayout?.[area] }; if (value === undefined) delete next[key]; else next[key] = value; return { ...p, areaLayout: { ...p.areaLayout, [area]: next } }; });
  }
  return <section className={styles.section} aria-labelledby="problem-layout-heading"><h3 id="problem-layout-heading" className={styles.sectionTitle}>{t("problem.areaLayout")}</h3>
    <label className={styles.field}><span>{t("problem.targetArea")}</span><select data-testid="problem-layout-area" value={area} onChange={e => setArea(e.target.value as ProblemAreaKind)}>
      {(["lead", "prompt", "hints", "solution"] as const).map(a => <option key={a} value={a}>{t(`problem.areas.${a}`)}</option>)}
    </select></label>
    <div className={styles.numberingGrid}>
      <Dimension label={t("problem.minHeightMm")} testId="problem-area-min-height" max={1000} value={layout?.minHeightMm} onChange={v => set("minHeightMm", v)} />
      <Dimension label={t("problem.widthMm")} testId="problem-area-width" min={0.01} max={1000} value={layout?.widthMm} onChange={v => set("widthMm", v)} />
      <Dimension label={t("problem.dimensions.offsetXPx")} testId="problem-area-offset-x" min={-256} value={layout?.offsetXPx} onChange={v => set("offsetXPx", v)} />
      <Dimension label={t("problem.marginTopPx")} testId="problem-area-margin-top" max={400} value={layout?.marginTopPx} onChange={v => set("marginTopPx", v)} />
      <Dimension label={t("problem.marginBottomPx")} testId="problem-area-margin-bottom" max={400} value={layout?.marginBottomPx} onChange={v => set("marginBottomPx", v)} />
    </div>
    <label className={styles.checkboxField}><input type="checkbox" data-testid="problem-area-padding-enabled" checked={Boolean(layout?.paddingPx)}
      onChange={event => set("paddingPx", event.target.checked ? padding : undefined)} /><span>{t("problem.customPadding")}</span></label>
    {layout?.paddingPx && <div className={styles.numberingGrid}>{(["top", "right", "bottom", "left"] as const).map(side => <Dimension key={side}
      label={t(`problem.paddingSides.${side}`)} testId={`problem-area-padding-${side}`} value={padding[side]}
      onChange={v => set("paddingPx", { ...padding, [side]: v ?? 0 })} />)}</div>}
  </section>;
}

export function ProblemBorderLayoutSettings({ problem, onChange }: Props) {
  const t = useT("settings");
  return <div className={styles.numberingGrid}>{(["borderWidthPx", "borderRadiusPx"] as const).map(key => <Dimension key={key}
    label={t(`problem.dimensions.${key}`)} testId={`problem-frame-${key}`} value={problem.frame?.[key]} max={key === "borderWidthPx" ? 24 : 128}
    onChange={value => onChange(p => { const frame = { ...p.frame }; if (value === undefined) delete frame[key]; else frame[key] = value; return { ...p, frame }; })} />)}</div>;
}
