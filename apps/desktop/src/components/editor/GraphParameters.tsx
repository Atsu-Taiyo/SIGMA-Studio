"use client";

import { Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GraphParameter } from "@/features/document";
import { DEFAULT_DURATION_MS, evaluateMathExpression, graph3DAnimationValueAt, type MathExpressionVariables } from "@/features/drawing";
import { MathExpressionInput } from "@/components/math/MathExpressionInput";
import { MathPreview } from "@/features/rendering/adapters/react";
import { Button, IconButton } from "@/components/ui/Button";
import { Inline } from "@/components/ui/layout";
import { Select } from "@/components/ui/Select";
import { graphExpressionToTex, texToGraphExpressionWithError } from "@/lib/graph-tex";
import { createId } from "@/lib/id";
import { useT } from "@/lib/i18n/react";
import { GraphAddCard, GraphCardGrid, GraphWidgetCard } from "./GraphSettingsControls";
import styles from "./GraphSettingsControls.module.css";

type UpdateParameters = (updater: (current: GraphParameter[]) => GraphParameter[]) => void;
type Preview = (overrides: MathExpressionVariables, playing: boolean) => void;
const defaultAnimation = () => ({ durationMs: DEFAULT_DURATION_MS, loop: "pingPong" as const });

export function GraphParameters({ parameters, onChange, onPreview }: {
  parameters: GraphParameter[];
  onChange: UpdateParameters;
  onPreview: Preview;
}) {
  const t = useT("shape");
  const [playingId, setPlayingId] = useState<string | null>(null);
  return <GraphCardGrid>
    {parameters.map((parameter) => <ParameterCard key={parameter.id} parameter={parameter}
      playing={playingId === parameter.id} onPlayingChange={(playing) => setPlayingId(playing ? parameter.id : null)}
      onChange={onChange} onPreview={onPreview} />)}
    <GraphAddCard label={t("graph3dUi.addParameter")} onClick={() => onChange((current) => {
      let index = 1;
      const names = new Set(current.map((parameter) => parameter.name.toLowerCase()));
      while (names.has(index === 1 ? "s" : `s${index}`)) index += 1;
      return [...current, { id: createId("graph_parameter"), name: index === 1 ? "s" : `s${index}`,
        value: 0, min: -1, max: 1, animation: defaultAnimation() }];
    })} />
  </GraphCardGrid>;
}

function ParameterCard({ parameter, playing, onPlayingChange, onChange, onPreview }: {
  parameter: GraphParameter;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  onChange: UpdateParameters;
  onPreview: Preview;
}) {
  const t = useT("shape");
  const latest = useRef({ onChange, onPreview, onPlayingChange });
  useLayoutEffect(() => { latest.current = { onChange, onPreview, onPlayingChange }; });
  const [previewValue, setPreviewValue] = useState(parameter.value);
  const [observedValue, setObservedValue] = useState(parameter.value);
  if (observedValue !== parameter.value) {
    setObservedValue(parameter.value);
    if (!playing) setPreviewValue(parameter.value);
  }
  const stopRef = useRef<((commit: boolean) => void) | null>(null);
  // React owns both the thumb and readout. Imperative input.value writes are restored to the
  // controlled prop after events/rerenders, making the animated thumb jump to its saved value.
  useEffect(() => {
    if (!playing) return;
    const start = performance.now();
    let frame = 0;
    let lastPaint = 0;
    let value = parameter.value;
    let active = true;
    const stop = (commit: boolean) => {
      if (!active) return;
      active = false;
      cancelAnimationFrame(frame);
      if (commit) latest.current.onChange((current) => current.map((item) => item.id === parameter.id ? { ...item, value } : item));
      latest.current.onPreview({ [parameter.name]: value }, false);
    };
    stopRef.current = stop;
    const tick = (now: number) => {
      if (!active) return;
      if (now - lastPaint >= 50) {
        value = graph3DAnimationValueAt(parameter, now - start);
        setPreviewValue(value);
        latest.current.onPreview({ [parameter.name]: value }, true);
        lastPaint = now;
        if (parameter.animation?.loop === "once" && now - start >= (parameter.animation.durationMs ?? DEFAULT_DURATION_MS)) {
          stop(true);
          latest.current.onPlayingChange(false);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { stop(true); stopRef.current = null; };
    // The playback session owns its start snapshot; edits below explicitly finish it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, parameter.id]);
  const patch = (change: Partial<GraphParameter>) => {
    stopRef.current?.(false);
    onPlayingChange(false);
    if (change.value !== undefined) setPreviewValue(change.value);
    onChange((current) => current.map((item) => item.id === parameter.id ? { ...item, value: previewValue, ...change } : item));
  };
  // Keep the stopped frame until the canonical commit comes back through selection events.
  const displayValue = previewValue;
  const rangeInput = (bound: "min" | "max") => <MathExpressionInput
    ariaLabel={t(bound === "min" ? "graph3dUi.rangeMin" : "graph3dUi.rangeMax")}
    tex={graphExpressionToTex(String(parameter[bound]))}
    onCommit={(tex) => {
      const parsed = texToGraphExpressionWithError(tex);
      if (!("expression" in parsed)) return;
      try {
        const value = evaluateMathExpression(parsed.expression);
        if (!Number.isFinite(value)) return;
        const min = bound === "min" ? value : parameter.min;
        const max = bound === "max" ? value : parameter.max;
        if (min > max) return;
        patch({ min, max, value: Math.min(max, Math.max(min, displayValue)) });
      } catch { /* Keep the previous numeric bound when the expression cannot be evaluated. */ }
    }} />;
  return <GraphWidgetCard label={t("graph3dFormat.details", { name: parameter.label || parameter.name })}
    title={<strong>{parameter.label || parameter.name}</strong>}
    headerAction={<IconButton label={t(playing ? "graph3dUi.stop" : "graph3dUi.play")}
      tooltip={{ label: t(playing ? "graph3dUi.stopPreviewTooltip" : "graph3dUi.playPreviewTooltip") }} size="sm" tone="ghost"
      disabled={parameter.max <= parameter.min} onClick={() => {
        if (playing) stopRef.current?.(true);
        else setPreviewValue(parameter.value);
        onPlayingChange(!playing);
      }}>
      {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
    </IconButton>}
    summary={<Inline gap="sm">
      <input className={styles.slider} type="range" aria-label={parameter.label || parameter.name}
        min={parameter.min} max={parameter.max} step={playing ? "any" : Math.max(0.001, Math.abs(parameter.max - parameter.min) / 200)}
        value={displayValue} onChange={(event) => patch({ value: Number(event.target.value) })} />
      <output className={styles.parameterValue}>{displayValue.toFixed(2)}</output>
    </Inline>}>
    <label className={styles.field}><span>{t("graph3dUi.parameterName")}</span>
      <input className={styles.parameterName} value={parameter.name} onChange={(event) => patch({ name: event.target.value })} />
    </label>
    <div className={styles.relationRow}>{rangeInput("min")}<MathPreview tex={`\\leqq ${graphExpressionToTex(parameter.name || "s")} \\leqq`} />{rangeInput("max")}</div>
    <div className={styles.compactGrid}>
      <label className={styles.field}><span>{t("graph3dUi.seconds")}</span><input type="number" min={0.1} step={0.1}
        value={(parameter.animation?.durationMs ?? DEFAULT_DURATION_MS) / 1000}
        onChange={(event) => { const seconds = Number(event.target.value); if (Number.isFinite(seconds)) patch({ animation: { ...(parameter.animation ?? defaultAnimation()), durationMs: Math.max(100, seconds * 1000) } }); }} /></label>
      <div className={styles.field}><span>{t("graph3dUi.loop")}</span><Select value={parameter.animation?.loop ?? "pingPong"}
        options={[{ value: "pingPong", label: t("graph3dUi.loopPingPong") }, { value: "repeat", label: t("graph3dUi.loopRepeat") }, { value: "once", label: t("graph3dUi.loopOnce") }]}
        onChange={(loop) => patch({ animation: { ...(parameter.animation ?? defaultAnimation()), loop: loop as "once" | "repeat" | "pingPong" } })} /></div>
    </div>
    <label className={styles.checkbox}><input type="checkbox" checked={parameter.animation?.playOnPage === true}
      onChange={(event) => patch({ animation: { ...(parameter.animation ?? defaultAnimation()), playOnPage: event.target.checked } })} /><span>{t("graph3dUi.animateOnPage")}</span></label>
    <Button tone="danger" size="sm" onClick={() => {
      document.querySelector<HTMLElement>("[data-graph-settings-panel]")?.focus({ preventScroll: true });
      stopRef.current?.(false);
      onPlayingChange(false);
      onChange((current) => current.filter((item) => item.id !== parameter.id));
    }}>
      <Trash2 size={14} /> {t("graph3dUi.deleteParameter")}
    </Button>
  </GraphWidgetCard>;
}
