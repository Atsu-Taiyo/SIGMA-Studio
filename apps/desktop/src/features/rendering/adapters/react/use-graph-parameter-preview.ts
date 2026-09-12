"use client";

import { useEffect, useMemo, useState } from "react";
import type { Graph2DSpec } from "@/features/document";
import { graph3DAnimationValueAt, type MathExpressionVariables } from "@/features/drawing";
import { GRAPH_PARAMETER_PREVIEW_EVENT, GRAPH_PARAMETERS_OPEN_EVENT, type GraphParameterPreviewDetail } from "@/lib/graph-parameter-preview";

/** Playback only projects values; saves and crop operations keep the author's source spec. */
export function useGraphParameterPreview(spec: Graph2DSpec, shapeId: string | undefined, staticMode: boolean) {
  const [preview, setPreview] = useState<MathExpressionVariables | null>(null);
  const [pageValues, setPageValues] = useState<MathExpressionVariables | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    // Cropping temporarily freezes rendering; keep receiving stop/close notifications then.
    if (!shapeId) return;
    const handlePreview = (event: Event) => {
      const detail = (event as CustomEvent<GraphParameterPreviewDetail>).detail;
      if (detail?.shapeId === shapeId) setPreview(detail.playing ? detail.overrides : null);
    };
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ shapeId: string; open: boolean }>).detail;
      if (detail?.shapeId === shapeId) setSettingsOpen(detail.open);
    };
    window.addEventListener(GRAPH_PARAMETER_PREVIEW_EVENT, handlePreview);
    window.addEventListener(GRAPH_PARAMETERS_OPEN_EVENT, handleOpen);
    return () => {
      window.removeEventListener(GRAPH_PARAMETER_PREVIEW_EVENT, handlePreview);
      window.removeEventListener(GRAPH_PARAMETERS_OPEN_EVENT, handleOpen);
    };
  }, [shapeId]);
  useEffect(() => {
    if (staticMode || settingsOpen) return;
    const parameters = spec.parameters?.filter((parameter) => parameter.animation?.playOnPage && parameter.max > parameter.min) ?? [];
    if (parameters.length === 0) return;
    const start = performance.now();
    let frame = 0;
    let lastPaint = 0;
    const tick = (now: number) => {
      if (now - lastPaint >= 50) {
        setPageValues(Object.fromEntries(parameters.map((parameter) => [parameter.name, graph3DAnimationValueAt(parameter, now - start)])));
        lastPaint = now;
      }
      if (parameters.every((parameter) => parameter.animation?.loop === "once" && now - start >= parameter.animation.durationMs)) return;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [spec.parameters, staticMode, settingsOpen]);
  return useMemo(() => {
    if (staticMode) return spec;
    const overrides = preview ?? (settingsOpen ? null : pageValues);
    if (!overrides || !spec.parameters?.length) return spec;
    return { ...spec, parameters: spec.parameters.map((parameter) => ({ ...parameter,
      value: (preview || parameter.animation?.playOnPage ? overrides[parameter.name] : undefined) ?? parameter.value,
    })) };
  }, [spec, preview, settingsOpen, pageValues, staticMode]);
}
