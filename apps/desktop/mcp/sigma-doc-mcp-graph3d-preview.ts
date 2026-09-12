import {
  isAllowedAiOverlayAssetSource,
  MAX_AI_OVERLAY_ASSET_BYTES,
  MAX_AI_OVERLAY_ASSET_DIMENSION,
  MAX_AI_OVERLAY_ASSET_PIXELS,
} from "@/lib/ai/sigma-doc-edit-schema";
// 深いパスで引くのは意図的。`@/features/rendering/adapters/svg` の index は
// react-static-renderers を再輸出しており、index 経由にすると MCP プロセスへ
// react-dom/server が入る (features/rendering/architecture.test.ts の publicEntrypoints 参照)。
import {
  createGraph3DSceneSvg,
} from "@/features/rendering/adapters/svg/graph3d-scene-svg";
import type { Graph3DSpec } from "@/features/document";

import { loadAiRenderBridgeInfo, type RenderSvgResult } from "../electron/ai-render-bridge";
import type { RenderVisualPreviewDeps } from "./sigma-doc-mcp-preview";

/**
 * The still picture a 3D figure carries into the document.
 *
 * `graph3dShape` draws through WebGL, which a stdio MCP process does not have, so a figure written
 * from outside the app used to reach the page as a "3D" placeholder and stayed that way through
 * print and the public viewer until someone opened the file in the editor. This draws the figure
 * to SVG without a GPU and rasterizes it two ways: the running app's own renderer first, then
 * `@resvg/resvg-js` for a dev/CLI process with no app attached.
 *
 * **A failure here is never an insertion failure.** `source: "none"` means the figure goes in
 * without a derived picture; the editor's WebGL capture fills it in the moment the page is opened.
 */
export type Graph3DPreviewPngResult =
  | {
      source: "app-bridge" | "resvg";
      /** Always `data:image/png;base64,…` — the only asset source AI writes may carry. */
      dataUrl: string;
      width: number;
      height: number;
      warnings: string[];
    }
  | { source: "none"; warnings: string[] };

/**
 * How much finer than the document box the picture is drawn.
 *
 * The figure is a raster in a vector page: at 1× it is visibly soft as soon as the reader zooms
 * or the page is printed. Dropped to 1× when 2× does not fit the asset budget.
 */
export const GRAPH3D_PREVIEW_SUPERSAMPLE_STEPS = [2, 1] as const;

export async function renderGraph3DPreviewPng(
  deps: RenderVisualPreviewDeps,
  spec: Graph3DSpec,
  size: { width: number; height: number },
): Promise<Graph3DPreviewPngResult> {
  const warnings: string[] = [];
  // The app renderer is asked at most once. A refusal from it is about the figure or the app's
  // state, not about the resolution, so asking again one step down only pays its timeout twice —
  // and a best-effort preview must never be what makes the tool call itself time out.
  let appBridgeAvailable = true;

  for (const supersample of GRAPH3D_PREVIEW_SUPERSAMPLE_STEPS) {
    const width = Math.round(size.width * supersample);
    const height = Math.round(size.height * supersample);
    if (
      width <= 0 || height <= 0
      || width > MAX_AI_OVERLAY_ASSET_DIMENSION
      || height > MAX_AI_OVERLAY_ASSET_DIMENSION
      || width * height > MAX_AI_OVERLAY_ASSET_PIXELS
    ) {
      continue;
    }

    const drawing = createGraph3DSceneSvg(spec, { width, height });
    if (!drawing) {
      warnings.push("3D図版を描画できませんでした。specのカメラとサイズを確認してください。");
      return { source: "none", warnings };
    }
    if (drawing.svg === null) {
      warnings.push("3D図版の面数が多すぎるため静止画を作成しませんでした。resolutionを下げてください。");
      return { source: "none", warnings };
    }

    const rasterized = await rasterize(deps, drawing.svg, width, height, warnings, appBridgeAvailable);
    if (!rasterized) {
      appBridgeAvailable = false;
      continue;
    }
    appBridgeAvailable = rasterized.source === "app-bridge";
    if (rasterized.png.byteLength > MAX_AI_OVERLAY_ASSET_BYTES) {
      warnings.push(`生成した静止画が上限(${MAX_AI_OVERLAY_ASSET_BYTES}バイト)を超えたため解像度を下げて再試行しました。`);
      continue;
    }

    const dataUrl = `data:image/png;base64,${rasterized.png.toString("base64")}`;
    // 呼び出し側が文書へ書く前に必ず通る門と同じ判定を、作った場所でも掛ける。ここを通らない
    // 画像は提案の書き出しで落ちるだけなので、静止画なしへ倒すほうが正しい。
    if (!isAllowedAiOverlayAssetSource(dataUrl)) {
      warnings.push("生成した静止画が教材へ埋め込める形式になりませんでした。");
      continue;
    }

    return {
      source: rasterized.source,
      dataUrl,
      width,
      height,
      warnings,
    };
  }

  if (warnings.length === 0) {
    warnings.push("3D図版をPNG化できるレンダラがありません。Sigma Studioを起動した状態で再実行してください。");
  }
  return { source: "none", warnings };
}

interface RasterizedPreview {
  source: "app-bridge" | "resvg";
  png: Buffer;
}

async function rasterize(
  deps: RenderVisualPreviewDeps,
  svg: string,
  width: number,
  height: number,
  warnings: string[],
  /** False once the app renderer has already refused this figure — see the caller. */
  allowAppBridge: boolean,
): Promise<RasterizedPreview | null> {
  const viaBridge = allowAppBridge
    ? await rasterizeViaAppBridge(deps, svg, width, height, warnings)
    : null;
  if (viaBridge) {
    return viaBridge;
  }

  const resvg = await deps.loadResvg();
  if (!resvg) {
    return null;
  }
  try {
    return { source: "resvg", png: resvg.render(svg) };
  } catch (error) {
    warnings.push(`resvgでのPNG化に失敗しました: ${errorText(error)}`);
    return null;
  }
}

async function rasterizeViaAppBridge(
  deps: RenderVisualPreviewDeps,
  svg: string,
  width: number,
  height: number,
  warnings: string[],
): Promise<RasterizedPreview | null> {
  const bridgeInfo = loadAiRenderBridgeInfo(deps.env);
  if (bridgeInfo.state === "none") {
    // アプリが起動していないだけの通常ケース。警告にはしない (CLI 単独実行が普通の使い方)。
    return null;
  }
  if (bridgeInfo.state === "invalid") {
    warnings.push(`render bridge情報が不正です: ${bridgeInfo.error}`);
    return null;
  }

  let response: Response;
  try {
    response = await deps.fetchImpl(`${bridgeInfo.info.url}/render-svg`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridgeInfo.info.token}`,
      },
      body: JSON.stringify({ svg, width, height }),
    });
  } catch (error) {
    warnings.push(`app bridgeへの接続に失敗しました: ${errorText(error)}`);
    return null;
  }

  let payload: RenderSvgResult;
  try {
    payload = (await response.json()) as RenderSvgResult;
  } catch (error) {
    warnings.push(`app bridgeの応答を解釈できませんでした: ${errorText(error)}`);
    return null;
  }
  if (!payload.ok) {
    warnings.push(`app bridgeでのPNG化に失敗しました: ${payload.error}`);
    return null;
  }

  const png = Buffer.from(payload.pngBase64, "base64");
  if (png.byteLength === 0) {
    warnings.push("app bridgeが空のPNGを返しました。");
    return null;
  }
  return { source: "app-bridge", png };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
