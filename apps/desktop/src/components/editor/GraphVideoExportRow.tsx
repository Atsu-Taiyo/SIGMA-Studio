"use client";

import { Video } from "lucide-react";
import type { GraphParameter } from "@/features/document";
import { graphVideoDurationMs } from "@/features/drawing";
import { Button } from "@/components/ui/Button";
import { revealDownloadedFile } from "@/lib/download-file";
import { useT } from "@/lib/i18n/react";
import styles from "./GraphSettingsControls.module.css";

/** What the 動画書き出し button is doing right now, as the panel shows it. */
export type GraphVideoExportState =
  | { status: "idle" }
  | { status: "preparing" }
  | { status: "recording"; progress: number }
  | { status: "saving" }
  | { status: "done"; filePath: string | null }
  | { status: "error"; message: string };

/**
 * 「動画で書き出す」の一行。
 *
 * 押す前に何秒の動画になるかを書いておく: 長さはパラメータの秒数から決まるので、ここで
 * 初めて知る値ではないが、書き出しは数秒かかるので待つ心づもりができる方がいい。
 */
export function GraphVideoExportRow({
  parameters,
  state,
  onExport,
}: {
  parameters: readonly GraphParameter[];
  state: GraphVideoExportState;
  onExport: () => void;
}) {
  const tShape = useT("shape");
  const durationMs = graphVideoDurationMs(parameters);
  const busy = state.status === "preparing" || state.status === "recording" || state.status === "saving";
  const savedFilePath = state.status === "done" ? state.filePath : null;
  return (
    <div className={styles.videoExport}>
      <Button size="sm" onClick={onExport} disabled={busy || parameters.length === 0}>
        <Video size={14} /> {tShape("graph3dUi.exportVideo")}
      </Button>
      <span className={styles.videoExportNote} role="status">
        {videoExportNote(state, parameters.length, durationMs, tShape)}
      </span>
      {savedFilePath && (
        <Button size="sm" tone="ghost" onClick={() => void revealDownloadedFile(savedFilePath)}>
          {tShape("graph3dUi.openFolder")}
        </Button>
      )}
    </div>
  );
}

function videoExportNote(
  state: GraphVideoExportState,
  parameterCount: number,
  durationMs: number,
  tShape: ReturnType<typeof useT<"shape">>,
): string {
  switch (state.status) {
    case "preparing":
      return tShape("graph3dUi.exportPreparing");
    case "recording":
      return tShape("graph3dFormat.recording", { progress: Math.round(state.progress * 100) });
    case "saving":
      return tShape("graph3dUi.exportSaving");
    case "done":
      return state.filePath
        ? tShape("graph3dFormat.savedPath", { path: state.filePath })
        : tShape("graph3dUi.exportDownloaded");
    case "error":
      return state.message;
    default:
      return parameterCount === 0
        ? tShape("graph3d.noAnimatableParameters")
        : tShape("graph3dFormat.downloadEstimate", { seconds: (durationMs / 1_000).toFixed(1) });
  }
}
