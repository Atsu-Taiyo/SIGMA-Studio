"use client";

import { WandSparkles } from "lucide-react";

import { useRegionCaptureActions } from "@/components/editor/region-capture/RegionCaptureLayer";
import { readBlobAsDataUrl } from "@/components/editor/region-capture/region-capture-client";
import type { AiEditAttachment } from "@/lib/ai/sigma-doc-agent-tools";
import { useT } from "@/lib/i18n/react";

import { createAttachmentId } from "../application/ai-chat-attachments";

/** AI へ渡す画像の長辺の上限。細かい字が読める大きさに留め、無駄に大きな画像を送らない。 */
export const AI_SCREENSHOT_MAX_DIMENSION = 2048;

export type AiScreenshotRequestHandler = (
  attachment: AiEditAttachment,
  anchor: { left: number; top: number },
) => void;

/**
 * 範囲スクリーンショットの操作バーに並ぶ「AIに聞く」。選んだ範囲を撮って画像として AI の
 * 入力欄へ添え、すぐ質問を打てる状態にする。撮影層は AI を知らず、この部品だけが AI を知る。
 */
export function AiScreenshotAskButton({ onRequest }: { onRequest: AiScreenshotRequestHandler }) {
  const t = useT("ai");
  const label = t("screenshot.ask");
  const { anchor, busy, capture, dismiss, reportFailure } = useRegionCaptureActions();

  const ask = async () => {
    const image = await capture({ maxDimension: AI_SCREENSHOT_MAX_DIMENSION });
    if (!image) {
      reportFailure();
      return;
    }
    try {
      const dataUrl = await readBlobAsDataUrl(image.blob);
      onRequest({
        id: createAttachmentId(),
        name: image.fileName,
        mimeType: "image/png",
        dataUrl,
        width: image.width,
        height: image.height,
        fileSize: image.blob.size,
      }, anchor);
      dismiss();
    } catch {
      reportFailure();
    }
  };

  return (
    <button
      type="button"
      className="region-capture-labeled"
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={() => { void ask(); }}
    >
      <WandSparkles size={16} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
