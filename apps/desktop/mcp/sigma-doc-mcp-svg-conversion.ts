import type { SigmaDocument } from "@/features/document";

import {
  CONVERT_SVG_IMAGE_PATH,
  ConvertedSvgImageSchema,
  loadAiRenderBridgeInfo,
} from "../electron/ai-render-bridge";
import type { RenderVisualPreviewDeps } from "./sigma-doc-mcp-preview";

/**
 * How `convert_svg_image` measured text and math: `app-bridge` = the app's own renderer, the same
 * measurement as "図形に変換" on the canvas; `estimate` = the converter's estimate in this process.
 */
export type SvgConversionSource = "app-bridge" | "estimate";

export interface SvgConversionAttempt {
  /** The conversion the app measured; `null` when the converter has to estimate. */
  conversion: Record<string, unknown> | null;
  source: SvgConversionSource;
  warnings: string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Asks the running app to convert the image with its renderer. Any failure (no app, a refused request,
 * a malformed answer) falls back to the estimate, and says why in `warnings`: converting with estimated
 * text positions is better than not converting, and the proposal says that it was estimated.
 */
export async function convertSvgImageViaAppBridge(
  deps: Pick<RenderVisualPreviewDeps, "env" | "fetchImpl">,
  document: SigmaDocument,
  shapeId: string,
): Promise<SvgConversionAttempt> {
  const warnings: string[] = [];
  const estimate = (reason: string): SvgConversionAttempt => ({
    conversion: null,
    source: "estimate",
    warnings: [...warnings, reason],
  });
  const bridgeInfo = loadAiRenderBridgeInfo(deps.env);
  if (bridgeInfo.state === "none") {
    return estimate("アプリの描画環境(render bridge)が無いため、文字・数式の幅と位置を推定して変換しました。");
  }
  if (bridgeInfo.state === "invalid") {
    return estimate(`render bridge情報が不正なため、文字・数式の位置を推定して変換しました: ${bridgeInfo.error}`);
  }

  let response: Response;
  try {
    response = await deps.fetchImpl(`${bridgeInfo.info.url}${CONVERT_SVG_IMAGE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridgeInfo.info.token}`,
      },
      body: JSON.stringify({ document, shapeId }),
    });
  } catch (error) {
    return estimate(`app bridgeへ接続できないため、文字・数式の位置を推定して変換しました: ${errorText(error)}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return estimate(`app bridgeの応答を解釈できないため、文字・数式の位置を推定して変換しました: ${errorText(error)}`);
  }
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (record.ok !== true) {
    const reason = typeof record.error === "string" ? record.error : `HTTP ${response.status}`;
    return estimate(`アプリの描画環境で変換できなかったため、文字・数式の位置を推定して変換しました: ${reason}`);
  }
  const conversion = ConvertedSvgImageSchema.safeParse(record.conversion);
  if (!conversion.success) {
    return estimate("app bridgeの変換結果が不正なため、文字・数式の位置を推定して変換しました。");
  }
  return { conversion: conversion.data, source: "app-bridge", warnings };
}
