"use client";

import { useEffect, useRef, useState } from "react";
import type { Graph2DSpec } from "@/features/document";
import { graphVideoAnimationParameters } from "@/features/drawing";
import { recordGraph2DAnimationVideo, useMathEnvironment } from "@/features/rendering/adapters/react";
import { downloadGeneratedFile } from "@/lib/download-file";
import { useT } from "@/lib/i18n/react";
import { GraphVideoExportRow, type GraphVideoExportState } from "./GraphVideoExportRow";

export function Graph2DVideoExport({ spec }: { spec: Graph2DSpec }) {
  const t = useT("shape");
  const mathEnvironment = useMathEnvironment();
  const [state, setState] = useState<GraphVideoExportState>({ status: "idle" });
  const runRef = useRef<AbortController | null>(null);
  useEffect(() => () => { runRef.current?.abort(); }, []);
  const exportVideo = async () => {
    if (runRef.current) return;
    const run = new AbortController();
    runRef.current = run;
    setState({ status: "preparing" });
    try {
      const recording = await recordGraph2DAnimationVideo({
        spec, mathEnvironment, signal: run.signal,
        onProgress: (progress) => setState({ status: "recording", progress }),
      });
      run.signal.throwIfAborted();
      setState({ status: "saving" });
      const saved = await downloadGeneratedFile(recording.blob, t("graphPanel.animationExportName", { extension: recording.extension }));
      if (!run.signal.aborted) setState({ status: "done", filePath: saved.filePath });
    } catch (error) {
      if (!run.signal.aborted) setState({ status: "error", message: error instanceof Error ? error.message : t("graph3dUi.videoExportFailed") });
    } finally {
      if (runRef.current === run) runRef.current = null;
    }
  };
  return <GraphVideoExportRow parameters={graphVideoAnimationParameters(spec.parameters ?? [])}
    state={state} onExport={() => void exportVideo()} />;
}
